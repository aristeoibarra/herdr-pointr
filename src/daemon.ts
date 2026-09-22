import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ownersForPort } from "./ports.ts";

/**
 * Process lifecycle for the bridge.
 *
 * herdr's `[[startup]]` hooks are one-shot initialisation commands, not
 * supervised daemons, so this owns the process: `start` detaches the server and
 * records its pid, `stop` takes it down, `status` reports. `start` is
 * idempotent — a server already answering is left alone — which is what makes
 * the same command safe as a startup hook and as something typed by hand.
 */

const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

function stateDir(): string {
  return process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local", "state", "herdr-pointr");
}

function pidFile(): string {
  return join(stateDir(), "server.pid");
}

function logFile(): string {
  return join(stateDir(), "server.log");
}

/** daemon.ts is bundled into dist/cli.js, so __dirname is dist/ at runtime. */
function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

async function answering(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The recorded pid, but only if that process is actually alive. */
function livePid(): number | null {
  if (!existsSync(pidFile())) return null;
  const pid = Number.parseInt(readFileSync(pidFile(), "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function start(port: number): Promise<number> {
  if (await answering(port)) {
    process.stdout.write(`pointr already running on http://localhost:${port}\n`);
    return 0;
  }

  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(logFile(), "a");
  const child = spawn(process.execPath, [cliPath(), "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    // Carries HERDR_SOCKET_PATH through. Without it a plugin running in a named
    // herdr session would end up talking to the default session's socket.
    env: { ...process.env },
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(pidFile(), `${child.pid}\n`, { mode: 0o600 });

  // Having spawned is not the same as being up: wait for it to actually answer.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answering(port)) {
      process.stdout.write(`pointr listening on http://localhost:${port}\n`);
      return 0;
    }
    await sleep(POLL_MS);
  }
  process.stderr.write(
    `pointr did not answer http://localhost:${port}/health within ${READY_TIMEOUT_MS / 1000}s — see ${logFile()}\n`,
  );
  return 1;
}

export async function stop(port: number): Promise<number> {
  // The pidfile lives under the state directory herdr injects, so a daemon
  // started as a plugin action and a `stop` typed by hand outside herdr do not
  // see the same file. Falling back to whoever holds the port keeps the two
  // from disagreeing about whether anything is running.
  const pid = livePid() ?? (await answering(port) ? await listenerPid(port) : null);
  if (pid === null) {
    rmSync(pidFile(), { force: true });
    process.stdout.write("pointr is not running\n");
    return 0;
  }
  try {
    // Negative pid signals the whole process group, which exists because the
    // server was spawned detached.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      process.stderr.write(`could not signal pid ${pid}\n`);
      return 1;
    }
  }
  rmSync(pidFile(), { force: true });
  process.stdout.write(`stopped pointr (pid ${pid})\n`);
  return 0;
}

/**
 * Who is listening on our port. Only trusted after /health has answered, which
 * no other process on this port would do.
 */
async function listenerPid(port: number): Promise<number | null> {
  const owners = await ownersForPort(String(port));
  return owners[0]?.pid ?? null;
}

/**
 * Always exits 0, including when down: herdr records a non-zero exit as a
 * failed action, and being switched off is not a failure.
 */
export async function status(port: number): Promise<number> {
  const up = await answering(port);
  const pid = livePid() ?? (up ? await listenerPid(port) : null);
  process.stdout.write(
    `${up ? "running" : "down"} http://localhost:${port}${pid === null ? "" : ` (pid ${pid})`}\n`,
  );
  return 0;
}
