/**
 * pointr browser widget.
 * Injected via <script src="http://localhost:PORT/widget.js"> in development.
 * Select DOM elements, add context, and send to the agent that owns the project.
 */

import { buildElementPayload, type ElementPayload } from "./capture.ts";
import { getDiagnostics, installDiagnostics } from "./diagnostics.ts";
import { loadDomToPng } from "./shot-loader.ts";

interface PickedItem {
  element: Element;
  payload: ElementPayload;
}

type ShotTarget = "element" | "viewport";

interface Hotkey {
  /** KeyboardEvent.code — layout-independent (Alt+C yields "ç" in e.key on macOS). */
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

const DEFAULT_HOTKEY: Hotkey = { code: "KeyC", alt: true, ctrl: false, shift: false, meta: false };

/**
 * Rasterizing waits on every image and font the element pulls in, and a picked
 * container can be the whole page — `domToPng` has no timeout of its own, so
 * without these the panel sits on "Sending…" forever with no way back.
 */
const SHOT_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 20_000;
/** Base64 chars, kept under the bridge's 5 MB body cap with room for the prompt. */
const MAX_SHOT_CHARS = 4_000_000;

class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

/**
 * The underlying work keeps running (neither domToPng nor a stalled decode can
 * be cancelled) — this only stops the UI from waiting on it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new TimeoutError()), ms);
    const done = (): void => window.clearTimeout(timer);
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A pinned destination. The session id rides along so the bridge can tell an
 * agent that restarted in the same terminal from one that never moved.
 */
interface AgentPin {
  paneId: string;
  session: string | null;
}

interface Prefs {
  autoSend: boolean;
  /** Attach a screenshot to the next send — toggled from the panel itself. */
  shot: boolean;
  /** What the screenshot frames; remembered even while `shot` is off. */
  shotTarget: ShotTarget;
  /** Agent pinned in settings, or null for auto-routing. Per origin, as localStorage is. */
  targetAgent: AgentPin | null;
  /** Human label for the pinned agent, so the panel needn't refetch /agents. */
  targetAgentLabel: string | null;
  hotkey: Hotkey;
}

// Inline SVGs (no external assets — the widget is a single bundle).
const ICON_AI =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.7 5.4 5.4 1.7-5.4 1.7L12 16.4l-1.7-5.4L4.9 9.3l5.4-1.7z"/><path d="M18.6 13.6l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>';
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

interface WidgetHandle {
  dispose(): void;
}

const HANDLE_KEY = "__pointrWidget";

function isWidgetHandle(value: unknown): value is WidgetHandle {
  return typeof value === "object" && value !== null && "dispose" in value && typeof value.dispose === "function";
}

(function initWidget(): void {
  const ROOT_ID = "pointr-root";

  // Origin of the bridge that served this script — works on any port, no build-time define.
  const loader = document.currentScript as HTMLScriptElement | null;
  const BRIDGE_ORIGIN = loader?.src ? new URL(loader.src).origin : "http://localhost:7331";

  // Hook console/fetch/error before the app code runs (the proxy puts this
  // script first in <head>), and before the double-injection guard below.
  installDiagnostics(BRIDGE_ORIGIN);

  if (document.getElementById(ROOT_ID)) return;

  // A previous instance whose root was removed — Pointr.tsx unmounting under
  // StrictMode or HMR, then loading the script again — still has its document
  // and window listeners attached. Tear it down before mounting over it, or
  // every keypress runs twice.
  const previous: unknown = Reflect.get(window, HANDLE_KEY);
  if (isWidgetHandle(previous)) previous.dispose();
  const life = new AbortController();
  const { signal } = life;

  const host = document.createElement("div");
  host.id = ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
      .hidden { display: none !important; }
      /* Author rules such as .picked's display:flex outrank the UA's [hidden]. */
      [hidden] { display: none !important; }

      /* Launcher: one button, one meaning. Settings live behind the panel's gear. */
      .fab {
        position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;
        width: 52px; height: 52px; border-radius: 50%;
        background: #d97757; color: #fff; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 14px rgba(0,0,0,.28);
        transition: background .15s, transform .15s;
      }
      .fab:hover { transform: scale(1.06); }
      .fab.armed { background: #1a1a1a; }
      .fab svg { width: 24px; height: 24px; display: block; }

      .overlay {
        position: fixed; z-index: 2147483645; pointer-events: none;
        border: 2px solid #d97757; background: rgba(217,119,87,.12);
        border-radius: 3px; display: none;
      }

      .panel {
        position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
        width: 360px; max-height: 80vh; overflow-y: auto;
        background: #1a1a1a; color: #f5f5f5; border-radius: 14px;
        padding: 16px; box-shadow: 0 10px 34px rgba(0,0,0,.45); display: none;
      }
      .panel.open { display: block; }

      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .head .title { font-size: 13px; font-weight: 700; color: #f5b78f; }
      .head .x { border: none; background: none; color: #999; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }
      .head .x:hover { color: #fff; }

      .dest { font-size: 11px; margin-bottom: 10px; color: #8a8a8a; display: flex; align-items: center; gap: 5px; }
      .dest.ok { color: #6ee7a8; }
      .dest.err { color: #ff8a8a; }
      .dest.pin { color: #f5b78f; }

      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .chip {
        display: inline-flex; align-items: center; gap: 4px;
        background: #2a2a2a; border-radius: 6px; padding: 3px 6px; font-size: 11px; color: #ddd;
      }
      .chip button { border: none; background: none; color: #ff8a8a; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }

      .picked {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        background: #141414; border: 1px solid #2e2e2e; border-radius: 8px;
        padding: 8px 10px; margin-bottom: 10px;
      }
      .picked .name { font-size: 13px; font-weight: 700; color: #f5b78f; }
      .picked .meta { font-size: 11px; color: #9a9a9a; margin-top: 2px; word-break: break-all; }
      .picked .nav { display: flex; gap: 2px; flex-shrink: 0; }
      .picked .nav button {
        border: none; background: transparent; color: #9a9a9a; cursor: pointer;
        font-size: 11px; padding: 4px 7px; border-radius: 6px;
      }
      .picked .nav button:hover { background: #2a2a2a; color: #f5b78f; }

      .compose { position: relative; }
      textarea {
        width: 100%; min-height: 76px; resize: vertical; border-radius: 10px;
        border: 1px solid #3a3a3a; background: #0f0f0f; color: #f5f5f5;
        padding: 10px; font-size: 13px; outline: none;
      }
      textarea:focus { border-color: #d97757; }

      .gear {
        margin-left: auto; width: 24px; height: 24px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        background: none; border: none; color: #8a8a8a; cursor: pointer;
      }
      .gear:hover { color: #d97757; }
      .gear svg { width: 15px; height: 15px; display: block; }
      .gear.on { color: #d97757; }

      .settings { display: grid; gap: 12px; padding: 4px 0 2px; }
      .set-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        font-size: 12px; color: #c9c9c9;
      }
      .set-row select, .set-row .hotkey {
        flex: 1; min-width: 0; max-width: 62%;
        background: #1f1f1f; color: #e8e8e8; border: 1px solid #3a3a3a;
        border-radius: 8px; padding: 6px 8px; font-size: 12px; font-family: inherit;
      }
      .set-row .hotkey { cursor: pointer; text-align: center; }
      .set-row .hotkey.rec { border-color: #d97757; color: #f5b78f; }
      .set-note { font-size: 11px; color: #8a8a8a; }
      .set-note.err { color: #ff8a8a; }
      .set-foot { font-size: 11px; color: #6f6f6f; line-height: 1.5; }

      .opts {
        display: flex; align-items: center; gap: 10px;
        margin-top: 10px; font-size: 12px; color: #bbb;
      }
      .opts label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .seg { display: flex; border: 1px solid #3a3a3a; border-radius: 8px; overflow: hidden; }
      .seg button {
        border: none; background: transparent; color: #8a8a8a;
        font-size: 11px; padding: 4px 9px; cursor: pointer;
      }
      .seg button:hover { color: #ddd; }
      .seg button.on { background: #2f2f2f; color: #f5b78f; }
      .seg.off { opacity: .4; pointer-events: none; }

      .row { display: flex; gap: 8px; margin-top: 10px; }
      .row .send { flex: 1; }
      button.send {
        border: none; border-radius: 10px; padding: 11px; font-size: 13px; font-weight: 700;
        background: #d97757; color: #fff; cursor: pointer;
      }
      button.send:hover { background: #c8693f; }
      button.send:disabled { opacity: .5; cursor: default; }
      button.ghost {
        border: 1px solid #3a3a3a; border-radius: 10px; padding: 11px 14px; font-size: 13px;
        background: transparent; color: #bbb; cursor: pointer;
      }
      button.ghost:hover { background: #242424; color: #fff; }

      .status { font-size: 12px; margin-top: 8px; min-height: 16px; }
      .status.ok { color: #6ee7a8; }
      .status.err { color: #ff8a8a; }
      .status.warn { color: #ffd479; }
    </style>

    <button class="fab" title="Select an element (Alt+C)"></button>
    <div class="overlay"></div>

    <div class="panel">
      <div class="head">
        <span class="title">Send to agent</span>
        <button class="gear" title="Settings"></button>
        <button class="x close-panel" title="Close">✕</button>
      </div>
      <div class="body">
      <div class="dest"></div>
      <div class="chips"></div>
      <div class="picked" hidden>
        <div>
          <div class="name"></div>
          <div class="meta"></div>
        </div>
        <div class="nav">
          <button class="parent" title="Select parent element">↑</button>
          <button class="child" title="Select child element">↓</button>
          <button class="add" title="Keep this and pick another">+ add</button>
        </div>
      </div>
      <div class="compose">
        <textarea placeholder="Describe the change you want…"></textarea>
      </div>
      <div class="opts">
        <label title="Attach a PNG to this send.">
          <input type="checkbox" class="shot"> screenshot
        </label>
        <div class="seg">
          <button class="shot-element" title="Tight crop of the selected element">element</button>
          <button class="shot-viewport" title="Whole viewport, selection outlined">viewport</button>
        </div>
      </div>
      <div class="row">
        <button class="send">Send to agent</button>
      </div>
      </div>
      <div class="settings" hidden>
        <div class="set-row">
          <span>Destination</span>
          <select class="agent-select"></select>
        </div>
        <div class="set-note"></div>
        <label class="set-row">
          <span>Send on click</span>
          <input type="checkbox" class="autosend">
        </label>
        <div class="set-row">
          <span>Shortcut</span>
          <button class="hotkey"></button>
        </div>
        <div class="set-foot">
          The destination is remembered per site. The shortcut and send-on-click
          are the same everywhere.
        </div>
      </div>
      <div class="status"></div>
    </div>
  `;

  const q = <T extends Element>(sel: string): T => shadow.querySelector(sel) as T;
  const fab = q<HTMLButtonElement>(".fab");
  const overlay = q<HTMLDivElement>(".overlay");
  const panel = q<HTMLDivElement>(".panel");
  const chips = q<HTMLDivElement>(".chips");
  const pickedBox = q<HTMLDivElement>(".picked");
  const nameEl = q<HTMLDivElement>(".name");
  const metaEl = q<HTMLDivElement>(".meta");
  const textarea = q<HTMLTextAreaElement>("textarea");
  const shotCheck = q<HTMLInputElement>(".shot");
  const shotSeg = q<HTMLDivElement>(".seg");
  const shotElementBtn = q<HTMLButtonElement>(".shot-element");
  const shotViewportBtn = q<HTMLButtonElement>(".shot-viewport");
  const sendBtn = q<HTMLButtonElement>(".send");
  const status = q<HTMLDivElement>(".status");
  const dest = q<HTMLDivElement>(".dest");
  const gearBtn = q<HTMLButtonElement>(".gear");
  const bodyEl = q<HTMLDivElement>(".body");
  const settingsEl = q<HTMLDivElement>(".settings");
  const agentSelect = q<HTMLSelectElement>(".agent-select");
  const setNote = q<HTMLDivElement>(".set-note");
  const autoSendCheck = q<HTMLInputElement>(".autosend");
  const hotkeyBtn = q<HTMLButtonElement>(".hotkey");

  fab.innerHTML = ICON_AI;
  gearBtn.innerHTML = ICON_GEAR;

  const PREFS_KEY = "pointr-prefs";
  const prefs: Prefs = {
    autoSend: true,
    shot: false,
    shotTarget: "element",
    targetAgent: null,
    targetAgentLabel: null,
    hotkey: { ...DEFAULT_HOTKEY },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs> & {
      shotMode?: string; // superseded by shot + shotTarget
    };
    if (typeof saved.autoSend === "boolean") prefs.autoSend = saved.autoSend;
    if (typeof saved.shot === "boolean") prefs.shot = saved.shot;
    if (saved.shotTarget === "element" || saved.shotTarget === "viewport") {
      prefs.shotTarget = saved.shotTarget;
    }
    if (saved.shotMode === "off" || saved.shotMode === "element" || saved.shotMode === "viewport") {
      prefs.shot = saved.shotMode !== "off";
      if (saved.shotMode !== "off") prefs.shotTarget = saved.shotMode;
    }
    if (saved.targetAgent && typeof saved.targetAgent.paneId === "string") {
      prefs.targetAgent = saved.targetAgent;
    }
    if (typeof saved.targetAgentLabel === "string") prefs.targetAgentLabel = saved.targetAgentLabel;
    if (typeof saved.hotkey === "object" && saved.hotkey !== null && typeof saved.hotkey.code === "string") {
      prefs.hotkey = normalizeHotkey(saved.hotkey);
    }
  } catch {
    /* ignore */
  }

  function syncShotUi(): void {
    shotCheck.checked = prefs.shot;
    shotSeg.classList.toggle("off", !prefs.shot);
    shotElementBtn.classList.toggle("on", prefs.shotTarget === "element");
    shotViewportBtn.classList.toggle("on", prefs.shotTarget === "viewport");
  }
  syncShotUi();

  function hotkeyLabel(h: Hotkey): string {
    const parts: string[] = [];
    if (h.ctrl) parts.push("Ctrl");
    if (h.alt) parts.push("Alt");
    if (h.shift) parts.push("Shift");
    if (h.meta) parts.push("⌘");
    parts.push(h.code.replace(/^(?:Key|Digit)/, ""));
    return parts.join("+");
  }

  function normalizeHotkey(h: Hotkey): Hotkey {
    return {
      code: h.code,
      alt: h.alt === true,
      ctrl: h.ctrl === true,
      shift: h.shift === true,
      meta: h.meta === true,
    };
  }

  function matchesHotkey(e: KeyboardEvent, h: Hotkey): boolean {
    return (
      e.code === h.code &&
      e.altKey === h.alt &&
      e.ctrlKey === h.ctrl &&
      e.shiftKey === h.shift &&
      e.metaKey === h.meta
    );
  }

  const selectTitle = (): string => `Select an element (${hotkeyLabel(prefs.hotkey)})`;

  const savePrefs = (): void => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  };

  // ── Settings, in the widget ──────────────────────────────────────────────
  // Kept in the page's localStorage, which is scoped to the origin: a
  // destination chosen for one app never follows you to another.

  interface AgentEntry {
    id: string;
    label: string;
    status: string;
    session: string | null;
  }

  let settingsOpen = false;
  let recordingHotkey = false;

  function renderHotkeyBtn(): void {
    hotkeyBtn.textContent = recordingHotkey
      ? "press a combo… (Esc cancels)"
      : hotkeyLabel(prefs.hotkey);
    hotkeyBtn.classList.toggle("rec", recordingHotkey);
  }

  async function loadAgents(): Promise<void> {
    const pinned = prefs.targetAgent;
    agentSelect.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto — from this page's port";
    agentSelect.append(auto);

    try {
      const r = await withTimeout(fetch(`${BRIDGE_ORIGIN}/agents`), SEND_TIMEOUT_MS);
      const data = (await r.json()) as { agents?: AgentEntry[] };
      const agents = data.agents ?? [];
      for (const agent of agents) {
        const opt = document.createElement("option");
        opt.value = agent.id;
        // Status is rendered here and never stored: it changes by the second.
        opt.textContent = `${agent.label} — ${agent.status}`;
        opt.dataset["label"] = agent.label;
        opt.dataset["session"] = agent.session ?? "";
        agentSelect.append(opt);
      }
      // A pin the bridge no longer lists is a dead pane id — they are never
      // reused, so say so instead of silently showing Auto.
      const stale = pinned !== null && !agents.some((a) => a.id === pinned.paneId);
      agentSelect.value = stale ? "" : (pinned?.paneId ?? "");
      setNote.textContent = stale
        ? "That agent is gone — sends fall back to auto-routing."
        : agents.length === 0
          ? "herdr reports no agents open."
          : "";
      setNote.classList.toggle("err", stale);
    } catch {
      // Offline proves nothing about the pin, so keep it selectable.
      if (pinned !== null) {
        const opt = document.createElement("option");
        opt.value = pinned.paneId;
        opt.textContent = prefs.targetAgentLabel ?? pinned.paneId;
        agentSelect.append(opt);
        agentSelect.value = pinned.paneId;
      }
      setNote.textContent = "Bridge offline — showing the last known pin.";
      setNote.classList.add("err");
    }
  }

  function openSettings(): void {
    settingsOpen = true;
    bodyEl.hidden = true;
    settingsEl.hidden = false;
    gearBtn.classList.add("on");
    autoSendCheck.checked = prefs.autoSend;
    renderHotkeyBtn();
    void loadAgents();
  }

  function closeSettings(): void {
    settingsOpen = false;
    recordingHotkey = false;
    bodyEl.hidden = false;
    settingsEl.hidden = true;
    gearBtn.classList.remove("on");
    void updateDest();
  }

  async function updateDest(): Promise<void> {
    if (prefs.targetAgent) {
      const label = prefs.targetAgentLabel ?? prefs.targetAgent.paneId;
      dest.textContent = `→ ${label} (pinned)`;
      dest.className = "dest pin";
      return;
    }
    dest.textContent = "resolving…";
    dest.className = "dest";
    try {
      const r = await withTimeout(
        fetch(`${BRIDGE_ORIGIN}/resolve?url=${encodeURIComponent(location.href)}`),
        SEND_TIMEOUT_MS,
      );
      const d = (await r.json()) as { ok: boolean; project?: string };
      dest.textContent = d.ok ? `→ ${d.project}` : "→ no agent for this project";
      dest.className = d.ok ? "dest ok" : "dest err";
    } catch {
      dest.textContent = "→ bridge offline";
      dest.className = "dest err";
    }
  }

  // ── State machine: idle ↔ selecting ↔ composing ──────────────────────────
  let selecting = false;
  let focused: Element | null = null;
  const picked: PickedItem[] = [];

  const isOwn = (node: EventTarget | null): boolean =>
    node instanceof Node && host.contains(node);

  /** Return to the resting state: launcher visible, nothing selected/open. */
  function goIdle(): void {
    closeStream(); // and never leave a status stream behind one either
    if (settingsOpen) closeSettings();
    selecting = false;
    fab.innerHTML = ICON_AI;
    fab.classList.remove("armed");
    fab.title = selectTitle();
    panel.classList.remove("open");
    drawOverlay(null);
    fab.classList.remove("hidden");
  }

  /**
   * Fetch the rasterizer while the user is still picking and typing, so the
   * send does not pay for the download. Failure is left for the send to report.
   */
  function prefetchShot(): void {
    loadDomToPng(BRIDGE_ORIGIN).catch(() => undefined);
  }

  function startSelect(): void {
    if (prefs.shot) prefetchShot();
    selecting = true;
    fab.innerHTML = ICON_CLOSE;
    fab.classList.add("armed");
    fab.title = "Esc to cancel";
    panel.classList.remove("open");
    fab.classList.remove("hidden"); // it is the cancel button now
  }

  function openPanel(): void {
    selecting = false;
    fab.classList.add("hidden");
    panel.classList.add("open");
  }

  function drawOverlay(el: Element | null): void {
    if (!el) {
      overlay.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  }

  function onMove(e: MouseEvent): void {
    if (!selecting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    drawOverlay(el && !isOwn(el) ? el : null);
  }

  function onClick(e: MouseEvent): void {
    if (!selecting || isOwn(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwn(el)) return;
    setFocused(el);
    openPanel();
    setStatus("", "");
    void updateDest();
    textarea.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (recordingHotkey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recordingHotkey = false;
        renderHotkeyBtn();
        return;
      }
      // A modifier on its own is the user still reaching for the key.
      if (/^(?:Alt|Control|Shift|Meta)/.test(e.code)) return;
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        hotkeyBtn.textContent = "add Alt, Ctrl or ⌘ to the key…";
        return;
      }
      prefs.hotkey = normalizeHotkey({
        code: e.code,
        alt: e.altKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      });
      recordingHotkey = false;
      renderHotkeyBtn();
      fab.title = selectTitle();
      savePrefs();
      return;
    }
    if (e.key === "Escape") {
      goIdle();
      return;
    }
    if (matchesHotkey(e, prefs.hotkey)) {
      e.preventDefault();
      startSelect();
    }
  }

  function setFocused(el: Element): void {
    focused = el;
    const p = buildElementPayload(el);
    pickedBox.hidden = false;
    nameEl.textContent = p.component
      ? `<${p.component}>`
      : `${p.tag}${p.id ? `#${p.id}` : ""}`;
    metaEl.textContent =
      p.componentStack.length > 1 ? p.componentStack.join(" › ") : p.selector;
    drawOverlay(el);
  }

  function focusParent(): void {
    const parent = focused?.parentElement;
    if (parent && !isOwn(parent)) setFocused(parent);
  }

  function focusChild(): void {
    const child = focused?.firstElementChild;
    if (child && !isOwn(child)) setFocused(child);
  }

  function addAnother(): void {
    if (focused) {
      picked.push({ element: focused, payload: buildElementPayload(focused) });
      focused = null;
      pickedBox.hidden = true;
      renderChips();
    }
    startSelect();
  }

  function renderChips(): void {
    chips.replaceChildren();
    picked.forEach((item, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = item.payload.component ?? item.payload.tag;
      chip.append(label);
      const x = document.createElement("button");
      x.textContent = "✕";
      x.addEventListener("click", () => {
        picked.splice(i, 1);
        renderChips();
      });
      chip.append(x);
      chips.append(chip);
    });
  }

  const area = (el: Element): number => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  /** PNG of the largest selected element — a tight crop, no surroundings. */
  async function captureElement(targets: Element[]): Promise<string | null> {
    const target = targets.reduce<Element | null>(
      (best, el) => (best && area(best) >= area(el) ? best : el),
      null,
    );
    if (!target) return null;
    const domToPng = await loadDomToPng(BRIDGE_ORIGIN);
    return domToPng(target, { scale: 1, backgroundColor: "#ffffff" });
  }

  /** The whole visible viewport with every selected element outlined — context, not a crop. */
  async function captureViewport(targets: Element[]): Promise<string | null> {
    const boxes = targets.map((el) => el.getBoundingClientRect());
    const domToPng = await loadDomToPng(BRIDGE_ORIGIN);
    const png = await domToPng(document.body, {
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: "#ffffff",
      filter: (node) => !(node instanceof Element && node.id === ROOT_ID),
      style: {
        transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
        transformOrigin: "top left",
      },
    });
    return drawHighlights(png, boxes);
  }

  function drawHighlights(dataUrl: string, boxes: DOMRect[]): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const scale = img.width / window.innerWidth;
        ctx.strokeStyle = "#d97757";
        ctx.lineWidth = Math.max(2, 3 * scale);
        for (const r of boxes) {
          ctx.strokeRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
        }
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function send(): Promise<void> {
    const elements = [...picked.map((p) => p.payload)];
    if (focused) elements.push(buildElementPayload(focused));
    if (elements.length === 0) {
      setStatus("Select an element first.", "err");
      return;
    }
    const message = textarea.value.trim();
    if (!message) {
      setStatus("Write what you want changed.", "err");
      return;
    }

    sendBtn.disabled = true;

    let screenshot: string | null = null;
    let shotNote: string | null = null;
    const shotTargets = [...picked.map((p) => p.element), ...(focused ? [focused] : [])];
    if (prefs.shot) {
      // Its own status line: rasterizing is the slow half, and calling it
      // "Sending…" made a stalled capture look like a dead bridge.
      setStatus("Rendering screenshot…", "");
      try {
        screenshot = await withTimeout(
          prefs.shotTarget === "viewport"
            ? captureViewport(shotTargets)
            : captureElement(shotTargets),
          SHOT_TIMEOUT_MS,
        );
        if (screenshot === null) shotNote = "screenshot failed";
        else if (screenshot.length > MAX_SHOT_CHARS) {
          // Better to land the prompt without the image than to have the bridge
          // reject the whole send for being oversized.
          screenshot = null;
          shotNote = "screenshot too large, dropped";
        }
      } catch (error) {
        screenshot = null;
        shotNote = error instanceof TimeoutError ? "screenshot timed out" : "screenshot failed";
      }
    }

    setStatus("Sending…", "");

    const pinned = prefs.targetAgent;
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(`${BRIDGE_ORIGIN}/send`, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          url: location.href,
          elements,
          screenshot,
          autoSubmit: prefs.autoSend,
          targetAgent: pinned,
          diagnostics: getDiagnostics(),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        reason?: string;
        targetAgent?: { paneId: string; session: string | null };
        project?: string;
        stale?: { paneId: string; reason: string } | null;
      };
      if (!data.ok) {
        // A blocked agent is something the user can clear and retry, so it gets
        // an amber state and — crucially — the composer keeps their text.
        setStatus(data.error ?? "Failed.", data.reason === "agent_blocked" ? "warn" : "err");
        return;
      }

      textarea.value = "";
      picked.length = 0;
      focused = null;
      renderChips();
      pickedBox.hidden = true;

      const notes: string[] = [];
      if (shotNote) notes.push(shotNote);
      if (data.stale?.reason === "pane_closed") {
        // Pane ids never come back once gone — drop the dead pin instead of
        // silently re-routing on every send.
        prefs.targetAgent = null;
        prefs.targetAgentLabel = null;
        savePrefs();
        notes.push("pinned agent was closed, auto-routed");
      } else if (data.stale?.reason === "session_replaced") {
        // The terminal is the same one, so the pin still points somewhere
        // sensible; just say the conversation behind it is new.
        notes.push("that agent restarted");
      }
      const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      const project = data.project ?? "Claude";
      if (!prefs.autoSend) {
        setStatus(`Pasted into ${project} — review and press Enter${suffix}.`, "ok");
        window.setTimeout(goIdle, 2200);
        return;
      }
      setStatus(`Sent to ${project}${suffix}.`, "ok");
      watchAgent(data.targetAgent?.paneId);
    } catch {
      setStatus(
        abort.signal.aborted
          ? `No answer from the bridge after ${SEND_TIMEOUT_MS / 1000}s — try again.`
          : `Bridge not reachable at ${BRIDGE_ORIGIN}.`,
        "err",
      );
    } finally {
      window.clearTimeout(timer);
      sendBtn.disabled = false;
    }
  }

  /**
   * Follow the destination agent until it settles.
   *
   * The stream is opened here, on a confirmed send, and never at load: the
   * widget is injected into every localhost tab, so a stream held from page
   * load would pin one connection per tab for as long as the tab lives.
   */
  let liveStream: EventSource | null = null;

  function closeStream(): void {
    liveStream?.close();
    liveStream = null;
  }

  function watchAgent(paneId: string | undefined): void {
    if (!paneId) {
      window.setTimeout(goIdle, 1500);
      return;
    }
    closeStream();

    // No EventSource, or a page CSP that refuses it: fall back to the single
    // delayed check this replaced, so the widget is never worse than before.
    if (typeof EventSource !== "function") {
      pollOnce(paneId);
      return;
    }

    let stream: EventSource;
    try {
      stream = new EventSource(`${BRIDGE_ORIGIN}/status?agent=${encodeURIComponent(paneId)}`);
    } catch {
      pollOnce(paneId);
      return;
    }
    liveStream = stream;

    // Never hold it open indefinitely: an agent that never settles would
    // otherwise keep both this stream and a herdr subscription alive.
    const cap = window.setTimeout(() => {
      closeStream();
      window.setTimeout(goIdle, 500);
    }, 60_000);

    const finish = (delay: number): void => {
      window.clearTimeout(cap);
      closeStream();
      window.setTimeout(goIdle, delay);
    };

    stream.addEventListener("status", (event: MessageEvent<string>) => {
      const { status: state } = JSON.parse(event.data) as { status: string };
      if (state === "working") {
        setStatus("Agent is working…", "ok");
        return;
      }
      if (state === "blocked") {
        setStatus("Agent is waiting on an approval in its terminal.", "warn");
        finish(3200);
        return;
      }
      // idle and done both mean "ready for input" — the turn is over.
      setStatus("Agent finished.", "ok");
      finish(2200);
    });

    stream.addEventListener("title", (event: MessageEvent<string>) => {
      const { title } = JSON.parse(event.data) as { title: string };
      if (title) setStatus(truncate(title, 70), "ok");
    });

    // The terminal disappearing is a different thing from the agent finishing,
    // and the user needs to know which happened.
    stream.addEventListener("closed", () => {
      setStatus("That agent's terminal was closed.", "warn");
      finish(2600);
    });

    stream.addEventListener("replaced", () => {
      setStatus("That agent restarted — it has none of the earlier context.", "warn");
    });

    stream.onerror = () => {
      // EventSource retries on its own; only give up once it is really done.
      if (stream.readyState === EventSource.CLOSED) finish(1200);
    };
  }

  /** The pre-stream behaviour, kept as the degraded path. */
  function pollOnce(paneId: string): void {
    window.setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`${BRIDGE_ORIGIN}/status?agent=${encodeURIComponent(paneId)}&once=1`);
          const d = (await r.json()) as { ok: boolean; title?: string };
          if (d.ok && d.title) setStatus(truncate(d.title, 70), "ok");
        } catch {
          /* bridge hiccup — keep the sent confirmation */
        }
        window.setTimeout(goIdle, 2500);
      })();
    }, 1800);
  }

  function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function setStatus(text: string, kind: "ok" | "err" | "warn" | ""): void {
    status.textContent = text;
    status.className = `status ${kind}`.trim();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  // FAB has exactly one meaning: select, or cancel while selecting.
  fab.addEventListener("click", () => (selecting ? goIdle() : startSelect()));
  q<HTMLButtonElement>(".close-panel").addEventListener("click", goIdle);
  q<HTMLButtonElement>(".parent").addEventListener("click", focusParent);
  q<HTMLButtonElement>(".child").addEventListener("click", focusChild);
  q<HTMLButtonElement>(".add").addEventListener("click", addAnother);
  sendBtn.addEventListener("click", () => void send());
  gearBtn.addEventListener("click", () => (settingsOpen ? closeSettings() : openSettings()));
  hotkeyBtn.addEventListener("click", () => {
    recordingHotkey = !recordingHotkey;
    renderHotkeyBtn();
  });
  autoSendCheck.addEventListener("change", () => {
    prefs.autoSend = autoSendCheck.checked;
    savePrefs();
  });
  agentSelect.addEventListener("change", () => {
    const opt = agentSelect.selectedOptions[0];
    if (agentSelect.value === "" || opt === undefined) {
      prefs.targetAgent = null;
      prefs.targetAgentLabel = null;
    } else {
      const session = opt.dataset["session"] ?? "";
      prefs.targetAgent = { paneId: agentSelect.value, session: session === "" ? null : session };
      prefs.targetAgentLabel = opt.dataset["label"] ?? null;
    }
    setNote.textContent = "";
    setNote.classList.remove("err");
    savePrefs();
  });
  shotCheck.addEventListener("change", () => {
    prefs.shot = shotCheck.checked;
    if (prefs.shot) prefetchShot();
    savePrefs();
    syncShotUi();
  });
  const setShotTarget = (target: ShotTarget) => () => {
    prefs.shotTarget = target;
    savePrefs();
    syncShotUi();
  };
  shotElementBtn.addEventListener("click", setShotTarget("element"));
  shotViewportBtn.addEventListener("click", setShotTarget("viewport"));
  document.addEventListener("mousemove", onMove, { capture: true, signal });
  document.addEventListener("click", onClick, { capture: true, signal });
  document.addEventListener("keydown", onKey, { capture: true, signal });
  window.addEventListener("scroll", () => focused && drawOverlay(focused), { capture: true, signal });

  // A modal (Radix/vaul drawers, dialogs, popovers) watches the document for
  // presses and focus outside itself, and sees the widget's as exactly that:
  // they leave the shadow root retargeted to the host. Pressing the button
  // closed the drawer being inspected, and focusing the textarea had focus
  // pulled straight back. So the widget's own events end at the host.
  for (const type of [
    "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend",
    "click", "focusin", "focusout", "keydown", "keyup", "keypress",
  ]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  // Focus leaving the modal *for* the widget is dispatched on the modal's
  // element, not ours, so it has to be caught on the way down instead.
  window.addEventListener(
    "focusout",
    (e) => {
      if (isOwn(e.relatedTarget)) e.stopImmediatePropagation();
    },
    { capture: true, signal },
  );
  // While picking, a press is the pick, not an interaction: it must not
  // dismiss a modal or trigger a control that acts on pointerdown.
  // touchstart is left alone: cancelling it would cancel the click that picks.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!selecting || isOwn(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true, signal },
    );
  }

  const handle: WidgetHandle = {
    dispose: () => {
      life.abort();
      closeStream();
      host.remove();
    },
  };
  Reflect.set(window, HANDLE_KEY, handle);

  fab.title = selectTitle();
  console.info(
    `[pointr] widget ready — ${hotkeyLabel(prefs.hotkey)} or the button to select an element. Settings: the gear in the panel.`,
  );
})();
