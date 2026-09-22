package main

// Watchers turn herdr's event stream into per-browser-tab SSE.
//
//   - Status is per-pane, titles are global. pane.agent_status_changed needs a
//     pane_id and carries no title; titles only arrive on the global
//     pane.updated. So each watched pane gets its own subscription, and one
//     shared connection carries the globals for everyone.
//   - Subscriptions never replay. Whatever happens between losing a connection
//     and re-acking one is gone, so a reconnect re-seeds from agent.get and
//     tells clients their view may have skipped.
//
// Watchers are keyed by pane id alone: three tabs that resolve to the same
// agent share one watcher and one herdr socket.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	// Bounds how many herdr sockets the bridge can hold open.
	maxWatchers = 16
	// Grace before tearing a watcher down, so a tab reload doesn't thrash it.
	idleGrace = 30 * time.Second
	heartbeat = 15 * time.Second
)

// sseClient is one open EventSource. Events are queued, never written from
// another goroutine: only the request's own handler touches its writer.
type sseClient struct {
	events chan string
	ended  chan struct{}
	once   sync.Once
}

func (c *sseClient) send(event string, data map[string]any) {
	raw, _ := json.Marshal(data)
	select {
	case c.events <- fmt.Sprintf("event: %s\ndata: %s\n\n", event, raw):
	default: // a stalled tab must not block the others
	}
}

func (c *sseClient) end() { c.once.Do(func() { close(c.ended) }) }

type watcher struct {
	paneID    string
	clients   map[*sseClient]bool
	holds     int
	status    string
	title     string
	hasTitle  bool
	session   string
	sub       *Subscription
	idleTimer *time.Timer
}

var (
	watchMu          sync.Mutex
	watchers         = map[string]*watcher{}
	globals          *Subscription
	globalsIdleTimer *time.Timer
)

func (w *watcher) broadcast(event string, data map[string]any) {
	for client := range w.clients {
		client.send(event, data)
	}
}

// closeWatcher tells every client the pane is gone and tears down. Pane ids
// are never reused, so this never recovers: no grace period. Lock held.
func (w *watcher) closePane() {
	w.broadcast("closed", map[string]any{"agent": w.paneID, "reason": "pane_closed"})
	for client := range w.clients {
		client.end()
	}
	destroyLocked(w.paneID)
}

func onGlobalEvent(event Event) {
	watchMu.Lock()
	defer watchMu.Unlock()
	w := watchers[event.PaneID]
	if w == nil {
		return
	}
	switch event.Kind {
	case "closed":
		w.closePane()
	case "title":
		if w.hasTitle && event.Title == w.title {
			return
		}
		w.title, w.hasTitle = event.Title, true
		w.broadcast("title", map[string]any{"agent": w.paneID, "title": event.Title})
		// pane.updated carries status too, and it is the only status we get
		// for a pane whose own subscription dropped.
		if event.Status != "" && event.Status != w.status {
			w.status = event.Status
			w.broadcast("status", map[string]any{"agent": w.paneID, "status": event.Status})
		}
	case "detected":
		go reseed(w.paneID)
	}
}

func ensureGlobalsLocked() {
	if globalsIdleTimer != nil {
		globalsIdleTimer.Stop()
		globalsIdleTimer = nil
	}
	if globals != nil {
		return
	}
	globals = subscribe(
		[]map[string]any{{"type": "pane.updated"}, {"type": "pane.closed"}, {"type": "pane.exited"}, {"type": "pane.agent_detected"}},
		onGlobalEvent,
		func(error) {
			watchMu.Lock()
			defer watchMu.Unlock()
			globals = nil
			// Only worth reopening while something is being watched.
			if len(watchers) > 0 {
				time.AfterFunc(time.Second, func() {
					watchMu.Lock()
					defer watchMu.Unlock()
					if len(watchers) > 0 {
						ensureGlobalsLocked()
					}
				})
			}
		},
	)
}

func releaseGlobalsLocked() {
	if len(watchers) > 0 || globals == nil || globalsIdleTimer != nil {
		return
	}
	globalsIdleTimer = time.AfterFunc(idleGrace, func() {
		watchMu.Lock()
		defer watchMu.Unlock()
		globalsIdleTimer = nil
		if len(watchers) == 0 && globals != nil {
			globals.Close()
			globals = nil
		}
	})
}

// reseed re-reads the agent after a gap and tells clients their view may have
// skipped. The herdr call runs without the lock held.
func reseed(paneID string) {
	agent, _ := getAgent(paneID)
	watchMu.Lock()
	defer watchMu.Unlock()
	w := watchers[paneID]
	if w == nil {
		return
	}
	if agent == nil {
		w.closePane()
		return
	}
	replaced := w.session != "" && agent.SessionID != "" && agent.SessionID != w.session
	w.session, w.status, w.title, w.hasTitle = agent.SessionID, agent.Status, agent.Title, true
	if replaced {
		w.broadcast("replaced", map[string]any{"agent": paneID, "session": agent.SessionID})
	}
	w.broadcast("status", map[string]any{"agent": paneID, "status": agent.Status})
}

func subscribePane(paneID string) *Subscription {
	return subscribe(
		[]map[string]any{{"type": "pane.agent_status_changed", "pane_id": paneID}},
		func(event Event) {
			if event.Kind != "status" {
				return
			}
			watchMu.Lock()
			defer watchMu.Unlock()
			w := watchers[paneID]
			if w == nil || event.Status == w.status {
				return
			}
			w.status = event.Status
			w.broadcast("status", map[string]any{"agent": paneID, "status": event.Status})
		},
		func(error) {
			// The stream died (most often a herdr handoff). Reopen, then
			// re-seed: anything that happened in the gap is unrecoverable.
			time.AfterFunc(time.Second, func() {
				watchMu.Lock()
				w := watchers[paneID]
				if w == nil {
					watchMu.Unlock()
					return
				}
				w.sub = subscribePane(paneID)
				w.broadcast("resync", map[string]any{"agent": paneID})
				watchMu.Unlock()
				reseed(paneID)
			})
		},
	)
}

func evictOneLocked() bool {
	for paneID, w := range watchers {
		if len(w.clients) == 0 && w.holds == 0 {
			destroyLocked(paneID)
			return true
		}
	}
	return false
}

func ensureWatcherLocked(paneID string) *watcher {
	if w := watchers[paneID]; w != nil {
		if w.idleTimer != nil {
			w.idleTimer.Stop()
			w.idleTimer = nil
		}
		return w
	}
	if len(watchers) >= maxWatchers && !evictOneLocked() {
		return nil
	}
	w := &watcher{paneID: paneID, clients: map[*sseClient]bool{}}
	watchers[paneID] = w
	w.sub = subscribePane(paneID)
	ensureGlobalsLocked()
	return w
}

func destroyLocked(paneID string) {
	w := watchers[paneID]
	if w == nil {
		return
	}
	if w.idleTimer != nil {
		w.idleTimer.Stop()
	}
	w.sub.Close()
	delete(watchers, paneID)
	releaseGlobalsLocked()
}

func scheduleIdleLocked(w *watcher) {
	if len(w.clients)+w.holds > 0 || w.idleTimer != nil {
		return
	}
	w.idleTimer = time.AfterFunc(idleGrace, func() {
		watchMu.Lock()
		defer watchMu.Unlock()
		if watchers[w.paneID] == w && len(w.clients)+w.holds == 0 {
			destroyLocked(w.paneID)
		}
	})
}

// retain holds a watcher open for a window, with no client attached. /send
// calls it *before* prompting: subscriptions do not replay, so the
// subscription has to be acked before the agent starts working, or the first
// transition is lost. It also covers the gap until the EventSource connects.
func retain(paneID string, window time.Duration) {
	watchMu.Lock()
	defer watchMu.Unlock()
	w := ensureWatcherLocked(paneID)
	if w == nil {
		return
	}
	w.holds++
	time.AfterFunc(window, func() {
		watchMu.Lock()
		defer watchMu.Unlock()
		w.holds = max(0, w.holds-1)
		scheduleIdleLocked(w)
	})
}

// seed notes what we already know, so a late client gets it at once.
func seed(paneID, status, session string) {
	watchMu.Lock()
	defer watchMu.Unlock()
	if w := watchers[paneID]; w != nil {
		if status != "" {
			w.status = status
		}
		if session != "" {
			w.session = session
		}
	}
}

// serveStatusStream attaches one SSE client and blocks until it goes away.
func serveStatusStream(w http.ResponseWriter, r *http.Request, paneID string) {
	flusher, _ := w.(http.Flusher)
	header := w.Header()
	header.Set("content-type", "text/event-stream; charset=utf-8")
	header.Set("cache-control", "no-cache, no-transform")
	header.Set("connection", "keep-alive")
	// Tells any proxy in front not to buffer the stream into uselessness.
	header.Set("x-accel-buffering", "no")
	w.WriteHeader(http.StatusOK)
	write := func(chunk string) {
		_, _ = w.Write([]byte(chunk))
		if flusher != nil {
			flusher.Flush()
		}
	}

	client := &sseClient{events: make(chan string, 32), ended: make(chan struct{})}
	watchMu.Lock()
	watch := ensureWatcherLocked(paneID)
	if watch == nil {
		watchMu.Unlock()
		write(`event: error` + "\n" + `data: {"reason":"too_many_watchers"}` + "\n\n")
		return
	}
	watch.clients[client] = true
	known := watch.status != ""
	watchMu.Unlock()

	defer func() {
		watchMu.Lock()
		delete(watch.clients, client)
		scheduleIdleLocked(watch)
		watchMu.Unlock()
	}()

	// Slow the browser's automatic reconnect from its default down to 3s.
	write("retry: 3000\n\n")

	if !known {
		agent, _ := getAgent(paneID)
		if agent == nil {
			client.send("closed", map[string]any{"agent": paneID, "reason": "pane_closed"})
			write(<-client.events)
			return
		}
		watchMu.Lock()
		watch.status, watch.title, watch.hasTitle, watch.session = agent.Status, agent.Title, true, agent.SessionID
		watchMu.Unlock()
	}
	watchMu.Lock()
	client.send("status", map[string]any{"agent": paneID, "status": watch.status})
	if watch.hasTitle {
		client.send("title", map[string]any{"agent": paneID, "title": watch.title})
	}
	watchMu.Unlock()

	// Comment lines are ignored by EventSource and stop intermediaries — and
	// Chrome — from treating a quiet stream as dead.
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case chunk := <-client.events:
			write(chunk)
		case <-ticker.C:
			write(": ping\n\n")
		case <-client.ended:
			// Drain what was queued before the end, like a final "closed".
			for {
				select {
				case chunk := <-client.events:
					write(chunk)
				default:
					return
				}
			}
		case <-r.Context().Done():
			return
		}
	}
}

// shutdownWatchers ends every stream so the server can actually shut down.
func shutdownWatchers() {
	watchMu.Lock()
	defer watchMu.Unlock()
	for paneID, w := range watchers {
		for client := range w.clients {
			client.end()
		}
		destroyLocked(paneID)
	}
	if globals != nil {
		globals.Close()
		globals = nil
	}
}
