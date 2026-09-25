package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Thread endpoints carry short text, never screenshots.
const maxThreadBodyBytes = 256_000

// ThreadView is a thread as the widget sees it: the derived states spelled
// out, so the client never re-derives them and cannot disagree with the
// setup page's unread count.
type ThreadView struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Port      string    `json:"port"`
	Path      string    `json:"path"`
	Anchors   []Anchor  `json:"anchors"`
	Pane      string    `json:"pane"`
	AgentKind string    `json:"agentKind"`
	Messages  []Message `json:"messages"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
	Resolved  bool      `json:"resolved"`
	Unread    bool      `json:"unread"`
	Waiting   bool      `json:"waiting"`
}

func view(t Thread) ThreadView {
	anchors := t.Anchors
	if anchors == nil {
		anchors = []Anchor{}
	}
	// A held message's prompt stays in the bridge: it is the full capture.
	messages := make([]Message, 0, len(t.Messages))
	for _, m := range t.Messages {
		m.Prompt = ""
		messages = append(messages, m)
	}
	return ThreadView{
		ID: t.ID, URL: t.URL, Port: t.Port, Path: t.Path, Anchors: anchors, Pane: t.Pane,
		AgentKind: t.AgentKind, Messages: messages, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
		Resolved: t.ResolvedAt != 0, Unread: t.unread(), Waiting: t.waiting(),
	}
}

// decodeBody reads a bounded JSON body into v, answering the error itself.
func decodeBody(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			sendJSON(w, 413, map[string]any{"ok": false, "reason": "payload_too_large", "error": "request too large"})
			return false
		}
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "could not read body"})
		return false
	}
	if json.Unmarshal(raw, v) != nil {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "invalid JSON"})
		return false
	}
	return true
}

func unknownThread(w http.ResponseWriter, id string) {
	sendJSON(w, 404, map[string]any{"ok": false, "reason": "unknown_thread",
		"error": fmt.Sprintf("No thread %s on this bridge.", id)})
}

// handleThreads answers GET /threads?url=…&since=… with the page's project:
// its open threads, and the live state of the agents a thread waits on.
// since is the rev the widget already holds; when nothing changed the
// threads are left out and only the live state goes back, which is what
// keeps polling while a reply is pending cheap.
func (s *Server) handleThreads(w http.ResponseWriter, r *http.Request) {
	pageURL := r.URL.Query().Get("url")
	if pageURL == "" {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "missing url"})
		return
	}
	key := s.projectKey(pageURL)
	rev, open, resolved := s.threads.list(key)

	resp := map[string]any{
		"ok": true, "key": key, "project": project(key), "rev": rev,
		"port": portOf(upstreamURL(pageURL, s.proxies.aliases())),
	}
	waitingOn := map[string]bool{}
	for i := range open {
		if open[i].waiting() && open[i].Pane != "" {
			waitingOn[open[i].Pane] = true
		}
	}
	agents := map[string]any{}
	resp["herdr"] = true
	if len(waitingOn) > 0 {
		live, err := s.agents(false)
		resp["herdr"] = err == nil
		for _, agent := range live {
			if waitingOn[agent.PaneID] {
				agents[agent.PaneID] = map[string]any{"kind": agent.Kind, "status": agent.Status, "title": agent.Title}
			}
		}
	}
	resp["agents"] = agents

	if since := r.URL.Query().Get("since"); since != "" && since == strconv.FormatInt(rev, 10) {
		resp["unchanged"] = true
		sendJSON(w, 200, resp)
		return
	}
	views := make([]ThreadView, 0, len(open))
	for _, t := range open {
		views = append(views, view(t))
	}
	resp["unchanged"] = false
	resp["threads"] = views
	resp["resolvedCount"] = resolved
	sendJSON(w, 200, resp)
}

// handleThreadReply takes an agent's answer from `pointr reply`. The pane is
// whatever $HERDR_PANE_ID the agent had; when it names a live agent the
// thread follows it, so the next follow-up goes where the conversation is.
func (s *Server) handleThreadReply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   string `json:"id"`
		Text string `json:"text"`
		Pane string `json:"pane"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if body.ID == "" || text == "" {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "id and text are required"})
		return
	}
	current, _, err := s.threads.find(body.ID)
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	kind, livePane := current.AgentKind, false
	if body.Pane != "" {
		live, _ := s.agents(false)
		for _, agent := range live {
			if agent.PaneID == body.Pane {
				kind, livePane = agent.Kind, true
				break
			}
		}
	}
	t, err := s.threads.appendMessage(body.ID, Message{From: "agent", Text: text, Pane: body.Pane, Kind: kind}, func(t *Thread) {
		if livePane {
			t.Pane, t.AgentKind = body.Pane, kind
		}
	})
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	sendJSON(w, 200, map[string]any{"ok": true, "id": t.ID, "resolved": t.ResolvedAt != 0})
}

// handleThreadMessage sends a reply the user wrote inside a thread. It goes
// to the pane holding the conversation while that pane lives, and routes
// afresh — honouring the tab's own destination — only once it is gone.
func (s *Server) handleThreadMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID          string    `json:"id"`
		Text        string    `json:"text"`
		URL         string    `json:"url"`
		TargetAgent *AgentPin `json:"targetAgent"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	if body.ID == "" || text == "" {
		sendJSON(w, 400, map[string]any{"ok": false, "reason": "invalid_request", "error": "id and text are required"})
		return
	}
	current, _, err := s.threads.find(body.ID)
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	pageURL := body.URL
	if pageURL == "" {
		pageURL = current.URL
	}
	var override *AgentPin
	if body.TargetAgent != nil && body.TargetAgent.PaneID != "" {
		override = body.TargetAgent
	}
	live, _ := s.agents(false)
	res, rerouted := followUpTarget(current.Pane, live, func() Resolution {
		return resolveTarget(s.routingInput(live, pageURL, override))
	})
	if res.Kind != "resolved" {
		sendNoTarget(w, res, live)
		return
	}
	agent := res.Agent
	hold := busy(agent.Status)
	message := Message{ID: randomID("m_", 4), From: "user", Text: text, BusyAtSend: agent.Status == "working", Held: hold}
	t, err := s.threads.appendMessage(body.ID, message, func(t *Thread) {
		t.Pane, t.AgentKind = agent.PaneID, agent.Kind
		t.ResolvedAt = 0
		t.ReadAt = nowMs()
	})
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	if hold {
		// Delivered once the agent is free; until then it can be taken back.
		sendJSON(w, 200, map[string]any{"ok": true, "thread": view(t), "rerouted": rerouted, "held": true, "project": project(agent.Cwd)})
		return
	}
	if _, err := promptAgent(agent.PaneID, formatFollowUp(t, []Message{message}, replyCommand(s.exe, s.cfg.Port, t.ID))); err != nil {
		if !mayHaveTyped(err) {
			s.threads.dropMessage(t.ID, message.ID)
		}
		s.sendFailure(w, err, agent.PaneID)
		return
	}
	sendJSON(w, 200, map[string]any{"ok": true, "thread": view(t), "rerouted": rerouted, "project": project(agent.Cwd)})
}

// handleThreadResolve resolves a thread, or reopens it with resolved:false.
func (s *Server) handleThreadResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID       string `json:"id"`
		Resolved *bool  `json:"resolved"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	resolved := body.Resolved == nil || *body.Resolved
	t, err := s.threads.setResolved(body.ID, resolved)
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	sendJSON(w, 200, map[string]any{"ok": true, "thread": view(t)})
}

// handleThreadRead marks a thread's replies as seen.
func (s *Server) handleThreadRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	t, err := s.threads.markRead(body.ID)
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	sendJSON(w, 200, map[string]any{"ok": true, "thread": view(t)})
}

// handleThreadCancel takes back what a thread still holds. A comment the
// agent never saw removes its thread altogether; the texts come back so the
// widget can put them in front of the user again.
func (s *Server) handleThreadCancel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	s.deliverMu.Lock()
	t, deleted, texts, err := s.threads.cancelHeld(body.ID)
	s.deliverMu.Unlock()
	switch {
	case errors.Is(err, errNotHeld):
		sendJSON(w, 409, map[string]any{"ok": false, "reason": "not_held", "error": "Already delivered — the agent has it."})
		return
	case err != nil:
		unknownThread(w, body.ID)
		return
	}
	resp := map[string]any{"ok": true, "deleted": deleted, "texts": texts}
	if !deleted {
		resp["thread"] = view(t)
	}
	sendJSON(w, 200, resp)
}

// handleThreadDeliver is "Send now": the held messages go in whatever the
// agent is doing — into its own queue if it is working. A closed pane
// routes afresh, as a follow-up would.
func (s *Server) handleThreadDeliver(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID          string    `json:"id"`
		URL         string    `json:"url"`
		TargetAgent *AgentPin `json:"targetAgent"`
	}
	if !decodeBody(w, r, maxThreadBodyBytes, &body) {
		return
	}
	current, _, err := s.threads.find(body.ID)
	if err != nil {
		unknownThread(w, body.ID)
		return
	}
	pageURL := body.URL
	if pageURL == "" {
		pageURL = current.URL
	}
	var override *AgentPin
	if body.TargetAgent != nil && body.TargetAgent.PaneID != "" {
		override = body.TargetAgent
	}
	live, _ := s.agents(true)
	res, rerouted := followUpTarget(current.Pane, live, func() Resolution {
		return resolveTarget(s.routingInput(live, pageURL, override))
	})
	if res.Kind != "resolved" {
		sendNoTarget(w, res, live)
		return
	}
	switch err := s.deliver(body.ID, res.Agent); {
	case errors.Is(err, errNotHeld):
		sendJSON(w, 409, map[string]any{"ok": false, "reason": "not_held", "error": "Already delivered — the agent has it."})
		return
	case err != nil:
		s.sendFailure(w, err, res.Agent.PaneID)
		return
	}
	t, _, _ := s.threads.find(body.ID)
	sendJSON(w, 200, map[string]any{"ok": true, "thread": view(t), "rerouted": rerouted})
}
