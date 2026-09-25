package main

// Delivery of held comments. A comment sent while its agent is busy is not
// typed into the agent's terminal right away: once there it belongs to the
// agent's own input queue, and nothing can take it back. The bridge keeps it
// instead, so the user can still cancel it or send it anyway, and types it
// in once the agent is free.

import (
	"strings"
	"time"
)

const (
	// How often held comments are checked against their agents' state. The
	// check is in memory; herdr is only asked while something is held.
	deliverEvery = 2 * time.Second
	// After a delivery, how long a pane is left alone. The agent needs a
	// moment to show as working, and until it does it still reads as idle.
	deliverCooldown = 6 * time.Second
)

// busy is a state in which a prompt would not be taken up right away: typed
// into a working agent it joins its queue; a blocked one would refuse it.
func busy(status string) bool {
	return status == "working" || status == "blocked"
}

// deliveryLoop hands held comments to their agents once they are free.
func (s *Server) deliveryLoop() {
	ticker := time.NewTicker(deliverEvery)
	defer ticker.Stop()
	for range ticker.C {
		s.deliverHeld()
	}
}

func (s *Server) deliverHeld() {
	held := s.threads.held()
	if len(held) == 0 {
		return
	}
	live, err := s.agents(true)
	if err != nil {
		return
	}
	byPane := map[string]Agent{}
	for _, agent := range live {
		byPane[agent.PaneID] = agent
	}
	now := time.Now()
	served := map[string]bool{}
	for _, ref := range held {
		agent, ok := byPane[ref.Pane]
		// One per pane per pass: the next waits until the agent is free again,
		// which keeps it cancellable that much longer. A pane that is gone, or
		// in a state herdr cannot read, waits for "Send now".
		if !ok || served[ref.Pane] || (agent.Status != "idle" && agent.Status != "done") {
			continue
		}
		s.deliverMu.Lock()
		cooling := now.Before(s.cooldown[ref.Pane])
		s.deliverMu.Unlock()
		if cooling {
			continue
		}
		served[ref.Pane] = true
		_ = s.deliver(ref.ID, &agent)
	}
}

// deliver types a thread's held messages into agent: the prompt stored with
// its first message when the thread never reached an agent, otherwise a
// follow-up carrying the thread so far. Serialized, so "Send now" and the
// loop never type the same comment twice.
func (s *Server) deliver(id string, agent *Agent) error {
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	t, _, err := s.threads.find(id)
	if err != nil {
		return err
	}
	var held []Message
	for _, m := range t.Messages {
		if m.Held {
			held = append(held, m)
		}
	}
	if len(held) == 0 {
		return errNotHeld
	}
	var prompt string
	if t.Messages[0].Held && held[0].Prompt != "" {
		prompt = held[0].Prompt
		if len(held) > 1 {
			more := []string{prompt, "", "Also from the user, added before you started:"}
			for _, m := range held[1:] {
				more = append(more, "- "+m.Text)
			}
			prompt = strings.Join(more, "\n")
		}
	} else {
		prompt = formatFollowUp(t, held, replyCommand(s.exe, s.cfg.Port, t.ID))
	}
	if _, err := promptAgent(agent.PaneID, prompt); err != nil && !mayHaveTyped(err) {
		return err
	}
	ids := make([]string, 0, len(held))
	for _, m := range held {
		ids = append(ids, m.ID)
	}
	s.cooldown[agent.PaneID] = time.Now().Add(deliverCooldown)
	_, err = s.threads.markDelivered(id, ids, agent.PaneID, agent.Kind)
	return err
}
