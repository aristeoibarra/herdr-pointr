/**
 * pointr browser widget.
 * Injected via <script src="http://localhost:PORT/widget.js"> in development.
 * Select DOM elements, add context, and send to the agent that owns the project.
 */

import { domToPng } from "modern-screenshot";

import { buildElementPayload, type ElementPayload } from "./capture.ts";
import { createDictation, micBlockedByPagePolicy, POLICY_MESSAGE } from "./dictation.ts";
import { getDiagnostics, installDiagnostics } from "./diagnostics.ts";

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

/** Must stay in sync with DEFAULT_HOTKEY in extension/popup.js. */
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
 * Everything the extension popup owns arrives over postMessage (see
 * `extension/content.js`); the panel's own toggles stay in localStorage, which
 * is also the fallback when the widget is loaded without the extension.
 */
interface ExtensionPrefs {
  autoSend?: boolean;
  dictationLang?: string;
  hotkey?: Hotkey | null;
  targetPane?: string | null;
  targetPaneLabel?: string | null;
}

interface Prefs {
  autoSend: boolean;
  /** Attach a screenshot to the next send — toggled from the panel itself. */
  shot: boolean;
  /** What the screenshot frames; remembered even while `shot` is off. */
  shotTarget: ShotTarget;
  /** Pane id pinned in the popup, or null for auto-routing. Set per origin. */
  targetPane: string | null;
  /** Human label for the pinned pane, so the panel needn't refetch /sessions. */
  targetPaneLabel: string | null;
  hotkey: Hotkey;
  /** BCP-47 tag for dictation, or "auto" to follow the browser. */
  dictationLang: string;
}

// Inline SVGs (no external assets — the widget is a single bundle).
const ICON_AI =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.7 5.4 5.4 1.7-5.4 1.7L12 16.4l-1.7-5.4L4.9 9.3l5.4-1.7z"/><path d="M18.6 13.6l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg>';
const ICON_STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

(function initWidget(): void {
  const ROOT_ID = "pointr-root";

  // Origin of the bridge that served this script — works on any port, no build-time define.
  const loader = document.currentScript as HTMLScriptElement | null;
  const BRIDGE_ORIGIN = loader?.src ? new URL(loader.src).origin : "http://localhost:7331";

  // Hook console/fetch/error before the app code runs (extension injects at
  // document_start), and before the double-injection guard below.
  installDiagnostics(BRIDGE_ORIGIN);

  if (document.getElementById(ROOT_ID)) return;

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

      /* Launcher: one button, one meaning. Settings live in the extension popup. */
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
        padding: 10px 44px 10px 10px; font-size: 13px; outline: none;
      }
      textarea:focus { border-color: #d97757; }

      /* Mic sits inside the composer: typing and dictating are the same field. */
      .mic {
        position: absolute; right: 9px; bottom: 11px;
        width: 28px; height: 28px; border-radius: 50%;
        border: 1px solid #3a3a3a; background: #1f1f1f; color: #b5b5b5;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        transition: background .12s, color .12s, border-color .12s;
      }
      .mic:hover { color: #f5b78f; border-color: #d97757; }
      .mic svg { width: 15px; height: 15px; display: block; }
      /* Ring grows with the live input level, so silence is visible as silence. */
      .mic.on {
        background: #d97757; border-color: #d97757; color: #fff;
        box-shadow: 0 0 0 calc(2px + var(--level, 0) * 7px) rgba(217,119,87,.35);
      }
      .mic.busy {
        border-color: #d97757; color: #f5b78f;
        animation: mic-blink 1s ease-in-out infinite;
      }
      @keyframes mic-blink { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
      .interim { margin-top: 6px; font-size: 12px; color: #8a8a8a; font-style: italic; }

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
    </style>

    <button class="fab" title="Select an element (Alt+C)"></button>
    <div class="overlay"></div>

    <div class="panel">
      <div class="head">
        <span class="title">Send to agent</span>
        <button class="x close-panel" title="Close">✕</button>
      </div>
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
        <textarea placeholder="Describe the change you want — type or dictate…"></textarea>
        <button class="mic" title="Dictate"></button>
      </div>
      <div class="interim" hidden></div>
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
  const micBtn = q<HTMLButtonElement>(".mic");
  const interimEl = q<HTMLDivElement>(".interim");
  const shotCheck = q<HTMLInputElement>(".shot");
  const shotSeg = q<HTMLDivElement>(".seg");
  const shotElementBtn = q<HTMLButtonElement>(".shot-element");
  const shotViewportBtn = q<HTMLButtonElement>(".shot-viewport");
  const sendBtn = q<HTMLButtonElement>(".send");
  const status = q<HTMLDivElement>(".status");
  const dest = q<HTMLDivElement>(".dest");

  fab.innerHTML = ICON_AI;
  micBtn.innerHTML = ICON_MIC;

  const PREFS_KEY = "pointr-prefs";
  const prefs: Prefs = {
    autoSend: true,
    shot: false,
    shotTarget: "element",
    targetPane: null,
    targetPaneLabel: null,
    hotkey: { ...DEFAULT_HOTKEY },
    dictationLang: "auto",
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
    if (typeof saved.dictationLang === "string") prefs.dictationLang = saved.dictationLang;
    if (typeof saved.targetPane === "string") prefs.targetPane = saved.targetPane;
    if (typeof saved.targetPaneLabel === "string") prefs.targetPaneLabel = saved.targetPaneLabel;
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

  // ── Settings channel: the extension popup owns them, this widget only reads ──
  // The popup writes to chrome.storage; extension/content.js relays it here.
  // Without the extension (bookmarklet, React mount) nothing answers and the
  // localStorage values loaded above stand.
  const FROM_WIDGET = "pointr-widget";
  const FROM_EXT = "pointr-ext";

  const toExtension = (message: Record<string, unknown>): void => {
    window.postMessage({ source: FROM_WIDGET, ...message }, location.origin);
  };

  function isExtensionPrefs(value: unknown): value is ExtensionPrefs {
    return typeof value === "object" && value !== null;
  }

  function applyExtensionPrefs(incoming: ExtensionPrefs): void {
    if (typeof incoming.autoSend === "boolean") prefs.autoSend = incoming.autoSend;
    if (typeof incoming.dictationLang === "string") prefs.dictationLang = incoming.dictationLang;
    if (incoming.hotkey && typeof incoming.hotkey.code === "string") {
      prefs.hotkey = normalizeHotkey(incoming.hotkey);
    }
    if (typeof incoming.targetPane === "string" || incoming.targetPane === null) {
      prefs.targetPane = incoming.targetPane;
    }
    if (typeof incoming.targetPaneLabel === "string" || incoming.targetPaneLabel === null) {
      prefs.targetPaneLabel = incoming.targetPaneLabel;
    }
    savePrefs(); // keeps the fallback copy warm if the extension is later removed
    fab.title = selectTitle();
    if (panel.classList.contains("open")) void updateDest();
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    if (typeof event.data !== "object" || event.data === null) return;
    const message: Record<string, unknown> = { ...event.data };
    if (message.source !== FROM_EXT || message.type !== "prefs") return;
    if (isExtensionPrefs(message.prefs)) applyExtensionPrefs(message.prefs);
  });

  toExtension({ type: "prefs:get" });

  async function updateDest(): Promise<void> {
    if (prefs.targetPane) {
      const label = prefs.targetPaneLabel ?? `pane ${prefs.targetPane}`;
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

  // ── Dictation: same composer, voice instead of keyboard ──────────────────
  function appendDictated(chunk: string): void {
    const text = chunk.trim();
    if (!text) return;
    const current = textarea.value;
    const sep = current === "" || /\s$/.test(current) ? "" : " ";
    textarea.value = `${current}${sep}${text}`;
    textarea.scrollTop = textarea.scrollHeight;
  }

  let recordingSince = 0;
  let recordingTimer = 0;

  function recordingTick(): void {
    const seconds = Math.floor((Date.now() - recordingSince) / 1000);
    const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    interimEl.textContent = `● recording ${mmss} — click the mic or press Esc to transcribe`;
  }

  const dictation = createDictation(BRIDGE_ORIGIN, {
    onState(state) {
      const recording = state === "recording";
      micBtn.classList.toggle("on", recording);
      micBtn.classList.toggle("busy", state === "transcribing");
      micBtn.innerHTML = recording ? ICON_STOP : ICON_MIC;
      micBtn.title = recording ? "Stop and transcribe (Esc)" : "Dictate";
      window.clearInterval(recordingTimer);
      interimEl.hidden = state === "idle";
      if (recording) {
        recordingSince = Date.now();
        recordingTick();
        recordingTimer = window.setInterval(recordingTick, 1000);
      } else if (state === "transcribing") {
        interimEl.textContent = "transcribing locally…";
      } else {
        micBtn.style.removeProperty("--level");
      }
    },
    onLevel(level) {
      micBtn.style.setProperty("--level", level.toFixed(2));
    },
    onText(text) {
      appendDictated(text);
      textarea.focus();
    },
    onError(message) {
      setStatus(message, "err");
    },
  });

  /**
   * No getUserMedia (or no bridge-side whisper) — hide the mic rather than fail on
   * click. Whether the mic works is page-local (the Permissions-Policy case is
   * invisible to both the popup and the bridge), so report it up to the extension:
   * that reason is what the popup shows under "Dictation language".
   */
  function reportDictation(available: boolean, reason: string): void {
    toExtension({ type: "dictation", available, reason });
    if (available) return;
    micBtn.classList.add("hidden");
    textarea.placeholder = "Describe the change you want…";
    console.info(`[pointr] dictation off — ${reason}`);
  }

  if (!dictation.supported) reportDictation(false, "This browser cannot capture audio.");
  // The page's own header can veto the mic; no point offering a button that can't work.
  else if (micBlockedByPagePolicy()) reportDictation(false, POLICY_MESSAGE);

  async function checkDictationBackend(): Promise<void> {
    if (!dictation.supported || micBlockedByPagePolicy()) return;
    try {
      const r = await fetch(`${BRIDGE_ORIGIN}/dictation`);
      const d = (await r.json()) as { available?: boolean; model?: string; error?: string };
      if (d.available) {
        reportDictation(
          true,
          `Transcribed locally with whisper.cpp (${d.model ?? "model"}). Audio never leaves this machine.`,
        );
        return;
      }
      // A bridge from before dictation existed 404s here — say so instead of "not found".
      reportDictation(
        false,
        d.error === "not found"
          ? "Bridge is out of date — restart it to enable dictation."
          : (d.error ?? "Dictation unavailable."),
      );
    } catch {
      /* bridge hiccup — keep the mic, the error will surface on use */
    }
  }

  const dictationLang = (): string =>
    prefs.dictationLang === "auto" ? navigator.language || "auto" : prefs.dictationLang;

  function toggleDictation(): void {
    if (dictation.state() === "recording") {
      dictation.stop();
      return;
    }
    if (dictation.state() === "transcribing") return;
    setStatus("", "");
    dictation.start(dictationLang());
  }

  // ── State machine: idle ↔ selecting ↔ composing ──────────────────────────
  let selecting = false;
  let focused: Element | null = null;
  const picked: PickedItem[] = [];

  const isOwn = (node: EventTarget | null): boolean =>
    node instanceof Node && host.contains(node);

  /** Return to the resting state: launcher visible, nothing selected/open. */
  function goIdle(): void {
    dictation.cancel(); // never leave the mic open behind a closed panel
    selecting = false;
    fab.innerHTML = ICON_AI;
    fab.classList.remove("armed");
    fab.title = selectTitle();
    panel.classList.remove("open");
    drawOverlay(null);
    fab.classList.remove("hidden");
  }

  function startSelect(): void {
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
    if (e.key === "Escape") {
      // While recording, Esc means "stop and transcribe" — not "throw away the draft".
      if (dictation.state() === "recording") {
        e.preventDefault();
        dictation.stop();
        return;
      }
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
  function captureElement(targets: Element[]): Promise<string | null> {
    const target = targets.reduce<Element | null>(
      (best, el) => (best && area(best) >= area(el) ? best : el),
      null,
    );
    if (!target) return Promise.resolve(null);
    return domToPng(target, { scale: 1, backgroundColor: "#ffffff" });
  }

  /** The whole visible viewport with every selected element outlined — context, not a crop. */
  async function captureViewport(targets: Element[]): Promise<string | null> {
    const boxes = targets.map((el) => el.getBoundingClientRect());
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
    // Sending mid-dictation would drop what you just said — finish the round trip first.
    if (dictation.state() === "recording") {
      dictation.stop();
      setStatus("Transcribing — press Send again when the text lands.", "");
      return;
    }
    if (dictation.state() === "transcribing") {
      setStatus("Still transcribing…", "");
      return;
    }
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

    const pinned = prefs.targetPane;
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
          targetPane: pinned,
          diagnostics: getDiagnostics(),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        targetPane?: string;
        project?: string;
      };
      if (!data.ok) {
        setStatus(data.error ?? "Failed.", "err");
        return;
      }

      textarea.value = "";
      picked.length = 0;
      focused = null;
      renderChips();
      pickedBox.hidden = true;

      const notes: string[] = [];
      if (shotNote) notes.push(shotNote);
      if (pinned && data.targetPane && data.targetPane !== pinned) {
        // Pane ids never come back once gone — drop the dead pin instead of
        // silently re-routing on every send.
        prefs.targetPane = null;
        prefs.targetPaneLabel = null;
        savePrefs();
        toExtension({ type: "pin:clear" });
        notes.push("pinned session was gone, auto-routed");
      }
      const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      const project = data.project ?? "Claude";
      if (!prefs.autoSend) {
        setStatus(`Pasted into ${project} — review and press Enter${suffix}.`, "ok");
        window.setTimeout(goIdle, 2200);
        return;
      }
      setStatus(`Sent to ${project}${suffix}.`, "ok");
      watchPaneTitle(data.targetPane);
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
   * Claude Code mirrors its current task into the tmux pane title, so one
   * delayed poll turns "sent" into "Claude: <what it's doing>" — the closest
   * thing to a feedback loop without holding a connection open.
   */
  function watchPaneTitle(pane: string | undefined): void {
    if (!pane) {
      window.setTimeout(goIdle, 1500);
      return;
    }
    window.setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`${BRIDGE_ORIGIN}/pane-title?pane=${encodeURIComponent(pane)}`);
          const d = (await r.json()) as { ok: boolean; title?: string };
          if (d.ok && d.title) {
            const title = d.title.length > 70 ? `${d.title.slice(0, 70)}…` : d.title;
            setStatus(`Claude: ${title}`, "ok");
          }
        } catch {
          /* bridge hiccup — keep the sent confirmation */
        }
        window.setTimeout(goIdle, 2500);
      })();
    }, 1800);
  }

  function setStatus(text: string, kind: "ok" | "err" | ""): void {
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
  micBtn.addEventListener("click", toggleDictation);
  shotCheck.addEventListener("change", () => {
    prefs.shot = shotCheck.checked;
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
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", () => focused && drawOverlay(focused), true);

  fab.title = selectTitle();
  void checkDictationBackend();
  console.info(
    `[pointr] widget ready — ${hotkeyLabel(prefs.hotkey)} or the button to select an element. Settings live in the extension popup.`,
  );
})();
