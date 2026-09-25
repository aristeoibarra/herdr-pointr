import type { WidgetContext } from "../context.ts";
import { h } from "../dom.ts";
import { hotkeyLabel, normalizeHotkey, type ShotTarget } from "../prefs.ts";

export interface SettingsPanel {
  /** Shown inside the comment list, in place of the threads. */
  readonly el: HTMLElement;
  /** Redraws from the prefs and stops any recording. */
  reset(): void;
  /** Takes the keystroke while a shortcut is being recorded. */
  handleKey(e: KeyboardEvent): boolean;
}

export interface SettingsDeps {
  /** The shortcut changed. */
  onChange(): void;
}

/**
 * The selection shortcut and the screenshot framing. The destination is
 * chosen on the comment itself. Saved in the page's localStorage, so each is
 * per app.
 */
export function createSettings(ctx: WidgetContext, deps: SettingsDeps): SettingsPanel {
  let recording = false;
  const hotkey = h("button", { className: "hk", attrs: { type: "button", "aria-label": "Selection shortcut" } });
  const shotElement = h("button", { attrs: { type: "button" }, text: "Element" });
  const shotViewport = h("button", { attrs: { type: "button" }, text: "Viewport" });
  const el = h("div", { className: "settings" },
    h("div", { className: "srow" },
      h("div", { className: "sname" }, h("span", { text: "Selection shortcut" }), h("span", { className: "shelp", text: "Click to record another." })),
      hotkey),
    h("div", { className: "srow" },
      h("div", { className: "sname" }, h("span", { text: "Screenshot" }), h("span", { className: "shelp", text: "What a screenshot frames." })),
      h("div", { className: "seg", attrs: { role: "group", "aria-label": "Screenshot framing" } }, shotElement, shotViewport)),
    h("div", { className: "sfoot", text: "Saved for this site only. The destination is picked on each comment." }),
  );

  function renderHotkey(): void {
    hotkey.textContent = recording ? "press a combo…" : hotkeyLabel(ctx.prefs.hotkey);
    hotkey.classList.toggle("rec", recording);
  }

  function renderShot(): void {
    shotElement.classList.toggle("on", ctx.prefs.shotTarget === "element");
    shotViewport.classList.toggle("on", ctx.prefs.shotTarget === "viewport");
  }

  hotkey.addEventListener("click", () => {
    recording = !recording;
    renderHotkey();
  });
  const setShot = (target: ShotTarget) => (): void => {
    ctx.prefs.shotTarget = target;
    ctx.savePrefs();
    renderShot();
  };
  shotElement.addEventListener("click", setShot("element"));
  shotViewport.addEventListener("click", setShot("viewport"));

  return {
    el,
    reset() {
      recording = false;
      renderHotkey();
      renderShot();
    },
    handleKey(e) {
      if (!recording) return false;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = false;
        renderHotkey();
        return true;
      }
      // A modifier on its own is the user still reaching for the key.
      if (/^(?:Alt|Control|Shift|Meta)/.test(e.code)) return true;
      if (!e.altKey && !e.ctrlKey && !e.metaKey) {
        hotkey.textContent = "add Alt, Ctrl or ⌘…";
        return true;
      }
      ctx.prefs.hotkey = normalizeHotkey({ code: e.code, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey });
      recording = false;
      renderHotkey();
      ctx.savePrefs();
      deps.onChange();
      return true;
    },
  };
}
