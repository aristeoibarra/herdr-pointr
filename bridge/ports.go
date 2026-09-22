package main

// Map a dev-server port to the directory it was launched from — the first
// half of the routing cascade — and list every listening port for the setup
// page.
//
// Linux reads procfs directly instead of shelling out: `ss` needs iproute2 and
// a PATH, and a daemon started by a service manager gets a minimal
// environment. macOS has no procfs, so it asks lsof.

import (
	"bufio"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

type PortOwner struct {
	Pid int `json:"pid"`
	// Empty when the cwd is unreadable — another user, or ptrace_scope.
	Cwd string `json:"cwd"`
}

type ListeningPort struct {
	Port int
	Pid  int
	Cwd  string
}

func portStrategy() string {
	switch runtime.GOOS {
	case "linux":
		return "procfs"
	case "darwin":
		return "lsof"
	}
	return "none"
}

// Listening socket state in /proc/net/tcp.
const tcpListen = "0A"

var procNetTables = []string{"/proc/net/tcp", "/proc/net/tcp6"}

func parsePort(raw string) int {
	port, err := strconv.Atoi(raw)
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// procListening maps each listening socket inode to its port. The bound
// address is ignored on purpose: a dev server can be on 0.0.0.0, 127.0.0.1,
// a LAN address or IPv6, and matching on the port alone holds across all.
func procListening() map[string]int {
	byInode := map[string]int{}
	for _, table := range procNetTables {
		file, err := os.Open(table)
		if err != nil {
			continue // no IPv6 on this kernel, or a container without procfs
		}
		scanner := bufio.NewScanner(file)
		scanner.Scan() // header
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 10 || fields[3] != tcpListen {
				continue
			}
			local := fields[1]
			port, err := strconv.ParseInt(local[strings.LastIndex(local, ":")+1:], 16, 32)
			if err == nil {
				byInode[fields[9]] = int(port)
			}
		}
		file.Close()
	}
	return byInode
}

// pidsByInode walks /proc once, however many inodes are asked about — which
// is what makes listing every port as cheap as looking up one.
func pidsByInode(inodes map[string]int) map[string][]int {
	found := map[string][]int{}
	if len(inodes) == 0 {
		return found
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return found
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		fdDir := "/proc/" + entry.Name() + "/fd"
		handles, err := os.ReadDir(fdDir)
		if err != nil {
			continue // someone else's process, or it exited mid-scan
		}
		seen := map[string]bool{}
		for _, handle := range handles {
			link, err := os.Readlink(fdDir + "/" + handle.Name())
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			inode := link[len("socket:[") : len(link)-1]
			if _, wanted := inodes[inode]; wanted && !seen[inode] {
				seen[inode] = true
				found[inode] = append(found[inode], pid)
			}
		}
	}
	return found
}

func procCwd(pid int) string {
	cwd, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
	if err != nil {
		return ""
	}
	return cwd
}

func lsofCwd(pid int) string {
	out, err := exec.Command("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			return line[1:]
		}
	}
	return ""
}

// ownersForPort returns every process listening on port. Several is normal:
// SO_REUSEPORT workers, or a supervisor sharing a listening fd with its child
// (Vite, Next) — those share a cwd and collapse in cwdsForPort.
func ownersForPort(raw string) []PortOwner {
	port := parsePort(raw)
	if port == 0 {
		return nil
	}
	var owners []PortOwner
	switch portStrategy() {
	case "procfs":
		inodes := map[string]int{}
		for inode, p := range procListening() {
			if p == port {
				inodes[inode] = p
			}
		}
		pids := map[int]bool{}
		for _, list := range pidsByInode(inodes) {
			for _, pid := range list {
				pids[pid] = true
			}
		}
		for pid := range pids {
			owners = append(owners, PortOwner{Pid: pid, Cwd: procCwd(pid)})
		}
	case "lsof":
		out, err := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-t").Output()
		if err != nil {
			return nil // lsof exits non-zero when nothing matches
		}
		for _, line := range strings.Fields(string(out)) {
			if pid, err := strconv.Atoi(line); err == nil {
				owners = append(owners, PortOwner{Pid: pid, Cwd: lsofCwd(pid)})
			}
		}
	}
	return owners
}

// cwdsForPort returns the distinct working directories behind a port, minus
// excludePid — the bridge passes its own, since a port it serves (its
// proxies) says nothing about any project. The whole set, not one string:
// collapsing several owners to the first is how a guess used to get made
// before routing ever saw the evidence.
func cwdsForPort(port string, excludePid int) []string {
	seen := map[string]bool{}
	var dirs []string
	for _, owner := range ownersForPort(port) {
		if owner.Pid == excludePid || owner.Cwd == "" || seen[owner.Cwd] {
			continue
		}
		seen[owner.Cwd] = true
		dirs = append(dirs, owner.Cwd)
	}
	return dirs
}

// listeningPorts returns every listening TCP port outside the ephemeral range.
// That range is where port-0 binds land — Next's internal router workers,
// debuggers, language servers — and a dev server someone opens is never there.
func listeningPorts() []ListeningPort {
	low, high := ephemeralRange()
	var all []ListeningPort
	switch portStrategy() {
	case "procfs":
		byInode := procListening()
		seen := map[string]bool{}
		for inode, pids := range pidsByInode(byInode) {
			for _, pid := range pids {
				// One port on IPv4 and IPv6 is two inodes held by one process.
				key := strconv.Itoa(byInode[inode]) + ":" + strconv.Itoa(pid)
				if seen[key] {
					continue
				}
				seen[key] = true
				all = append(all, ListeningPort{Port: byInode[inode], Pid: pid, Cwd: procCwd(pid)})
			}
		}
	case "lsof":
		all = lsofListening()
	}
	var result []ListeningPort
	for _, entry := range all {
		if entry.Port < low || entry.Port > high {
			result = append(result, entry)
		}
	}
	return result
}

func lsofListening() []ListeningPort {
	out, err := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn").Output()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	cwds := map[int]string{}
	var result []ListeningPort
	pid := 0
	for _, line := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(line, "p"):
			pid, _ = strconv.Atoi(line[1:])
		case strings.HasPrefix(line, "n") && pid != 0:
			port, err := strconv.Atoi(line[strings.LastIndex(line, ":")+1:])
			key := strconv.Itoa(port) + ":" + strconv.Itoa(pid)
			if err != nil || seen[key] {
				continue
			}
			seen[key] = true
			if _, ok := cwds[pid]; !ok {
				cwds[pid] = lsofCwd(pid)
			}
			result = append(result, ListeningPort{Port: port, Pid: pid, Cwd: cwds[pid]})
		}
	}
	return result
}

func ephemeralRange() (int, int) {
	if runtime.GOOS == "linux" {
		if raw, err := os.ReadFile("/proc/sys/net/ipv4/ip_local_port_range"); err == nil {
			fields := strings.Fields(string(raw))
			if len(fields) == 2 {
				low, errLow := strconv.Atoi(fields[0])
				high, errHigh := strconv.Atoi(fields[1])
				if errLow == nil && errHigh == nil {
					return low, high
				}
			}
		}
	}
	return 49152, 65535
}
