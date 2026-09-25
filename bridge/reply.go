package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxReplyBytes = 64 << 10

// replyCmd is `pointr reply [--port N] <thread-id>`: the agent answering a
// browser comment. The text comes on stdin — the prompt hands the agent a
// heredoc — or as the remaining arguments.
//
// It only ever talks HTTP to the bridge. An agent pane has none of herdr's
// plugin variables, so it would compute a different state dir and config
// than the bridge's; the port arrives in the command the prompt spells out.
func replyCmd(defaultPort int, args []string) int {
	port := defaultPort
	var rest []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--port" && i+1 < len(args) {
			p, err := strconv.Atoi(args[i+1])
			if err != nil {
				fmt.Fprintln(os.Stderr, "--port takes a number")
				return 2
			}
			port = p
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "usage: pointr reply [--port N] <thread-id> <<'POINTR'\n<your reply>\nPOINTR")
		return 2
	}
	id := rest[0]
	text := strings.Join(rest[1:], " ")
	if text == "" {
		// Waiting on a terminal would hang an agent's tool call forever.
		if info, err := os.Stdin.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprintf(os.Stderr, "pass the reply on stdin: pointr reply %s <<'POINTR' … POINTR\n", id)
			return 2
		}
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxReplyBytes))
		if err != nil {
			fmt.Fprintln(os.Stderr, "could not read the reply: "+err.Error())
			return 1
		}
		text = string(raw)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		fmt.Fprintln(os.Stderr, "The reply is empty; nothing was posted.")
		return 1
	}

	body, _ := json.Marshal(map[string]string{"id": id, "text": text, "pane": os.Getenv("HERDR_PANE_ID")})
	client := http.Client{Timeout: 5 * time.Second}
	res, err := client.Post(fmt.Sprintf("http://127.0.0.1:%d/threads/reply", port), "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "No pointr bridge answering on :%d — the reply was not delivered.\n", port)
		return 1
	}
	defer res.Body.Close()
	var answer struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Error  string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&answer)
	if !answer.OK {
		if answer.Reason == "unknown_thread" {
			fmt.Fprintf(os.Stderr, "No thread %s on the bridge at :%d — check the id in the prompt.\n", id, port)
			return 1
		}
		message := answer.Error
		if message == "" {
			message = res.Status
		}
		fmt.Fprintln(os.Stderr, "The bridge refused the reply: "+message)
		return 1
	}
	fmt.Printf("Posted to thread %s.\n", id)
	return 0
}

var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

// shellWord quotes s for a POSIX shell only when it has to. A plain path stays
// bare so a prefix permission rule like Bash(/path/pointr reply:*) matches
// the command exactly as the prompt writes it.
func shellWord(s string) string {
	if s != "" && shellSafe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// replyCommand is the command an agent runs to answer thread id, spelled out
// in full: the binary is not on the agent's PATH, and the port has to be the
// one this bridge listens on, not whatever the agent's own config says.
func replyCommand(exe string, port int, id string) string {
	return fmt.Sprintf("%s reply --port %d %s", shellWord(exe), port, id)
}
