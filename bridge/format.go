package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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
	Message    *string   `json:"message"`
	URL        *string   `json:"url"`
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

// formatPrompt renders the agent-facing prompt.
//
// Written for what the agent does next — find this in the source and edit it —
// not for describing the screen. Measured against a real send, 83% of what
// used to go out was never read: computed styles restating the class list,
// icon path data, geometry, four levels of context providers.
//
// Geometry and computed styles ride along only with a screenshot: ticking it
// is how someone says "this is a visual problem", the only kind where rendered
// values beat the class list already in the HTML.
func formatPrompt(payload SendPayload, pageURL, screenshotPath string) string {
	visual := screenshotPath != ""
	lines := []string{"[pointr] UI change request from the browser", ""}

	message := strings.TrimSpace(*payload.Message)
	if message == "" {
		message = "(no message provided)"
	}
	lines = append(lines, "Request: "+message, "Page: "+pageURL)
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
	return strings.TrimRight(strings.Join(lines, "\n"), " \t\r\n")
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
