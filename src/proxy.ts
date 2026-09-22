import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type { Duplex, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The injection proxy: how the widget gets onto a page with nothing installed
 * in the browser.
 *
 * A dev server on :3000 is also served on :13000, identical except that every
 * page navigation gets the widget's <script> as the first thing in <head>, so
 * its diagnostics hooks beat the app's own code. Nothing else is touched: assets, API calls
 * and HMR are piped through byte for byte, never buffered or decoded, which
 * is what keeps a proxy in front of a dev server from costing anything.
 *
 * Proxies open on demand (`pointr open`, a ctrl-clicked link, /open) and close
 * after sitting idle with no connections, so nothing listens per project
 * unless it is in use.
 */

/** Proxy port = dev-server port + this, when free: 3000 → 13000, 5173 → 15173. */
const PORT_OFFSET = 10_000;
const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;
/**
 * Bound to IPv4 loopback only. A dev server bound to localhost is private on
 * purpose; a proxy on every interface would quietly publish it to the LAN.
 */
const LISTEN_HOST = "127.0.0.1";
/** Resolved by the OS, so a dev server on ::1 only (Vite's default) is reached too. */
const UPSTREAM_HOST = "localhost";

/** Hop-by-hop headers (RFC 9110 §7.6.1): meaningful per connection, never forwarded. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

interface Proxy {
  upstream: number;
  port: number;
  server: Server;
  lastUsed: number;
}

export interface ProxyRegistry {
  /** The proxy port fronting `upstream`, opening one if needed. */
  ensure(upstream: number): Promise<number>;
  /** proxy port → dev-server port, as strings, for routing. */
  aliases(): ReadonlyMap<string, string>;
  /** Whether the bridge serves this port itself — its own port or one of its proxies. */
  owns(port: number): boolean;
  closeAll(): void;
}

export function createProxyRegistry(options: { bridgePort: number; stateDir: string }): ProxyRegistry {
  const proxies = new Map<number, Proxy>();
  const opening = new Map<number, Promise<number>>();
  const stateFile = join(options.stateDir, "proxies.json");
  const widgetTag = Buffer.from(`<script src="http://localhost:${options.bridgePort}/widget.js"></script>`);

  const sweep = setInterval(() => {
    for (const proxy of proxies.values()) {
      if (Date.now() - proxy.lastUsed < IDLE_MS) continue;
      // An open tab holds its HMR socket, so a proxy anyone still looks at
      // always has a connection and is never swept from under them.
      proxy.server.getConnections((error, count) => {
        if (error !== null || count > 0) return;
        proxy.server.close();
        proxies.delete(proxy.upstream);
        persist();
      });
    }
  }, SWEEP_MS);
  sweep.unref();

  /**
   * Remembered across bridge restarts: herdr restarting takes the bridge with
   * it, and the tabs open on :13000 would otherwise refuse to reload.
   */
  function persist(): void {
    try {
      mkdirSync(options.stateDir, { recursive: true });
      writeFileSync(stateFile, JSON.stringify([...proxies.keys()]));
    } catch {
      // Losing this only costs a re-open after the next restart.
    }
  }

  function restore(): void {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;
    for (const upstream of saved) {
      if (typeof upstream === "number") void ensure(upstream).catch(() => undefined);
    }
  }

  async function ensure(upstream: number): Promise<number> {
    if (!Number.isInteger(upstream) || upstream < 1 || upstream > 65_535) {
      throw new Error(`not a port: ${upstream}`);
    }
    if (upstream === options.bridgePort) throw new Error("that is the bridge itself");
    // Asked to proxy a proxy: it already has the widget.
    for (const proxy of proxies.values()) {
      if (proxy.port === upstream) return upstream;
    }
    const existing = proxies.get(upstream);
    if (existing !== undefined) {
      existing.lastUsed = Date.now();
      return existing.port;
    }
    const pending = opening.get(upstream);
    if (pending !== undefined) return pending;

    const started = open(upstream).finally(() => opening.delete(upstream));
    opening.set(upstream, started);
    return started;
  }

  async function open(upstream: number): Promise<number> {
    const proxy: Proxy = { upstream, port: 0, server: createServer(), lastUsed: Date.now() };
    proxy.server.on("request", (req, res) => {
      proxy.lastUsed = Date.now();
      forward(proxy, req, res);
    });
    proxy.server.on("upgrade", (req, socket, head) => {
      proxy.lastUsed = Date.now();
      tunnel(proxy, req, socket, head);
    });

    const preferred = upstream + PORT_OFFSET;
    // A stable port is what lets a bookmark or an open tab survive a restart;
    // an ephemeral one is only the fallback when that port is taken.
    proxy.port = preferred <= 65_535 ? await listen(proxy.server, preferred).catch(() => listen(proxy.server, 0)) : await listen(proxy.server, 0);
    proxies.set(upstream, proxy);
    persist();
    return proxy.port;
  }

  function forward(proxy: Proxy, req: IncomingMessage, res: ServerResponse): void {
    const document = isNavigation(req);
    const headers = requestHeaders(req.headers, proxy);
    // Only for pages, and only so the one body we rewrite arrives plain; a
    // server that compresses anyway is decoded below.
    if (document) headers["accept-encoding"] = "identity";

    const upstreamReq = request(
      { host: UPSTREAM_HOST, port: proxy.upstream, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const outHeaders = responseHeaders(upstreamRes.headers, proxy);
        const html = String(upstreamRes.headers["content-type"] ?? "").includes("text/html");
        if (!document || !html || req.method === "HEAD" || status === 204 || status === 304) {
          res.writeHead(status, outHeaders);
          upstreamRes.pipe(res);
          return;
        }
        void collect(decoded(upstreamRes)).then(
          (body) => {
            const injected = injectWidget(body, widgetTag);
            delete outHeaders["content-encoding"];
            // The page's CSP would block a script from the bridge's origin.
            // Dev-only tooling on a dev server: dropping it is the point.
            delete outHeaders["content-security-policy"];
            delete outHeaders["content-security-policy-report-only"];
            outHeaders["content-length"] = injected.length;
            res.writeHead(status, outHeaders);
            res.end(injected);
          },
          () => res.destroy(),
        );
      },
    );
    upstreamReq.on("error", () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(unreachablePage(proxy.upstream));
    });
    req.pipe(upstreamReq);
  }

  /**
   * WebSocket upgrades (Vite/Next HMR) as a raw TCP tunnel: the handshake is
   * replayed with Host/Origin rewritten, then bytes flow both ways untouched.
   */
  function tunnel(proxy: Proxy, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upstream = connect({ host: UPSTREAM_HOST, port: proxy.upstream });
    const close = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("connect", () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? "";
        const value = req.rawHeaders[i + 1] ?? "";
        lines.push(`${name}: ${rewriteRequestHeader(name.toLowerCase(), value, proxy)}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  }

  restore();

  return {
    ensure,
    owns(port) {
      return port === options.bridgePort || [...proxies.values()].some((proxy) => proxy.port === port);
    },
    aliases() {
      return new Map([...proxies.values()].map((proxy) => [String(proxy.port), String(proxy.upstream)]));
    },
    closeAll() {
      clearInterval(sweep);
      for (const proxy of proxies.values()) {
        proxy.server.close();
        proxy.server.closeAllConnections();
      }
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LISTEN_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("proxy has no port"));
      else resolve(address.port);
    });
  });
}

/**
 * A top-level page load. Sec-Fetch-Dest says so outright; without it (an old
 * or non-browser client) a GET asking for HTML is the best available guess.
 * Iframes are left alone on purpose: one widget per tab, not one per frame.
 */
function isNavigation(req: IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (dest !== undefined) return dest === "document";
  return req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
}

/**
 * The dev server should see the request it would have seen without us: its
 * own port in Host, Origin and Referer. Next's server actions and Vite's
 * WebSocket check compare Origin against Host and reject a mismatch.
 */
function requestHeaders(incoming: IncomingHttpHeaders, proxy: Proxy): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.includes(name)) continue;
    headers[name] = typeof value === "string" ? rewriteRequestHeader(name, value, proxy) : value;
  }
  return headers;
}

function rewriteRequestHeader(name: string, value: string, proxy: Proxy): string {
  if (name === "host") return swapPort(value, proxy.port, proxy.upstream);
  if (name === "origin" || name === "referer") return swapPort(value, proxy.port, proxy.upstream);
  return value;
}

/** Redirects to the dev server's own port are sent back through the proxy. */
function responseHeaders(incoming: IncomingHttpHeaders, proxy: Proxy): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.includes(name)) continue;
    headers[name] = name === "location" && typeof value === "string" ? swapPort(value, proxy.upstream, proxy.port) : value;
  }
  return headers;
}

/** Swap `:from` for `:to` on a loopback host, whether in a bare Host or a URL. */
function swapPort(value: string, from: number, to: number): string {
  return value.replace(
    new RegExp(`(^|//)(localhost|127\\.0\\.0\\.1|\\[::1\\]):${from}(?=$|[/?#])`),
    `$1$2:${to}`,
  );
}

function decoded(res: IncomingMessage): Readable {
  switch (res.headers["content-encoding"]) {
    case "gzip":
      return res.pipe(createGunzip());
    case "deflate":
      return res.pipe(createInflate());
    case "br":
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

/**
 * Put the widget first inside <head>, else after <html> or the doctype, else
 * at the very start. Searched as latin1 so every byte is one char: the index
 * is a byte offset and the page's own encoding is never decoded or re-encoded.
 */
function injectWidget(body: Buffer, tag: Buffer): Buffer {
  const text = body.toString("latin1");
  const anchor = /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
  const at = anchor === null ? 0 : anchor.index + anchor[0].length;
  return Buffer.concat([body.subarray(0, at), tag, body.subarray(at)]);
}

/**
 * Where to send the browser for a dev-server URL, a `host:port`, or a bare
 * port — only ever a loopback address, since loopback is all the proxy serves.
 */
export function parseTarget(raw: string): { port: number; rest: string; hostname: string } | null {
  const trimmed = raw.trim();
  const withScheme = /^\d+$/.test(trimmed)
    ? `http://localhost:${trimmed}/`
    : /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port)) return null;
  // The proxy listens on IPv4 loopback; keep a hostname that reaches it and
  // shares the page's cookies (they are per host, not per port).
  const hostname = url.hostname === "[::1]" ? "localhost" : url.hostname;
  return { port, rest: `${url.pathname}${url.search}${url.hash}`, hostname };
}

function unreachablePage(port: number): string {
  return `<!doctype html><meta charset="utf-8"><title>pointr — nothing on :${port}</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px">
<h1 style="font-size:20px">Nothing is answering on localhost:${port}</h1>
<p>pointr is proxying this port, but the dev server behind it is not running. Start it and reload.</p>
</body>`;
}
