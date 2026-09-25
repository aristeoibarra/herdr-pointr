package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const defaultPort = 7331

// AgentPin is a pinned destination. The session is what tells "same pane, new
// agent" apart: a pane id alone cannot.
type AgentPin struct {
	PaneID string `json:"paneId"`
	// Nil for a pin stored before sessions were tracked; adopted on first use.
	Session *string `json:"session"`
}

type Config struct {
	// Pinned destination, or nil to resolve at send time.
	TargetAgent *AgentPin `json:"targetAgent"`
	// Project path used to match an agent when nothing else resolves.
	ProjectPath *string `json:"projectPath"`
	Port        int     `json:"port"`
	// herdr socket to talk to. Nil = HERDR_SOCKET_PATH, then the default
	// session. A detached daemon starts with a fresh environment, so a named
	// session's socket has to be configured rather than inherited.
	HerdrSocketPath *string `json:"herdrSocketPath"`
}

// When herdr runs us as a plugin it hands us a config directory of its own,
// which survives reinstalling the plugin.
func configDir() string {
	if dir := os.Getenv("HERDR_PLUGIN_CONFIG_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(homeDir(), ".config", "herdr-pointr")
}

func configFile() string { return filepath.Join(configDir(), "config.json") }

func loadConfig() Config {
	cfg := Config{Port: defaultPort}
	raw, err := os.ReadFile(configFile())
	if err != nil {
		return cfg
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil {
		return cfg
	}
	pin := parsed["targetAgent"]
	if pin == nil {
		pin = parsed["targetPane"]
	}
	cfg.TargetAgent = readPin(pin)
	cfg.ProjectPath = nonEmpty(parsed["projectPath"])
	cfg.HerdrSocketPath = nonEmpty(parsed["herdrSocketPath"])
	if port, ok := parsed["port"].(float64); ok && port == float64(int(port)) {
		cfg.Port = int(port)
	}
	return cfg
}

// A pin saved before sessions were tracked is a bare pane-id string. Lift it
// and let the session be adopted the first time it resolves.
func readPin(value any) *AgentPin {
	switch v := value.(type) {
	case string:
		if v == "" {
			return nil
		}
		return &AgentPin{PaneID: v}
	case map[string]any:
		paneID, _ := v["paneId"].(string)
		if paneID == "" {
			return nil
		}
		pin := &AgentPin{PaneID: paneID}
		if session, ok := v["session"].(string); ok {
			pin.Session = &session
		}
		return pin
	}
	return nil
}

func nonEmpty(value any) *string {
	if s, ok := value.(string); ok && s != "" {
		return &s
	}
	return nil
}

func saveConfig(cfg Config) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(configFile(), append(raw, '\n'), 0o644)
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/"
	}
	return home
}
