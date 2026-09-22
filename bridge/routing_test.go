package main

// These cover the one place in the bridge where being wrong is invisible:
// routing does not fail, it delivers somewhere else. Every case is a shape
// that actually misrouted, or the rule that stops it from happening again.

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func agent(paneID, cwd string) Agent {
	return Agent{PaneID: paneID, Kind: "claude", Status: "idle", Cwd: cwd}
}

// Every directory is a project, so tier rules can be tested on their own.
func anyDir(string) bool { return true }

func ids(agents []Agent) []string {
	out := []string{}
	for _, a := range agents {
		out = append(out, a.PaneID)
	}
	slices.Sort(out)
	return out
}

func expectIDs(t *testing.T, got []Agent, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if g := ids(got); !slices.Equal(g, want) {
		t.Fatalf("got %v, want %v", g, want)
	}
}

func TestMatchAgents(t *testing.T) {
	t.Run("prefers an exact directory over anything else", func(t *testing.T) {
		agents := []Agent{agent("w1:p1", "/repo"), agent("w2:p1", "/repo/apps/web")}
		expectIDs(t, matchAgents("/repo/apps/web", agents, anyDir), "w2:p1")
	})
	t.Run("takes the deepest ancestor", func(t *testing.T) {
		agents := []Agent{agent("w1:p1", "/a"), agent("w2:p1", "/a/b")}
		expectIDs(t, matchAgents("/a/b/c", agents, anyDir), "w2:p1")
	})
	t.Run("takes the shallowest descendant", func(t *testing.T) {
		agents := []Agent{agent("w1:p1", "/repo/apps/web/src"), agent("w2:p1", "/repo/apps")}
		expectIDs(t, matchAgents("/repo", agents, anyDir), "w2:p1")
	})
	t.Run("prefers an ancestor over a longer-named descendant", func(t *testing.T) {
		// The regression, and it only shows up across tiers: within one tier
		// "deepest" and "longest string" agree, so a length sort looks right.
		// The old rule let the descendant win and misrouted.
		agents := []Agent{agent("w1:p1", "/repo"), agent("w2:p1", "/repo/apps/web/src/components")}
		expectIDs(t, matchAgents("/repo/apps/web", agents, anyDir), "w1:p1")
	})
	t.Run("reports every tie rather than breaking it", func(t *testing.T) {
		agents := []Agent{agent("w1:p1", "/repo/a"), agent("w2:p1", "/repo/b")}
		expectIDs(t, matchAgents("/repo", agents, anyDir), "w1:p1", "w2:p1")
	})
	t.Run("refuses an ancestor whose own directory is not a project", func(t *testing.T) {
		// $HOME contains every project on the machine.
		home := []Agent{agent("w1:p1", "/home/someone")}
		isProject := func(dir string) bool { return dir != "/home/someone" }
		expectIDs(t, matchAgents("/home/someone/percep", home, anyDir), "w1:p1")
		expectIDs(t, matchAgents("/home/someone/percep", home, isProject))
	})
	t.Run("still lets a real project ancestor win", func(t *testing.T) {
		agents := []Agent{agent("w1:p1", "/home/someone"), agent("w2:p1", "/home/someone/repo")}
		isProject := func(dir string) bool { return dir != "/home/someone" }
		expectIDs(t, matchAgents("/home/someone/repo/apps/web", agents, isProject), "w2:p1")
	})
	t.Run("ignores trailing slashes on both sides", func(t *testing.T) {
		expectIDs(t, matchAgents("/repo", []Agent{agent("w1:p1", "/repo/")}, anyDir), "w1:p1")
	})
	t.Run("does not match a sibling that merely shares a prefix", func(t *testing.T) {
		// "/repo-old" starts with "/repo" as a string but is not inside it.
		expectIDs(t, matchAgents("/repo/apps", []Agent{agent("w1:p1", "/repo-old")}, anyDir))
	})
	t.Run("skips agents with no directory at all", func(t *testing.T) {
		expectIDs(t, matchAgents("/repo", []Agent{agent("w1:p1", "")}, anyDir))
	})
}

func TestIsInformativeProjectDir(t *testing.T) {
	root := t.TempDir()

	t.Run("accepts a directory carrying a project marker", func(t *testing.T) {
		project := filepath.Join(root, "acme")
		must(t, os.Mkdir(project, 0o755))
		must(t, os.WriteFile(filepath.Join(project, "package.json"), []byte("{}"), 0o644))
		if !isInformativeProjectDir(project) {
			t.Fatal("rejected a project")
		}
	})
	t.Run("rejects a directory with no marker", func(t *testing.T) {
		plain := filepath.Join(root, "notes")
		must(t, os.Mkdir(plain, 0o755))
		if isInformativeProjectDir(plain) {
			t.Fatal("accepted a plain directory")
		}
	})
	t.Run("rejects the universal ancestors outright", func(t *testing.T) {
		// Checked before markers: a dotfiles $HOME is a git repo.
		if isInformativeProjectDir("/") || isInformativeProjectDir(homeDir()) {
			t.Fatal("accepted / or $HOME")
		}
	})
	t.Run("rejects a path that does not exist", func(t *testing.T) {
		if isInformativeProjectDir(filepath.Join(root, "gone")) {
			t.Fatal("accepted a missing path")
		}
	})
}

func TestUpstreamURL(t *testing.T) {
	aliases := map[string]string{"13000": "3000"}
	cases := map[string]string{
		// Untranslated, the proxy port leads to the bridge's own process,
		// whose cwd is pointr's checkout: every proxied page would route to
		// pointr's agent.
		"http://localhost:13000/settings?tab=2#x": "http://localhost:3000/settings?tab=2#x",
		"http://localhost:3000/":                  "http://localhost:3000/",
		"http://localhost/":                       "http://localhost/",
		"not a url":                               "not a url",
	}
	for in, want := range cases {
		if got := upstreamURL(in, aliases); got != want {
			t.Errorf("upstreamURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
