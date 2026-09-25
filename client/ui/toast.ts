import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";

export type ToastKind = "ok" | "reply" | "warn" | "err";

export interface ToastOptions {
  kind?: ToastKind;
  action?: { label: string; run(): void };
  /** Milliseconds before it goes away on its own; 0 keeps it. */
  ms?: number;
}

export interface Toaster {
  show(text: string, options?: ToastOptions): void;
  clear(): void;
}

/** One toast at a time, above the dock. A newer one replaces the last. */
export function createToaster(ctx: WidgetContext): Toaster {
  let timer = 0;
  const led = h("span", { className: "led" });
  const text = h("span", { className: "msg-text" });
  const action = h("button", { className: "pbtn", attrs: { type: "button" } });
  const close = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Dismiss" } }, icon("close", 14));
  const el = h("div", { className: "toast", attrs: { role: "status" }, hidden: true }, led, text, action, close);
  ctx.layer.append(el);

  let onAction: (() => void) | null = null;
  action.addEventListener("click", () => {
    const run = onAction;
    clear();
    run?.();
  });
  close.addEventListener("click", () => clear());

  function clear(): void {
    window.clearTimeout(timer);
    el.hidden = true;
    onAction = null;
  }

  return {
    show(message, options = {}) {
      window.clearTimeout(timer);
      el.className = `toast ${options.kind ?? "ok"}`;
      text.textContent = message;
      onAction = options.action?.run ?? null;
      action.textContent = options.action?.label ?? "";
      action.hidden = !options.action;
      el.hidden = false;
      const ms = options.ms ?? 4000;
      if (ms > 0) timer = window.setTimeout(clear, ms);
    },
    clear,
  };
}
