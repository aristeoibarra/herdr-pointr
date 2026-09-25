package main

// The injection proxy: how the widget gets onto a page with nothing installed
// in the browser.
//
// A dev server on :3000 is also served on :13000, identical except that every
// page navigation gets the widget's <script> first in <head>, so its
// diagnostics hooks beat the app's own code. Nothing else is touched: assets,
// API calls and HMR WebSockets pass through untouched, which is what keeps a
// proxy in front of a dev server from costing anything.
//
// Proxies open on demand and close after sitting idle with no connections, so
// nothing listens per project unless it is in use.

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Proxy port = dev-server port + this, when free: 3000 → 13000.
	portOffset = 10_000
	proxyIdle  = 30 * time.Minute
	sweepEvery = 5 * time.Minute
	// Loopback only. A dev server bound to localhost is private on purpose; a
	// proxy on every interface would quietly publish it to the LAN.
	listenHost = "127.0.0.1"
	// Resolved by the dialer with both families tried, so a dev server on ::1
	// only (Vite's default) is reached too.
	upstreamHost = "localhost"
)

type proxy struct {
	upstream int
	port     int
	server   *http.Server
	lastUsed atomic.Int64
	// Open connections to the dev server. An open tab holds its HMR socket,
	// so a proxy anyone still looks at is never swept from under them.
	upstreamConns atomic.Int64
}

type ProxyRegistry struct {
	mu         sync.Mutex
	proxies    map[int]*proxy // by upstream port
	bridgePort int
	stateFile  string
	widgetTag  []byte
}

func newProxyRegistry(bridgePort int, stateDir string) *ProxyRegistry {
	reg := &ProxyRegistry{
		proxies:    map[int]*proxy{},
		bridgePort: bridgePort,
		stateFile:  filepath.Join(stateDir, "proxies.json"),
		widgetTag:  []byte(fmt.Sprintf(`<script src="http://localhost:%d/widget.js"></script>`, bridgePort)),
	}
	go reg.sweep()
	reg.restore()
	return reg
}

func (reg *ProxyRegistry) sweep() {
	for range time.Tick(sweepEvery) {
		reg.mu.Lock()
		for upstream, p := range reg.proxies {
			idle := time.Since(time.UnixMilli(p.lastUsed.Load())) > proxyIdle
			if idle && p.upstreamConns.Load() == 0 {
				p.server.Close()
				delete(reg.proxies, upstream)
				reg.persistLocked()
			}
		}
		reg.mu.Unlock()
	}
}

// Remembered across bridge restarts: herdr restarting takes the bridge with
// it, and the tabs open on :13000 would otherwise refuse to reload.
func (reg *ProxyRegistry) persistLocked() {
	ports := []int{}
	for upstream := range reg.proxies {
		ports = append(ports, upstream)
	}
	raw, _ := json.Marshal(ports)
	_ = writeFileAtomic(reg.stateFile, raw, 0o644) // losing it only costs a re-open
}

func (reg *ProxyRegistry) restore() {
	raw, err := os.ReadFile(reg.stateFile)
	if err != nil {
		return
	}
	var ports []int
	if json.Unmarshal(raw, &ports) != nil {
		return
	}
	for _, upstream := range ports {
		_, _ = reg.ensure(upstream)
	}
}

// ensure returns the proxy port fronting upstream, opening one if needed.
func (reg *ProxyRegistry) ensure(upstream int) (int, error) {
	if upstream < 1 || upstream > 65535 {
		return 0, fmt.Errorf("not a port: %d", upstream)
	}
	if upstream == reg.bridgePort {
		return 0, errors.New("that is the bridge itself")
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for _, p := range reg.proxies {
		if p.port == upstream {
			return upstream, nil // asked to proxy a proxy: it already has the widget
		}
	}
	if p := reg.proxies[upstream]; p != nil {
		p.lastUsed.Store(time.Now().UnixMilli())
		return p.port, nil
	}

	// A stable port is what lets a bookmark or an open tab survive a restart;
	// an ephemeral one is only the fallback when that port is taken.
	var listener net.Listener
	var err error
	if preferred := upstream + portOffset; preferred <= 65535 {
		listener, err = net.Listen("tcp", net.JoinHostPort(listenHost, strconv.Itoa(preferred)))
	}
	if listener == nil {
		listener, err = net.Listen("tcp", net.JoinHostPort(listenHost, "0"))
		if err != nil {
			return 0, err
		}
	}

	p := &proxy{upstream: upstream, port: listener.Addr().(*net.TCPAddr).Port}
	p.lastUsed.Store(time.Now().UnixMilli())
	p.server = &http.Server{Handler: reg.handler(p)}
	go func() { _ = p.server.Serve(listener) }()
	reg.proxies[upstream] = p
	reg.persistLocked()
	return p.port, nil
}

// aliases maps proxy port → dev-server port, as strings, for routing.
func (reg *ProxyRegistry) aliases() map[string]string {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	out := map[string]string{}
	for _, p := range reg.proxies {
		out[strconv.Itoa(p.port)] = strconv.Itoa(p.upstream)
	}
	return out
}

// owns says whether the bridge serves this port itself.
func (reg *ProxyRegistry) owns(port int) bool {
	if port == reg.bridgePort {
		return true
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for _, p := range reg.proxies {
		if p.port == port {
			return true
		}
	}
	return false
}

func (reg *ProxyRegistry) closeAll() {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for _, p := range reg.proxies {
		p.server.Close()
	}
}

// countedConn decrements its proxy's open-connection count exactly once.
type countedConn struct {
	net.Conn
	p    *proxy
	once sync.Once
}

func (c *countedConn) Close() error {
	c.once.Do(func() { c.p.upstreamConns.Add(-1) })
	return c.Conn.Close()
}

func (reg *ProxyRegistry) handler(p *proxy) http.Handler {
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort(upstreamHost, strconv.Itoa(p.upstream))}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			p.upstreamConns.Add(1)
			return &countedConn{Conn: conn, p: p}, nil
		},
		// The bridge never asks for compression itself; see Rewrite.
		DisableCompression: true,
		IdleConnTimeout:    90 * time.Second,
	}

	rp := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// The dev server should see the request it would have seen without
			// us: its own port in Host, Origin and Referer. Next's server
			// actions and Vite's WebSocket check compare Origin against Host.
			for _, name := range []string{"Origin", "Referer"} {
				if value := pr.In.Header.Get(name); value != "" {
					pr.Out.Header.Set(name, swapPort(value, p.port, p.upstream))
				}
			}
			// Only for pages, and only so the one body we rewrite arrives
			// plain; a server that compresses anyway is decoded below.
			if isNavigation(pr.In) {
				pr.Out.Header.Set("Accept-Encoding", "identity")
			}
		},
		ModifyResponse: func(res *http.Response) error {
			if location := res.Header.Get("Location"); location != "" {
				res.Header.Set("Location", swapPort(location, p.upstream, p.port))
			}
			return reg.inject(res)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("content-type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, unreachablePage(p.upstream))
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.lastUsed.Store(time.Now().UnixMilli())
		rp.ServeHTTP(w, r)
	})
}

// inject puts the widget into a page navigation's HTML. Anything it cannot
// safely rewrite — an encoding it cannot decode — passes through untouched.
func (reg *ProxyRegistry) inject(res *http.Response) error {
	req := res.Request
	status := res.StatusCode
	if req == nil || !isNavigation(req) || req.Method == http.MethodHead || status == 204 || status == 304 {
		return nil
	}
	if !strings.Contains(res.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	var reader io.Reader
	switch res.Header.Get("Content-Encoding") {
	case "":
		reader = res.Body
	case "gzip":
		gz, err := gzip.NewReader(res.Body)
		if err != nil {
			return err
		}
		reader = gz
	case "deflate":
		reader = flate.NewReader(res.Body)
	default:
		return nil // brotli and friends: the page loads, just without the widget
	}
	body, err := io.ReadAll(reader)
	res.Body.Close()
	if err != nil {
		return err
	}
	injected := injectWidget(body, reg.widgetTag)
	res.Body = io.NopCloser(bytes.NewReader(injected))
	res.ContentLength = int64(len(injected))
	res.Header.Set("Content-Length", strconv.Itoa(len(injected)))
	res.Header.Del("Content-Encoding")
	// The page's CSP would block a script from the bridge's origin. Dev-only
	// tooling on a dev server: dropping it is the point.
	res.Header.Del("Content-Security-Policy")
	res.Header.Del("Content-Security-Policy-Report-Only")
	return nil
}

// isNavigation says whether a request is a top-level page load.
// Sec-Fetch-Dest says so outright; without it, a GET asking for HTML is the
// best available guess. Iframes are left alone: one widget per tab.
func isNavigation(r *http.Request) bool {
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" {
		return dest == "document"
	}
	return r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html")
}

var (
	headTag    = regexp.MustCompile(`(?i)<head\b[^>]*>`)
	htmlTag    = regexp.MustCompile(`(?i)<html\b[^>]*>`)
	doctypeTag = regexp.MustCompile(`(?i)<!doctype[^>]*>`)
)

// injectWidget puts the tag first inside <head>, else after <html> or the
// doctype, else at the very start. Matched on raw bytes: the page's own
// encoding is never decoded or re-encoded.
func injectWidget(body, tag []byte) []byte {
	at := 0
	for _, pattern := range []*regexp.Regexp{headTag, htmlTag, doctypeTag} {
		if loc := pattern.FindIndex(body); loc != nil {
			at = loc[1]
			break
		}
	}
	out := make([]byte, 0, len(body)+len(tag))
	out = append(out, body[:at]...)
	out = append(out, tag...)
	return append(out, body[at:]...)
}

// swapPort swaps :from for :to on a loopback host, in a bare Host or a URL.
func swapPort(value string, from, to int) string {
	pattern := regexp.MustCompile(`(^|//)(localhost|127\.0\.0\.1|\[::1\]):` + strconv.Itoa(from) + `($|[/?#])`)
	return pattern.ReplaceAllString(value, "${1}${2}:"+strconv.Itoa(to)+"${3}")
}

// parseTarget reads a dev-server URL, a host:port or a bare port — only ever a
// loopback address, since loopback is all the proxy serves.
func parseTarget(raw string) (port int, rest, hostname string, ok bool) {
	trimmed := strings.TrimSpace(raw)
	switch {
	case regexp.MustCompile(`^\d+$`).MatchString(trimmed):
		trimmed = "http://localhost:" + trimmed + "/"
	case !regexp.MustCompile(`(?i)^[a-z]+://`).MatchString(trimmed):
		trimmed = "http://" + trimmed
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme != "http" {
		return 0, "", "", false
	}
	host := u.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return 0, "", "", false
	}
	port, err = strconv.Atoi(u.Port())
	if err != nil {
		return 0, "", "", false
	}
	// The proxy listens on IPv4 loopback; keep a hostname that reaches it and
	// shares the page's cookies (per host, not per port).
	if host == "::1" {
		host = "localhost"
	}
	rest = u.EscapedPath()
	if rest == "" {
		rest = "/"
	}
	if u.RawQuery != "" {
		rest += "?" + u.RawQuery
	}
	if u.Fragment != "" {
		rest += "#" + u.EscapedFragment()
	}
	return port, rest, host, true
}

func unreachablePage(port int) string {
	return fmt.Sprintf(`<!doctype html><meta charset="utf-8"><title>pointr — nothing on :%[1]d</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px">
<h1 style="font-size:20px">Nothing is answering on localhost:%[1]d</h1>
<p>pointr is proxying this port, but the dev server behind it is not running. Start it and reload.</p>
</body>`, port)
}
