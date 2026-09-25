// Command pointr is the herdr-pointr bridge: it receives browser selections
// from the widget and delivers them to the coding agent that owns the project.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	cfg := loadConfig()
	if cfg.HerdrSocketPath != nil {
		setSocketPath(*cfg.HerdrSocketPath)
	}
	command, args := "", []string{}
	if len(os.Args) > 1 {
		command, args = os.Args[1], os.Args[2:]
	}

	switch command {
	case "serve":
		serve(cfg, args)
	case "start":
		os.Exit(daemonStart(cfg.Port))
	case "stop":
		os.Exit(daemonStop(cfg.Port))
	case "status":
		os.Exit(daemonStatus(cfg.Port))
	case "agents":
		printAgents()
	case "pin":
		pin(args)
	case "pick":
		pick()
	case "open":
		target := os.Getenv("HERDR_PLUGIN_CLICKED_URL")
		if len(args) > 0 {
			target = args[0]
		}
		openInBrowser(cfg.Port, target)
	case "doctor":
		doctor(cfg.Port)
	case "reply":
		os.Exit(replyCmd(cfg.Port, args))
	case "", "help", "--help", "-h":
		printHelp()
	default:
		fail("Unknown command: " + command)
	}
}

func serve(cfg Config, args []string) {
	if port := readFlag(args, "--port"); port != "" {
		cfg.Port, _ = strconv.Atoi(port)
	}
	if project := readFlag(args, "--project"); project != "" {
		cfg.ProjectPath = &project
	}

	// Loopback only, on both families: the widget asks for "localhost", which
	// a browser may resolve to either. Nothing off this machine can reach it.
	var listeners []net.Listener
	for _, host := range []string{"127.0.0.1", "::1"} {
		if l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(cfg.Port))); err == nil {
			listeners = append(listeners, l)
		}
	}
	if len(listeners) == 0 {
		fail(fmt.Sprintf("could not listen on localhost:%d", cfg.Port))
	}

	bridge := newServer(cfg)
	// No write timeout: /status is a long-lived event stream.
	server := &http.Server{Handler: bridge, ReadHeaderTimeout: 10 * time.Second}
	for _, l := range listeners {
		go func(l net.Listener) {
			if err := server.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
				fmt.Fprintln(os.Stderr, err)
			}
		}(l)
	}
	fmt.Printf("bridge listening on http://localhost:%d\n", cfg.Port)
	fmt.Printf("herdr:   %s\n", socketPath())
	if cfg.TargetAgent != nil {
		fmt.Printf("target:  %s (pinned)\n", cfg.TargetAgent.PaneID)
	} else {
		fmt.Println("target:  resolved per page (dev-server port -> project dir -> agent)")
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	// Open event streams would keep Shutdown waiting, so end them first.
	shutdownWatchers()
	bridge.proxies.closeAll()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func printAgents() {
	if !isAvailable() {
		fail("No herdr server answering at " + socketPath() + ".")
	}
	agents, err := listAgents()
	if err != nil {
		fail(err.Error())
	}
	if len(agents) == 0 {
		fmt.Println("herdr is running, but no agents are open.")
		return
	}
	fmt.Println("agents:")
	for _, a := range agents {
		fmt.Printf("  %-10s %-10s %-8s %s\n", a.PaneID, a.Kind, a.Status, a.Cwd)
	}
}

// pin is rarely needed — routing is automatic — but it settles the case where
// several agents legitimately match one project.
func pin(args []string) {
	cfg := loadConfig()
	for _, arg := range args {
		if arg == "--clear" {
			cfg.TargetAgent = nil
			saveOrFail(cfg)
			fmt.Println("pin cleared — the bridge resolves the agent per page again.")
			return
		}
	}
	// Default to the pane this ran in, which is what herdr exports to an agent.
	// Pane ids are opaque ("w3Y:p2"), so any argument that is not a flag is
	// taken as one and checked against herdr below — a pattern that only knew
	// numeric workspaces skipped the argument and pinned this pane instead.
	paneID := os.Getenv("HERDR_PANE_ID")
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			paneID = arg
		}
	}
	if paneID == "" {
		fail("No pane to pin. Run this inside a herdr pane, or pass one: `pin w1:p1`.")
	}
	agents, _ := listAgents()
	for _, a := range agents {
		if a.PaneID == paneID {
			cfg.TargetAgent = &AgentPin{PaneID: a.PaneID, Session: nullable(a.SessionID)}
			saveOrFail(cfg)
			fmt.Printf("pinned %s (%s) in %s\nsaved to %s\n", a.PaneID, a.Kind, a.Cwd, configFile())
			return
		}
	}
	fail("herdr reports no agent in pane " + paneID + ".")
}

// pick chooses a destination from a list. It runs in a herdr popup pane, so it
// has a terminal and can just read a number.
func pick() {
	defer time.Sleep(1200 * time.Millisecond) // let the result show before herdr closes the popup
	agents, _ := listAgents()
	if len(agents) == 0 {
		fmt.Println("No agents open in herdr.")
		return
	}
	fmt.Println("Send browser selections to:\n\n  0) auto — resolve from the page's dev-server port")
	for i, a := range agents {
		fmt.Printf("  %d) %s  %s/%s  %s\n", i+1, a.PaneID, a.Kind, a.Status, a.Cwd)
	}
	fmt.Print("\nnumber: ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	choice, err := strconv.Atoi(strings.TrimSpace(line))
	cfg := loadConfig()
	switch {
	case err == nil && choice == 0:
		cfg.TargetAgent = nil
		saveOrFail(cfg)
		fmt.Println("cleared — routing resolves per page again.")
	case err == nil && choice >= 1 && choice <= len(agents):
		a := agents[choice-1]
		cfg.TargetAgent = &AgentPin{PaneID: a.PaneID, Session: nullable(a.SessionID)}
		saveOrFail(cfg)
		fmt.Printf("pinned %s (%s)\n", a.PaneID, a.Cwd)
	default:
		fmt.Println("Not a choice; nothing changed.")
	}
}

// openInBrowser opens a dev server through the bridge's injection proxy, so
// the page arrives with the widget in it. Wired to the manifest's link
// handler. If the bridge cannot proxy it, the original URL still opens: a
// link that does nothing is worse than a page without the widget.
func openInBrowser(bridgePort int, target string) {
	if target == "" {
		fail("No URL to open. Pass one, or a port: `pointr open 3000`.")
	}
	dest := target
	if regexp.MustCompile(`^\d+$`).MatchString(target) {
		dest = "http://localhost:" + target + "/"
	}
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(fmt.Sprintf("http://localhost:%d/proxy?url=%s", bridgePort, url.QueryEscape(target)))
	if err != nil {
		fmt.Printf("no bridge on :%d; opening without the widget\n", bridgePort)
	} else {
		var body struct {
			URL string `json:"url"`
		}
		if json.NewDecoder(res.Body).Decode(&body) == nil && res.StatusCode == 200 && body.URL != "" {
			dest = body.URL
		} else {
			fmt.Println("the bridge would not proxy this URL; opening it without the widget")
		}
		res.Body.Close()
	}
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	cmd := exec.Command(opener, dest)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		fail(err.Error())
	}
	_ = cmd.Process.Release()
	fmt.Println("opening " + dest)
}

// doctor checks everything the bridge needs, and ends on the next step.
func doctor(bridgePort int) {
	herdr := isAvailable()
	fmt.Printf("herdr socket   %s  %s\n", map[bool]string{true: "ok", false: "MISSING"}[herdr], socketPath())
	if herdr {
		agents, _ := listAgents()
		fmt.Printf("agents         %d open\n", len(agents))
	}
	if strategy := portStrategy(); strategy == "none" {
		fmt.Printf("port lookup    UNSUPPORTED on %s\n", runtime.GOOS)
	} else {
		fmt.Printf("port lookup    ok (%s)\n", strategy)
	}
	fmt.Printf("config         %s\n", configFile())
	if exe, err := os.Executable(); err == nil {
		// The first reply from Claude Code asks for Bash permission and leaves
		// the pane blocked until someone answers it.
		fmt.Printf("agent replies  %s reply --port %d <thread>\n", shellWord(exe), bridgePort)
		fmt.Printf("               Claude Code allow rule: Bash(%s reply:*)\n", shellWord(exe))
	}

	bridge := fmt.Sprintf("http://localhost:%d", bridgePort)
	client := http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(bridge + "/servers")
	if err != nil {
		fmt.Printf("bridge         NOT RUNNING on :%d — start it: herdr plugin action invoke aristeoibarra.pointr.start\n", bridgePort)
		return
	}
	defer res.Body.Close()
	var body struct {
		Servers []DevServer `json:"servers"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	fmt.Printf("bridge         ok  %s\n", bridge)
	if len(body.Servers) == 0 {
		fmt.Printf("\nNo dev server running in a project yet. Start one, then open it at\n  %s  (it lists them) or %s/open?url=<port>\n", bridge, bridge)
		return
	}
	fmt.Println("\nOpen with the widget:")
	for _, server := range body.Servers {
		note := ""
		if len(server.Agents) == 0 {
			note = "  (no agent there yet)"
		}
		fmt.Printf("  %-16s %s/open?url=%d%s\n", server.Project, bridge, server.Port, note)
	}
}

func printHelp() {
	fmt.Printf(`Send selected browser elements into the coding agent that owns the project.

Usage:
  start | stop | status              Manage the background bridge (default :%d)
  serve [--port N] [--project PATH]  Run it in the foreground instead
  agents                             List the agents herdr can see
  pin [w1:p1|--clear]                Pin/clear a destination agent (rarely needed)
  pick                               Choose a destination from a list
  open <url|port>                    Open a dev server with the widget injected
  doctor                             Check herdr and port lookup
  reply [--port N] <thread-id>       Answer a browser comment; text on stdin (run by the agent)

Routing is automatic: the page's dev-server port maps to the directory it
was launched from, which maps to the agent working there. Pin only when
several agents legitimately match one project.
`, defaultPort)
}

func readFlag(args []string, name string) string {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func saveOrFail(cfg Config) {
	if err := saveConfig(cfg); err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
