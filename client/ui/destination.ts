import type { AgentEntry, Api } from "../api.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";

export interface DestinationPicker {
  /** The chip: a native select dressed as one, so choosing is one click. */
  readonly el: HTMLElement;
  /**
   * Reads the agents and where auto-routing would send this page. Returns a
   * line worth showing — candidates from a send routing could not settle, a
   * pinned agent that is gone — or "".
   */
  refresh(candidates?: AgentEntry[]): Promise<string>;
  /** Opens the list where the browser allows it: routing asked the user to choose. */
  prompt(): void;
}

export interface DestinationDeps {
  api: Api;
  /** The pin changed. */
  onChange(): void;
}

/**
 * Where a comment goes: auto-routing, or an agent pinned for this app. The
 * pin lives in the page's localStorage, so it is per app.
 */
export function createDestinationPicker(ctx: WidgetContext, deps: DestinationDeps): DestinationPicker {
  const select = h("select", { attrs: { "aria-label": "Destination", title: "Where this comment goes" } });
  const el = h("span", { className: "dest" }, h("span", { className: "led" }), select, icon("chevron", 12));

  function option(value: string, text: string): HTMLOptionElement {
    return h("option", { attrs: { value }, text });
  }

  async function auto(): Promise<{ text: string; ok: boolean; ambiguous: number }> {
    try {
      const d = await deps.api.destination(location.href);
      if (d.ok) return { text: `auto · ${[d.project, d.kind].filter(Boolean).join(" · ")}`, ok: true, ambiguous: 0 };
      if (d.candidates.length > 1) return { text: `auto · ${d.candidates.length} agents`, ok: false, ambiguous: d.candidates.length };
      return { text: "auto · no agent for this page", ok: false, ambiguous: 0 };
    } catch {
      return { text: "auto · bridge offline", ok: false, ambiguous: 0 };
    }
  }

  async function refresh(candidates: AgentEntry[] = []): Promise<string> {
    const pinned = ctx.prefs.targetAgent;
    const [route, agents] = await Promise.all([auto(), deps.api.agents().catch(() => null)]);
    const autoOption = option("", route.text);
    select.replaceChildren(autoOption);
    let line = "";
    if (agents === null) {
      // Offline proves nothing about the pin, so keep it selectable.
      if (pinned) select.append(option(pinned.paneId, ctx.prefs.targetAgentLabel ?? pinned.paneId));
    } else {
      for (const agent of agents) {
        // Status is shown here and never stored: it changes by the second.
        const entry = option(agent.id, `${agent.label} — ${agent.status}`);
        entry.dataset["label"] = agent.label;
        entry.dataset["session"] = agent.session ?? "";
        select.append(entry);
      }
      // Pane ids are never reused: a pin the bridge no longer lists is dead.
      if (pinned && !agents.some((a) => a.id === pinned.paneId)) {
        line = "The pinned agent was closed — this goes to auto-routing.";
      }
    }
    select.value = pinned && [...select.options].some((o) => o.value === pinned.paneId) ? pinned.paneId : "";
    // Said before sending, not after: a send left on auto would come back 409.
    const choices = candidates.length > 0 ? candidates.length : select.value === "" ? route.ambiguous : 0;
    if (choices > 0) line = `${choices} agents could own this page — choose one in the destination list.`;
    el.classList.toggle("warn", line !== "" || (select.value === "" && !route.ok));
    return line;
  }

  select.addEventListener("change", () => {
    const chosen = select.selectedOptions[0];
    if (select.value === "" || chosen === undefined) {
      ctx.prefs.targetAgent = null;
      ctx.prefs.targetAgentLabel = null;
    } else {
      const session = chosen.dataset["session"] ?? "";
      ctx.prefs.targetAgent = { paneId: select.value, session: session === "" ? null : session };
      ctx.prefs.targetAgentLabel = chosen.dataset["label"] ?? null;
    }
    el.classList.remove("warn");
    ctx.savePrefs();
    deps.onChange();
  });

  return {
    el,
    refresh,
    prompt() {
      select.focus();
      try {
        // Needs a user gesture still in effect; the send click usually is.
        select.showPicker();
      } catch {
        /* focused and flagged is enough */
      }
    },
  };
}
