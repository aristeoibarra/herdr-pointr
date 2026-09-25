/** Picking mode: hover outlines what a click would pick, the click picks it. */

import type { WidgetContext } from "./context.ts";
import { h } from "./dom.ts";
import { inspectComponent } from "./frameworks/index.ts";
import { outline } from "./ui/popover.ts";

export interface PickFor {
  /** What the hint asks for. */
  hint: string;
  /** Takes this one pick instead of opening a comment. */
  pick(el: Element): void;
}

export interface Selector {
  readonly active: boolean;
  /** Picks for a new comment, or once for `pickFor`. */
  start(pickFor?: PickFor): void;
  cancel(): void;
}

export interface SelectorDeps {
  onPick(el: Element): void;
  onChange(active: boolean): void;
}

function describe(el: Element): string {
  const component = inspectComponent(el)?.component;
  if (component) return `<${component}>`;
  const tag = el.tagName.toLowerCase();
  return el.id ? `${tag}#${el.id}` : tag;
}

const COMMENT_HINT = "Click an element to comment on it";

export function createSelector(ctx: WidgetContext, deps: SelectorDeps): Selector {
  let active = false;
  let once: PickFor | null = null;
  const overlay = h("div", { className: "overlay" });
  const name = h("span");
  const size = h("span", { className: "sub" });
  const tag = h("div", { className: "tag" }, name, size);
  const cancel = h("button", { className: "gbtn", attrs: { type: "button" }, text: "Cancel" });
  const hintText = h("span", { text: COMMENT_HINT });
  const hint = h("div", { className: "hint", attrs: { role: "status" }, hidden: true }, hintText, cancel);
  ctx.layer.append(overlay, tag, hint);
  cancel.addEventListener("click", () => stop());

  function draw(el: Element | null): void {
    if (!el) {
      overlay.style.display = "none";
      tag.classList.remove("show");
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    outline(overlay, rect);
    name.textContent = describe(el);
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    tag.classList.add("show");
    tag.style.left = `${Math.max(8, rect.left)}px`;
    tag.style.top = `${rect.top > 34 ? rect.top - 30 : rect.bottom + 6}px`;
  }

  function stop(): void {
    if (!active) return;
    active = false;
    once = null;
    hint.hidden = true;
    draw(null);
    deps.onChange(false);
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!active) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      draw(el && !ctx.isOwn(el) ? el : null);
    },
    { capture: true, signal: ctx.signal },
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!active || ctx.isOwn(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || ctx.isOwn(el)) return;
      const pickFor = once;
      stop();
      if (pickFor) pickFor.pick(el);
      else deps.onPick(el);
    },
    { capture: true, signal: ctx.signal },
  );

  // While picking, a press is the pick, not an interaction: it must not
  // dismiss a modal or trigger a control that acts on pointerdown.
  // touchstart is left alone: cancelling it would cancel the click that picks.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!active || ctx.isOwn(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true, signal: ctx.signal },
    );
  }

  window.addEventListener("scroll", () => active && draw(null), { capture: true, passive: true, signal: ctx.signal });

  return {
    get active() {
      return active;
    },
    start(pickFor) {
      once = pickFor ?? null;
      hintText.textContent = pickFor?.hint ?? COMMENT_HINT;
      if (active) return;
      active = true;
      hint.hidden = false;
      deps.onChange(true);
    },
    cancel: stop,
  };
}
