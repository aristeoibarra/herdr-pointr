import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import type { BridgeConfig } from "./config.ts";
import type { HerdrAgent } from "./herdr.ts";
import { HerdrError, listAgents, notify, pasteText, promptAgent, reportTokens } from "./herdr.ts";
import { portStrategy, ownersForPort } from "./ports.ts";
import { resolveTarget, type AgentPin, type Resolution } from "./routing.ts";
import { attach, retain, seed } from "./watch.ts";
import { formatPrompt, isSendPayload, type SendPayload } from "./format.ts";
import { bookmarkletPage } from "./bookmarklet.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Pre-built widget: bundled next to dist/cli.js, or under ../dist in dev (tsx).
const WIDGET_CANDIDATES = [
  join(__dirname, "widget.global.js"),
  join(__dirname, "..", "dist", "widget.global.js"),
];
const MAX_BODY_BYTES = 5_000_000;
/**
 * How long a watcher is held open around a send. Long enough for the agent to
 * start working and for the browser's EventSource to connect, short enough that
 * an abandoned tab doesn't pin a herdr socket.
 */
const SEND_WATCH_MS = 90_000;
/** Just long enough to collapse the burst of /resolve calls when tabs wake. */
const AGENT_CACHE_MS = 1_000;

interface AgentEntry {
  id: string;
  label: string;
  path: string;
  kind: string;
  status: string;
  title: string;
  workspace: string;
  session: string | null;
  focused: boolean;
}

export function createServer(config: BridgeConfig) {
  let widgetCache: string | null = null;
  let agentCache: { at: number; agents: HerdrAgent[] } | null = null;
  let agentInflight: Promise<HerdrAgent[]> | null = null;

  async function loadWidget(): Promise<string> {
    if (widgetCache) return widgetCache;
    const file = WIDGET_CANDIDATES.find((p) => existsSync(p));
    if (!file) throw new Error("widget.global.js not found — run `npm run build`");
    widgetCache = await readFile(file, "utf8");
    return widgetCache;
  }

  /**
   * Cached agent list. The TTL is short because routing to a dead pane is far
   * worse than one extra socket; the single-flight matters more anyway, since
   * the extension injects into every localhost tab and they all call /resolve
   * at once when a window wakes.
   */
  async function agents(fresh = false): Promise<HerdrAgent[]> {
    if (!fresh && agentCache !== null && Date.now() - agentCache.at < AGENT_CACHE_MS) return agentCache.agents;
    if (agentInflight !== null) return agentInflight;
    agentInflight = listAgents()
      .then((live) => {
        agentCache = { at: Date.now(), agents: live };
        return live;
      })
      .finally(() => {
        agentInflight = null;
      });
    return agentInflight;
  }

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.writableEnded) return;
      const tooLarge = error instanceof PayloadTooLarge;
      if (tooLarge) res.setHeader("connection", "close");
      const failure = tooLarge
        ? { status: 413, reason: "payload_too_large", error: errorMessage(error) }
        : failureFor(error);
      sendJson(res, failure.status, { ok: false, reason: failure.reason, error: failure.error });
      // Only now is it safe to drop the half-read upload: the browser has the
      // explanation. Destroying before this turns "screenshot too big" into a
      // connection reset, which the widget can only report as "bridge offline".
      if (tooLarge) res.on("finish", () => req.destroy());
    });
  });

  // Node closes any request older than this, which would silently kill every
  // SSE stream at the five-minute mark. Event streams are meant to be long.
  server.requestTimeout = 0;

  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === "OPTIONS") {
      // A page served on the machine's LAN IP reaching localhost crosses into a
      // more-private network, which Chromium gates behind this preflight opt-in.
      // Without it the widget can only report "bridge offline". This must stay
      // ahead of route dispatch — /status depends on it too.
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("access-control-allow-private-network", "true");
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, targetAgent: config.targetAgent });
      return;
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(bookmarkletPage(config.port));
      return;
    }
    if (req.method === "GET" && pathname === "/widget.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(await loadWidget());
      return;
    }
    if (req.method === "GET" && pathname === "/debug") {
      const live = await agents(true).catch(() => []);
      const port = searchParams.get("port");
      const resolution = await resolveTarget({
        agents: live,
        url: searchParams.get("url") ?? `http://localhost:${port ?? ""}/`,
        override: null,
        pin: config.targetAgent,
        projectPath: config.projectPath,
      });
      sendJson(res, 200, {
        ok: true,
        cwd: process.cwd(),
        portStrategy: portStrategy(),
        portOwners: port === null ? [] : await ownersForPort(port),
        agents: live.map((agent) => entryFor(agent, live)),
        resolution: describe(resolution),
        trace: resolution.trace,
      });
      return;
    }
    if (req.method === "GET" && pathname === "/resolve") {
      const live = await agents();
      const resolution = await resolveTarget({
        agents: live,
        url: searchParams.get("url") ?? "",
        override: null,
        pin: config.targetAgent,
        projectPath: config.projectPath,
      });
      if (resolution.kind === "resolved") {
        sendJson(res, 200, {
          ok: true,
          project: basename(resolution.agent.cwd) || resolution.agent.cwd,
          agent: { paneId: resolution.agent.paneId, session: resolution.agent.sessionId },
          via: resolution.via,
          trace: resolution.trace,
        });
      } else {
        sendJson(res, 200, {
          ok: false,
          reason: resolution.kind === "ambiguous" ? "ambiguous" : "no_agents",
          candidates: resolution.candidates.map((agent) => entryFor(agent, live)),
          trace: resolution.trace,
        });
      }
      return;
    }
    // `/sessions` is the name the shipped extension popup still calls. Keeping
    // it saves a stale popup from showing an empty picker before it's reloaded.
    if (req.method === "GET" && (pathname === "/agents" || pathname === "/sessions")) {
      try {
        const live = await agents();
        const entries = live.map((agent) => entryFor(agent, live));
        sendJson(res, 200, { ok: true, agents: entries, sessions: entries });
      } catch {
        // herdr not running — degrade to an empty list so the widget shows "Auto".
        sendJson(res, 200, { ok: true, agents: [], sessions: [] });
      }
      return;
    }
    if (req.method === "GET" && pathname === "/status") {
      await handleStatus(req, res, searchParams);
      return;
    }
    if (req.method === "POST" && pathname === "/send") {
      await handleSend(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, reason: "not_found", error: "not found" });
  }

  /**
   * Agent status, live. The widget opens this after a send and closes it once
   * the agent settles — a permanently-open stream per localhost tab would pin
   * a connection per tab forever.
   *
   * `?once=1` answers with plain JSON instead, which is the fallback for a
   * browser without EventSource or a page whose CSP blocks the stream.
   */
  async function handleStatus(
    req: IncomingMessage,
    res: ServerResponse,
    searchParams: URLSearchParams,
  ): Promise<void> {
    const paneId = searchParams.get("agent");
    if (paneId === null || paneId.length === 0) {
      sendJson(res, 400, { ok: false, reason: "invalid_request", error: "missing agent" });
      return;
    }

    if (searchParams.get("once") === "1") {
      const live = await agents();
      const agent = live.find((candidate) => candidate.paneId === paneId);
      if (agent === undefined) sendJson(res, 200, { ok: false, reason: "stale_target" });
      else sendJson(res, 200, { ok: true, status: agent.status, title: agent.title });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells any proxy in front not to buffer the stream into uselessness.
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    const accepted = await attach(paneId, res);
    if (!accepted) {
      res.write(`event: error\ndata: ${JSON.stringify({ reason: "too_many_watchers" })}\n\n`);
      res.end();
    }
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { ok: false, reason: "invalid_request", error: "invalid JSON" });
      return;
    }
    if (!isSendPayload(parsed)) {
      sendJson(res, 400, { ok: false, reason: "invalid_request", error: "missing message/url/elements" });
      return;
    }

    const live = await agents();
    const resolution = await resolveTarget({
      agents: live,
      url: parsed.url,
      override: overrideFrom(parsed),
      pin: config.targetAgent,
      projectPath: config.projectPath,
    });

    if (resolution.kind !== "resolved") {
      const ambiguous = resolution.kind === "ambiguous";
      sendJson(res, 409, {
        ok: false,
        reason: ambiguous ? "ambiguous" : "no_agents",
        error: ambiguous
          ? "Several agents could be working on this project — pick one in the extension popup."
          : "No agent found for this project. Open one in herdr inside the project directory, or pin one.",
        candidates: resolution.candidates.map((agent) => entryFor(agent, live)),
        trace: resolution.trace,
      });
      return;
    }

    const { agent } = resolution;
    const screenshotPath = parsed.screenshot ? await saveScreenshot(parsed.screenshot) : null;
    const prompt = formatPrompt(parsed, screenshotPath);
    const autoSubmit = parsed.autoSubmit !== false;

    try {
      if (autoSubmit) {
        // Subscribe before prompting: subscriptions don't replay, so a watcher
        // opened afterwards would miss the very transition it exists to report.
        retain(agent.paneId, SEND_WATCH_MS);
        const after = await promptAgent(agent.paneId, prompt);
        seed(agent.paneId, after?.status ?? null, after?.sessionId ?? agent.sessionId);
      } else {
        // pane.send_text is pane-level and has no agent_blocked guard, so text
        // typed into an open approval dialog could answer it. Check what we
        // already know before writing. Racy, but it turns the common case from
        // a silent "yes" into a clear refusal.
        if (agent.status === "blocked") throw new HerdrError("agent_blocked", "agent is blocked");
        await pasteText(agent.paneId, prompt);
      }
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        // Surface it where the user has to act — in herdr, not only in the tab.
        void notify("Bridge", "An agent is blocked on an approval dialog");
      }
      const failure = failureFor(error);
      sendJson(res, failure.status, {
        ok: false,
        reason: failure.reason,
        error: failure.error,
        agent: agent.paneId,
      });
      return;
    }

    // Show in herdr's sidebar which page this pane is pointed at. Self-expiring,
    // so a crashed bridge leaves no stale marker.
    void reportTokens(agent.paneId, "bridge", { browser: shortUrl(parsed.url) }, 120_000);

    sendJson(res, 200, {
      ok: true,
      targetAgent: { paneId: agent.paneId, session: agent.sessionId },
      project: basename(agent.cwd) || agent.cwd,
      screenshot: screenshotPath,
      status: agent.status,
      autoSubmitted: autoSubmit,
      stale: resolution.stale,
    });
  }
}

function overrideFrom(payload: SendPayload): AgentPin | null {
  if (payload.targetAgent !== undefined && payload.targetAgent !== null) return payload.targetAgent;
  if (typeof payload.targetPane === "string" && payload.targetPane.length > 0) {
    return { paneId: payload.targetPane, session: null };
  }
  return null;
}

function describe(resolution: Resolution): string {
  return resolution.kind === "resolved" ? `${resolution.via}:${resolution.agent.paneId}` : resolution.kind;
}

/**
 * A label for the popup's picker.
 *
 * Only stable fields go in: the extension persists this string next to the pin
 * so it never has to call /agents again, and a status baked into it would be
 * wrong seconds later. Status and title ship as separate live fields.
 */
function entryFor(agent: HerdrAgent, all: HerdrAgent[]): AgentEntry {
  const project = basename(agent.cwd) || agent.cwd;
  const collides = all.some(
    (other) =>
      other.paneId !== agent.paneId &&
      (basename(other.cwd) || other.cwd) === project &&
      other.kind === agent.kind,
  );
  return {
    id: agent.paneId,
    label: collides ? `${project} · ${agent.kind} · ${agent.workspaceId}` : `${project} · ${agent.kind}`,
    path: agent.cwd,
    kind: agent.kind,
    status: agent.status,
    title: agent.title,
    workspace: agent.workspaceId,
    session: agent.sessionId,
    focused: agent.focused,
  } satisfies AgentEntry;
}

function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 32);
  } catch {
    return "browser";
  }
}

interface HttpFailure {
  status: number;
  reason: string;
  error: string;
}

/** Turn a herdr refusal into an answer the widget can render distinctly. */
function failureFor(error: unknown): HttpFailure {
  if (!(error instanceof HerdrError)) {
    return { status: 500, reason: "bridge_error", error: errorMessage(error) };
  }
  switch (error.code) {
    case "agent_blocked":
      // A conflict with current state, not an outage: the user can clear it and
      // retry the identical request, so it must not read as "bridge broken".
      return {
        status: 409,
        reason: "agent_blocked",
        error: "That agent is waiting on an approval dialog in its terminal — answer it there, then send again.",
      };
    case "agent_not_found":
    case "pane_not_found":
      return { status: 409, reason: "stale_target", error: "That agent is gone." };
    case "unavailable":
      return { status: 503, reason: "herdr_down", error: "herdr isn't answering — is it running?" };
    case "timeout":
      return { status: 504, reason: "herdr_timeout", error: "herdr did not answer in time." };
    case "protocol":
      return { status: 502, reason: "herdr_protocol", error: "Unexpected response from herdr." };
    default:
      return { status: 502, reason: "herdr_error", error: error.message };
  }
}

async function saveScreenshot(dataUrl: string): Promise<string | null> {
  const match = /^data:image\/(?:png|jpeg);base64,(.+)$/s.exec(dataUrl);
  if (!match?.[1]) return null;
  const dir = join(tmpdir(), "herdr-pointr");
  await mkdir(dir, { recursive: true });
  // Random suffix: two quick sends can land on the same millisecond.
  const file = join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await writeFile(file, Buffer.from(match[1], "base64"));
  return file;
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Thrown past the limit so the request handler can answer 413 instead of 500. */
class PayloadTooLarge extends Error {
  constructor(limit: number) {
    super(`payload too large — over ${Math.round(limit / 1_000_000)} MB (usually an oversized screenshot)`);
    this.name = "PayloadTooLarge";
  }
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        // Stop buffering, but keep the socket alive so the 413 can be written.
        req.pause();
        reject(new PayloadTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
