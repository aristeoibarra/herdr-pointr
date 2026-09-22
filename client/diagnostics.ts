/**
 * Page-level diagnostics buffer: recent console errors, uncaught exceptions,
 * unhandled rejections, and failed fetch requests. Installed as early as the
 * widget loads (the proxy injects it first in <head>), so a send carries
 * the "why is it broken" context — not just the rendered DOM.
 */

export interface DiagnosticsPayload {
  errors: string[];
  network: string[];
}

const MAX_ENTRIES = 8;
const MAX_LINE = 300;

const errors: string[] = [];
const network: string[] = [];

export function installDiagnostics(bridgeOrigin: string): void {
  // Window-level guard: the widget can be injected twice (proxy + bookmarklet).
  if (Reflect.get(window, "__pointrDiagnostics") === true) return;
  Reflect.set(window, "__pointrDiagnostics", true);

  window.addEventListener("error", (event) => {
    if (!(event instanceof ErrorEvent)) return;
    const where = event.filename ? ` (${shortPath(event.filename)}:${event.lineno})` : "";
    push(errors, `Uncaught: ${event.message}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    push(errors, `Unhandled rejection: ${describe(event.reason)}`);
  });

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    push(errors, `console.error: ${args.map(describe).join(" ")}`);
    originalError(...args);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    // The widget's own bridge traffic is noise, not app context.
    const own = url.startsWith(bridgeOrigin);
    try {
      const res = await originalFetch(input, init);
      if (!own && res.status >= 400) push(network, `${method} ${shortPath(url)} → ${res.status}`);
      return res;
    } catch (error) {
      if (!own) push(network, `${method} ${shortPath(url)} → network error (${describe(error)})`);
      throw error;
    }
  };
}

/** Copies, oldest first — safe for the caller to hold across awaits. */
export function getDiagnostics(): DiagnosticsPayload {
  return { errors: [...errors], network: [...network] };
}

function push(list: string[], entry: string): void {
  const at = new Date().toLocaleTimeString("en-GB");
  list.push(`[${at}] ${entry}`.slice(0, MAX_LINE));
  if (list.length > MAX_ENTRIES) list.shift();
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/** Origin stripped for same-page URLs; bundler hashes stay (they're greppable). */
function shortPath(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? `${u.pathname}${u.search}` : u.href;
  } catch {
    return url;
  }
}
