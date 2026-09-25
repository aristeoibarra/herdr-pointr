package main

// Routing: which agent a page's feedback goes to. The one place in the bridge
// where being wrong is invisible — it does not fail, it delivers somewhere
// else — so every rule here is covered in routing_test.go.

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type StaleTarget struct {
	PaneID string `json:"paneId"`
	Reason string `json:"reason"` // pane_closed | session_replaced
}

type Resolution struct {
	Kind       string // resolved | ambiguous | none
	Agent      *Agent
	Via        string // override | pin | port | config | only
	Stale      *StaleTarget
	Candidates []Agent
	Trace      []string
}

type RoutingInput struct {
	Agents []Agent
	// Page URL from the widget; the dev-server port is read off it.
	URL string
	// Per-tab choice from the widget, beats the persisted pin.
	Override *AgentPin
	// Persisted pin from config.
	Pin         *AgentPin
	ProjectPath string
	// pointr's own proxy ports, each mapped to the dev-server port it fronts.
	// A page opened through the proxy carries the proxy's port, not the app's.
	PortAliases map[string]string
}

// Files that make a directory look like a project someone works in.
var projectMarkers = []string{".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "deno.json"}

func normalize(dir string) string {
	if dir == "/" {
		return "/"
	}
	return strings.TrimRight(dir, "/")
}

func isAncestor(parent, child string) bool {
	prefix := parent + "/"
	if parent == "/" {
		prefix = "/"
	}
	return child == parent || strings.HasPrefix(child, prefix)
}

func depth(dir string) int {
	count := 0
	for _, segment := range strings.Split(normalize(dir), "/") {
		if segment != "" {
			count++
		}
	}
	return count
}

func agentDir(agent Agent) string {
	if agent.Cwd == "" {
		return ""
	}
	return normalize(agent.Cwd)
}

// isInformativeProjectDir says whether a directory is evidence of *which
// project* a page belongs to.
//
// A dev server started from $HOME has every agent below it, so any containment
// rule matches all of them and something has to break the tie. There is no
// correct tie to break: $HOME says nothing about which project is served. So
// it is rejected as evidence and the caller asks instead of quietly picking.
func isInformativeProjectDir(dir string) bool {
	normalized := normalize(dir)
	home := normalize(homeDir())

	// Reject the universal ancestors before looking at markers: a dotfiles
	// $HOME is a git repo and would otherwise pass.
	if normalized == "/" || normalized == home || normalized == normalize(os.TempDir()) {
		return false
	}
	if isAncestor(normalized, home) {
		return false
	}
	info, err := os.Stat(normalized)
	if err != nil || !info.IsDir() {
		return false
	}
	for _, marker := range projectMarkers {
		if _, err := os.Stat(filepath.Join(normalized, marker)); err == nil {
			return true
		}
	}
	return false
}

// matchAgents returns the agents plausibly working on dir, in ordered,
// exclusive tiers: exact, then nearest ancestor (deepest), then nearest
// descendant (shallowest). Once a tier produces candidates the rest are never
// consulted. More than one means genuinely ambiguous: the caller asks, it
// does not guess.
//
// This replaced one length sort over every match, which compared characters
// across unrelated relationships — so /a/bbbbbbbbbb outranked /a/b/c.
func matchAgents(dir string, agents []Agent, isProjectDir func(string) bool) []Agent {
	target := normalize(dir)

	var exact, ancestors, descendants []Agent
	for _, agent := range agents {
		d := agentDir(agent)
		switch {
		case d == "":
		case d == target:
			exact = append(exact, agent)
		// The agent sits above the dev server: a monorepo agent at /repo with
		// the server in /repo/apps/web. Its own directory has to look like a
		// project too: an agent parked in $HOME contains every project on the
		// machine and would win this tier for all of them.
		case isAncestor(d, target):
			if isProjectDir(d) {
				ancestors = append(ancestors, agent)
			}
		// The agent sits below: server at the repo root, agent in a subpackage.
		case isAncestor(target, d):
			descendants = append(descendants, agent)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	if len(ancestors) > 0 {
		return extreme(ancestors, func(a, b int) bool { return a > b })
	}
	if len(descendants) > 0 {
		return extreme(descendants, func(a, b int) bool { return a < b })
	}
	return nil
}

// extreme keeps every agent at the best depth by `better`, ties included.
func extreme(agents []Agent, better func(a, b int) bool) []Agent {
	best := depth(agentDir(agents[0]))
	for _, agent := range agents[1:] {
		if d := depth(agentDir(agent)); better(d, best) {
			best = d
		}
	}
	var kept []Agent
	for _, agent := range agents {
		if depth(agentDir(agent)) == best {
			kept = append(kept, agent)
		}
	}
	return kept
}

// portOf mirrors the WHATWG URL rule the widget's URLs follow: an explicit
// default port reads as no port at all.
func portOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		return ""
	}
	return port
}

// upstreamURL returns the page URL as the dev server itself serves it: a page
// opened through pointr's proxy is rewritten back to the port it fronts.
//
// Routing must never see a proxy port. The process listening there is the
// bridge, whose working directory is pointr's own checkout — so an
// untranslated URL does not fail, it resolves to whichever agent is working
// on pointr and delivers every project's feedback there.
func upstreamURL(raw string, aliases map[string]string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	upstream, ok := aliases[u.Port()]
	if !ok {
		return raw
	}
	u.Host = u.Hostname() + ":" + upstream
	if strings.Contains(u.Hostname(), ":") {
		u.Host = "[" + u.Hostname() + "]:" + upstream
	}
	return u.String()
}

// usePin checks a pin against live agents, reporting how it has gone stale.
func usePin(pin *AgentPin, agents []Agent, via string, trace *[]string) *Resolution {
	for i := range agents {
		agent := &agents[i]
		if agent.PaneID != pin.PaneID {
			continue
		}
		if pin.Session != nil && agent.SessionID != "" && agent.SessionID != *pin.Session {
			// Restarted in the same terminal. The pin names a terminal, not a
			// conversation, so it still points at the right place — but the
			// caller should say so rather than pretend nothing changed.
			*trace = append(*trace, fmt.Sprintf("%s: pane %s kept, session replaced", via, pin.PaneID))
			return &Resolution{Kind: "resolved", Agent: agent, Via: via,
				Stale: &StaleTarget{PaneID: pin.PaneID, Reason: "session_replaced"}}
		}
		*trace = append(*trace, fmt.Sprintf("%s: pane %s", via, pin.PaneID))
		return &Resolution{Kind: "resolved", Agent: agent, Via: via}
	}
	*trace = append(*trace, fmt.Sprintf("%s: pane %s is gone", via, pin.PaneID))
	return nil
}

// resolveTarget picks the destination agent. Order: per-tab override,
// persisted pin, dev-server port, configured project, sole agent. Every step
// appends to the trace, which /debug and /resolve return — given the class of
// bug this replaces, seeing *why* a route was chosen matters most.
func resolveTarget(input RoutingInput) Resolution {
	var trace []string
	done := func(r Resolution) Resolution {
		r.Trace = trace
		return r
	}
	agents := input.Agents
	if len(agents) == 0 {
		trace = append(trace, "no agents running")
		return done(Resolution{Kind: "none"})
	}
	if input.Override != nil {
		if r := usePin(input.Override, agents, "override", &trace); r != nil {
			return done(*r)
		}
	}
	if input.Pin != nil {
		if r := usePin(input.Pin, agents, "pin", &trace); r != nil {
			return done(*r)
		}
	}

	pagePort := portOf(input.URL)
	port := portOf(upstreamURL(input.URL, input.PortAliases))
	if pagePort != "" && port != pagePort {
		trace = append(trace, fmt.Sprintf("port %s is pointr's proxy for %s", pagePort, port))
	}
	if port == "" {
		trace = append(trace, "url carries no port")
	} else if resolved, stop := routeByPort(port, agents, &trace); stop {
		return done(resolved)
	}

	if input.ProjectPath != "" {
		matched := matchAgents(input.ProjectPath, agents, isInformativeProjectDir)
		switch {
		case len(matched) == 1:
			trace = append(trace, fmt.Sprintf("configured project %s -> %s", input.ProjectPath, matched[0].PaneID))
			return done(Resolution{Kind: "resolved", Agent: &matched[0], Via: "config"})
		case len(matched) > 1:
			trace = append(trace, fmt.Sprintf("configured project %s -> %d agents match equally", input.ProjectPath, len(matched)))
			return done(Resolution{Kind: "ambiguous", Candidates: matched})
		}
		trace = append(trace, fmt.Sprintf("configured project %s -> no agent there", input.ProjectPath))
	}

	if len(agents) == 1 {
		trace = append(trace, fmt.Sprintf("only one agent running -> %s", agents[0].PaneID))
		return done(Resolution{Kind: "resolved", Agent: &agents[0], Via: "only"})
	}
	trace = append(trace, fmt.Sprintf("%d agents running, none identifiable for this page", len(agents)))
	return done(Resolution{Kind: "none", Candidates: agents})
}

// portEvidence is the evidence half of the port step: every directory behind
// the port and the ones that name a project. Routing and thread storage both
// read a page's project off it, so the two cannot disagree about it.
func portEvidence(port string) (dirs, informative []string) {
	// Second line of defence behind upstreamURL: a port the bridge serves
	// itself is never evidence of which project a page belongs to.
	dirs = cwdsForPort(port, os.Getpid())
	for _, dir := range dirs {
		if isInformativeProjectDir(dir) {
			informative = append(informative, dir)
		}
	}
	return dirs, informative
}

// projectDir picks one of several directories that each name a project, and
// always the same one, so a page's threads do not hop between files. Routing
// still matches against all of them; this is only for keys and labels.
func projectDir(informative []string) string {
	if len(informative) == 0 {
		return ""
	}
	sorted := append([]string(nil), informative...)
	sort.Strings(sorted)
	return normalize(sorted[0])
}

// projectKeyFor names the project a page's threads belong to. upstream must
// already be translated off pointr's proxy ports. The dev server's directory
// wins, then the configured project, then the origin itself — for servers
// whose cwd says nothing, like Docker's proxy or a server started in $HOME.
//
// The agent's directory is deliberately not a fallback: the agent routing
// picks changes as panes open and close, and threads keyed on it would drop
// off the page without any error.
func projectKeyFor(upstream string, informativeFor func(port string) []string, projectPath string) string {
	if port := portOf(upstream); port != "" {
		if dir := projectDir(informativeFor(port)); dir != "" {
			return dir
		}
	}
	if projectPath != "" {
		return normalize(projectPath)
	}
	return originKey(upstream)
}

// originKey is the last-resort project key: host and port, with the loopback
// spellings folded together so localhost and 127.0.0.1 share threads.
func originKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "unknown"
	}
	host := u.Hostname()
	if host == "127.0.0.1" || host == "::1" {
		host = "localhost"
	}
	if port := portOf(raw); port != "" {
		return host + ":" + port
	}
	return host
}

// routeByPort is the port → cwd → agent step. stop is true when it settled
// the answer, resolved or ambiguous.
func routeByPort(port string, agents []Agent, trace *[]string) (Resolution, bool) {
	dirs, informative := portEvidence(port)
	if len(dirs) == 0 {
		*trace = append(*trace, fmt.Sprintf("port %s: nothing listening, or its cwd is unreadable", port))
		return Resolution{}, false
	}
	if len(informative) == 0 {
		*trace = append(*trace, fmt.Sprintf("port %s: %s says nothing about which project this is", port, strings.Join(dirs, ", ")))
		return Resolution{}, false
	}
	seen := map[string]bool{}
	var winners []Agent
	for _, dir := range informative {
		for _, agent := range matchAgents(dir, agents, isInformativeProjectDir) {
			if !seen[agent.PaneID] {
				seen[agent.PaneID] = true
				winners = append(winners, agent)
			}
		}
	}
	where := strings.Join(informative, ", ")
	switch {
	case len(winners) == 1:
		*trace = append(*trace, fmt.Sprintf("port %s -> %s -> %s", port, where, winners[0].PaneID))
		return Resolution{Kind: "resolved", Agent: &winners[0], Via: "port"}, true
	case len(winners) > 1:
		*trace = append(*trace, fmt.Sprintf("port %s -> %s -> %d agents match equally", port, where, len(winners)))
		return Resolution{Kind: "ambiguous", Candidates: winners}, true
	}
	*trace = append(*trace, fmt.Sprintf("port %s -> %s -> no agent there", port, where))
	return Resolution{}, false
}

// followUpTarget picks where a reply inside a thread goes: the pane holding
// the conversation, for as long as it exists — even when routing would pick
// someone else today, since the context is in that pane. Only a closed pane
// re-routes, through the normal cascade, so ambiguity is still reported
// rather than guessed.
func followUpTarget(pane string, live []Agent, reroute func() Resolution) (Resolution, bool) {
	for i := range live {
		if pane != "" && live[i].PaneID == pane {
			return Resolution{Kind: "resolved", Agent: &live[i], Via: "thread",
				Trace: []string{fmt.Sprintf("thread: pane %s", pane)}}, false
		}
	}
	res := reroute()
	res.Trace = append([]string{fmt.Sprintf("thread: pane %s is gone, routing afresh", pane)}, res.Trace...)
	return res, true
}
