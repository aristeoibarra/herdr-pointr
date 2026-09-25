package main

import (
	"crypto/rand"
	"crypto/sha1"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFiles embed.FS

const (
	maxBodyBytes = 5_000_000
	// Just long enough to collapse the burst of /resolve calls when tabs wake.
	agentCacheTTL = time.Second
	// A page's project is re-read from its port this often. Widgets poll every
	// few seconds while a reply is pending; a /proc walk each time is waste.
	projectKeyFresh = 15 * time.Second
	// And the last answer that named a project is kept this long when the port
	// goes quiet: a dev server mid-restart unbinds for a moment, and a comment
	// sent then would otherwise be filed under the bare origin.
	projectKeyStale = 10 * time.Minute
)

// Script bundles, embedded at build time. The screenshot bundle is separate so
// a tab only loads the rasterizer when a screenshot is actually taken.
var scripts = map[string]string{
	"/widget.js":     "web/widget.global.js",
	"/screenshot.js": "web/screenshot.global.js",
}

type Server struct {
	cfg     Config
	proxies *ProxyRegistry
	page    []byte
	etags   map[string]string

	agentMu    sync.Mutex
	agentCache []Agent
	agentAt    time.Time
	agentWait  chan struct{}
	agentErr   error

	threads *ThreadStore
	// Serializes deliveries of held comments; cooldown is per pane.
	deliverMu sync.Mutex
	cooldown  map[string]time.Time
	// This binary's own path, spelled out in the reply command every prompt
	// carries: the agent's PATH does not have it.
	exe   string
	keyMu sync.Mutex
	keys  map[string]portProjects
}

// portProjects is the cached evidence for one upstream port.
type portProjects struct {
	dirs   []string
	at     time.Time
	good   []string
	goodAt time.Time
}

// AgentEntry is how an agent is shown in the widget's picker and the page.
type AgentEntry struct {
	ID        string  `json:"id"`
	Label     string  `json:"label"`
	Path      string  `json:"path"`
	Kind      string  `json:"kind"`
	Status    string  `json:"status"`
	Title     string  `json:"title"`
	Workspace string  `json:"workspace"`
	Session   *string `json:"session"`
	Focused   bool    `json:"focused"`
}

type DevServer struct {
	Port    int          `json:"port"`
	Project string       `json:"project"`
	Cwd     string       `json:"cwd"`
	Agents  []AgentEntry `json:"agents"`
	// Replies in this project's threads nobody has opened yet.
	Unread int `json:"unread"`
}

func newServer(cfg Config) *Server {
	page, _ := webFiles.ReadFile("web/index.html")
	s := &Server{
		cfg:      cfg,
		proxies:  newProxyRegistry(cfg.Port, stateDir()),
		page:     []byte(strings.ReplaceAll(string(page), "{{PORT}}", strconv.Itoa(cfg.Port))),
		etags:    map[string]string{},
		threads:  newThreadStore(filepath.Join(stateDir(), "threads")),
		keys:     map[string]portProjects{},
		cooldown: map[string]time.Time{},
		exe:      "pointr",
	}
	if exe, err := os.Executable(); err == nil {
		s.exe = exe
	} else {
		fmt.Fprintln(os.Stderr, "threads: cannot find this binary's path; reply commands will say plain `pointr`")
	}
	// The bundles never change inside one binary, so their ETags are fixed.
	for path, file := range scripts {
		if body, err := webFiles.ReadFile(file); err == nil {
			sum := sha1.Sum(body)
			s.etags[path] = `"` + base64.RawURLEncoding.EncodeToString(sum[:]) + `"`
		}
	}
	return s
}

// agents is a cached agent list. The TTL is short because routing to a dead
// pane is far worse than one extra socket; the single flight matters more,
// since every open localhost tab calls /resolve at once when a window wakes.
func (s *Server) agents(fresh bool) ([]Agent, error) {
	s.agentMu.Lock()
	if !fresh && s.agentCache != nil && time.Since(s.agentAt) < agentCacheTTL {
		cached := s.agentCache
		s.agentMu.Unlock()
		return cached, nil
	}
	if wait := s.agentWait; wait != nil {
		s.agentMu.Unlock()
		<-wait
		s.agentMu.Lock()
		defer s.agentMu.Unlock()
		return s.agentCache, s.agentErr
	}
	wait := make(chan struct{})
	s.agentWait = wait
	s.agentMu.Unlock()

	live, err := listAgents()

	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	s.agentErr = err
	if err == nil {
		s.agentCache, s.agentAt = live, time.Now()
	}
	s.agentWait = nil
	close(wait)
	return live, err
}

// informativeFor is portEvidence behind a short cache that also remembers
// the last answer naming a project (see projectKeyStale).
func (s *Server) informativeFor(port string) []string {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	entry := s.keys[port]
	if time.Since(entry.at) >= projectKeyFresh {
		_, dirs := portEvidence(port)
		entry.dirs, entry.at = dirs, time.Now()
		if len(dirs) > 0 {
			entry.good, entry.goodAt = dirs, entry.at
		}
		s.keys[port] = entry
	}
	if len(entry.dirs) > 0 {
		return entry.dirs
	}
	if len(entry.good) > 0 && time.Since(entry.goodAt) < projectKeyStale {
		return entry.good
	}
	return nil
}

// projectKey names the project a page's threads are filed under.
func (s *Server) projectKey(pageURL string) string {
	projectPath := ""
	if s.cfg.ProjectPath != nil {
		projectPath = *s.cfg.ProjectPath
	}
	return projectKeyFor(upstreamURL(pageURL, s.proxies.aliases()), s.informativeFor, projectPath)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("access-control-allow-origin", "*")
	h.Set("access-control-allow-methods", "GET, POST, OPTIONS")
	h.Set("access-control-allow-headers", "content-type")
	if r.Method == http.MethodOptions {
		// A page served on the machine's LAN IP reaching localhost crosses into
		// a more-private network, which Chromium gates behind this preflight
		// opt-in. It must stay ahead of dispatch — /status depends on it too.
		if r.Header.Get("access-control-request-private-network") == "true" {
			h.Set("access-control-allow-private-network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	query := r.URL.Query()
	get := r.Method == http.MethodGet
	switch path := r.URL.Path; {
	case get && path == "/health":
		sendJSON(w, 200, map[string]any{"ok": true, "targetAgent": s.cfg.TargetAgent})
	case get && (path == "/" || path == "/index.html"):
		h.Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write(s.page)
	case get && scripts[path] != "":
		s.serveScript(w, r, path)
	case get && (path == "/open" || path == "/proxy"):
		s.handleOpen(w, r, path == "/open")
	case get && path == "/servers":
		live, _ := s.agents(false)
		sendJSON(w, 200, map[string]any{"ok": true, "servers": s.devServers(live)})
	case get && path == "/debug":
		live, _ := s.agents(true)
		port := query.Get("port")
		pageURL := query.Get("url")
		if pageURL == "" {
			pageURL = "http://localhost:" + port + "/"
		}
		res := resolveTarget(s.routingInput(live, pageURL, nil))
		cwd, _ := os.Getwd()
		owners := []PortOwner{}
		if port != "" {
			owners = append(owners, ownersForPort(port)...)
		}
		sendJSON(w, 200, map[string]any{
			"ok": true, "cwd": cwd, "portStrategy": portStrategy(), "portOwners": owners,
			"agents": entries(live), "resolution": describe(res), "trace": res.Trace,
			// Where this page's comment threads are filed — "why don't my
			// threads show?" answered next to "why did it route there?".
			"threadsKey": s.projectKey(pageURL),
		})
	case get && path == "/resolve":
		live, _ := s.agents(false)
		res := resolveTarget(s.routingInput(live, query.Get("url"), nil))
		if res.Kind == "resolved" {
			sendJSON(w, 200, map[string]any{
				"ok": true, "project": project(res.Agent.Cwd),
				"agent": map[string]any{"paneId": res.Agent.PaneID, "session": nullable(res.Agent.SessionID), "kind": res.Agent.Kind},
				"via":   res.Via, "trace": res.Trace,
			})
			return
		}
		sendJSON(w, 200, map[string]any{
			"ok": false, "reason": noMatchReason(res), "candidates": entriesAmong(res.Candidates, live), "trace": res.Trace,
		})
	case get && path == "/agents":
		// herdr not running degrades to an empty list, so the widget shows "Auto".
		live, _ := s.agents(false)
		sendJSON(w, 200, map[string]any{"ok": true, "agents": entries(live)})
	case get && path == "/status":
		s.handleStatus(w, r)
	case get && path == "/threads":
		s.handleThreads(w, r)
	case r.Method == http.MethodPost && path == "/send":
		s.handleSend(w, r)
	case r.Method == http.MethodPost && path == "/threads/reply":
		s.handleThreadReply(w, r)
	case r.Method == http.MethodPost && path == "/threads/message":
		s.handleThreadMessage(w, r)
	case r.Method == http.MethodPost && path == "/threads/resolve":
		s.handleThreadResolve(w, r)
	case r.Method == http.MethodPost && path == "/threads/anchor":
		s.handleThreadAnchor(w, r)
	case r.Method == http.MethodPost && path == "/threads/read":
		s.handleThreadRead(w, r)
	case r.Method == http.MethodPost && path == "/threads/cancel":
		s.handleThreadCancel(w, r)
	case r.Method == http.MethodPost && path == "/threads/deliver":
		s.handleThreadDeliver(w, r)
	default:
		sendJSON(w, 404, map[string]any{"ok": false, "reason": "not_found", "error": "not found"})
	}
}

// serveScript answers with an ETag and no-cache: a reload costs a 304, a new
// binary lands on the next one. Loaders must not add a cache-buster.
func (s *Server) serveScript(w http.ResponseWriter, r *http.Request, path string) {
	body, err := webFiles.ReadFile(scripts[path])
	if err != nil {
		sendJSON(w, 500, map[string]any{"ok": false, "reason": "bridge_error", "error": "widget missing from this build"})
		return
	}
	h := w.Header()
	h.Set("content-type", "application/javascript; charset=utf-8")
	h.Set("cache-control", "no-cache")
	h.Set("etag", s.etags[path])
	if r.Header.Get("if-none-match") == s.etags[path] {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request, redirect bool) {
	port, rest, hostname, ok := parseTarget(r.URL.Query().Get("url"))
	if !ok {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "url must be a localhost URL or a port"})
		return
	}
	proxyPort, err := s.proxies.ensure(port)
	if err != nil {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": err.Error()})
		return
	}
	target := fmt.Sprintf("http://%s:%d%s", hostname, proxyPort, rest)
	// /open is for a browser (a bookmark, the setup page); /proxy for the CLI.
	if redirect {
		w.Header().Set("location", target)
		w.WriteHeader(http.StatusFound)
		return
	}
	sendJSON(w, 200, map[string]any{"ok": true, "url": target, "upstream": port, "port": proxyPort})
}

func (s *Server) routingInput(live []Agent, pageURL string, override *AgentPin) RoutingInput {
	input := RoutingInput{Agents: live, URL: pageURL, Override: override, Pin: s.cfg.TargetAgent, PortAliases: s.proxies.aliases()}
	if s.cfg.ProjectPath != nil {
		input.ProjectPath = *s.cfg.ProjectPath
	}
	return input
}

// devServers lists the dev servers on this machine for the setup page: one
// bookmark instead of one per project and port. "Dev server" is decided with
// the routing's own evidence test, so the list shows exactly what routing
// could attribute to a project; the bridge's own ports are left out.
func (s *Server) devServers(live []Agent) []DevServer {
	byPort := map[int][]string{}
	self := os.Getpid()
	for _, entry := range listeningPorts() {
		if entry.Pid == self || entry.Cwd == "" || s.proxies.owns(entry.Port) || !isInformativeProjectDir(entry.Cwd) {
			continue
		}
		byPort[entry.Port] = append(byPort[entry.Port], entry.Cwd)
	}
	servers := make([]DevServer, 0, len(byPort))
	for port, dirs := range byPort {
		// The same pick the thread store keys on, so the page and the list agree.
		cwd := projectDir(dirs)
		servers = append(servers, DevServer{
			Port: port, Project: project(cwd), Cwd: cwd,
			Agents: entriesAmong(matchAgents(cwd, live, isInformativeProjectDir), live),
			Unread: s.threads.unread(cwd),
		})
	}
	sort.Slice(servers, func(i, j int) bool { return servers[i].Port < servers[j].Port })
	return servers
}

// handleStatus streams an agent's status as SSE. The widget opens it after a
// send and closes it once the agent settles. ?once=1 answers with plain JSON
// instead: the fallback for a page whose CSP blocks the stream.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	paneID := r.URL.Query().Get("agent")
	if paneID == "" {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "missing agent"})
		return
	}
	if r.URL.Query().Get("once") == "1" {
		live, _ := s.agents(false)
		for _, agent := range live {
			if agent.PaneID == paneID {
				sendJSON(w, 200, map[string]any{"ok": true, "status": agent.Status, "title": agent.Title})
				return
			}
		}
		sendJSON(w, 200, map[string]any{"ok": false, "reason": "stale_target"})
		return
	}
	serveStatusStream(w, r, paneID)
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			sendJSON(w, 413, map[string]any{"ok": false, "reason": "payload_too_large",
				"error": fmt.Sprintf("payload too large — over %d MB (usually an oversized screenshot)", maxBodyBytes/1_000_000)})
			return
		}
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "could not read body"})
		return
	}
	var payload SendPayload
	if json.Unmarshal(raw, &payload) != nil {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "invalid JSON"})
		return
	}
	if !payload.valid() {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "missing message/url/elements"})
		return
	}

	live, _ := s.agents(false)
	res := resolveTarget(s.routingInput(live, *payload.URL, overrideFrom(payload)))
	if res.Kind != "resolved" {
		sendNoTarget(w, res, live)
		return
	}

	agent := res.Agent
	upstream := upstreamURL(*payload.URL, s.proxies.aliases())
	// Reserved before the prompt goes out: a quick agent can answer before
	// herdr has even returned, and its reply needs a thread to land in.
	thread := s.threads.reserve(s.projectKey(*payload.URL), newThreadFromSend(payload, upstream, agent))
	screenshot := saveScreenshot(payload.Screenshot)
	// The agent gets the URL it can reason about — the app's, not the proxy's.
	prompt := formatPrompt(payload, upstream, screenshot, thread.ID, replyCommand(s.exe, s.cfg.Port, thread.ID))
	autoSubmit := payload.AutoSubmit == nil || *payload.AutoSubmit
	held := autoSubmit && busy(agent.Status)

	if held {
		// Busy agent: keep it here until it is free (see delivery.go), so it
		// can still be cancelled. Nothing is typed yet.
		s.threads.holdFirst(thread.ID, prompt)
	} else if autoSubmit {
		if _, err := promptAgent(agent.PaneID, prompt); err != nil {
			s.abandon(thread.ID, err)
			s.sendFailure(w, err, agent.PaneID)
			return
		}
	} else {
		// Only a widget from before threads sends autoSubmit=false; it still
		// gets a thread, so the agent's reply has somewhere to go.
		//
		// pane.send_text has no agent_blocked guard, so text typed into an
		// open approval dialog could answer it. Check what we already know
		// first: racy, but it turns the common case into a clear refusal.
		if agent.Status == "blocked" {
			s.threads.drop(thread.ID)
			s.sendFailure(w, &HerdrError{"agent_blocked", "agent is blocked"}, agent.PaneID)
			return
		}
		if err := pasteText(agent.PaneID, prompt); err != nil {
			s.abandon(thread.ID, err)
			s.sendFailure(w, err, agent.PaneID)
			return
		}
	}
	committed, err := s.threads.commit(thread.ID)
	if err != nil {
		committed = thread
	}

	// Show in herdr's sidebar which page this pane is pointed at. Self-expiring.
	go reportTokens(agent.PaneID, "bridge", map[string]any{"browser": shortURL(*payload.URL)}, 120*time.Second)

	sendJSON(w, 200, map[string]any{
		"ok": true, "targetAgent": map[string]any{"paneId": agent.PaneID, "session": nullable(agent.SessionID)},
		"project": project(agent.Cwd), "screenshot": nullable(screenshot), "status": agent.Status,
		"autoSubmitted": autoSubmit, "stale": res.Stale, "thread": view(committed), "held": held,
	})
}

// sendNoTarget answers a send that routing could not settle, with the
// candidates the widget offers in its destination picker.
func sendNoTarget(w http.ResponseWriter, res Resolution, live []Agent) {
	message := "No agent found for this project. Open one in herdr inside the project directory, or pin one."
	if res.Kind == "ambiguous" {
		message = "Several agents could be working on this project — pick one as the destination."
	}
	sendJSON(w, 409, map[string]any{"ok": false, "reason": noMatchReason(res), "error": message,
		"candidates": entriesAmong(res.Candidates, live), "trace": res.Trace})
}

// abandon rolls back a thread whose first prompt failed — unless herdr may
// have typed it anyway (a timeout, a garbled answer), in which case the agent
// could still reply and the thread has to exist for it.
func (s *Server) abandon(id string, err error) {
	if mayHaveTyped(err) {
		_, _ = s.threads.commit(id)
		return
	}
	s.threads.drop(id)
}

// mayHaveTyped: herdr failed in a way that does not prove the prompt never
// reached the terminal.
func mayHaveTyped(err error) bool {
	var herr *HerdrError
	return errors.As(err, &herr) && (herr.Code == "timeout" || herr.Code == "protocol")
}

func (s *Server) sendFailure(w http.ResponseWriter, err error, paneID string) {
	var herr *HerdrError
	if errors.As(err, &herr) && herr.Code == "agent_blocked" {
		// Surface it where the user has to act — in herdr, not only the tab.
		go notify("Bridge", "An agent is blocked on an approval dialog")
	}
	status, reason, message := failureFor(err)
	sendJSON(w, status, map[string]any{"ok": false, "reason": reason, "error": message, "agent": paneID})
}

// failureFor turns a herdr refusal into an answer the widget renders distinctly.
func failureFor(err error) (int, string, string) {
	var herr *HerdrError
	if !errors.As(err, &herr) {
		return 500, "bridge_error", err.Error()
	}
	switch herr.Code {
	case "agent_blocked":
		// A conflict with current state, not an outage: the user clears it and
		// retries the same request, so it must not read as "bridge broken".
		return 409, "agent_blocked", "That agent is waiting on an approval dialog in its terminal — answer it there, then send again."
	case "agent_not_found", "pane_not_found":
		return 409, "stale_target", "That agent is gone."
	case "unavailable":
		return 503, "herdr_down", "herdr isn't answering — is it running?"
	case "timeout":
		return 504, "herdr_timeout", "herdr did not answer in time."
	case "protocol":
		return 502, "herdr_protocol", "Unexpected response from herdr."
	}
	return 502, "herdr_error", herr.Message
}

func overrideFrom(p SendPayload) *AgentPin {
	if p.TargetAgent != nil && p.TargetAgent.PaneID != "" {
		return p.TargetAgent
	}
	if p.TargetPane != "" {
		return &AgentPin{PaneID: p.TargetPane}
	}
	return nil
}

func noMatchReason(res Resolution) string {
	if res.Kind == "ambiguous" {
		return "ambiguous"
	}
	return "no_agents"
}

func describe(res Resolution) string {
	if res.Kind == "resolved" {
		return res.Via + ":" + res.Agent.PaneID
	}
	return res.Kind
}

var dataURL = regexp.MustCompile(`(?s)^data:image/(?:png|jpeg);base64,(.+)$`)

func saveScreenshot(data string) string {
	match := dataURL.FindStringSubmatch(data)
	if match == nil {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(match[1])
	if err != nil {
		return ""
	}
	dir := filepath.Join(os.TempDir(), "herdr-pointr")
	if os.MkdirAll(dir, 0o755) != nil {
		return ""
	}
	// Random suffix: two quick sends can land on the same millisecond.
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	file := filepath.Join(dir, fmt.Sprintf("shot-%d-%s.png", time.Now().UnixMilli(), hex.EncodeToString(suffix)))
	if os.WriteFile(file, decoded, 0o644) != nil {
		return ""
	}
	return file
}

func project(cwd string) string {
	if base := filepath.Base(cwd); base != "" && base != "." && base != "/" {
		return base
	}
	return cwd
}

func entries(agents []Agent) []AgentEntry { return entriesAmong(agents, agents) }

// entriesAmong labels agents for the picker. Only stable fields go into the
// label: the widget persists it beside a pin, and a status baked in would be
// wrong seconds later. Status and title ship as separate live fields.
func entriesAmong(agents, all []Agent) []AgentEntry {
	out := make([]AgentEntry, 0, len(agents))
	for _, agent := range agents {
		name := project(agent.Cwd)
		label := name + " · " + agent.Kind
		for _, other := range all {
			if other.PaneID != agent.PaneID && project(other.Cwd) == name && other.Kind == agent.Kind {
				label += " · " + agent.WorkspaceID
				break
			}
		}
		out = append(out, AgentEntry{
			ID: agent.PaneID, Label: label, Path: agent.Cwd, Kind: agent.Kind, Status: agent.Status,
			Title: agent.Title, Workspace: agent.WorkspaceID, Session: nullable(agent.SessionID), Focused: agent.Focused,
		})
	}
	return out
}

func shortURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "browser"
	}
	short := u.Host
	if u.Path != "/" {
		short += u.Path
	}
	if len(short) > 32 {
		short = short[:32]
	}
	return short
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func sendJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
