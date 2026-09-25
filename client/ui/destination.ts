import type { AgentEntry, Api } from "../api.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";
import { agentName } from "../status-text.ts";

export interface DestinationPicker {
  /** The chip; it opens the list of agents under it. */
  readonly el: HTMLElement;
  /**
   * Reads the agents and where auto-routing would send this page. Returns a
   * line worth showing — candidates from a send routing could not settle, a
   * pinned agent that is gone — or "".
   */
  refresh(candidates?: AgentEntry[]): Promise<string>;
  /** Opens the list: routing asked the user to choose. */
  prompt(): void;
  close(): void;
  /** While the list is open: arrows move through it, Esc closes only it. */
  handleKey(e: KeyboardEvent): boolean;
}

export interface DestinationDeps {
  api: Api;
  /** The pin changed. */
  onChange(): void;
}

interface Route {
  /** What the chip says on auto. */
  chip: string;
  /** What the Auto row says under its name. */
  detail: string;
  ok: boolean;
  candidates: AgentEntry[];
}

const GAP = 6;
const MARGIN = 12;

/**
 * Where a comment goes: auto-routing, or an agent pinned for this app. The
 * pin lives in the page's localStorage, so it is per app. The list is the
 * widget's own rather than a native select's: those open in the system's
 * colours, with no room to say what each agent is doing.
 */
export function createDestinationPicker(ctx: WidgetContext, deps: DestinationDeps): DestinationPicker {
  let agents: AgentEntry[] | null = [];
  let route: Route = { chip: "auto", detail: "", ok: true, candidates: [] };
  let asked: AgentEntry[] = [];
  let open = false;

  const text = h("span", { className: "dtext", text: "auto" });
  const chip = h("button", { className: "dest", attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" } },
    h("span", { className: "led" }), text, icon("chevron", 12));
  const menu = h("div", { className: "dmenu", attrs: { role: "listbox", "aria-label": "Destination" }, hidden: true });
  ctx.layer.append(menu);

  async function readRoute(): Promise<Route> {
    try {
      const d = await deps.api.destination(location.href);
      if (d.ok) {
        const where = [d.project, d.kind].filter(Boolean).join(" · ");
        return { chip: `auto · ${where}`, detail: `${where}, from this page's port`, ok: true, candidates: [] };
      }
      if (d.candidates.length > 1) {
        const n = d.candidates.length;
        return { chip: `auto · ${n} agents`, detail: `${n} agents could own this page`, ok: false, candidates: d.candidates };
      }
      return { chip: "auto · no agent", detail: "No agent works on this page's project", ok: false, candidates: [] };
    } catch {
      return { chip: "auto · offline", detail: "The bridge is not answering", ok: false, candidates: [] };
    }
  }

  /** The pin, when it still points at a live agent — or the bridge cannot tell. */
  function livePin(): string | null {
    const pinned = ctx.prefs.targetAgent;
    if (!pinned) return null;
    return agents === null || agents.some((a) => a.id === pinned.paneId) ? pinned.paneId : null;
  }

  function renderChip(line: string): void {
    const pinned = livePin();
    const live = pinned ? agents?.find((a) => a.id === pinned) : undefined;
    text.textContent = pinned ? (ctx.prefs.targetAgentLabel ?? pinned) : route.chip;
    chip.title = pinned
      ? `Pinned to ${text.textContent}${live ? ` (${live.status})` : ""}. Click to change.`
      : "Auto: the agent working in this page's project. Click to pin one.";
    chip.classList.toggle("warn", line !== "" || (!pinned && !route.ok));
  }

  async function refresh(candidates: AgentEntry[] = []): Promise<string> {
    const [nextRoute, nextAgents] = await Promise.all([readRoute(), deps.api.agents().catch(() => null)]);
    route = nextRoute;
    agents = nextAgents;
    asked = candidates.length > 0 ? candidates : route.candidates;
    const pinned = ctx.prefs.targetAgent;
    let line = "";
    // Pane ids are never reused: a pin the bridge no longer lists is dead.
    if (pinned && agents !== null && !agents.some((a) => a.id === pinned.paneId)) {
      line = "The pinned agent was closed — this goes to auto-routing.";
    }
    // Said before sending, not after: a send left on auto would come back 409.
    if (candidates.length > 0 || (!livePin() && asked.length > 1)) {
      line = `${asked.length} agents could own this page — choose one in the destination list.`;
    }
    renderChip(line);
    if (open) {
      renderMenu();
      position();
    }
    return line;
  }

  function choose(agent: AgentEntry | null): void {
    if (agent) {
      ctx.prefs.targetAgent = { paneId: agent.id, session: agent.session };
      ctx.prefs.targetAgentLabel = agent.label;
    } else {
      ctx.prefs.targetAgent = null;
      ctx.prefs.targetAgentLabel = null;
    }
    ctx.savePrefs();
    close();
    renderChip("");
    chip.focus();
    deps.onChange();
  }

  function option(name: string, sub: string, selected: boolean, status: string, pick: () => void): HTMLButtonElement {
    const button = h("button", { className: "dopt", attrs: { type: "button", role: "option", "aria-selected": String(selected) } },
      h("span", { className: "ck" }, selected ? icon("check", 14) : null),
      h("span", { className: "nm" }, h("b", { text: name }), sub ? h("span", { text: sub }) : null),
      status ? h("span", { className: `st ${status}` }, h("span", { className: "led" }), status) : null,
    );
    button.addEventListener("click", pick);
    return button;
  }

  function agentOption(agent: AgentEntry, pinned: string | null): HTMLButtonElement {
    // The label is "project · kind", plus the workspace when two share both.
    const [project = agent.label, , ...rest] = agent.label.split(" · ");
    const kind = [agentName(agent.kind), ...rest].join(" · ");
    const sub = agent.title ? `${kind} — ${agent.title}` : kind;
    return option(project, sub, agent.id === pinned, agent.status || "unknown", () => choose(agent));
  }

  function renderMenu(): void {
    const pinned = livePin();
    const focused = options().findIndex((o) => o === ctx.host.shadowRoot?.activeElement);
    menu.replaceChildren(option("Auto", route.detail, pinned === null, "", () => choose(null)), h("div", { className: "dsep" }));
    if (agents === null || agents.length === 0) {
      menu.append(h("div", { className: "dempty", text: agents === null ? "No agents to list while the bridge is not answering." : "herdr reports no agents open." }));
    } else {
      const could = new Set(asked.map((a) => a.id));
      const first = agents.filter((a) => could.has(a.id));
      const others = agents.filter((a) => !could.has(a.id));
      if (first.length > 0) {
        menu.append(h("div", { className: "dhead", text: "Could own this page" }), ...first.map((a) => agentOption(a, pinned)));
        if (others.length > 0) menu.append(h("div", { className: "dhead", text: "Other agents" }));
      } else {
        menu.append(h("div", { className: "dhead", text: "Pin an agent" }));
      }
      menu.append(...others.map((a) => agentOption(a, pinned)));
    }
    // A refresh while the list is open must not throw away where the keyboard was.
    if (focused >= 0) options()[focused]?.focus();
  }

  /** Under the chip, its right edge on the chip's; above it when there is no room below. */
  function position(): void {
    const rect = chip.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(MARGIN, rect.right - width), window.innerWidth - width - MARGIN);
    const below = rect.bottom + GAP;
    const top = below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, rect.top - GAP - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function options(): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>(".dopt")];
  }

  function show(): void {
    open = true;
    renderMenu();
    // Popovers share the top z-index, so the last in the DOM wins.
    ctx.layer.append(menu);
    menu.hidden = false;
    chip.setAttribute("aria-expanded", "true");
    position();
    const all = options();
    (all.find((o) => o.getAttribute("aria-selected") === "true") ?? all[0])?.focus();
    // Statuses change by the second: read them again while the list is open.
    void refresh(asked);
  }

  function close(): void {
    if (!open) return;
    open = false;
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
  }

  chip.addEventListener("click", () => (open ? close() : show()));
  const inside = (e: Event): boolean => e.composedPath().some((node) => node === menu || node === chip);
  document.addEventListener("pointerdown", (e) => {
    if (open && !inside(e)) close();
  }, { capture: true, signal: ctx.signal });
  window.addEventListener("scroll", (e) => {
    if (open && !inside(e)) close();
  }, { capture: true, passive: true, signal: ctx.signal });
  window.addEventListener("resize", close, { passive: true, signal: ctx.signal });

  return {
    el: chip,
    refresh,
    prompt: show,
    close,
    handleKey(e) {
      if (!open) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        chip.focus();
        return true;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = options();
        const at = all.findIndex((o) => o === ctx.host.shadowRoot?.activeElement);
        const next = e.key === "ArrowDown" ? Math.min(all.length - 1, at + 1) : Math.max(0, at - 1);
        all[next]?.focus();
        return true;
      }
      return false;
    },
  };
}
