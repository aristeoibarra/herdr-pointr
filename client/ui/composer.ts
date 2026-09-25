import { BridgeTimeout, type Anchor, type Api, type Thread } from "../api.ts";
import { findAnchor } from "../anchor.ts";
import { buildElementPayload, type ElementPayload } from "../capture.ts";
import type { WidgetContext } from "../context.ts";
import { getDiagnostics } from "../diagnostics.ts";
import { h, icon } from "../dom.ts";
import { pageKey } from "../navigation.ts";
import { saveComposeDraft, takeComposeDraft } from "../session.ts";
import { loadDomToPng } from "../shot-loader.ts";
import { MAX_SHOT_CHARS, SEND_TIMEOUT_MS, SHOT_TIMEOUT_MS, TimeoutError, captureElement, captureViewport, withTimeout } from "../shot.ts";
import { createDestinationPicker } from "./destination.ts";
import { outline, place } from "./popover.ts";

interface Item {
  element: Element;
  payload: ElementPayload;
}

export interface Composer {
  readonly isOpen: boolean;
  /** Adds a picked element, opening the composer on the first. */
  add(el: Element): void;
  close(): void;
  reposition(): void;
  /**
   * Brings back a comment that was being written when the page reloaded —
   * often the agent's edit for another thread. True when this page has one,
   * even if its elements are still rendering.
   */
  restore(): boolean;
  /** Opens on these elements with this text — a cancelled comment coming back. */
  edit(elements: Element[], text: string): void;
  /** Keys for the destination list while it is open. */
  handleKey(e: KeyboardEvent): boolean;
}

export interface ComposerDeps {
  api: Api;
  /** "+ Add": pick another element for the same comment. */
  pickAnother(): void;
  onSent(thread: Thread | null, project: string, notes: string[]): void;
}

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

/** What finds a picked element again after a reload — the same shape the bridge stores. */
function anchorOf(p: ElementPayload): Anchor {
  return {
    selector: p.selector,
    tag: p.tag,
    id: p.id ?? "",
    component: p.component ?? "",
    framework: p.framework ?? "",
    source: p.source ?? "",
    text: squash(p.text).slice(0, 120),
    context: p.context,
    pos: p.pos,
    peers: p.peers,
  };
}

function label(payload: ElementPayload): string {
  return payload.component ?? `${payload.tag}${payload.id ? `#${payload.id}` : ""}`;
}

/**
 * The comment being written: the picked elements, the text, an optional
 * screenshot. Opens next to the element it is about.
 */
export function createComposer(ctx: WidgetContext, deps: ComposerDeps): Composer {
  let items: Item[] = [];
  let shot = false;
  let sending = false;

  const marks = h("div");
  const dest = createDestinationPicker(ctx, { api: deps.api, onChange: () => setNote("") });
  dest.el.classList.add("push");
  const closeBtn = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Close" } }, icon("close", 14));
  const chips = h("div", { className: "chips" });
  const textarea = h("textarea", { attrs: { rows: "3", placeholder: "Ask or request a change…", "aria-label": "Comment" } });
  const shotBtn = h("button", { className: "gbtn", attrs: { type: "button", "aria-pressed": "false" } }, icon("camera", 15), "Screenshot");
  const sendBtn = h("button", { className: "pbtn push", attrs: { type: "button" } }, "Send", h("span", { className: "kbd", text: "Ctrl ↵" }));
  const note = h("div", { className: "note", attrs: { role: "status" } });
  const pop = h("div", { className: "pop", attrs: { role: "dialog", "aria-label": "New comment" }, hidden: true },
    h("div", { className: "head" }, h("span", { className: "title", text: "Comment" }), dest.el, closeBtn),
    chips,
    h("div", { className: "pad" }, textarea),
    h("div", { className: "row" }, shotBtn, sendBtn),
    note,
  );
  ctx.layer.append(marks, pop);
  textarea.style.height = "84px";

  function setNote(text: string, kind: "" | "err" | "warn" = ""): void {
    note.textContent = text;
    note.className = `note ${kind}`.trim();
  }

  function renderChips(): void {
    chips.replaceChildren();
    items.forEach((item, index) => {
      const remove = h("button", { attrs: { type: "button", "aria-label": `Remove ${label(item.payload)}` } }, icon("close", 11));
      remove.addEventListener("click", () => {
        items.splice(index, 1);
        if (items.length === 0) close();
        else render();
      });
      const text = item.payload.text.trim().slice(0, 40);
      chips.append(h("span", { className: "chip" }, h("span", { text: label(item.payload) }),
        text ? h("span", { className: "sub", text: `“${text}”` }) : null, remove));
    });
    const last = items[items.length - 1];
    if (last) {
      const up = h("button", { className: "nav", attrs: { type: "button", "aria-label": "Select the parent element", title: "Parent" } }, icon("up", 13));
      const down = h("button", { className: "nav", attrs: { type: "button", "aria-label": "Select the first child element", title: "Child" } }, icon("down", 13));
      up.addEventListener("click", () => swapLast(last.element.parentElement));
      down.addEventListener("click", () => swapLast(last.element.firstElementChild));
      chips.append(up, down);
    }
    const add = h("button", { className: "add", attrs: { type: "button", title: "Add another element to this comment" }, text: "+ Add" });
    add.addEventListener("click", () => deps.pickAnother());
    chips.append(add);
  }

  function swapLast(next: Element | null): void {
    if (!next || next === document.body.parentElement || ctx.isOwn(next) || items.length === 0) return;
    items[items.length - 1] = { element: next, payload: buildElementPayload(next) };
    render();
  }

  function drawMarks(): void {
    marks.replaceChildren();
    for (const item of items) {
      const mark = h("div", { className: "mark" });
      outline(mark, item.element.getBoundingClientRect());
      marks.append(mark);
    }
  }

  function reposition(): void {
    if (pop.hidden) return;
    drawMarks();
    const last = items[items.length - 1];
    place(pop, last ? last.element.getBoundingClientRect() : null);
  }

  function render(): void {
    renderChips();
    reposition();
    persist();
  }

  /** Keeps the comment being written for the tab, so a reload does not eat it. */
  function persist(): void {
    if (pop.hidden || items.length === 0) {
      saveComposeDraft(null);
      return;
    }
    saveComposeDraft({ page: pageKey(), text: textarea.value, anchors: items.map((item) => anchorOf(item.payload)) });
  }

  function setShot(on: boolean): void {
    shot = on;
    shotBtn.classList.toggle("on", on);
    shotBtn.setAttribute("aria-pressed", String(on));
    // Fetch the rasterizer while the comment is still being written.
    if (on) loadDomToPng(ctx.bridge).catch(() => undefined);
  }

  async function refreshDestination(): Promise<void> {
    const line = await dest.refresh();
    if (line) setNote(line, "warn");
    reposition();
  }

  async function screenshotFor(targets: Element[]): Promise<{ data: string | null; note: string }> {
    // Its own status line: rasterizing is the slow half, and calling it
    // "Sending…" made a stalled capture look like a dead bridge.
    setNote("Rendering screenshot…");
    try {
      const data = await withTimeout(
        ctx.prefs.shotTarget === "viewport" ? captureViewport(ctx.bridge, targets, ctx.rootId) : captureElement(ctx.bridge, targets),
        SHOT_TIMEOUT_MS,
      );
      if (data === null) return { data: null, note: "screenshot failed" };
      // Better to land the comment without the image than to have the
      // bridge reject the whole send for being oversized.
      if (data.length > MAX_SHOT_CHARS) return { data: null, note: "screenshot too large, dropped" };
      return { data, note: "" };
    } catch (error) {
      return { data: null, note: error instanceof TimeoutError ? "screenshot timed out" : "screenshot failed" };
    }
  }

  async function send(): Promise<void> {
    if (sending || items.length === 0) return;
    const message = textarea.value.trim();
    if (!message) {
      setNote("Write a comment first.", "err");
      return;
    }
    sending = true;
    sendBtn.disabled = true;
    const notes: string[] = [];
    try {
      let screenshot: string | null = null;
      if (shot) {
        const result = await screenshotFor(items.map((item) => item.element));
        screenshot = result.data;
        if (result.note) notes.push(result.note);
      }
      setNote("Sending…");
      const res = await deps.api.send({
        message,
        url: location.href,
        page: pageKey(),
        elements: items.map((item) => item.payload),
        screenshot,
        targetAgent: ctx.prefs.targetAgent,
        diagnostics: getDiagnostics(),
      });
      if (!res.ok) {
        // A blocked agent is something to clear and retry, so it reads as a
        // warning — and the comment keeps its text either way.
        setNote(res.error, res.reason === "agent_blocked" ? "warn" : "err");
        if (res.candidates.length > 0) {
          setNote(await dest.refresh(res.candidates), "warn");
          dest.prompt();
        }
        return;
      }
      if (res.stale === "pane_closed") {
        // Pane ids never come back once gone — drop the dead pin instead of
        // silently re-routing on every send.
        ctx.prefs.targetAgent = null;
        ctx.prefs.targetAgentLabel = null;
        ctx.savePrefs();
        notes.push("pinned agent was closed, auto-routed");
      } else if (res.stale === "session_replaced") {
        notes.push("that agent restarted");
      }
      textarea.value = "";
      close();
      deps.onSent(res.thread, res.project, notes);
    } catch (error) {
      setNote(
        error instanceof BridgeTimeout
          ? `No answer from the bridge after ${SEND_TIMEOUT_MS / 1000}s — try again.`
          : `Bridge not reachable at ${ctx.bridge}.`,
        "err",
      );
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  function close(): void {
    dest.close();
    pop.hidden = true;
    items = [];
    marks.replaceChildren();
    saveComposeDraft(null);
  }

  function reopen(elements: Element[], text: string): void {
    items = elements.map((element) => ({ element, payload: buildElementPayload(element) }));
    setShot(false);
    setNote("");
    void refreshDestination();
    pop.hidden = false;
    textarea.value = text;
    render();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  closeBtn.addEventListener("click", () => close());
  sendBtn.addEventListener("click", () => void send());
  shotBtn.addEventListener("click", () => setShot(!shot));
  let persistTimer = 0;
  textarea.addEventListener("input", () => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persist, 300);
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  });

  return {
    get isOpen() {
      return !pop.hidden;
    },
    add(el) {
      const opening = pop.hidden;
      if (opening) {
        items = [];
        setShot(false);
        setNote("");
        void refreshDestination();
      }
      items.push({ element: el, payload: buildElementPayload(el) });
      pop.hidden = false;
      render();
      textarea.focus();
    },
    close,
    reposition,
    edit(elements, text) {
      reopen(elements, text);
    },
    handleKey: (e) => dest.handleKey(e),
    restore() {
      const draft = takeComposeDraft();
      if (!draft) return false;
      let tries = 0;
      const attempt = (): void => {
        // Started another comment meanwhile: that one wins.
        if (!pop.hidden || ctx.signal.aborted) return;
        const found = draft.anchors.map((a) => findAnchor(a, ctx.isOwn)?.el ?? null).filter((el): el is Element => el !== null);
        if (found.length === 0) {
          // An app may still be rendering what the comment is about.
          if (++tries < 5) window.setTimeout(attempt, 400);
          return;
        }
        reopen(found, draft.text);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", attempt, { once: true, signal: ctx.signal });
      } else {
        attempt();
      }
      return true;
    },
  };
}
