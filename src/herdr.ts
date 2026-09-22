import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * herdr socket client — replaces the tmux shell-outs.
 *
 * Transport facts, all verified against herdr 0.9.1 (protocol 22) rather than
 * assumed. Each one shapes the module, so don't "simplify" them away:
 *
 * - **One request, one connection.** The server closes the socket after a
 *   single response, so there is no multiplexing by request id: a second write
 *   on the same socket gets EPIPE. A pooled socket would never see a reply.
 * - **`events.subscribe` is the one exception.** Its connection stays open past
 *   the `subscription_started` ack and then streams event lines forever.
 * - **Emitted event names use two different conventions**, matching the two
 *   enums in the schema. The three subscription-scoped events come back dotted,
 *   exactly as subscribed (`pane.agent_status_changed`); every lifecycle event
 *   comes back underscored, unlike its dotted subscription type
 *   (`{type:"pane.updated"}` yields `{"event":"pane_updated"}`). Both were
 *   captured live. Match on one convention only and half the stream vanishes.
 * - **Agent status is per-pane.** `pane.agent_status_changed` requires a
 *   `pane_id`; subscribing without one is rejected with `invalid_request`.
 *   There is no global agent-status stream to listen to.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Every status herdr can report. `idle` and `done` both mean "ready for input". */
const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

export interface HerdrAgent {
  /** Stable handle, e.g. "w37:p1". Never reused once the pane closes. */
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** Agent kind: "claude", "codex", "opencode"… herdr detects 24 of them. */
  kind: string;
  status: AgentStatus;
  /** Pane cwd — what the routing cascade matches a project against. */
  cwd: string;
  /** Title with the spinner glyph stripped; the agent's current task. */
  title: string;
  /**
   * The agent's own session id (Claude Code's UUID, say). Lets us tell "same
   * pane, different session" from "same session", which a pane id cannot.
   */
  sessionId: string | null;
  focused: boolean;
}

/**
 * A normalized event. Callers match on `kind` and never see herdr's two naming
 * conventions.
 *
 * `closed` and a `status` of "done" are deliberately different things: the
 * first means the terminal is gone, the second that the agent finished a turn.
 * Collapsing them would make the widget parse a status string for a sentinel.
 */
export type HerdrEvent =
  | { kind: "status"; paneId: string; status: AgentStatus }
  | { kind: "title"; paneId: string; title: string; status: AgentStatus | null }
  | { kind: "closed"; paneId: string }
  | { kind: "detected"; paneId: string };

/** A subscription spec, in the dotted form `events.subscribe` expects. */
export type SubscriptionSpec =
  | { type: "pane.updated" }
  | { type: "pane.closed" }
  | { type: "pane.exited" }
  | { type: "pane.agent_detected" }
  | { type: "pane.agent_status_changed"; pane_id: string };

export interface Subscription {
  close(): void;
}

/**
 * A typed failure from herdr. `code` is herdr's own machine-readable code —
 * `agent_blocked`, `not_found`, `invalid_request` — plus two we mint locally:
 * `unavailable` (no server listening) and `timeout`.
 */
export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** The agent is sitting at an approval/question dialog and refused the prompt. */
export function isBlocked(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "agent_blocked";
}

/** No herdr server answering — distinct from herdr answering with a refusal. */
export function isUnavailable(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "unavailable";
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** A prompt with `wait` blocks until the agent settles, so it gets its own budget. */
const PROMPT_TIMEOUT_MS = 30_000;
/** Guards against a malformed stream eating memory while we look for a newline. */
const MAX_LINE_BYTES = 8_000_000;

/**
 * Resolution order per herdr's docs: explicit env first, then the default
 * session socket. Named sessions live under sessions/<name>/herdr.sock, which
 * is exactly why the env var has to win — a plugin launched from a named
 * session would otherwise talk to the wrong server.
 */
export function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

let requestSeq = 0;

function nextId(): string {
  requestSeq += 1;
  return `bridge-${requestSeq}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readStatus(value: unknown): AgentStatus | null {
  return AGENT_STATUSES.find((status) => status === value) ?? null;
}

/**
 * Send one request and read its single reply. Opens and closes a socket per
 * call — see the header note on why pooling is impossible here.
 */
function request(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath() });
    let buffer = "";
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new HerdrError("timeout", `herdr did not answer ${method} in ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: nextId(), method, params })}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        finish(() => reject(new HerdrError("protocol", `herdr sent over ${MAX_LINE_BYTES} bytes with no newline`)));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(unwrap(method, line));
        } catch (error) {
          reject(error);
        }
      });
    });

    socket.on("error", (error: Error) => {
      // ENOENT/ECONNREFUSED here means "no herdr running", which the server
      // turns into a different HTTP answer than "herdr said no".
      finish(() => reject(new HerdrError("unavailable", `herdr socket at ${socketPath()}: ${error.message}`)));
    });

    socket.on("close", () => {
      finish(() => reject(new HerdrError("unavailable", `herdr closed the connection before answering ${method}`)));
    });
  });
}

/** Pull `result` out of a reply line, turning an `error` envelope into a throw. */
function unwrap(method: string, line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new HerdrError("protocol", `herdr sent a non-JSON reply to ${method}`);
  }
  if (!isRecord(parsed)) throw new HerdrError("protocol", `herdr sent a non-object reply to ${method}`);

  const errorBody = parsed["error"];
  if (isRecord(errorBody)) {
    const code = readString(errorBody, "code") ?? "unknown";
    const message = readString(errorBody, "message") ?? `herdr refused ${method}`;
    throw new HerdrError(code, message);
  }

  const result = parsed["result"];
  if (!isRecord(result)) throw new HerdrError("protocol", `herdr reply to ${method} had no result`);
  return result;
}

function toAgent(value: unknown): HerdrAgent | null {
  if (!isRecord(value)) return null;
  const paneId = readString(value, "pane_id");
  const kind = readString(value, "agent");
  if (paneId === null || kind === null) return null;

  const session = value["agent_session"];
  return {
    paneId,
    workspaceId: readString(value, "workspace_id") ?? "",
    tabId: readString(value, "tab_id") ?? "",
    kind,
    status: readStatus(value["agent_status"]) ?? "unknown",
    // foreground_cwd tracks `cd` inside the pane; cwd is where it started.
    // The latter is the stabler answer for "which project is this".
    cwd: readString(value, "cwd") ?? "",
    title: readString(value, "terminal_title_stripped") ?? "",
    sessionId: isRecord(session) ? readString(session, "value") : null,
    focused: value["focused"] === true,
  } satisfies HerdrAgent;
}

/** Every agent herdr currently recognises, across all workspaces. */
export async function listAgents(): Promise<HerdrAgent[]> {
  const result = await request("agent.list", {});
  const agents = result["agents"];
  if (!Array.isArray(agents)) return [];
  const parsed: HerdrAgent[] = [];
  for (const entry of agents) {
    const agent = toAgent(entry);
    if (agent !== null) parsed.push(agent);
  }
  return parsed;
}

/**
 * One agent by pane id. Null when that pane is gone or holds no agent.
 *
 * herdr namespaces its miss codes per subject — `agent_not_found`,
 * `pane_not_found` — so matching a bare "not_found" silently never fires.
 */
export async function getAgent(paneId: string): Promise<HerdrAgent | null> {
  try {
    const result = await request("agent.get", { target: paneId });
    return toAgent(result["agent"]);
  } catch (error) {
    if (error instanceof HerdrError && error.code.endsWith("not_found")) return null;
    throw error;
  }
}

/**
 * Submit a prompt and press Enter, as one ordered submission. herdr honours the
 * pane's live bracketed-paste mode, which is what keeps a multi-line prompt one
 * block instead of one submission per newline.
 *
 * Throws `HerdrError("agent_blocked")` when the agent is already waiting at an
 * approval dialog — herdr checks that *before* writing anything, so a blocked
 * agent never gets our prompt typed into its confirmation box.
 */
export async function promptAgent(paneId: string, text: string): Promise<HerdrAgent | null> {
  // No `wait`: holding the HTTP request open until the agent settles is exactly
  // what the event stream replaces. herdr still hands back the post-prompt
  // snapshot, so the caller can echo a first status without another round trip.
  const result = await request("agent.prompt", { target: paneId, text }, PROMPT_TIMEOUT_MS);
  return toAgent(result["agent"]);
}

/** Literal text with no Enter — the "let me review it first" path. */
export async function sendText(paneId: string, text: string): Promise<void> {
  await request("pane.send_text", { pane_id: paneId, text });
}

/** A herdr toast. Best-effort: a failed notification must never fail a send. */
export async function notify(title: string, body?: string): Promise<void> {
  try {
    await request("notification.show", body === undefined ? { title } : { title, body });
  } catch {
    /* cosmetic only */
  }
}

/**
 * Display-only sidebar tokens on a pane, e.g. which page the browser is
 * pointing at. `ttl_ms` lets the badge expire on its own, so a crashed bridge
 * doesn't leave a stale marker behind. Passing a null value clears one.
 */
export async function reportTokens(
  paneId: string,
  source: string,
  tokens: Record<string, string | null>,
  ttlMs?: number,
): Promise<void> {
  const params: Record<string, unknown> = { pane_id: paneId, source, tokens };
  if (ttlMs !== undefined) params["ttl_ms"] = ttlMs;
  try {
    await request("pane.report_metadata", params);
  } catch {
    /* cosmetic only */
  }
}

/**
 * Normalize one pushed line. Scoped events carry their fields flat; lifecycle
 * events nest a full pane object, which is where titles come from — the status
 * event carries no title, verified against a live event.
 */
function toEvent(value: unknown): HerdrEvent | null {
  if (!isRecord(value)) return null;
  const name = readString(value, "event");
  if (name === null) return null;
  const data = value["data"];
  const payload = isRecord(data) ? data : {};
  const nested = isRecord(payload["pane"]) ? payload["pane"] : null;
  const paneId = readString(payload, "pane_id") ?? (nested === null ? null : readString(nested, "pane_id"));
  if (paneId === null) return null;

  // Dotted: the subscription-scoped events (SubscriptionEventKind).
  if (name === "pane.agent_status_changed") {
    const status = readStatus(payload["agent_status"]);
    return status === null ? null : { kind: "status", paneId, status };
  }

  // Underscored: the lifecycle events (EventKind).
  if (name === "pane_closed" || name === "pane_exited") return { kind: "closed", paneId };
  if (name === "pane_agent_detected") return { kind: "detected", paneId };
  if (name === "pane_updated") {
    const source = nested ?? payload;
    const title = readString(source, "terminal_title_stripped");
    return title === null
      ? null
      : { kind: "title", paneId, title, status: readStatus(source["agent_status"]) };
  }
  return null;
}

/**
 * Open a long-lived subscription. `onEvent` fires per pushed line; `onClose`
 * fires once when the stream ends, with the reason. The subscription set is
 * fixed at subscribe time — watching another pane means another call.
 *
 * Remember the naming flip: `specs` use dotted types, `HerdrEvent.event`
 * arrives underscored.
 */
export function subscribe(
  specs: SubscriptionSpec[],
  onEvent: (event: HerdrEvent) => void,
  onClose: (error: HerdrError | null) => void,
): Subscription {
  const socket = connect({ path: socketPath() });
  let buffer = "";
  let closed = false;

  const shutdown = (error: HerdrError | null): void => {
    if (closed) return;
    closed = true;
    socket.destroy();
    onClose(error);
  };

  socket.setEncoding("utf8");

  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: nextId(), method: "events.subscribe", params: { subscriptions: specs } })}\n`);
  });

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      shutdown(new HerdrError("protocol", "herdr event stream overflowed with no newline"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // one bad line must not kill a live stream
      }

      // Discriminate on shape, not on position or id: pushed events carry
      // `event`+`data` and no id at all, while a refused subscribe comes back
      // with an empty id. Keying on `id === ours` would drop every event.
      if (isRecord(parsed) && !("event" in parsed)) {
        try {
          unwrap("events.subscribe", line);
        } catch (error) {
          // Usually a bad spec — most often a missing pane_id on
          // pane.agent_status_changed, which herdr rejects outright.
          shutdown(error instanceof HerdrError ? error : new HerdrError("protocol", String(error)));
          return;
        }
        continue;
      }

      const event = toEvent(parsed);
      if (event !== null) onEvent(event);
    }
  });

  socket.on("error", (error: Error) => {
    shutdown(new HerdrError("unavailable", `herdr event stream: ${error.message}`));
  });

  socket.on("close", () => {
    shutdown(null);
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      socket.destroy();
    },
  } satisfies Subscription;
}

/** True when a herdr server is answering on the socket. */
export async function isAvailable(): Promise<boolean> {
  try {
    await request("ping", {}, 1_500);
    return true;
  } catch {
    return false;
  }
}
