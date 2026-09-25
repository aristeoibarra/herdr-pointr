/**
 * The bridge's HTTP API, with every response read field by field. The JSON
 * comes from another process — often a different build of it — so nothing is
 * trusted to have the shape it should: a missing field reads as empty rather
 * than blowing up the widget.
 */

import type { ElementPayload } from "./capture.ts";
import type { DiagnosticsPayload } from "./diagnostics.ts";
import type { AgentPin } from "./prefs.ts";
import { SEND_TIMEOUT_MS } from "./shot.ts";

export interface Anchor {
  selector: string;
  tag: string;
  id: string;
  component: string;
  framework: string;
  source: string;
  text: string;
  context: string;
}

export interface ThreadMessage {
  id: string;
  from: "user" | "agent";
  text: string;
  at: number;
  kind: string;
  busyAtSend: boolean;
  /** Kept by the bridge until the agent is free: can still be cancelled. */
  held: boolean;
}

export interface Thread {
  id: string;
  url: string;
  port: string;
  path: string;
  anchors: Anchor[];
  pane: string;
  agentKind: string;
  messages: ThreadMessage[];
  createdAt: number;
  updatedAt: number;
  resolved: boolean;
  unread: boolean;
  waiting: boolean;
}

export interface LiveAgent {
  kind: string;
  status: string;
  title: string;
}

export interface ThreadsResponse {
  rev: number;
  /** The page's upstream port: what thread.port is compared against. */
  port: string;
  key: string;
  unchanged: boolean;
  /** Absent when unchanged. */
  threads: Thread[] | null;
  resolvedCount: number;
  herdr: boolean;
  agents: Record<string, LiveAgent>;
}

export interface AgentEntry {
  id: string;
  label: string;
  kind: string;
  status: string;
  session: string | null;
}

export interface Failure {
  ok: false;
  reason: string;
  error: string;
  candidates: AgentEntry[];
}

export interface SendSuccess {
  ok: true;
  thread: Thread | null;
  project: string;
  stale: string;
}

export interface MessageSuccess {
  ok: true;
  thread: Thread | null;
  rerouted: boolean;
}

export interface CancelSuccess {
  ok: true;
  /** The agent never saw the thread, so it is gone. */
  deleted: boolean;
  texts: string[];
  thread: Thread | null;
}

export interface SendBody {
  message: string;
  url: string;
  page: string;
  elements: ElementPayload[];
  screenshot: string | null;
  targetAgent: AgentPin | null;
  diagnostics: DiagnosticsPayload;
}

export interface Destination {
  ok: boolean;
  project: string;
  kind: string;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (o: Json, key: string): string => (typeof o[key] === "string" ? o[key] : "");
const num = (o: Json, key: string): number => (typeof o[key] === "number" ? o[key] : 0);
const bool = (o: Json, key: string): boolean => o[key] === true;
const list = (o: Json, key: string): unknown[] => {
  const value = o[key];
  return Array.isArray(value) ? value : [];
};

export function readAnchor(v: unknown): Anchor | null {
  if (!isJson(v)) return null;
  return {
    selector: str(v, "selector"),
    tag: str(v, "tag"),
    id: str(v, "id"),
    component: str(v, "component"),
    framework: str(v, "framework"),
    source: str(v, "source"),
    text: str(v, "text"),
    context: str(v, "context"),
  };
}

function readMessage(v: unknown): ThreadMessage | null {
  if (!isJson(v)) return null;
  return {
    id: str(v, "id"),
    from: str(v, "from") === "agent" ? "agent" : "user",
    text: str(v, "text"),
    at: num(v, "at"),
    kind: str(v, "kind"),
    busyAtSend: bool(v, "busyAtSend"),
    held: bool(v, "held"),
  };
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

export function readThread(v: unknown): Thread | null {
  if (!isJson(v) || str(v, "id") === "") return null;
  return {
    id: str(v, "id"),
    url: str(v, "url"),
    port: str(v, "port"),
    path: str(v, "path"),
    anchors: list(v, "anchors").map(readAnchor).filter(present),
    pane: str(v, "pane"),
    agentKind: str(v, "agentKind"),
    messages: list(v, "messages").map(readMessage).filter(present),
    createdAt: num(v, "createdAt"),
    updatedAt: num(v, "updatedAt"),
    resolved: bool(v, "resolved"),
    unread: bool(v, "unread"),
    waiting: bool(v, "waiting"),
  };
}

function readAgentEntry(v: unknown): AgentEntry | null {
  if (!isJson(v) || str(v, "id") === "") return null;
  const session = v["session"];
  return {
    id: str(v, "id"),
    label: str(v, "label"),
    kind: str(v, "kind"),
    status: str(v, "status"),
    session: typeof session === "string" ? session : null,
  };
}

function readFailure(data: Json, fallback: string): Failure {
  return {
    ok: false,
    reason: str(data, "reason") || "bridge_error",
    error: str(data, "error") || fallback,
    candidates: list(data, "candidates").map(readAgentEntry).filter(present),
  };
}

/** A request that timed out, as opposed to one the bridge answered with an error. */
export class BridgeTimeout extends Error {
  constructor() {
    super("timed out");
    this.name = "BridgeTimeout";
  }
}

export interface Api {
  threads(url: string, since: number | null): Promise<ThreadsResponse>;
  send(body: SendBody): Promise<SendSuccess | Failure>;
  message(id: string, text: string, targetAgent: AgentPin | null): Promise<MessageSuccess | Failure>;
  resolve(id: string, resolved: boolean): Promise<Thread | null>;
  cancel(id: string): Promise<CancelSuccess | Failure>;
  deliver(id: string, targetAgent: AgentPin | null): Promise<MessageSuccess | Failure>;
  read(id: string): Promise<Thread | null>;
  agents(): Promise<AgentEntry[]>;
  destination(url: string): Promise<Destination>;
}

export function createApi(bridge: string): Api {
  async function call(path: string, init: RequestInit = {}, timeout = SEND_TIMEOUT_MS): Promise<Json> {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), timeout);
    try {
      const res = await fetch(`${bridge}${path}`, { ...init, signal: abort.signal });
      const data: unknown = await res.json();
      return isJson(data) ? data : {};
    } catch (error) {
      if (abort.signal.aborted) throw new BridgeTimeout();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      window.clearTimeout(timer);
    }
  }

  const post = (path: string, body: object): Promise<Json> =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    async threads(url, since) {
      const query = `url=${encodeURIComponent(url)}${since === null ? "" : `&since=${since}`}`;
      const data = await call(`/threads?${query}`, {}, 10_000);
      const agents: Record<string, LiveAgent> = {};
      const raw = data["agents"];
      if (isJson(raw)) {
        for (const [pane, value] of Object.entries(raw)) {
          if (isJson(value)) agents[pane] = { kind: str(value, "kind"), status: str(value, "status"), title: str(value, "title") };
        }
      }
      const unchanged = bool(data, "unchanged");
      return {
        rev: num(data, "rev"),
        port: str(data, "port"),
        key: str(data, "key"),
        unchanged,
        threads: unchanged ? null : list(data, "threads").map(readThread).filter(present),
        resolvedCount: num(data, "resolvedCount"),
        herdr: data["herdr"] !== false,
        agents,
      };
    },

    async send(body) {
      const data = await post("/send", body);
      if (!bool(data, "ok")) return readFailure(data, "The bridge refused the comment.");
      const stale = data["stale"];
      return {
        ok: true,
        thread: readThread(data["thread"]),
        project: str(data, "project"),
        stale: isJson(stale) ? str(stale, "reason") : "",
      };
    },

    async message(id, text, targetAgent) {
      const data = await post("/threads/message", { id, text, url: location.href, targetAgent });
      if (!bool(data, "ok")) return readFailure(data, "The bridge refused the reply.");
      return { ok: true, thread: readThread(data["thread"]), rerouted: bool(data, "rerouted") };
    },

    async resolve(id, resolved) {
      const data = await post("/threads/resolve", { id, resolved });
      return bool(data, "ok") ? readThread(data["thread"]) : null;
    },

    async cancel(id) {
      const data = await post("/threads/cancel", { id });
      if (!bool(data, "ok")) return readFailure(data, "Could not cancel it.");
      return {
        ok: true,
        deleted: bool(data, "deleted"),
        texts: list(data, "texts").filter((t): t is string => typeof t === "string"),
        thread: readThread(data["thread"]),
      };
    },

    async deliver(id, targetAgent) {
      const data = await post("/threads/deliver", { id, url: location.href, targetAgent });
      if (!bool(data, "ok")) return readFailure(data, "Could not send it.");
      return { ok: true, thread: readThread(data["thread"]), rerouted: bool(data, "rerouted") };
    },

    async read(id) {
      const data = await post("/threads/read", { id });
      return bool(data, "ok") ? readThread(data["thread"]) : null;
    },

    async agents() {
      const data = await call("/agents");
      return list(data, "agents").map(readAgentEntry).filter(present);
    },

    async destination(url) {
      const data = await call(`/resolve?url=${encodeURIComponent(url)}`);
      const agent = data["agent"];
      return { ok: bool(data, "ok"), project: str(data, "project"), kind: isJson(agent) ? str(agent, "kind") : "" };
    },
  };
}
