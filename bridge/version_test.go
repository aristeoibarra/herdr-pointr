package main

// Two files carry the version and nothing makes them agree. They are read by
// different things — npm and herdr's plugin registry — so drift breaks no
// build: it ships a plugin whose manifest disagrees with its own package.

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestVersionsAgree(t *testing.T) {
	raw, err := os.ReadFile("../package.json")
	must(t, err)
	var pkg struct {
		Version string `json:"version"`
	}
	must(t, json.Unmarshal(raw, &pkg))
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(pkg.Version) {
		t.Fatalf("package.json version %q is not a plain semver triple", pkg.Version)
	}

	manifest, err := os.ReadFile("../herdr-plugin.toml")
	must(t, err)
	// Top-level only: stop at the first [section], so a later block with its
	// own version key cannot be mistaken for the package's.
	top := regexp.MustCompile(`(?m)^\s*\[`).Split(string(manifest), 2)[0]
	match := regexp.MustCompile(`(?m)^\s*version\s*=\s*"([^"]+)"`).FindStringSubmatch(top)
	if match == nil {
		t.Fatal("herdr-plugin.toml: no top-level version")
	}
	if strings.TrimSpace(match[1]) != pkg.Version {
		t.Fatalf("herdr-plugin.toml says %s, package.json says %s", match[1], pkg.Version)
	}
}
