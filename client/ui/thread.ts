import type { Api, Thread } from "../api.ts";
import { findThreadTarget } from "../anchor.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon, spinner } from "../dom.ts";
import { pageKey } from "../navigation.ts";
import { agentName, ago, threadLabel, waitingText } from "../status-text.ts";
import type { Store } from "../store.ts";
import { outline, place } from "./popover.ts";
import type { Settings } from "./settings.ts";

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
  settings: Settings;
  /** The thread's element, when it is on this page. */
  elementFor(id: string): Element | null;
  /** Something changed on the bridge's side: fetch the project again. */
  changed(): void;
  goTo(thread: Thread): void;
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
  const resolveBtn = h("button", { className: "sbtn push", attrs: { type: "button", "aria-label": "Resolve thread", title: "Resolve" } }, icon("check", 16));
  const closeBtn = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Close" } }, icon("close", 14));
  const msgs = h("div", { className: "msgs" });
  const waitTitle = h("div", { className: "t" });
  const waitSub = h("div", { className: "s" });
  const wait = h("div", { className: "wait", hidden: true }, spinner(), h("div", {}, waitTitle, waitSub));
  const input = h("textarea", { attrs: { rows: "1", placeholder: "Reply…", "aria-label": "Reply" } });
  const sendBtn = h("button", { className: "sq", attrs: { type: "button", "aria-label": "Send reply" } }, icon("up", 16));
  const reply = h("div", { className: "reply", hidden: true }, input, sendBtn);
  const note = h("div", { className: "note", attrs: { role: "status" } });
  const goBtn = h("button", { className: "gbtn", attrs: { type: "button" } }, "Go to page", icon("arrowRight", 13));
  const foot = h("div", { className: "foot", hidden: true }, goBtn);
  const pop = h("div", { className: "pop", attrs: { role: "dialog" }, hidden: true },
    h("div", { className: "head ruled" }, label, page, resolveBtn, closeBtn), msgs, wait, reply, note, foot);
  ctx.layer.append(anchor, pop);

  function setNote(text: string, kind: "" | "err" | "warn" = ""): void {
    note.textContent = text;
    note.className = `note ${kind}`.trim();
  }

  function renderMessages(t: Thread): void {
    const key = `${t.id}:${t.messages.map((m) => m.id).join(",")}`;
    if (key === renderedKey) return;
    renderedKey = key;
    msgs.replaceChildren(
      ...t.messages.map((m) => {
        const you = m.from === "user";
        const avatar = you
          ? h("span", { className: "av you", attrs: { "aria-hidden": "true" } }, icon("person", 12))
          : h("span", { className: "av agent", attrs: { "aria-hidden": "true" }, text: ">_" });
        const name = you ? "You" : agentName(m.kind || t.agentKind);
        const meta = you ? ago(m.at) : `via herdr · ${ago(m.at)}`;
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
    pop.setAttribute("aria-label", `Thread on ${threadLabel(t)}`);
    renderMessages(t);
    if (t.waiting) {
      const w = waitingText(t, deps.store);
      waitTitle.textContent = w.title;
      waitSub.textContent = w.sub;
      wait.classList.toggle("warn", w.warn);
    }
    wait.hidden = !t.waiting;
    reply.hidden = t.waiting;
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
    return deps.elementFor(t.id) ?? findThreadTarget(t, ctx.isOwn);
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
        if (res.candidates.length > 0) deps.settings.open(pop.getBoundingClientRect(), res.candidates);
        return;
      }
      input.value = "";
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

  async function resolve(): Promise<void> {
    if (!openId) return;
    try {
      const updated = await deps.api.resolve(openId, true);
      if (updated) deps.store.upsert(updated);
      close();
      deps.changed();
    } catch {
      setNote(`Bridge not reachable at ${ctx.bridge}.`, "err");
    }
  }

  function close(): void {
    openId = null;
    renderedKey = "";
    pop.hidden = true;
    anchor.hidden = true;
  }

  closeBtn.addEventListener("click", () => close());
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
  input.addEventListener("input", () => {
    input.style.height = "34px";
    input.style.height = `${Math.min(120, input.scrollHeight + 2)}px`;
  });

  return {
    get openId() {
      return openId;
    },
    open(id) {
      const t = deps.store.get(id);
      if (!t) return;
      if (openId !== id) {
        input.value = "";
        setNote("");
      }
      openId = id;
      renderedKey = "";
      // Only a thread of this very page is pinned here: another page's
      // selector can match something unrelated on this one.
      anchored = t.port === deps.store.port && t.path === pageKey() && targetFor(t) !== null;
      pop.hidden = false;
      render();
      if (!t.waiting) input.focus();
    },
    close,
    refresh: () => {
      if (openId) render();
    },
    reposition,
  };
}
