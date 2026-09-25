/**
 * pointr browser widget.
 * Injected via <script src="http://localhost:PORT/widget.js"> in development.
 * Pick elements on the page, comment on them, and the comment goes to the
 * coding agent that owns the project.
 */

import { createApi } from "./api.ts";
import type { WidgetContext } from "./context.ts";
import { installDiagnostics } from "./diagnostics.ts";
import { h } from "./dom.ts";
import { hotkeyLabel, loadPrefs, matchesHotkey, savePrefs } from "./prefs.ts";
import { createSelector } from "./select.ts";
import { STYLES } from "./styles.ts";
import { createComposer } from "./ui/composer.ts";
import { createDock } from "./ui/dock.ts";
import { createSettings } from "./ui/settings.ts";
import { createToaster } from "./ui/toast.ts";

const ROOT_ID = "pointr-root";
const HANDLE_KEY = "__pointrWidget";

interface WidgetHandle {
  dispose(): void;
}

function isWidgetHandle(value: unknown): value is WidgetHandle {
  return typeof value === "object" && value !== null && "dispose" in value && typeof value.dispose === "function";
}

function mount(bridge: string): WidgetHandle {
  const life = new AbortController();
  const { signal } = life;

  const host = h("div", { attrs: { id: ROOT_ID } });
  const shadow = host.attachShadow({ mode: "open" });
  const layer = h("div", { className: "layer" });
  shadow.append(h("style", { text: STYLES }), layer);
  // documentElement, not body: the proxy runs this first in <head>.
  document.documentElement.appendChild(host);

  const prefs = loadPrefs();
  const ctx: WidgetContext = {
    bridge,
    rootId: ROOT_ID,
    host,
    layer,
    signal,
    prefs,
    savePrefs: () => savePrefs(prefs),
    isOwn: (node) => node instanceof Node && host.contains(node),
  };

  const api = createApi(bridge);
  const toast = createToaster(ctx);
  const settings = createSettings(ctx, {
    api,
    onChange: () => {
      dock.refreshTitle();
      composer.refreshDestination();
    },
  });
  const composer = createComposer(ctx, {
    api,
    settings,
    pickAnother: () => selector.start(),
    onSent: (_thread, project, notes) => {
      const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      toast.show(`Sent to ${project || "the agent"}${suffix}.`);
    },
  });
  const selector = createSelector(ctx, {
    onPick: (el) => composer.add(el),
    onChange: (active) => dock.setSelecting(active),
  });
  const dock = createDock(ctx, {
    select: () => (selector.active ? selector.cancel() : startSelect()),
    togglePins: () => undefined,
    toggleList: () => undefined,
  });
  dock.showComments(false);

  function startSelect(): void {
    settings.close();
    selector.start();
  }

  /** Esc closes the topmost thing the widget has open, one layer at a time. */
  function closeTopmost(): boolean {
    if (selector.active) selector.cancel();
    else if (settings.isOpen) settings.close();
    else if (composer.isOpen) composer.close();
    else return false;
    return true;
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (settings.handleKey(e)) return;
      if (e.key === "Escape") {
        closeTopmost();
        return;
      }
      if (matchesHotkey(e, prefs.hotkey)) {
        e.preventDefault();
        if (selector.active) selector.cancel();
        else startSelect();
      }
    },
    { capture: true, signal },
  );

  const reposition = (): void => composer.reposition();
  window.addEventListener("scroll", reposition, { capture: true, passive: true, signal });
  window.addEventListener("resize", reposition, { passive: true, signal });

  // A modal (Radix/vaul drawers, dialogs, popovers) watches the document for
  // presses and focus outside itself, and sees the widget's as exactly that:
  // they leave the shadow root retargeted to the host. Pressing a button
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
      if (ctx.isOwn(e.relatedTarget)) e.stopImmediatePropagation();
    },
    { capture: true, signal },
  );

  console.info(`[pointr] widget ready — ${hotkeyLabel(prefs.hotkey)} or the dock to comment on an element.`);

  return {
    dispose: () => {
      life.abort();
      host.remove();
    },
  };
}

(function initWidget(): void {
  // Origin of the bridge that served this script — works on any port, no build-time define.
  const script = document.currentScript;
  const bridge = script instanceof HTMLScriptElement && script.src ? new URL(script.src).origin : "http://localhost:7331";

  // Hook console/fetch/error before the app code runs (the proxy puts this
  // script first in <head>), and before the double-injection guard below.
  installDiagnostics(bridge);

  if (document.getElementById(ROOT_ID)) return;

  // A previous instance whose root was removed — Pointr.tsx unmounting under
  // StrictMode or HMR, then loading the script again — still has its document
  // and window listeners attached. Tear it down before mounting over it, or
  // every keypress runs twice.
  const previous: unknown = Reflect.get(window, HANDLE_KEY);
  if (isWidgetHandle(previous)) previous.dispose();
  Reflect.set(window, HANDLE_KEY, mount(bridge));
})();
