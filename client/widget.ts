/**
 * pointr browser widget.
 * Injected via <script src="http://localhost:PORT/widget.js"> in development.
 * Pick elements on the page, comment on them, and the comment goes to the
 * coding agent that owns the project.
 */

import { findAnchor } from "./anchor.ts";
import { createApi, type Thread } from "./api.ts";
import type { WidgetContext } from "./context.ts";
import { installDiagnostics } from "./diagnostics.ts";
import { h } from "./dom.ts";
import { NAVIGATE_EVENT, installHistoryHook, pageKey } from "./navigation.ts";
import { createPins } from "./pins.ts";
import { createPoller } from "./poller.ts";
import { hotkeyLabel, loadPrefs, matchesHotkey, savePrefs } from "./prefs.ts";
import { createSelector } from "./select.ts";
import { rememberOpenThread, takeOpenThread } from "./session.ts";
import { agentName } from "./status-text.ts";
import { createStore } from "./store.ts";
import { STYLES } from "./styles.ts";
import { createComposer } from "./ui/composer.ts";
import { createDock } from "./ui/dock.ts";
import { createThreadList } from "./ui/list.ts";
import { createSettings } from "./ui/settings.ts";
import { createThreadView } from "./ui/thread.ts";
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
  const store = createStore();
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
    onSent: (thread, project, notes) => {
      if (notes.length > 0) toast.show(`Sent to ${project || "the agent"} (${notes.join("; ")}).`, { kind: "warn" });
      if (!thread) return;
      store.upsert(thread);
      threads.open(thread.id);
      poller.kick();
    },
  });
  const pins = createPins(ctx, (id) => openThread(id));
  const threads = createThreadView(ctx, {
    api,
    store,
    settings,
    elementFor: (id) => pins.elementFor(id),
    changed: () => poller.kick(),
    goTo,
    cancelled: (t, texts) => {
      const text = texts.join("\n\n");
      const here = store.isHere(t);
      const elements = here ? t.anchors.map((a) => findAnchor(a, ctx.isOwn)).filter((el): el is Element => el !== null) : [];
      if (elements.length > 0) {
        composer.edit(elements, text);
        return;
      }
      toast.show(`Cancelled before ${agentName(t.agentKind)} saw it.`, { kind: "warn", ms: 6000 });
    },
  });
  const list = createThreadList(ctx, {
    store,
    openThread: (id) => openThread(id),
    openSettings: (anchor) => settings.open(anchor),
    onToggle: (open) => dock.setListOpen(open),
  });
  let firstLoad = true;
  // A comment half-written when the page reloaded comes back first: unsent
  // text is the thing worth not losing, so it wins over reopening a thread.
  const restoringComment = composer.restore();
  const poller = createPoller(ctx, api, store, (replied) => {
    if (firstLoad) {
      firstLoad = false;
      // Reloaded with a thread open, or arrived through Go to page.
      const pending = takeOpenThread();
      if (pending && store.get(pending) && !restoringComment) openThread(pending);
      else announceMissed();
    }
    announce(replied);
  });
  const selector = createSelector(ctx, {
    onPick: (el) => composer.add(el),
    onChange: (active) => dock.setSelecting(active),
  });
  const dock = createDock(ctx, {
    select: () => (selector.active ? selector.cancel() : startSelect()),
    togglePins: () => {
      prefs.pins = !prefs.pins;
      ctx.savePrefs();
      dock.setPins(prefs.pins);
      pins.setVisible(prefs.pins);
    },
    toggleList: () => {
      if (list.isOpen) {
        list.close();
        return;
      }
      composer.close();
      threads.close();
      settings.close();
      list.open();
    },
  });
  dock.setPins(prefs.pins);
  pins.setVisible(prefs.pins);

  function rerender(): void {
    const onPage = store.onPage();
    pins.render(onPage);
    dock.setCount(onPage.length);
    dock.setUnread(store.anyUnread());
    threads.refresh();
    list.refresh();
  }
  store.subscribe(rerender);

  /**
   * A reply that is not already in view gets a toast: one on another page,
   * or one on this page whose pin is hidden or has lost its element.
   */
  function announce(replied: Thread[]): void {
    for (const t of replied) {
      if (threads.openId === t.id) continue;
      const here = store.isHere(t);
      if (here && prefs.pins && pins.elementFor(t.id)) continue;
      toast.show(`${agentName(t.agentKind)} replied ${here ? "on this page" : `on ${t.path}`}`, {
        kind: "reply",
        ms: 8000,
        action: { label: "View", run: () => openThread(t.id) },
      });
    }
  }

  /**
   * Replies that landed on other pages while this tab was elsewhere or
   * closed. This page's own show as pins; the others would go unnoticed.
   */
  function announceMissed(): void {
    const missed = store.otherPageUnread();
    const [only] = missed;
    if (missed.length === 1 && only) {
      toast.show(`${agentName(only.agentKind)} replied on ${only.path}`, {
        kind: "reply",
        ms: 8000,
        action: { label: "View", run: () => openThread(only.id) },
      });
    } else if (missed.length > 1) {
      toast.show(`${missed.length} replies waiting on other pages`, {
        kind: "reply",
        ms: 8000,
        action: { label: "Show", run: () => list.open() },
      });
    }
  }

  /**
   * Leaves for the thread's page. Same dev server: a plain navigation, and
   * the thread reopens on arrival. Another one of the project's servers is
   * another origin, so it opens through the bridge and nothing carries over.
   */
  function goTo(t: Thread): void {
    if (t.port === store.port) {
      rememberOpenThread(t.id, t.path);
      location.assign(location.origin + t.path);
      return;
    }
    window.open(`${bridge}/open?url=${encodeURIComponent(t.url)}`, "_self");
  }

  // Client-side routing moves the page without a load: redraw for the new one.
  installHistoryHook();
  let lastPage = pageKey();
  const onNavigate = (): void => {
    const now = pageKey();
    if (now === lastPage) return;
    lastPage = now;
    composer.close();
    if (threads.openId) threads.close();
    pins.refind();
    rerender();
  };
  window.addEventListener(NAVIGATE_EVENT, onNavigate, { signal });
  window.addEventListener("popstate", onNavigate, { signal });
  window.addEventListener("hashchange", onNavigate, { signal });

  function startSelect(): void {
    settings.close();
    threads.close();
    list.close();
    selector.start();
  }

  function openThread(id: string): void {
    composer.close();
    settings.close();
    list.close();
    threads.open(id);
  }

  /** Esc closes the topmost thing the widget has open, one layer at a time. */
  function closeTopmost(): boolean {
    if (selector.active) selector.cancel();
    else if (settings.isOpen) settings.close();
    else if (composer.isOpen) composer.close();
    else if (threads.openId) threads.close();
    else if (list.isOpen) list.close();
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

  const reposition = (): void => {
    composer.reposition();
    threads.reposition();
  };
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

  poller.kick();

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
