package main

// A reply lands by thread id. If the id stops resolving — after a restart, or
// under the wrong project — nothing fails where anyone looks: the agent's
// answer just never shows up next to the element.

import "testing"

func TestThreadStoreReload(t *testing.T) {
	dir := t.TempDir()
	st := newThreadStore(dir)
	reserved := st.reserve("/home/u/dev/shop", Thread{
		URL: "http://localhost:3000/cart", Port: "3000", Path: "/cart", Pane: "w1:p1",
		Messages: []Message{{From: "user", Text: "Is this the right total?"}},
	})
	if _, err := st.commit(reserved.ID); err != nil {
		t.Fatal(err)
	}
	rev := st.rev("/home/u/dev/shop")

	t.Run("a reply after a bridge restart still finds its thread", func(t *testing.T) {
		again := newThreadStore(dir)
		if _, key, err := again.find(reserved.ID); err != nil || key != "/home/u/dev/shop" {
			t.Fatalf("find after reload: key %q, err %v", key, err)
		}
		if _, err := again.appendMessage(reserved.ID, Message{From: "agent", Text: "Yes."}, nil); err != nil {
			t.Fatal(err)
		}
		if again.rev("/home/u/dev/shop") <= rev {
			t.Fatal("rev went backwards across a restart")
		}
	})
	t.Run("a reservation that never committed is gone after a restart", func(t *testing.T) {
		held := st.reserve("/home/u/dev/shop", Thread{Messages: []Message{{From: "user", Text: "x"}}})
		st.appendMessage(reserved.ID, Message{From: "agent", Text: "persist something"}, nil)
		if _, _, err := newThreadStore(dir).find(held.ID); err == nil {
			t.Fatal("an uncommitted thread was written to disk")
		}
	})
}

// The command every prompt hands the agent. Wrong here means replies that
// silently never arrive: a default port instead of the one this bridge
// listens on, or a quoting that splits the path.
func TestReplyCommand(t *testing.T) {
	t.Run("names the port this bridge listens on, not the default", func(t *testing.T) {
		got := replyCommand("/opt/pointr/dist/pointr", 7444, "t_ab12cd")
		if got != "/opt/pointr/dist/pointr reply --port 7444 t_ab12cd" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("quotes a path the shell would split", func(t *testing.T) {
		got := replyCommand("/home/a b/it's/pointr", 7331, "t_x")
		if got != `'/home/a b/it'\''s/pointr' reply --port 7331 t_x` {
			t.Fatalf("got %q", got)
		}
	})
}
