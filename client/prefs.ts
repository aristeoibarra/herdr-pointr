/**
 * Widget preferences, kept in the page's localStorage. localStorage is per
 * origin, and origin includes the port — so every setting is per app: a
 * destination chosen for one app never follows you to another.
 */

export type ShotTarget = "element" | "viewport";

export interface Hotkey {
  /** KeyboardEvent.code — layout-independent (Alt+C yields "ç" in e.key on macOS). */
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * A pinned destination. The session id rides along so the bridge can tell an
 * agent that restarted in the same terminal from one that never moved.
 */
export interface AgentPin {
  paneId: string;
  session: string | null;
}

export interface Prefs {
  autoSend: boolean;
  /** Attach a screenshot to the next send — toggled from the panel itself. */
  shot: boolean;
  /** What the screenshot frames; remembered even while `shot` is off. */
  shotTarget: ShotTarget;
  /** Agent pinned in settings, or null for auto-routing. */
  targetAgent: AgentPin | null;
  /** Human label for the pinned agent, so the panel needn't refetch /agents. */
  targetAgentLabel: string | null;
  hotkey: Hotkey;
}

const PREFS_KEY = "pointr-prefs";

export const DEFAULT_HOTKEY: Hotkey = { code: "KeyC", alt: true, ctrl: false, shift: false, meta: false };

export function normalizeHotkey(h: Hotkey): Hotkey {
  return {
    code: h.code,
    alt: h.alt === true,
    ctrl: h.ctrl === true,
    shift: h.shift === true,
    meta: h.meta === true,
  };
}

export function hotkeyLabel(h: Hotkey): string {
  const parts: string[] = [];
  if (h.ctrl) parts.push("Ctrl");
  if (h.alt) parts.push("Alt");
  if (h.shift) parts.push("Shift");
  if (h.meta) parts.push("⌘");
  parts.push(h.code.replace(/^(?:Key|Digit)/, ""));
  return parts.join("+");
}

export function matchesHotkey(e: KeyboardEvent, h: Hotkey): boolean {
  return (
    e.code === h.code &&
    e.altKey === h.alt &&
    e.ctrlKey === h.ctrl &&
    e.shiftKey === h.shift &&
    e.metaKey === h.meta
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readHotkey(value: unknown): Hotkey | null {
  if (!isRecord(value) || typeof value["code"] !== "string") return null;
  return normalizeHotkey({
    code: value["code"],
    alt: value["alt"] === true,
    ctrl: value["ctrl"] === true,
    shift: value["shift"] === true,
    meta: value["meta"] === true,
  });
}

/** Every field is validated on its own: one bad value never costs the rest. */
export function loadPrefs(): Prefs {
  const prefs: Prefs = {
    autoSend: true,
    shot: false,
    shotTarget: "element",
    targetAgent: null,
    targetAgentLabel: null,
    hotkey: { ...DEFAULT_HOTKEY },
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    if (!isRecord(saved)) return prefs;
    if (typeof saved["autoSend"] === "boolean") prefs.autoSend = saved["autoSend"];
    if (typeof saved["shot"] === "boolean") prefs.shot = saved["shot"];
    const shotTarget = saved["shotTarget"];
    if (shotTarget === "element" || shotTarget === "viewport") prefs.shotTarget = shotTarget;
    // shotMode was superseded by shot + shotTarget.
    const shotMode = saved["shotMode"];
    if (shotMode === "off" || shotMode === "element" || shotMode === "viewport") {
      prefs.shot = shotMode !== "off";
      if (shotMode !== "off") prefs.shotTarget = shotMode;
    }
    const pin = saved["targetAgent"];
    if (isRecord(pin) && typeof pin["paneId"] === "string") {
      prefs.targetAgent = { paneId: pin["paneId"], session: typeof pin["session"] === "string" ? pin["session"] : null };
    }
    if (typeof saved["targetAgentLabel"] === "string") prefs.targetAgentLabel = saved["targetAgentLabel"];
    const hotkey = readHotkey(saved["hotkey"]);
    if (hotkey) prefs.hotkey = hotkey;
  } catch {
    /* unreadable or blocked storage: defaults */
  }
  return prefs;
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* blocked storage: the setting lasts for this page only */
  }
}
