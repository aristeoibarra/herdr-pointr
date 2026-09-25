package main

// Comment threads. Every comment sent from the browser opens one; the agent
// answers into it with `pointr reply`, and the widget shows the conversation
// next to the element.
//
// The bridge is the only writer. Each project gets one JSON file in the state
// dir, loaded at startup and rewritten whole on every change — hundreds of
// short threads per project, so a database would buy nothing but a
// dependency. The CLI never touches these files: an agent pane does not see
// the plugin's state dir, so it talks to the bridge over HTTP instead.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	threadFileVersion    = 1
	maxMessageRunes      = 8000
	maxThreadsPerProject = 500
	resolvedRetention    = 30 * 24 * time.Hour
)

var (
	errUnknownThread = errors.New("unknown thread")
	errNotHeld       = errors.New("nothing held")
)

// Anchor is what the widget needs to find an element again on a later load.
// Trimmed on purpose: the prompt already carried the full capture, and a
// thread file holding every element's HTML would grow without bound.
type Anchor struct {
	Selector  string `json:"selector"`
	Tag       string `json:"tag"`
	ID        string `json:"id"`
	Component string `json:"component"`
	Framework string `json:"framework"`
	Source    string `json:"source"`
	Text      string `json:"text"`
	// The parent's text with this element's cut out: unchanged when the
	// element itself is edited, different when a positional selector lands
	// on a neighbour.
	Context string `json:"context"`
}

type Message struct {
	ID   string `json:"id"`
	From string `json:"from"` // user | agent
	Text string `json:"text"`
	At   int64  `json:"at"` // unix ms
	Pane string `json:"pane,omitempty"`
	// Agent kind on agent messages ("claude", "codex"…), for the label.
	Kind string `json:"kind,omitempty"`
	// User messages only: the agent was mid-turn when this was prompted, so
	// it went into the agent's own input queue.
	BusyAtSend bool `json:"busyAtSend,omitempty"`
	// Sent while the agent was busy and kept here until it is free, so it
	// can still be cancelled. Prompt is what gets typed then, for a thread's
	// first message; a held follow-up is written at delivery, when the
	// thread so far is known. Prompt never leaves the bridge.
	Held   bool   `json:"held,omitempty"`
	Prompt string `json:"prompt,omitempty"`
}

type Thread struct {
	ID string `json:"id"`
	// The page as the dev server serves it: what the agent was told.
	URL string `json:"url"`
	// Page key from the widget: upstream port plus path. Two dev servers of
	// one project (an app and its Storybook) must not share a "/".
	Port      string    `json:"port"`
	Path      string    `json:"path"`
	Anchors   []Anchor  `json:"anchors"`
	Pane      string    `json:"pane"`
	AgentKind string    `json:"agentKind"`
	Messages  []Message `json:"messages"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
	// Read state lives here, not in the tab: the setup page counts unread
	// replies across projects, and two tabs of one app have to agree.
	ReadAt     int64 `json:"readAt"`
	ResolvedAt int64 `json:"resolvedAt"` // 0 = open
	// Reserved while its first prompt is in flight: invisible to lists, but a
	// reply that beats the prompt's own return still finds it.
	pending bool
}

// waiting: open, and the last word is the user's.
func (t *Thread) waiting() bool {
	return t.ResolvedAt == 0 && len(t.Messages) > 0 && t.Messages[len(t.Messages)-1].From == "user"
}

// unread: open, with an agent message newer than the last time it was read.
func (t *Thread) unread() bool {
	if t.ResolvedAt != 0 {
		return false
	}
	for i := len(t.Messages) - 1; i >= 0; i-- {
		if t.Messages[i].From == "agent" {
			return t.Messages[i].At > t.ReadAt
		}
	}
	return false
}

func (t *Thread) clone() Thread {
	c := *t
	c.Anchors = append([]Anchor(nil), t.Anchors...)
	c.Messages = append([]Message(nil), t.Messages...)
	return c
}

type projectFile struct {
	Version int    `json:"version"`
	Project string `json:"project"`
	// Bumped on every change and persisted, so a widget's cursor survives a
	// bridge restart. "Unchanged" is since == rev, never since >= rev: a
	// deleted file restarts at zero and must still force a full refetch.
	Rev     int64     `json:"rev"`
	Threads []*Thread `json:"threads"`
}

type ThreadStore struct {
	mu       sync.Mutex
	dir      string
	projects map[string]*projectFile
	byID     map[string]string // thread id -> project key
}

func newThreadStore(dir string) *ThreadStore {
	st := &ThreadStore{dir: dir, projects: map[string]*projectFile{}, byID: map[string]string{}}
	st.load()
	return st
}

// load reads every project file. One that does not parse is set aside rather
// than crashing the bridge or being overwritten by the next change.
func (st *ThreadStore) load() {
	paths, _ := filepath.Glob(filepath.Join(st.dir, "*.json"))
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var pf projectFile
		if json.Unmarshal(raw, &pf) != nil || pf.Version != threadFileVersion || pf.Project == "" {
			aside := fmt.Sprintf("%s.corrupt-%d", path, time.Now().UnixMilli())
			_ = os.Rename(path, aside)
			fmt.Fprintf(os.Stderr, "threads: %s did not parse, moved to %s\n", path, aside)
			continue
		}
		if _, dup := st.projects[pf.Project]; dup {
			continue
		}
		kept := pf.Threads[:0]
		for _, t := range pf.Threads {
			if t != nil && t.ID != "" {
				kept = append(kept, t)
				st.byID[t.ID] = pf.Project
			}
		}
		pf.Threads = kept
		st.projects[pf.Project] = &pf
	}
}

var slugUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// fileFor names a project's file: a readable slug for whoever lists the
// directory, plus a hash of the full key so two projects called "web" in
// different places never share one.
func (st *ThreadStore) fileFor(key string) string {
	slug := key
	if strings.HasPrefix(key, "/") {
		slug = filepath.Base(key)
	}
	slug = strings.Trim(slugUnsafe.ReplaceAllString(slug, "-"), "-.")
	if len(slug) > 40 {
		slug = slug[:40]
	}
	if slug == "" {
		slug = "project"
	}
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(st.dir, slug+"-"+hex.EncodeToString(sum[:6])+".json")
}

func (st *ThreadStore) projectLocked(key string) *projectFile {
	pf, ok := st.projects[key]
	if !ok {
		pf = &projectFile{Version: threadFileVersion, Project: key}
		st.projects[key] = pf
	}
	return pf
}

func (st *ThreadStore) threadLocked(id string) (*Thread, *projectFile) {
	key, ok := st.byID[id]
	if !ok {
		return nil, nil
	}
	pf := st.projects[key]
	for _, t := range pf.Threads {
		if t.ID == id {
			return t, pf
		}
	}
	return nil, nil
}

func randomID(prefix string, bytes int) string {
	buf := make([]byte, bytes)
	_, _ = rand.Read(buf)
	return prefix + hex.EncodeToString(buf)
}

func nowMs() int64 { return time.Now().UnixMilli() }

// reserve holds a thread in memory before its first prompt goes out, so a
// reply that arrives faster than herdr's own answer still has somewhere to
// land. Nothing is written until commit.
func (st *ThreadStore) reserve(key string, t Thread) Thread {
	st.mu.Lock()
	defer st.mu.Unlock()
	for {
		t.ID = randomID("t_", 3)
		if _, taken := st.byID[t.ID]; !taken {
			break
		}
	}
	now := nowMs()
	t.CreatedAt, t.UpdatedAt, t.ReadAt, t.pending = now, now, now, true
	for i := range t.Messages {
		if t.Messages[i].ID == "" {
			t.Messages[i].ID = randomID("m_", 4)
		}
		if t.Messages[i].At == 0 {
			t.Messages[i].At = now
		}
	}
	pf := st.projectLocked(key)
	stored := t.clone()
	pf.Threads = append(pf.Threads, &stored)
	st.byID[t.ID] = key
	return stored.clone()
}

// commit makes a reserved thread visible and durable.
func (st *ThreadStore) commit(id string) (Thread, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, errUnknownThread
	}
	t.pending = false
	pf.Rev++
	st.persistLocked(pf)
	return t.clone(), nil
}

// drop rolls back a reservation whose prompt never reached the agent.
func (st *ThreadStore) drop(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil || !t.pending {
		return
	}
	st.removeLocked(pf, id)
}

func (st *ThreadStore) removeLocked(pf *projectFile, id string) {
	kept := pf.Threads[:0]
	for _, t := range pf.Threads {
		if t.ID != id {
			kept = append(kept, t)
		}
	}
	pf.Threads = kept
	delete(st.byID, id)
}

// find returns a copy of a thread and the project it belongs to.
func (st *ThreadStore) find(id string) (Thread, string, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, "", errUnknownThread
	}
	return t.clone(), pf.Project, nil
}

// appendMessage adds a message and applies mutate under the same lock, so the
// thread's own fields and its conversation never disagree on disk.
func (st *ThreadStore) appendMessage(id string, m Message, mutate func(*Thread)) (Thread, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, errUnknownThread
	}
	if m.ID == "" {
		m.ID = randomID("m_", 4)
	}
	if m.At == 0 {
		m.At = nowMs()
	}
	m.Text = clipRunes(m.Text, maxMessageRunes)
	if mutate != nil {
		mutate(t)
	}
	t.Messages = append(t.Messages, m)
	t.UpdatedAt = m.At
	pf.Rev++
	st.persistLocked(pf)
	return t.clone(), nil
}

// dropMessage rolls back a follow-up whose prompt never reached the agent.
func (st *ThreadStore) dropMessage(id, messageID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return
	}
	kept := t.Messages[:0]
	for _, m := range t.Messages {
		if m.ID != messageID {
			kept = append(kept, m)
		}
	}
	t.Messages = kept
	pf.Rev++
	st.persistLocked(pf)
}

func (st *ThreadStore) setResolved(id string, resolved bool) (Thread, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, errUnknownThread
	}
	t.ResolvedAt = 0
	if resolved {
		t.ResolvedAt = nowMs()
	}
	pf.Rev++
	st.persistLocked(pf)
	return t.clone(), nil
}

func (st *ThreadStore) markRead(id string) (Thread, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, errUnknownThread
	}
	t.ReadAt = nowMs()
	pf.Rev++
	st.persistLocked(pf)
	return t.clone(), nil
}

// list returns a project's open threads, oldest first, and how many are
// resolved. Reserved threads stay out until their prompt has gone through.
func (st *ThreadStore) list(key string) (rev int64, open []Thread, resolved int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	pf, ok := st.projects[key]
	if !ok {
		return 0, []Thread{}, 0
	}
	open = []Thread{}
	for _, t := range pf.Threads {
		switch {
		case t.pending:
		case t.ResolvedAt != 0:
			resolved++
		default:
			open = append(open, t.clone())
		}
	}
	sort.SliceStable(open, func(i, j int) bool { return open[i].CreatedAt < open[j].CreatedAt })
	return pf.Rev, open, resolved
}

func (st *ThreadStore) rev(key string) int64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	if pf, ok := st.projects[key]; ok {
		return pf.Rev
	}
	return 0
}

// unread counts a project's threads with a reply the user has not opened.
func (st *ThreadStore) unread(key string) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	count := 0
	if pf, ok := st.projects[key]; ok {
		for _, t := range pf.Threads {
			if !t.pending && t.unread() {
				count++
			}
		}
	}
	return count
}

// persistLocked prunes and writes one project's file. A failed write is
// logged and otherwise ignored: memory is still right, and the next change
// writes the whole file again.
func (st *ThreadStore) persistLocked(pf *projectFile) {
	st.pruneLocked(pf)
	out := projectFile{Version: threadFileVersion, Project: pf.Project, Rev: pf.Rev, Threads: []*Thread{}}
	for _, t := range pf.Threads {
		if !t.pending {
			out.Threads = append(out.Threads, t)
		}
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err == nil {
		// 0600: comments can quote private code and data.
		err = writeFileAtomic(st.fileFor(pf.Project), raw, 0o600)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "threads: could not save %s: %v\n", pf.Project, err)
	}
}

// pruneLocked drops resolved threads past retention, then the oldest resolved
// ones, then the oldest of all, until the project is under its cap.
func (st *ThreadStore) pruneLocked(pf *projectFile) {
	cutoff := time.Now().Add(-resolvedRetention).UnixMilli()
	kept := pf.Threads[:0]
	for _, t := range pf.Threads {
		if t.ResolvedAt != 0 && t.ResolvedAt < cutoff {
			delete(st.byID, t.ID)
			continue
		}
		kept = append(kept, t)
	}
	pf.Threads = kept
	if len(pf.Threads) <= maxThreadsPerProject {
		return
	}
	sort.SliceStable(pf.Threads, func(i, j int) bool {
		a, b := pf.Threads[i], pf.Threads[j]
		if (a.ResolvedAt != 0) != (b.ResolvedAt != 0) {
			return a.ResolvedAt != 0
		}
		return a.UpdatedAt < b.UpdatedAt
	})
	excess := len(pf.Threads) - maxThreadsPerProject
	for _, t := range pf.Threads[:excess] {
		delete(st.byID, t.ID)
	}
	pf.Threads = pf.Threads[excess:]
	sort.SliceStable(pf.Threads, func(i, j int) bool { return pf.Threads[i].CreatedAt < pf.Threads[j].CreatedAt })
}

// holdFirst marks a reserved thread's first message as held, with the
// prompt to type once its agent is free.
func (st *ThreadStore) holdFirst(id, prompt string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if t, _ := st.threadLocked(id); t != nil && len(t.Messages) > 0 {
		t.Messages[0].Held, t.Messages[0].Prompt = true, prompt
	}
}

// heldRef is a thread with messages waiting for its agent to be free.
type heldRef struct {
	ID   string
	Pane string
	At   int64
}

// held lists the threads with held messages, the longest-waiting first.
func (st *ThreadStore) held() []heldRef {
	st.mu.Lock()
	defer st.mu.Unlock()
	var refs []heldRef
	for _, pf := range st.projects {
		for _, t := range pf.Threads {
			if t.pending || t.ResolvedAt != 0 {
				continue
			}
			for _, m := range t.Messages {
				if m.Held {
					refs = append(refs, heldRef{ID: t.ID, Pane: t.Pane, At: m.At})
					break
				}
			}
		}
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].At < refs[j].At })
	return refs
}

// markDelivered clears the held messages that were just typed into pane.
func (st *ThreadStore) markDelivered(id string, messageIDs []string, pane, kind string) (Thread, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, pf := st.threadLocked(id)
	if t == nil {
		return Thread{}, errUnknownThread
	}
	delivered := map[string]bool{}
	for _, mid := range messageIDs {
		delivered[mid] = true
	}
	for i := range t.Messages {
		if delivered[t.Messages[i].ID] {
			t.Messages[i].Held, t.Messages[i].Prompt = false, ""
		}
	}
	t.Pane, t.AgentKind = pane, kind
	pf.Rev++
	st.persistLocked(pf)
	return t.clone(), nil
}

// cancelHeld takes back what has not reached the agent yet. A thread whose
// first message never did is removed entirely: nothing of it exists outside
// the bridge.
func (st *ThreadStore) cancelHeld(id string) (t Thread, deleted bool, texts []string, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	thread, pf := st.threadLocked(id)
	if thread == nil {
		return Thread{}, false, nil, errUnknownThread
	}
	kept := thread.Messages[:0]
	for _, m := range thread.Messages {
		if m.Held {
			texts = append(texts, m.Text)
			continue
		}
		kept = append(kept, m)
	}
	if len(texts) == 0 {
		return thread.clone(), false, nil, errNotHeld
	}
	thread.Messages = kept
	pf.Rev++
	if len(kept) == 0 {
		st.removeLocked(pf, id)
		st.persistLocked(pf)
		return Thread{ID: id}, true, texts, nil
	}
	thread.UpdatedAt = nowMs()
	st.persistLocked(pf)
	return thread.clone(), false, texts, nil
}

// clipRunes caps text without touching its whitespace — unlike truncate,
// which flattens newlines for one-line prompt fields.
func clipRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}

// anchorFrom keeps the fields that find an element again, and nothing else.
func anchorFrom(el Element) Anchor {
	return Anchor{
		Selector:  clipRunes(el.Selector, 500),
		Tag:       el.Tag,
		ID:        el.ID,
		Component: el.Component,
		Framework: el.Framework,
		Source:    el.Source,
		Text:      truncate(el.Text, 120),
		Context:   clipRunes(el.Context, 200),
	}
}
