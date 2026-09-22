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

/**
 * Which pids hold each of these socket inodes open — one walk of /proc however
 * many inodes are asked about, which is what makes listing every port as cheap
 * as looking up one.
 */
function pidsByInode(inodes: Set<string>): Map<string, number[]> {
  const wanted = new Map([...inodes].map((inode) => [`socket:[${inode}]`, inode]));
  const found = new Map<string, number[]>();

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let handles: string[];
    try {
      handles = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // someone else's process, or it exited mid-scan
    }
    const pid = Number.parseInt(entry, 10);
    for (const handle of handles) {
      let link: string;
      try {
        link = readlinkSync(`/proc/${entry}/fd/${handle}`);
      } catch {
        continue;
      }
      const inode = wanted.get(link);
      if (inode === undefined) continue;
      const pids = found.get(inode) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      found.set(inode, pids);
    }
  }
  return found;
}

/** Pids holding any of these socket inodes open. */
function pidsForInodes(inodes: Set<string>): number[] {
  return [...new Set([...pidsByInode(inodes).values()].flat())];
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function procfsOwners(port: number): PortOwner[] {
  const inodes = listeningInodes(port);
  // Skip the /proc walk entirely when nothing is listening — the common case.
  if (inodes.size === 0) return [];

  return pidsForInodes(inodes).map((pid) => ({ pid, cwd: cwdOf(pid) }) satisfies PortOwner);
}

async function lsofCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = stdout.split("\n").find((entry) => entry.startsWith("n"));
    return line === undefined ? null : line.slice(1);
  } catch {
    return null;
  }
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
    owners.push({ pid, cwd: await lsofCwd(pid) });
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

/** A TCP port something is listening on, and the process doing it. */
export interface ListeningPort {
  port: number;
  pid: number;
  cwd: string | null;
}

/**
 * Every listening TCP port, outside the ephemeral range. The range is where
 * port-0 binds land — Next's internal router workers, debuggers, language
 * servers — and a dev server a person opens in a browser is never there.
 */
export async function listeningPorts(): Promise<ListeningPort[]> {
  const [low, high] = ephemeralRange();
  const all = portStrategy() === "procfs" ? procfsListening() : portStrategy() === "lsof" ? await lsofListening() : [];
  return all.filter((entry) => entry.port < low || entry.port > high);
}

function procfsListening(): ListeningPort[] {
  const portByInode = new Map<string, number>();
  for (const table of PROC_NET_TABLES) {
    let contents: string;
    try {
      contents = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1];
      const inode = fields[9];
      if (local === undefined || inode === undefined || fields[3] !== TCP_LISTEN) continue;
      const hex = local.slice(local.lastIndexOf(":") + 1);
      portByInode.set(inode, Number.parseInt(hex, 16));
    }
  }
  if (portByInode.size === 0) return [];

  const seen = new Set<string>();
  const result: ListeningPort[] = [];
  for (const [inode, pids] of pidsByInode(new Set(portByInode.keys()))) {
    const port = portByInode.get(inode);
    if (port === undefined) continue;
    for (const pid of pids) {
      // One port on both IPv4 and IPv6 is two inodes held by one process.
      const key = `${port}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ port, pid, cwd: cwdOf(pid) });
    }
  }
  return result;
}

async function lsofListening(): Promise<ListeningPort[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  } catch {
    return [];
  }
  const pairs = new Map<string, { port: number; pid: number }>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && pid !== null) {
      const port = Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
      if (Number.isInteger(port)) pairs.set(`${port}:${pid}`, { port, pid });
    }
  }
  const cwds = new Map<number, string | null>();
  const result: ListeningPort[] = [];
  for (const { port, pid: owner } of pairs.values()) {
    if (!cwds.has(owner)) cwds.set(owner, await lsofCwd(owner));
    result.push({ port, pid: owner, cwd: cwds.get(owner) ?? null });
  }
  return result;
}

function ephemeralRange(): [number, number] {
  if (process.platform === "linux") {
    try {
      const [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
      if (low !== undefined && high !== undefined && Number.isInteger(low) && Number.isInteger(high)) return [low, high];
    } catch {
      // fall through to the IANA range
    }
  }
  return [49_152, 65_535];
}
