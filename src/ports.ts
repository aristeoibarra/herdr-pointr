import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A process listening on the port, with its working directory when readable. */
export interface PortOwner {
  pid: number;
  /** Null when /proc/<pid>/cwd is unreadable — another user, or ptrace_scope. */
  cwd: string | null;
}

export type PortStrategy = "procfs" | "lsof" | "none";

/**
 * Map a dev-server port to the directory it was launched from — the first half
 * of the routing cascade.
 *
 * Linux reads procfs directly instead of shelling out to `ss`. Three reasons,
 * in increasing order of importance: `ss` needs iproute2 installed (it is, but
 * `lsof` was not, which is how the old code silently stopped routing on this
 * machine); its output needs a positional parse; and it needs a PATH. That last
 * one matters most — a daemon started by a service manager gets a minimal
 * environment, which is exactly why src/service.ts had to hardcode a PATH.
 * Reading files removes the last subprocess from the Linux path entirely.
 *
 * `ss -lntpH 'sport = :N'` stays the right command for a human debugging this
 * by hand; it just isn't shipped as a code path.
 */
export function portStrategy(): PortStrategy {
  if (process.platform === "linux") return "procfs";
  if (process.platform === "darwin") return "lsof";
  return "none";
}

/** Listening socket state in /proc/net/tcp. */
const TCP_LISTEN = "0A";
const PROC_NET_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port > 0 && port <= 65_535 ? port : null;
}

/**
 * Inodes of the sockets listening on `port`.
 *
 * The bound address is deliberately ignored. A dev server can be on 0.0.0.0,
 * 127.0.0.1, a LAN address or a tailnet address, and in tcp6 the same port
 * appears with a 32-hex-digit address — matching on the port alone is the only
 * thing that holds across all of them.
 */
function listeningInodes(port: number): Set<string> {
  const target = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set<string>();

  for (const table of PROC_NET_TABLES) {
    let contents: string;
    try {
      contents = readFileSync(table, "utf8");
    } catch {
      continue; // no IPv6 on this kernel, or a container without procfs
    }
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1];
      const state = fields[3];
      const inode = fields[9];
      if (local === undefined || inode === undefined) continue;
      if (state !== TCP_LISTEN) continue;
      if (!local.endsWith(target)) continue;
      inodes.add(inode);
    }
  }
  return inodes;
}

/** Pids holding any of these socket inodes open. */
function pidsForInodes(inodes: Set<string>): number[] {
  const wanted = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  const pids: number[] = [];

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let handles: string[];
    try {
      handles = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // someone else's process, or it exited mid-scan
    }
    for (const handle of handles) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${entry}/fd/${handle}`);
      } catch {
        continue;
      }
      if (wanted.has(link)) {
        pids.push(Number.parseInt(entry, 10));
        break;
      }
    }
  }
  return pids;
}

function procfsOwners(port: number): PortOwner[] {
  const inodes = listeningInodes(port);
  // Skip the /proc walk entirely when nothing is listening — the common case.
  if (inodes.size === 0) return [];

  return pidsForInodes(inodes).map((pid) => {
    let cwd: string | null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    return { pid, cwd } satisfies PortOwner;
  });
}

async function lsofOwners(port: number): Promise<PortOwner[]> {
  let pidOut: string;
  try {
    ({ stdout: pidOut } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]));
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }

  const owners: PortOwner[] = [];
  for (const raw of pidOut.split("\n")) {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const pid = Number.parseInt(trimmed, 10);
    try {
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const line = stdout.split("\n").find((entry) => entry.startsWith("n"));
      owners.push({ pid, cwd: line === undefined ? null : line.slice(1) });
    } catch {
      owners.push({ pid, cwd: null });
    }
  }
  return owners;
}

/**
 * Every process listening on `port`. Several is normal and not an error:
 * SO_REUSEPORT workers, or a supervisor sharing an inherited listening fd with
 * its child (Vite, Next) — those share a cwd and collapse in `cwdsForPort`.
 */
export async function ownersForPort(port: string): Promise<PortOwner[]> {
  const parsed = parsePort(port);
  if (parsed === null) return [];
  switch (portStrategy()) {
    case "procfs":
      return procfsOwners(parsed);
    case "lsof":
      return lsofOwners(parsed);
    case "none":
      return [];
  }
}

/**
 * Distinct working directories behind a port.
 *
 * `excludePid` drops one process from the evidence — the bridge passes its own,
 * since a port it serves (its proxies) says nothing about any project.
 *
 * Returns the whole set rather than one string on purpose: collapsing several
 * owners to `head -1`, as the old code did, is how a guess got made before the
 * routing layer ever saw the evidence.
 */
export async function cwdsForPort(port: string, excludePid: number | null = null): Promise<string[]> {
  const owners = await ownersForPort(port);
  const dirs = new Set<string>();
  for (const owner of owners) {
    if (owner.pid === excludePid) continue;
    if (owner.cwd !== null && owner.cwd.length > 0) dirs.add(owner.cwd);
  }
  return [...dirs];
}
