import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";
import { hotkeyLabel } from "../prefs.ts";

export interface Dock {
  readonly el: HTMLElement;
  /** Comments show once the widget can list them; until then only select does. */
  showComments(on: boolean): void;
  setSelecting(on: boolean): void;
  setPins(on: boolean): void;
  setCount(count: number): void;
  setUnread(on: boolean): void;
  setListOpen(open: boolean): void;
  refreshTitle(): void;
}

export interface DockHandlers {
  select(): void;
  togglePins(): void;
  toggleList(): void;
}

/**
 * Bottom-right: select, then the page's comments — the bubble shows or hides
 * their pins, the count opens the list. The blue dot means a reply is
 * waiting somewhere in the project, not only on this page.
 */
export function createDock(ctx: WidgetContext, handlers: DockHandlers): Dock {
  const selectBtn = h("button", { className: "ibtn select", attrs: { type: "button", "aria-pressed": "false" } }, icon("select", 18));
  const pinsBtn = h("button", { className: "ibtn on", attrs: { type: "button", "aria-pressed": "true", "aria-label": "Show comments on the page", title: "Show or hide comments" } });
  const countText = h("span", { text: "0" });
  const dot = h("span", { className: "dot", hidden: true });
  const countBtn = h("button", { className: "count", attrs: { type: "button", "aria-expanded": "false" } }, countText, icon("chevron", 14), dot);
  const sep = h("span", { className: "sep" });
  const el = h("div", { className: "dock", attrs: { role: "toolbar", "aria-label": "pointr" } },
    selectBtn, sep, pinsBtn, countBtn);
  ctx.layer.append(el);

  selectBtn.addEventListener("click", () => handlers.select());
  pinsBtn.addEventListener("click", () => handlers.togglePins());
  countBtn.addEventListener("click", () => handlers.toggleList());

  let count = 0;
  const refreshCount = (): void => {
    countText.textContent = String(count);
    countBtn.setAttribute("aria-label", `Comments on this page: ${count}`);
  };

  const dock: Dock = {
    el,
    showComments(on) {
      sep.hidden = !on;
      pinsBtn.hidden = !on;
      countBtn.hidden = !on;
    },
    setSelecting(on) {
      selectBtn.classList.toggle("on", on);
      selectBtn.setAttribute("aria-pressed", String(on));
    },
    setPins(on) {
      pinsBtn.classList.toggle("on", on);
      pinsBtn.setAttribute("aria-pressed", String(on));
      pinsBtn.replaceChildren(icon(on ? "bubble" : "bubbleOff", 18));
    },
    setCount(n) {
      count = n;
      refreshCount();
    },
    setUnread(on) {
      dot.hidden = !on;
    },
    setListOpen(open) {
      countBtn.classList.toggle("on", open);
      countBtn.setAttribute("aria-expanded", String(open));
    },
    refreshTitle() {
      const label = `Select an element (${hotkeyLabel(ctx.prefs.hotkey)})`;
      selectBtn.title = label;
      selectBtn.setAttribute("aria-label", label);
    },
  };
  dock.setPins(true);
  dock.refreshTitle();
  refreshCount();
  return dock;
}
