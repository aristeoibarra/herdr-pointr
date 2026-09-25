import type { AgentEntry, Api } from "../api.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";
import { hotkeyLabel, normalizeHotkey, type ShotTarget } from "../prefs.ts";
import { place } from "./popover.ts";

export interface Settings {
  readonly isOpen: boolean;
  /** Opens next to anchor; candidates come from a send routing could not settle. */
  open(anchor: DOMRect | null, candidates?: AgentEntry[]): void;
  close(): void;
  /** Takes the keystroke while a shortcut is being recorded. */
  handleKey(e: KeyboardEvent): boolean;
}

export interface SettingsDeps {
  api: Api;
  /** The destination or shortcut changed. */
  onChange(): void;
}

/**
 * Destination, shortcut and screenshot framing. Saved in the page's
 * localStorage, so each is per app — a destination chosen for one app
 * never follows you to another.
 */
export function createSettings(ctx: WidgetContext, deps: SettingsDeps): Settings {
  let recording = false;
  const select = h("select", { attrs: { "aria-label": "Destination" } });
  const note = h("div", { className: "snote" });
  const hotkey = h("button", { className: "hk", attrs: { type: "button", "aria-label": "Selection shortcut" } });
  const shotElement = h("button", { attrs: { type: "button" }, text: "Element" });
  const shotViewport = h("button", { attrs: { type: "button" }, text: "Viewport" });
  const close = h("button", { className: "sbtn push", attrs: { type: "button", "aria-label": "Close settings" } }, icon("close", 14));
  const pop = h("div", { className: "pop settings", attrs: { role: "dialog", "aria-label": "Settings" }, hidden: true },
    h("div", { className: "head" }, h("span", { className: "title", text: "Settings" }), close),
    h("div", { className: "srow" }, h("span", { text: "Destination" }), select),
    note,
    h("div", { className: "srow" }, h("span", { text: "Shortcut" }), hotkey),
    h("div", { className: "srow" }, h("span", { text: "Screenshot" }), h("div", { className: "seg", attrs: { role: "group", "aria-label": "Screenshot framing" } }, shotElement, shotViewport)),
    h("div", { className: "sfoot", text: "Saved for this site only." }),
  );
  ctx.layer.append(pop);

  function renderHotkey(): void {
    hotkey.textContent = recording ? "press a combo… (Esc cancels)" : hotkeyLabel(ctx.prefs.hotkey);
    hotkey.classList.toggle("rec", recording);
  }

  function renderShot(): void {
    shotElement.classList.toggle("on", ctx.prefs.shotTarget === "element");
    shotViewport.classList.toggle("on", ctx.prefs.shotTarget === "viewport");
  }

  function setNote(text: string, warn = false): void {
    note.textContent = text;
    note.classList.toggle("err", warn);
  }

  async function loadAgents(candidates: AgentEntry[] | undefined): Promise<void> {
    const pinned = ctx.prefs.targetAgent;
    select.replaceChildren(h("option", { attrs: { value: "" }, text: "Auto — from this page's port" }));
    try {
      const agents = await deps.api.agents();
      for (const agent of agents) {
        // Status is rendered here and never stored: it changes by the second.
        const option = h("option", { attrs: { value: agent.id }, text: `${agent.label} — ${agent.status}` });
        option.dataset["label"] = agent.label;
        option.dataset["session"] = agent.session ?? "";
        select.append(option);
      }
      // A pin the bridge no longer lists is a dead pane id — they are never
      // reused, so say so instead of silently showing Auto.
      const stale = pinned !== null && !agents.some((a) => a.id === pinned.paneId);
      select.value = stale ? "" : (pinned?.paneId ?? "");
      if (candidates && candidates.length > 0) {
        setNote(`${candidates.length} agents could own this page — pick one.`, true);
      } else if (stale) {
        setNote("That agent is gone — comments fall back to auto-routing.", true);
      } else {
        setNote(agents.length === 0 ? "herdr reports no agents open." : "");
      }
    } catch {
      // Offline proves nothing about the pin, so keep it selectable.
      if (pinned !== null) {
        select.append(h("option", { attrs: { value: pinned.paneId }, text: ctx.prefs.targetAgentLabel ?? pinned.paneId }));
        select.value = pinned.paneId;
      }
      setNote("Bridge offline — showing the last known pin.", true);
    }
  }

  select.addEventListener("change", () => {
    const option = select.selectedOptions[0];
    if (select.value === "" || option === undefined) {
      ctx.prefs.targetAgent = null;
      ctx.prefs.targetAgentLabel = null;
    } else {
      const session = option.dataset["session"] ?? "";
      ctx.prefs.targetAgent = { paneId: select.value, session: session === "" ? null : session };
      ctx.prefs.targetAgentLabel = option.dataset["label"] ?? null;
    }
    setNote("");
    ctx.savePrefs();
    deps.onChange();
  });
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
  close.addEventListener("click", () => settings.close());

  const settings: Settings = {
    get isOpen() {
      return !pop.hidden;
    },
    open(anchor, candidates) {
      recording = false;
      renderHotkey();
      renderShot();
      pop.hidden = false;
      place(pop, anchor);
      void loadAgents(candidates).then(() => place(pop, anchor));
    },
    close() {
      recording = false;
      pop.hidden = true;
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
        hotkey.textContent = "add Alt, Ctrl or ⌘ to the key…";
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
  return settings;
}
