package main

// Process lifecycle. herdr's [[startup]] hooks are one-shot, not supervised,
// so this owns the process: start detaches the server and records its pid,
// stop takes it down, status reports. start is idempotent — a server already
// answering is left alone — which makes the same command safe as a startup
// hook and as something typed by hand.

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const readyTimeout = 20 * time.Second

func stateDir() string {
	if dir := os.Getenv("HERDR_PLUGIN_STATE_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(homeDir(), ".local", "state", "herdr-pointr")
}

func pidFile() string { return filepath.Join(stateDir(), "server.pid") }
func logFile() string { return filepath.Join(stateDir(), "server.log") }

func answering(port int) bool {
	client := http.Client{Timeout: 1500 * time.Millisecond}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// livePid is the recorded pid, but only if that process is actually alive.
func livePid() int {
	raw, err := os.ReadFile(pidFile())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	// Signal 0 checks for existence without touching the process.
	if syscall.Kill(pid, 0) != nil {
		return 0
	}
	return pid
}

func daemonStart(port int) int {
	if answering(port) {
		fmt.Printf("pointr already running on http://localhost:%d\n", port)
		return 0
	}
	if err := os.MkdirAll(stateDir(), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	logOut, err := os.OpenFile(logFile(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer logOut.Close()
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// The environment is inherited, which carries HERDR_SOCKET_PATH through:
	// without it a named herdr session would talk to the default socket.
	cmd := exec.Command(self, "serve", "--port", strconv.Itoa(port))
	cmd.Stdout, cmd.Stderr = logOut, logOut
	// Its own session, so it outlives the one-shot hook that started it and
	// stop can signal the whole group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = os.WriteFile(pidFile(), []byte(strconv.Itoa(cmd.Process.Pid)+"\n"), 0o600)
	_ = cmd.Process.Release()

	// Having spawned is not the same as being up: wait for it to answer.
	for deadline := time.Now().Add(readyTimeout); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
		if answering(port) {
			fmt.Printf("pointr listening on http://localhost:%d\n", port)
			return 0
		}
	}
	fmt.Fprintf(os.Stderr, "pointr did not answer http://localhost:%d/health within %v — see %s\n", port, readyTimeout, logFile())
	return 1
}

// listenerPid is who listens on our port. Only trusted after /health answered,
// which no other process on this port would do.
func listenerPid(port int) int {
	owners := ownersForPort(strconv.Itoa(port))
	if len(owners) == 0 {
		return 0
	}
	return owners[0].Pid
}

func daemonStop(port int) int {
	// The pidfile lives under the state directory herdr injects, so a daemon
	// started as a plugin action and a stop typed outside herdr do not see the
	// same file. Falling back to the port owner keeps them from disagreeing.
	pid := livePid()
	if pid == 0 && answering(port) {
		pid = listenerPid(port)
	}
	if pid == 0 {
		_ = os.Remove(pidFile())
		fmt.Println("pointr is not running")
		return 0
	}
	// Negative pid signals the whole process group the detached start made.
	if syscall.Kill(-pid, syscall.SIGTERM) != nil && syscall.Kill(pid, syscall.SIGTERM) != nil {
		fmt.Fprintf(os.Stderr, "could not signal pid %d\n", pid)
		return 1
	}
	_ = os.Remove(pidFile())
	fmt.Printf("stopped pointr (pid %d)\n", pid)
	return 0
}

// daemonStatus always exits 0, including when down: herdr records a non-zero
// exit as a failed action, and being switched off is not a failure.
func daemonStatus(port int) int {
	up := answering(port)
	pid := livePid()
	if pid == 0 && up {
		pid = listenerPid(port)
	}
	state := "down"
	if up {
		state = "running"
	}
	suffix := ""
	if pid != 0 {
		suffix = fmt.Sprintf(" (pid %d)", pid)
	}
	fmt.Printf("%s http://localhost:%d%s\n", state, port, suffix)
	return 0
}
