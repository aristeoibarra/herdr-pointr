export interface ElementPayload {
  selector: string;
  tag: string;
  id: string | null;
  component: string | null;
  componentStack: string[];
  props?: Record<string, string> | null;
  source: string | null;
  role: string | null;
  accessibleName: string | null;
  text: string;
  styles: Record<string, string>;
  box: { x: number; y: number; w: number; h: number };
  html: string;
}

export interface DiagnosticsPayload {
  /** console.error / uncaught exceptions / unhandled rejections, oldest first. */
  errors: string[];
  /** Failed fetches: "GET /api/x → 500", oldest first. */
  network: string[];
}

export interface SendPayload {
  message: string;
  url: string;
  elements: ElementPayload[];
  screenshot: string | null;
  autoSubmit: boolean;
  /**
   * Per-tab override picked in the extension popup. null/absent = auto-route.
   * `targetAgent` carries the agent session alongside the pane id, so the
   * bridge can tell a restarted agent from an unchanged one; `targetPane` is
   * the older bare-pane-id form a widget built before that may still send.
   */
  targetAgent?: { paneId: string; session: string | null } | null;
  targetPane?: string | null;
  diagnostics?: DiagnosticsPayload | null;
}

export function isSendPayload(value: unknown): value is SendPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === "string" &&
    typeof v.url === "string" &&
    Array.isArray(v.elements)
  );
}

/** Build a clean, Claude-friendly prompt from selected elements + request. */
export function formatPrompt(payload: SendPayload, screenshotPath: string | null): string {
  const lines: string[] = ["[pointr] UI change request from the browser", ""];

  lines.push(`Request: ${payload.message.trim() || "(no message provided)"}`);
  lines.push(`Page: ${payload.url}`);
  if (screenshotPath) lines.push(`Screenshot: ${screenshotPath}`);
  lines.push("");

  payload.elements.forEach((el, i) => {
    const heading = el.component ? `<${el.component}>` : `${el.tag}${el.id ? `#${el.id}` : ""}`;
    lines.push(`Element ${i + 1}: ${heading}`);
    if (el.componentStack.length > 0) {
      lines.push(`- Component path: ${el.componentStack.join(" › ")}`);
    }
    lines.push(`- Selector: ${el.selector}`);
    if (el.props && Object.keys(el.props).length > 0) {
      const props = Object.entries(el.props)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- Props: ${truncate(props, 500)}`);
    }
    if (el.source) lines.push(`- Source: ${el.source}`);
    if (el.role || el.accessibleName) {
      lines.push(`- Role/name: ${[el.role, el.accessibleName].filter(Boolean).join(" / ")}`);
    }
    lines.push(`- Box: ${el.box.w}×${el.box.h} at (${el.box.x}, ${el.box.y})`);
    const styles = formatStyles(el.styles);
    if (styles) lines.push(`- Key styles: ${styles}`);
    if (el.text) lines.push(`- Text: "${truncate(el.text, 200)}"`);
    lines.push("- HTML:");
    lines.push("```html");
    lines.push(truncate(el.html, 1500));
    lines.push("```");
    lines.push("");
  });

  const errors = stringList(payload.diagnostics?.errors);
  if (errors.length > 0) {
    lines.push("Recent console errors (oldest first):");
    for (const entry of errors) lines.push(`- ${truncate(entry, 300)}`);
    lines.push("");
  }
  const network = stringList(payload.diagnostics?.network);
  if (network.length > 0) {
    lines.push("Recent failed requests (oldest first):");
    for (const entry of network) lines.push(`- ${truncate(entry, 300)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** The payload crosses the network — trust nothing beyond isSendPayload's check. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function formatStyles(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
