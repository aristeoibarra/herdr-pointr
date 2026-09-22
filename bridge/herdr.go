package main

// herdr socket client.
//
// Transport facts, all verified against herdr 0.9.1 (protocol 22) rather than
// assumed. Each one shapes this file, so don't "simplify" them away:
//
//   - One request, one connection. The server closes the socket after a single
//     response, so there is no multiplexing by request id: a second write on
//     the same socket gets EPIPE. A pooled socket would never see a reply.
//   - events.subscribe is the one exception. Its connection stays open past the
//     subscription_started ack and then streams event lines forever.
//   - Emitted event names use two conventions, matching two enums in the
//     schema. The three subscription-scoped events come back dotted, exactly
//     as subscribed (pane.agent_status_changed); every lifecycle event comes
//     back underscored (pane.updated yields "pane_updated"). Match on one
//     convention only and half the stream vanishes.
//   - Agent status is per-pane. pane.agent_status_changed requires a pane_id;
//     there is no global agent-status stream to listen to.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Every status herdr can report. idle and done both mean "ready for input".
var agentStatuses = map[string]bool{"idle": true, "working": true, "blocked": true, "done": true, "unknown": true}

type Agent struct {
	// Stable handle, e.g. "w37:p1". Never reused once the pane closes.
	PaneID      string
	WorkspaceID string
	TabID       string
	// Agent kind: "claude", "codex", "opencode"… herdr detects 24 of them.
	Kind   string
	Status string
	// Pane cwd — what routing matches a project against.
	Cwd string
	// Title with the spinner glyph stripped; the agent's current task.
	Title string
	// The agent's own session id. Tells "same pane, different session" from
	// "same session", which a pane id cannot. Empty when unknown.
	SessionID string
	Focused   bool
}

// HerdrError is a typed failure from herdr. Code is herdr's own code —
// agent_blocked, agent_not_found, invalid_request — plus three minted here:
// unavailable (no server listening), timeout and protocol.
type HerdrError struct {
	Code    string
	Message string
}

func (e *HerdrError) Error() string { return e.Message }

const (
	defaultTimeout = 5 * time.Second
	// A prompt blocks until herdr has written it and pressed Enter.
	promptTimeout = 30 * time.Second
	// Guards against a malformed stream eating memory while we look for a newline.
	maxLineBytes = 8_000_000
)

var (
	socketMu         sync.RWMutex
	configuredSocket string
	requestSeq       atomic.Int64
)

// setSocketPath pins the socket ahead of the environment. A detached daemon is
// started with a fresh environment, so a named session's socket path has to
// be configured rather than inherited.
func setSocketPath(path string) {
	socketMu.Lock()
	configuredSocket = path
	socketMu.Unlock()
}

// Resolution order per herdr's docs: explicit config, then env, then the
// default session. Named sessions live under sessions/<name>/herdr.sock, which
// is why the env var has to win over the default.
func socketPath() string {
	socketMu.RLock()
	defer socketMu.RUnlock()
	if configuredSocket != "" {
		return configuredSocket
	}
	if env := os.Getenv("HERDR_SOCKET_PATH"); env != "" {
		return env
	}
	return filepath.Join(homeDir(), ".config", "herdr", "herdr.sock")
}

func nextID() string { return fmt.Sprintf("bridge-%d", requestSeq.Add(1)) }

func writeLine(conn net.Conn, method string, params map[string]any) error {
	line, err := json.Marshal(map[string]any{"id": nextID(), "method": method, "params": params})
	if err != nil {
		return err
	}
	_, err = conn.Write(append(line, '\n'))
	return err
}

func newReader(conn net.Conn) *bufio.Reader { return bufio.NewReaderSize(conn, 64*1024) }

// readLine reads one newline-terminated line, bounded by maxLineBytes.
func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxLineBytes {
			return nil, &HerdrError{"protocol", fmt.Sprintf("herdr sent over %d bytes with no newline", maxLineBytes)}
		}
		if !isPrefix {
			return line, nil
		}
	}
}

// request sends one request and reads its single reply, on a fresh socket.
func request(method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	conn, err := net.DialTimeout("unix", socketPath(), timeout)
	if err != nil {
		// No herdr running is answered differently from "herdr said no".
		return nil, &HerdrError{"unavailable", fmt.Sprintf("herdr socket at %s: %v", socketPath(), err)}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	if err := writeLine(conn, method, params); err != nil {
		return nil, &HerdrError{"unavailable", fmt.Sprintf("herdr socket at %s: %v", socketPath(), err)}
	}
	line, err := readLine(newReader(conn))
	if err != nil {
		if herr, ok := err.(*HerdrError); ok {
			return nil, herr
		}
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			return nil, &HerdrError{"timeout", fmt.Sprintf("herdr did not answer %s in %v", method, timeout)}
		}
		return nil, &HerdrError{"unavailable", fmt.Sprintf("herdr closed the connection before answering %s", method)}
	}
	return unwrap(method, line)
}

// unwrap pulls result out of a reply line, turning an error envelope into an error.
func unwrap(method string, line []byte) (map[string]any, error) {
	var parsed map[string]any
	if err := json.Unmarshal(line, &parsed); err != nil {
		return nil, &HerdrError{"protocol", fmt.Sprintf("herdr sent a non-JSON reply to %s", method)}
	}
	if body, ok := parsed["error"].(map[string]any); ok {
		code, _ := body["code"].(string)
		if code == "" {
			code = "unknown"
		}
		message, _ := body["message"].(string)
		if message == "" {
			message = fmt.Sprintf("herdr refused %s", method)
		}
		return nil, &HerdrError{code, message}
	}
	result, ok := parsed["result"].(map[string]any)
	if !ok {
		return nil, &HerdrError{"protocol", fmt.Sprintf("herdr reply to %s had no result", method)}
	}
	return result, nil
}

func str(source map[string]any, key string) string {
	value, _ := source[key].(string)
	return value
}

func status(value any) string {
	if s, ok := value.(string); ok && agentStatuses[s] {
		return s
	}
	return ""
}

func toAgent(value any) *Agent {
	source, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	paneID, kind := str(source, "pane_id"), str(source, "agent")
	if paneID == "" || kind == "" {
		return nil
	}
	agent := &Agent{
		PaneID:      paneID,
		WorkspaceID: str(source, "workspace_id"),
		TabID:       str(source, "tab_id"),
		Kind:        kind,
		Status:      status(source["agent_status"]),
		// foreground_cwd tracks `cd` inside the pane; cwd is where it started.
		// The latter is the stabler answer for "which project is this".
		Cwd:     str(source, "cwd"),
		Title:   str(source, "terminal_title_stripped"),
		Focused: source["focused"] == true,
	}
	if agent.Status == "" {
		agent.Status = "unknown"
	}
	if session, ok := source["agent_session"].(map[string]any); ok {
		agent.SessionID = str(session, "value")
	}
	return agent
}

// listAgents returns every agent herdr currently recognises, across workspaces.
func listAgents() ([]Agent, error) {
	result, err := request("agent.list", map[string]any{}, defaultTimeout)
	if err != nil {
		return nil, err
	}
	entries, _ := result["agents"].([]any)
	agents := make([]Agent, 0, len(entries))
	for _, entry := range entries {
		if agent := toAgent(entry); agent != nil {
			agents = append(agents, *agent)
		}
	}
	return agents, nil
}

// getAgent returns one agent by pane id, or nil when that pane is gone or
// holds no agent. herdr namespaces its miss codes per subject —
// agent_not_found, pane_not_found — so a bare "not_found" never matches.
func getAgent(paneID string) (*Agent, error) {
	result, err := request("agent.get", map[string]any{"target": paneID}, defaultTimeout)
	if err != nil {
		if herr, ok := err.(*HerdrError); ok && strings.HasSuffix(herr.Code, "not_found") {
			return nil, nil
		}
		return nil, err
	}
	return toAgent(result["agent"]), nil
}

// promptAgent submits a prompt and presses Enter, as one ordered submission.
// herdr refuses with agent_blocked before writing anything when the agent sits
// at an approval dialog, so a blocked agent never gets our prompt typed into
// its confirmation box. No `wait`: the event stream replaces holding the HTTP
// request open, and herdr still hands back the post-prompt snapshot.
func promptAgent(paneID, text string) (*Agent, error) {
	result, err := request("agent.prompt", map[string]any{"target": paneID, "text": text}, promptTimeout)
	if err != nil {
		return nil, err
	}
	return toAgent(result["agent"]), nil
}

// pasteText puts text into a pane as a bracketed paste, with no Enter — the
// "let me review it first" path. The markers are not optional: pane.send_text
// is raw, so an unwrapped multi-line prompt is submitted line by line.
// agent.prompt does its own handling and needs none of this.
func pasteText(paneID, text string) error {
	_, err := request("pane.send_text", map[string]any{"pane_id": paneID, "text": "\x1b[200~" + text + "\x1b[201~"}, defaultTimeout)
	return err
}

// notify shows a herdr toast. Best-effort: it must never fail a send.
func notify(title, body string) {
	params := map[string]any{"title": title}
	if body != "" {
		params["body"] = body
	}
	_, _ = request("notification.show", params, defaultTimeout)
}

// reportTokens sets display-only sidebar tokens on a pane. ttl lets the badge
// expire on its own, so a crashed bridge leaves no stale marker. Best-effort.
func reportTokens(paneID, source string, tokens map[string]any, ttl time.Duration) {
	params := map[string]any{"pane_id": paneID, "source": source, "tokens": tokens}
	if ttl > 0 {
		params["ttl_ms"] = ttl.Milliseconds()
	}
	_, _ = request("pane.report_metadata", params, defaultTimeout)
}

// isAvailable reports whether a herdr server is answering on the socket.
func isAvailable() bool {
	_, err := request("ping", map[string]any{}, 1500*time.Millisecond)
	return err == nil
}

// Event is a normalized pushed event. Callers match on Kind and never see
// herdr's two naming conventions. "closed" and a Status of "done" differ on
// purpose: the terminal is gone versus the agent finished a turn.
type Event struct {
	Kind   string // status | title | closed | detected
	PaneID string
	Status string // may be empty on a title event
	Title  string
}

// toEvent normalizes one pushed line. Scoped events carry their fields flat;
// lifecycle events nest a full pane object, which is where titles come from.
func toEvent(value map[string]any) *Event {
	name := str(value, "event")
	if name == "" {
		return nil
	}
	payload, _ := value["data"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	nested, _ := payload["pane"].(map[string]any)
	paneID := str(payload, "pane_id")
	if paneID == "" && nested != nil {
		paneID = str(nested, "pane_id")
	}
	if paneID == "" {
		return nil
	}

	switch name {
	case "pane.agent_status_changed": // dotted: subscription-scoped
		if s := status(payload["agent_status"]); s != "" {
			return &Event{Kind: "status", PaneID: paneID, Status: s}
		}
	case "pane_closed", "pane_exited": // underscored: lifecycle
		return &Event{Kind: "closed", PaneID: paneID}
	case "pane_agent_detected":
		return &Event{Kind: "detected", PaneID: paneID}
	case "pane_updated":
		source := nested
		if source == nil {
			source = payload
		}
		title, ok := source["terminal_title_stripped"].(string)
		if !ok {
			return nil
		}
		return &Event{Kind: "title", PaneID: paneID, Title: title, Status: status(source["agent_status"])}
	}
	return nil
}

// Subscription is a live events.subscribe stream.
type Subscription struct {
	conn   net.Conn
	closed atomic.Bool
}

func (s *Subscription) Close() {
	if s.closed.CompareAndSwap(false, true) && s.conn != nil {
		s.conn.Close()
	}
}

// subscribe opens a long-lived subscription. onEvent fires per pushed event;
// onClose fires once when the stream ends on its own (not after Close), with
// the reason or nil. Specs use the dotted types; events arrive normalized.
func subscribe(specs []map[string]any, onEvent func(Event), onClose func(error)) *Subscription {
	sub := &Subscription{}
	conn, err := net.DialTimeout("unix", socketPath(), defaultTimeout)
	if err != nil {
		go onClose(&HerdrError{"unavailable", fmt.Sprintf("herdr event stream: %v", err)})
		return sub
	}
	sub.conn = conn
	if err := writeLine(conn, "events.subscribe", map[string]any{"subscriptions": specs}); err != nil {
		conn.Close()
		go onClose(&HerdrError{"unavailable", fmt.Sprintf("herdr event stream: %v", err)})
		return sub
	}

	go func() {
		reader := newReader(conn)
		var reason error
		for {
			line, err := readLine(reader)
			if err != nil {
				if herr, ok := err.(*HerdrError); ok {
					reason = herr
				}
				break
			}
			if strings.TrimSpace(string(line)) == "" {
				continue
			}
			var parsed map[string]any
			if json.Unmarshal(line, &parsed) != nil {
				continue // one bad line must not kill a live stream
			}
			// Discriminate on shape, not id: pushed events carry event+data and
			// no id, while a refused subscribe comes back with an empty id.
			if _, isEvent := parsed["event"]; !isEvent {
				if _, err := unwrap("events.subscribe", line); err != nil {
					// Usually a bad spec — most often a missing pane_id on
					// pane.agent_status_changed, which herdr rejects outright.
					reason = err
					break
				}
				continue
			}
			if event := toEvent(parsed); event != nil {
				onEvent(*event)
			}
		}
		conn.Close()
		if sub.closed.CompareAndSwap(false, true) {
			onClose(reason)
		}
	}()
	return sub
}
