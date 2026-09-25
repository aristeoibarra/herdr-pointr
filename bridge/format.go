package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// orderedMap keeps a JSON object's keys in the order the widget sent them. A
// Go map would shuffle props and styles on every send.
type orderedMap [][2]string

func (m *orderedMap) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*m = nil
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fmt.Errorf("expected an object")
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		var text string
		if json.Unmarshal(value, &text) != nil {
			text = string(value)
		}
		*m = append(*m, [2]string{fmt.Sprint(key), text})
	}
	return nil
}

type Element struct {
	Selector       string     `json:"selector"`
	Tag            string     `json:"tag"`
	ID             string     `json:"id"`
	Framework      string     `json:"framework"`
	Component      string     `json:"component"`
	ComponentStack []string   `json:"componentStack"`
	Props          orderedMap `json:"props"`
	Source         string     `json:"source"`
	Role           string     `json:"role"`
	AccessibleName *string    `json:"accessibleName"`
	Text           string     `json:"text"`
	Styles         orderedMap `json:"styles"`
	Box            struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
		W float64 `json:"w"`
		H float64 `json:"h"`
	} `json:"box"`
	HTML string `json:"html"`
}

type SendPayload struct {
	Message *string `json:"message"`
	URL     *string `json:"url"`
	// Page key from the widget (path, plus a hash route), the same one it
	// filters pins by. Derived from the URL when an older widget leaves it out.
	Page       string    `json:"page"`
	Elements   []Element `json:"elements"`
	Screenshot string    `json:"screenshot"`
	// Absent means true: only an explicit false pastes without submitting.
	AutoSubmit *bool `json:"autoSubmit"`
	// Per-tab override picked in the widget's settings. TargetPane is the
	// older bare-pane-id form a widget built before sessions may still send.
	TargetAgent *AgentPin `json:"targetAgent"`
	TargetPane  string    `json:"targetPane"`
	Diagnostics *struct {
		Errors  []any `json:"errors"`
		Network []any `json:"network"`
	} `json:"diagnostics"`
}

func (p SendPayload) valid() bool {
	return p.Message != nil && p.URL != nil && p.Elements != nil
}

// formatPrompt renders the agent-facing prompt: the comment, the elements it
// is about, and how to answer into its thread.
//
// Written for what the agent does next — find this in the source and edit it —
// not for describing the screen. Measured against a real send, 83% of what
// used to go out was never read: computed styles restating the class list,
// icon path data, geometry, four levels of context providers.
//
// Geometry and computed styles ride along only with a screenshot: ticking it
// is how someone says "this is a visual problem", the only kind where rendered
// values beat the class list already in the HTML.
func formatPrompt(payload SendPayload, pageURL, screenshotPath, threadID, replyCmd string) string {
	visual := screenshotPath != ""
	lines := []string{"[pointr] Browser comment · thread " + threadID, ""}

	message := strings.TrimSpace(*payload.Message)
	if message == "" {
		message = "(no message provided)"
	}
	lines = append(lines, "Comment: "+message, "Page: "+pageURL)
	if visual {
		lines = append(lines, "Screenshot: "+screenshotPath)
	}
	lines = append(lines, "")

	for i, el := range payload.Elements {
		heading := "<" + el.Component + ">"
		if el.Component == "" {
			heading = el.Tag
			if el.ID != "" {
				heading += "#" + el.ID
			}
		}
		if el.Framework != "" {
			heading += " (" + el.Framework + ")"
		}
		lines = append(lines, fmt.Sprintf("Element %d: %s", i+1, heading))
		// First, because it ends the search: with the data-source Babel plugin
		// on, this is the file and line and nothing else has to be grepped.
		if el.Source != "" {
			lines = append(lines, "- Source: "+el.Source)
		}
		if len(el.ComponentStack) > 0 {
			lines = append(lines, "- Component path: "+strings.Join(el.ComponentStack, " › "))
		}
		lines = append(lines, "- Selector: "+el.Selector)
		if len(el.Props) > 0 {
			props := make([]string, len(el.Props))
			for j, kv := range el.Props {
				props[j] = kv[0] + "=" + kv[1]
			}
			lines = append(lines, "- Props: "+truncate(strings.Join(props, ", "), 500))
		}
		// Only when it says something the text doesn't already say.
		name := ""
		if el.AccessibleName != nil && *el.AccessibleName != strings.TrimSpace(el.Text) {
			name = *el.AccessibleName
		}
		if el.Role != "" || name != "" {
			parts := []string{}
			for _, part := range []string{el.Role, name} {
				if part != "" {
					parts = append(parts, part)
				}
			}
			lines = append(lines, "- Role/name: "+strings.Join(parts, " / "))
		}
		if visual {
			lines = append(lines, fmt.Sprintf("- Box: %s×%s at (%s, %s)", num(el.Box.W), num(el.Box.H), num(el.Box.X), num(el.Box.Y)))
			styles := make([]string, len(el.Styles))
			for j, kv := range el.Styles {
				styles[j] = kv[0] + ": " + kv[1]
			}
			if len(styles) > 0 {
				lines = append(lines, "- Key styles: "+strings.Join(styles, "; "))
			}
		}
		if el.Text != "" {
			lines = append(lines, `- Text: "`+truncate(el.Text, 200)+`"`)
		}
		lines = append(lines, "- HTML:", "```html", truncate(el.HTML, 1000), "```", "")
	}

	if payload.Diagnostics != nil {
		lines = appendList(lines, "Recent console errors (oldest first):", payload.Diagnostics.Errors)
		lines = appendList(lines, "Recent failed requests (oldest first):", payload.Diagnostics.Network)
	}
	lines = append(strings.Split(strings.TrimRight(strings.Join(lines, "\n"), " \t\r\n"), "\n"), replyInstructions(replyCmd)...)
	return strings.Join(lines, "\n")
}

// replyInstructions end every prompt. The answer goes back to where the user
// asked, next to the element, and stays short because it reads as a comment.
// The heredoc delimiter is POINTR, not EOF: a reply quoting a line that says
// EOF would otherwise be cut there.
func replyInstructions(cmd string) []string {
	return []string{
		"",
		"When you are done, answer in the browser thread — the user reads it next to the element, not in this terminal:",
		cmd + " <<'POINTR'",
		"<2–4 sentences, the answer first>",
		"POINTR",
		"- Asked for a change: make it, then reply with what you changed.",
		"- Asked a question or for your opinion: reply without editing any files.",
		"- Several pointr comments at once: reply to each thread id separately.",
	}
}

// pagePath is the page key within a dev server when the widget did not send
// one: the path, plus the route when the app routes on the fragment, so a
// hash-router app does not pile every thread onto "/".
func pagePath(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "/"
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	if f := u.Fragment; strings.HasPrefix(f, "/") || strings.HasPrefix(f, "!/") {
		if i := strings.Index(f, "?"); i >= 0 {
			f = f[:i]
		}
		path += "#" + f
	}
	return path
}

// newThreadFromSend opens a thread for a comment about to be sent to agent.
func newThreadFromSend(payload SendPayload, upstream string, agent *Agent) Thread {
	anchors := make([]Anchor, 0, len(payload.Elements))
	for _, el := range payload.Elements {
		anchors = append(anchors, anchorFrom(el))
	}
	page := payload.Page
	if page == "" {
		page = pagePath(upstream)
	}
	text := strings.TrimSpace(*payload.Message)
	if text == "" {
		text = "(no message provided)"
	}
	return Thread{
		URL: upstream, Port: portOf(upstream), Path: page, Anchors: anchors,
		Pane: agent.PaneID, AgentKind: agent.Kind,
		Messages: []Message{{From: "user", Text: clipRunes(text, maxMessageRunes),
			// Read before the prompt: "working" means it lands in the agent's queue.
			BusyAtSend: agent.Status == "working"}},
	}
}

// The payload crosses the network — only strings are trusted as entries.
func appendList(lines []string, heading string, entries []any) []string {
	var kept []string
	for _, entry := range entries {
		if s, ok := entry.(string); ok {
			kept = append(kept, "- "+truncate(s, 300))
		}
	}
	if len(kept) == 0 {
		return lines
	}
	lines = append(lines, heading)
	lines = append(lines, kept...)
	return append(lines, "")
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

func truncate(value string, max int) string {
	normalized := strings.Join(strings.Fields(value), " ")
	runes := []rune(normalized)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return normalized
}
