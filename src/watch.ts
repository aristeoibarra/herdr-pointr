import type { ServerResponse } from "node:http";

import type { AgentStatus, HerdrEvent, Subscription } from "./herdr.ts";
import { getAgent, subscribe } from "./herdr.ts";

/**
 * Watchers turn herdr's event stream into per-browser-tab SSE.
 *
 * Two things shape this module:
 *
 * - **Status is per-pane, titles are global.** `pane.agent_status_changed`
 *   requires a pane_id and carries no title; titles only arrive on the global
 *   `pane.updated`. So each watched pane needs its own subscription, and one
 *   shared connection carries the globals for everyone.
 * - **Subscriptions never replay.** Whatever happens between losing a
 *   connection and re-acking one is gone, so a reconnect re-seeds from
 *   `agent.get` and tells clients their view may have skipped.
 *
 * Watchers are keyed by pane id alone, not by origin: three tabs on different
 * ports that resolve to the same agent share one watcher and one herdr socket.
 */

interface Watcher {
  paneId: string;
  clients: Set<ServerResponse>;
  /** Non-client retains, so a watcher survives the gap between POST and EventSource. */
  holds: number;
  status: AgentStatus | null;
  title: string | null;
  session: string | null;
  sub: Subscription;
  idleTimer: NodeJS.Timeout | null;
}

/** Bounds how many herdr sockets the bridge can hold open. */
const MAX_WATCHERS = 16;
/** Grace before tearing a watcher down, so a tab reload doesn't thrash it. */
const IDLE_GRACE_MS = 30_000;
const HEARTBEAT_MS = 15_000;

const watchers = new Map<string, Watcher>();
const heartbeats = new WeakMap<ServerResponse, NodeJS.Timeout>();
let globals: Subscription | null = null;
let globalsIdleTimer: NodeJS.Timeout | null = null;

function writeEvent(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(watcher: Watcher, event: string, data: Record<string, unknown>): void {
  for (const client of watcher.clients) writeEvent(client, event, data);
}

function onGlobalEvent(event: HerdrEvent): void {
  const watcher = watchers.get(event.paneId);
  if (watcher === undefined) return;

  if (event.kind === "closed") {
    // Pane ids are never reused, so this can never recover: tell every client
    // and tear down immediately, with no grace period.
    broadcast(watcher, "closed", { agent: watcher.paneId, reason: "pane_closed" });
    for (const client of watcher.clients) endClient(client);
    destroy(watcher.paneId);
    return;
  }

  if (event.kind === "title" && event.title !== watcher.title) {
    watcher.title = event.title;
    broadcast(watcher, "title", { agent: watcher.paneId, title: event.title });
    // pane.updated carries status too, and it is the only status we get for a
    // pane whose own subscription dropped.
    if (event.status !== null && event.status !== watcher.status) {
      watcher.status = event.status;
      broadcast(watcher, "status", { agent: watcher.paneId, status: event.status });
    }
    return;
  }

  if (event.kind === "detected") void reseed(watcher);
}

function ensureGlobals(): void {
  if (globalsIdleTimer !== null) {
    clearTimeout(globalsIdleTimer);
    globalsIdleTimer = null;
  }
  if (globals !== null) return;
  globals = subscribe(
    [{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.agent_detected" }],
    onGlobalEvent,
    () => {
      globals = null;
      // Only worth reopening while something is being watched.
      if (watchers.size > 0) setTimeout(ensureGlobals, 1_000);
    },
  );
}

function releaseGlobals(): void {
  if (watchers.size > 0 || globals === null || globalsIdleTimer !== null) return;
  globalsIdleTimer = setTimeout(() => {
    globalsIdleTimer = null;
    if (watchers.size > 0) return;
    globals?.close();
    globals = null;
  }, IDLE_GRACE_MS);
}

/** Re-read the agent after a gap and tell clients their view may have skipped. */
async function reseed(watcher: Watcher): Promise<void> {
  const agent = await getAgent(watcher.paneId).catch(() => null);
  if (agent === null) {
    broadcast(watcher, "closed", { agent: watcher.paneId, reason: "pane_closed" });
    for (const client of watcher.clients) endClient(client);
    destroy(watcher.paneId);
    return;
  }
  const replaced = watcher.session !== null && agent.sessionId !== null && agent.sessionId !== watcher.session;
  watcher.session = agent.sessionId;
  watcher.status = agent.status;
  watcher.title = agent.title;
  if (replaced) broadcast(watcher, "replaced", { agent: watcher.paneId, session: agent.sessionId });
  broadcast(watcher, "status", { agent: watcher.paneId, status: agent.status });
}

function openWatcher(paneId: string): Watcher {
  const watcher: Watcher = {
    paneId,
    clients: new Set(),
    holds: 0,
    status: null,
    title: null,
    session: null,
    idleTimer: null,
    sub: subscribe(
      [{ type: "pane.agent_status_changed", pane_id: paneId }],
      (event) => {
        if (event.kind !== "status") return;
        const live = watchers.get(paneId);
        if (live === undefined || event.status === live.status) return;
        live.status = event.status;
        broadcast(live, "status", { agent: paneId, status: event.status });
      },
      () => {
        const live = watchers.get(paneId);
        if (live === undefined) return;
        // The stream died (most often a herdr handoff). Reopen, then re-seed:
        // anything that happened in the gap is unrecoverable.
        setTimeout(() => {
          const still = watchers.get(paneId);
          if (still === undefined) return;
          still.sub = openWatcher(paneId).sub;
          broadcast(still, "resync", { agent: paneId });
          void reseed(still);
        }, 1_000);
      },
    ),
  };
  return watcher;
}

function evictOne(): boolean {
  for (const [paneId, watcher] of watchers) {
    if (watcher.clients.size === 0 && watcher.holds === 0) {
      destroy(paneId);
      return true;
    }
  }
  return false;
}

function ensureWatcher(paneId: string): Watcher | null {
  const existing = watchers.get(paneId);
  if (existing !== undefined) {
    if (existing.idleTimer !== null) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }
  if (watchers.size >= MAX_WATCHERS && !evictOne()) return null;

  const watcher = openWatcher(paneId);
  watchers.set(paneId, watcher);
  ensureGlobals();
  return watcher;
}

function destroy(paneId: string): void {
  const watcher = watchers.get(paneId);
  if (watcher === undefined) return;
  if (watcher.idleTimer !== null) clearTimeout(watcher.idleTimer);
  watcher.sub.close();
  watchers.delete(paneId);
  releaseGlobals();
}

function scheduleIdle(watcher: Watcher): void {
  if (watcher.clients.size + watcher.holds > 0 || watcher.idleTimer !== null) return;
  watcher.idleTimer = setTimeout(() => destroy(watcher.paneId), IDLE_GRACE_MS);
}

function endClient(res: ServerResponse): void {
  const timer = heartbeats.get(res);
  if (timer !== undefined) clearInterval(timer);
  heartbeats.delete(res);
  if (!res.writableEnded) res.end();
}

/**
 * Hold a watcher open for a window, with no client attached.
 *
 * `/send` calls this *before* prompting: subscriptions do not replay, so the
 * subscription has to be acked before the agent starts working, or the first
 * transition is lost. It also covers the gap until the browser's EventSource
 * actually connects.
 */
export function retain(paneId: string, windowMs: number): void {
  const watcher = ensureWatcher(paneId);
  if (watcher === null) return;
  watcher.holds += 1;
  setTimeout(() => {
    watcher.holds = Math.max(0, watcher.holds - 1);
    scheduleIdle(watcher);
  }, windowMs);
}

/** Note what we already know about an agent, so a late client gets it at once. */
export function seed(paneId: string, status: AgentStatus | null, session: string | null): void {
  const watcher = watchers.get(paneId);
  if (watcher === undefined) return;
  if (status !== null) watcher.status = status;
  if (session !== null) watcher.session = session;
}

/** Attach one SSE client. Returns false when the bridge is at its watcher cap. */
export async function attach(paneId: string, res: ServerResponse): Promise<boolean> {
  const watcher = ensureWatcher(paneId);
  if (watcher === null) return false;

  watcher.clients.add(res);
  // Slow the browser's automatic reconnect from its default down to 3s.
  res.write("retry: 3000\n\n");

  if (watcher.status === null) {
    const agent = await getAgent(paneId).catch(() => null);
    if (agent === null) {
      writeEvent(res, "closed", { agent: paneId, reason: "pane_closed" });
      watcher.clients.delete(res);
      endClient(res);
      return true;
    }
    watcher.status = agent.status;
    watcher.title = agent.title;
    watcher.session = agent.sessionId;
  }
  writeEvent(res, "status", { agent: paneId, status: watcher.status });
  if (watcher.title !== null) writeEvent(res, "title", { agent: paneId, title: watcher.title });

  // Comment lines are ignored by EventSource and stop intermediaries — and
  // Chrome — from treating a quiet stream as dead.
  heartbeats.set(res, setInterval(() => {
    if (res.writableEnded) return;
    res.write(": ping\n\n");
  }, HEARTBEAT_MS));

  res.on("close", () => {
    watcher.clients.delete(res);
    const timer = heartbeats.get(res);
    if (timer !== undefined) clearInterval(timer);
    heartbeats.delete(res);
    scheduleIdle(watcher);
  });
  return true;
}

/**
 * End every stream so `server.close()` can actually complete — an open SSE
 * response keeps the server from closing, which would hang SIGINT.
 */
export function shutdownWatchers(): void {
  for (const [paneId, watcher] of watchers) {
    for (const client of watcher.clients) endClient(client);
    watcher.clients.clear();
    destroy(paneId);
  }
  globals?.close();
  globals = null;
}
