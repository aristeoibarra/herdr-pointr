/**
 * Pins: one per open thread on this page, at the top-right corner of its
 * element. They live in the shadow root like the rest of the widget, so the
 * host's event guards cover them and a host-page modal stays open when one
 * is clicked.
 */

import type { Thread } from "./api.ts";
import { findThreadTarget } from "./anchor.ts";
import type { WidgetContext } from "./context.ts";
import { h, icon } from "./dom.ts";
import { agentName, threadLabel } from "./status-text.ts";

export interface Pins {
  render(threads: Thread[]): void;
  setVisible(on: boolean): void;
  /** The element a thread is pinned to, when it is on the page. */
  elementFor(id: string): Element | null;
  /** Looks every pin's element up again — after a route change. */
  refind(): void;
  schedule(): void;
}

interface Entry {
  thread: Thread;
  el: Element | null;
  pin: HTMLButtonElement;
}

export function createPins(ctx: WidgetContext, open: (id: string) => void): Pins {
  const layer = h("div", { className: "pins" });
  ctx.layer.append(layer);
  const entries = new Map<string, Entry>();
  let visible = true;
  let frame = 0;
  let mutationTimer = 0;
  let observing = false;

  const resizes = new ResizeObserver(() => schedule());
  const mutations = new MutationObserver(() => {
    // DOM churn comes in bursts; one pass every 300 ms is plenty, and it only
    // looks for pins that have lost their element.
    if (mutationTimer) return;
    mutationTimer = window.setTimeout(() => {
      mutationTimer = 0;
      let changed = false;
      for (const entry of entries.values()) {
        if (!entry.el || !entry.el.isConnected) changed = locate(entry) || changed;
      }
      if (changed) schedule();
    }, 300);
  });
  ctx.signal.addEventListener("abort", () => {
    resizes.disconnect();
    mutations.disconnect();
    window.cancelAnimationFrame(frame);
    window.clearTimeout(mutationTimer);
  });

  function observe(): void {
    const wanted = visible && entries.size > 0 && document.body !== null;
    if (wanted && !observing) {
      mutations.observe(document.body, { childList: true, subtree: true });
      observing = true;
    } else if (!wanted && observing) {
      mutations.disconnect();
      resizes.disconnect();
      observing = false;
    }
  }

  /** Finds the entry's element; true when it changed. */
  function locate(entry: Entry): boolean {
    const el = findThreadTarget(entry.thread, ctx.isOwn);
    if (el === entry.el) return false;
    if (entry.el) resizes.unobserve(entry.el);
    entry.el = el;
    if (el) resizes.observe(el);
    return true;
  }

  function paint(entry: Entry): void {
    const t = entry.thread;
    const name = agentName(t.agentKind);
    const label = threadLabel(t);
    entry.pin.className = `pin ${t.waiting ? "waiting" : "replied"}`;
    entry.pin.replaceChildren(t.waiting ? icon("person", 13) : ">_");
    if (t.unread) entry.pin.append(h("span", { className: "dot" }));
    entry.pin.setAttribute(
      "aria-label",
      t.waiting ? `Your comment on ${label}, waiting for ${name}` : `${name} replied on ${label}${t.unread ? ", unread" : ""}`,
    );
    entry.pin.title = t.messages[0]?.text.slice(0, 120) ?? "";
  }

  function flush(): void {
    frame = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Read every rect first, then write: no layout thrash with many pins.
    const placed: Array<{ entry: Entry; x: number; y: number } | { entry: Entry; hide: true }> = [];
    for (const entry of entries.values()) {
      const el = entry.el;
      const rect = el?.isConnected ? el.getBoundingClientRect() : null;
      if (!rect || (rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        placed.push({ entry, hide: true });
        continue;
      }
      placed.push({ entry, x: Math.min(rect.right - 5, vw - 32), y: Math.max(4, rect.top - 23) });
    }
    const taken: Array<{ x: number; y: number }> = [];
    for (const item of placed) {
      if ("hide" in item) {
        item.entry.pin.hidden = true;
        continue;
      }
      let { x } = item;
      while (taken.some((p) => Math.abs(p.x - x) < 8 && Math.abs(p.y - item.y) < 8)) x -= 24;
      taken.push({ x, y: item.y });
      item.entry.pin.hidden = !visible;
      item.entry.pin.style.transform = `translate(${x}px, ${item.y}px)`;
    }
  }

  function schedule(): void {
    if (!frame && !ctx.signal.aborted) frame = window.requestAnimationFrame(flush);
  }

  window.addEventListener("scroll", schedule, { capture: true, passive: true, signal: ctx.signal });
  window.addEventListener("resize", schedule, { passive: true, signal: ctx.signal });

  return {
    render(threads) {
      const ids = new Set(threads.map((t) => t.id));
      for (const [id, entry] of entries) {
        if (ids.has(id)) continue;
        if (entry.el) resizes.unobserve(entry.el);
        entry.pin.remove();
        entries.delete(id);
      }
      for (const thread of threads) {
        let entry = entries.get(thread.id);
        if (!entry) {
          const pin = h("button", { className: "pin", attrs: { type: "button" }, hidden: true });
          pin.addEventListener("click", () => open(thread.id));
          layer.append(pin);
          entry = { thread, el: null, pin };
          entries.set(thread.id, entry);
          locate(entry);
        }
        entry.thread = thread;
        if (!entry.el || !entry.el.isConnected) locate(entry);
        paint(entry);
      }
      observe();
      schedule();
    },
    setVisible(on) {
      visible = on;
      layer.hidden = !on;
      observe();
      schedule();
    },
    elementFor(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (!entry.el || !entry.el.isConnected) locate(entry);
      return entry.el;
    },
    refind() {
      for (const entry of entries.values()) locate(entry);
      schedule();
    },
    schedule,
  };
}
