import type { AgentEntry, Api, Thread } from "../api.ts";
import { findThreadTarget } from "../anchor.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon, spinner } from "../dom.ts";
import { readDraft, rememberOpenThread, saveDraft } from "../session.ts";
import { agentName, ago, isHeld, threadLabel, waitingText } from "../status-text.ts";
import type { Store } from "../store.ts";
import { createDestinationPicker } from "./destination.ts";
import { outline, place } from "./popover.ts";

export interface ThreadView {
  readonly openId: string | null;
  /** Anchored next to its element when it is on this page, else in the dock's corner. */
  open(id: string): void;
  close(): void;
  /** Re-reads the open thread from the store after an update. */
  refresh(): void;
  reposition(): void;
}

export interface ThreadDeps {
  api: Api;
  store: Store;
  /** The thread's element, when it is on this page. */
  elementFor(id: string): Element | null;
  /** Something changed on the bridge's side: fetch the project again. */
  changed(): void;
  goTo(thread: Thread): void;
  /** A comment the agent never saw was cancelled: hand it back for editing. */
  cancelled(thread: Thread, texts: string[]): void;
}

/**
 * One thread: the conversation, what the agent is doing while it waits, and
 * a reply box. Replies are rendered as text nodes only — they come from an
 * agent, and from whatever else can reach the bridge.
 */
export function createThreadView(ctx: WidgetContext, deps: ThreadDeps): ThreadView {
  let openId: string | null = null;
  let anchored = false;
  let renderedKey = "";
  let sending = false;

  const anchor = h("div", { className: "anchor", hidden: true });
  const label = h("span", { className: "label" });
  const page = h("span", { className: "sub-label", hidden: true });
  const resolvedTag = h("span", { className: "sub-label", text: "resolved", hidden: true });
  const resolveBtn = h("button", { className: "sbtn push", attrs: { type: "button" } });
  const closeBtn = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Close" } }, icon("close", 14));
  const msgs = h("div", { className: "msgs" });
  const waitTitle = h("div", { className: "t" });
  const waitSub = h("div", { className: "s" });
  const cancelBtn = h("button", { className: "gbtn", attrs: { type: "button" }, text: "Cancel" });
  const sendNowBtn = h("button", { className: "gbtn", attrs: { type: "button" }, text: "Send now" });
  const heldActions = h("div", { className: "held-actions", hidden: true }, cancelBtn, sendNowBtn);
  const wait = h("div", { className: "wait", hidden: true }, spinner(), h("div", { className: "wait-body" }, waitTitle, waitSub, heldActions));
  const input = h("textarea", { attrs: { rows: "1", placeholder: "Reply…", "aria-label": "Reply" } });
  const sendBtn = h("button", { className: "sq", attrs: { type: "button", "aria-label": "Send reply" } }, icon("up", 16));
  const reply = h("div", { className: "reply" }, input, sendBtn);
  const note = h("div", { className: "note", attrs: { role: "status" } });
  // Only when routing could not choose for a thread whose terminal is gone.
  const dest = createDestinationPicker(ctx, { api: deps.api, onChange: () => setNote("") });
  const destRow = h("div", { className: "dest-row", hidden: true }, dest.el);
  const goBtn = h("button", { className: "gbtn", attrs: { type: "button" } }, "Go to page", icon("arrowRight", 13));
  const foot = h("div", { className: "foot", hidden: true }, goBtn);
  const pop = h("div", { className: "pop", attrs: { role: "dialog" }, hidden: true },
    h("div", { className: "head ruled" }, label, page, resolvedTag, resolveBtn, closeBtn), msgs, wait, reply, destRow, note, foot);
  ctx.layer.append(anchor, pop);

  function setNote(text: string, kind: "" | "err" | "warn" = ""): void {
    note.textContent = text;
    note.className = `note ${kind}`.trim();
  }

  function renderMessages(t: Thread): void {
    const key = `${t.id}:${t.messages.map((m) => `${m.id}${m.held ? "h" : ""}`).join(",")}`;
    if (key === renderedKey) return;
    renderedKey = key;
    msgs.replaceChildren(
      ...t.messages.map((m) => {
        const you = m.from === "user";
        const avatar = you
          ? h("span", { className: "av you", attrs: { "aria-hidden": "true" } }, icon("person", 12))
          : h("span", { className: "av agent", attrs: { "aria-hidden": "true" }, text: ">_" });
        const name = you ? "You" : agentName(m.kind || t.agentKind);
        const meta = you ? (m.held ? `${ago(m.at)} · queued` : ago(m.at)) : `via herdr · ${ago(m.at)}`;
        return h("div", { className: "msg" },
          h("div", { className: "who" }, avatar, h("b", { text: name }), h("span", { className: "meta", text: meta })),
          h("div", { className: "text", text: m.text }),
        );
      }),
    );
    msgs.scrollTop = msgs.scrollHeight;
  }

  function render(): void {
    const t = openId ? deps.store.get(openId) : undefined;
    if (!t) {
      close();
      return;
    }
    label.textContent = threadLabel(t);
    page.textContent = t.path;
    page.hidden = anchored;
    resolvedTag.hidden = !t.resolved;
    const action = t.resolved ? "Reopen thread" : "Resolve thread";
    resolveBtn.replaceChildren(icon(t.resolved ? "reopen" : "check", 16));
    resolveBtn.setAttribute("aria-label", action);
    resolveBtn.title = action;
    pop.setAttribute("aria-label", `Thread on ${threadLabel(t)}`);
    renderMessages(t);
    if (t.waiting) {
      const w = waitingText(t, deps.store);
      waitTitle.textContent = w.title;
      waitSub.textContent = w.sub;
      wait.classList.toggle("warn", w.warn);
    }
    heldActions.hidden = !isHeld(t);
    // The reply box stays while it waits: whatever is typed goes into the
    // agent's own queue behind the comment it is still working on.
    wait.hidden = !t.waiting;
    foot.hidden = anchored;
    // A reply that arrives while it is on screen has been read.
    if (t.unread && !document.hidden) void markRead(t.id);
    reposition();
  }

  async function markRead(id: string): Promise<void> {
    try {
      const updated = await deps.api.read(id);
      if (updated) deps.store.upsert(updated);
    } catch {
      /* stays unread; the next open tries again */
    }
  }

  function targetFor(t: Thread): Element | null {
    return deps.elementFor(t.id) ?? findThreadTarget(t, ctx.isOwn)?.el ?? null;
  }

  function reposition(): void {
    if (pop.hidden || !openId) return;
    const t = deps.store.get(openId);
    const el = t && anchored ? targetFor(t) : null;
    const rect = el?.isConnected ? el.getBoundingClientRect() : null;
    anchor.hidden = !rect;
    if (rect) outline(anchor, rect, 4);
    place(pop, rect);
  }

  async function sendReply(): Promise<void> {
    const text = input.value.trim();
    if (!openId || !text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    setNote("");
    try {
      const res = await deps.api.message(openId, text, ctx.prefs.targetAgent);
      if (!res.ok) {
        setNote(res.error, res.reason === "agent_blocked" ? "warn" : "err");
        if (res.candidates.length > 0) await chooseAgent(res.candidates);
        return;
      }
      input.value = "";
      fitInput();
      saveDraft(openId, "");
      if (res.rerouted) setNote("That terminal was closed — sent to another agent with the whole thread.", "warn");
      if (res.thread) deps.store.upsert(res.thread);
      deps.changed();
    } catch {
      setNote(`Bridge not reachable at ${ctx.bridge}.`, "err");
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  async function chooseAgent(candidates: AgentEntry[]): Promise<void> {
    destRow.hidden = false;
    setNote(await dest.refresh(candidates), "warn");
    reposition();
    dest.prompt();
  }

  async function resolve(): Promise<void> {
    const t = openId ? deps.store.get(openId) : undefined;
    if (!t) return;
    try {
      // A resolved thread's button reopens it, and it stays on screen.
      const updated = await deps.api.resolve(t.id, !t.resolved);
      if (updated) deps.store.upsert(updated);
      if (!t.resolved) close();
      deps.changed();
    } catch {
      setNote(`Bridge not reachable at ${ctx.bridge}.`, "err");
    }
  }

  async function cancelHeld(): Promise<void> {
    const t = openId ? deps.store.get(openId) : undefined;
    if (!t) return;
    try {
      const res = await deps.api.cancel(t.id);
      if (!res.ok) {
        setNote(res.error, "warn");
        deps.changed();
        return;
      }
      if (res.deleted) {
        deps.store.remove(t.id);
        close();
        deps.cancelled(t, res.texts);
        return;
      }
      if (res.thread) deps.store.upsert(res.thread);
      // The follow-ups it held go back into the box, ready to edit or drop.
      const back = res.texts.join("\n\n");
      input.value = input.value ? `${back}\n\n${input.value}` : back;
      fitInput();
      input.focus();
    } catch {
      setNote(`Bridge not reachable at ${ctx.bridge}.`, "err");
    }
  }

  async function sendNow(): Promise<void> {
    const t = openId ? deps.store.get(openId) : undefined;
    if (!t) return;
    sendNowBtn.disabled = true;
    try {
      const res = await deps.api.deliver(t.id, ctx.prefs.targetAgent);
      if (!res.ok) {
        setNote(res.error, res.reason === "agent_blocked" || res.reason === "not_held" ? "warn" : "err");
        if (res.candidates.length > 0) await chooseAgent(res.candidates);
        return;
      }
      if (res.rerouted) setNote("That terminal was closed — sent to another agent with the whole thread.", "warn");
      if (res.thread) deps.store.upsert(res.thread);
      deps.changed();
    } catch {
      setNote(`Bridge not reachable at ${ctx.bridge}.`, "err");
    } finally {
      sendNowBtn.disabled = false;
    }
  }

  function close(): void {
    openId = null;
    renderedKey = "";
    pop.hidden = true;
    anchor.hidden = true;
    rememberOpenThread(null);
  }

  closeBtn.addEventListener("click", () => close());
  cancelBtn.addEventListener("click", () => void cancelHeld());
  sendNowBtn.addEventListener("click", () => void sendNow());
  resolveBtn.addEventListener("click", () => void resolve());
  sendBtn.addEventListener("click", () => void sendReply());
  goBtn.addEventListener("click", () => {
    const t = openId ? deps.store.get(openId) : undefined;
    if (t) deps.goTo(t);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendReply();
    }
  });
  /**
   * Grows with its text up to 120px. No scrollbar until then: at one line the
   * browser would otherwise draw one for the fraction of a pixel it rounds.
   */
  function fitInput(): void {
    input.style.height = "34px";
    const wanted = input.scrollHeight + 2;
    input.style.height = `${Math.min(120, wanted)}px`;
    input.style.overflowY = wanted > 120 ? "auto" : "hidden";
  }

  let draftTimer = 0;
  input.addEventListener("input", () => {
    fitInput();
    window.clearTimeout(draftTimer);
    const id = openId;
    if (id) draftTimer = window.setTimeout(() => saveDraft(id, input.value), 300);
  });

  return {
    get openId() {
      return openId;
    },
    open(id) {
      const t = deps.store.get(id);
      if (!t) return;
      if (openId !== id) {
        input.value = readDraft(id);
        setNote("");
        destRow.hidden = true;
      }
      openId = id;
      // Kept for the tab: a reload — often the agent's own edit landing —
      // brings the thread back open instead of dropping it.
      rememberOpenThread(id);
      renderedKey = "";
      // Only a thread of this very page is pinned here: another page's
      // selector can match something unrelated on this one.
      anchored = deps.store.isHere(t) && targetFor(t) !== null;
      pop.hidden = false;
      render();
      fitInput();
      input.focus();
    },
    close,
    refresh: () => {
      if (openId) render();
    },
    reposition,
  };
}
