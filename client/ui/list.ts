import type { Thread } from "../api.ts";
import { findThreadTarget } from "../anchor.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";
import { agentName, ago, isHeld, threadLabel } from "../status-text.ts";
import type { Store } from "../store.ts";
import { place } from "./popover.ts";

export interface ThreadList {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  refresh(): void;
}

export interface ListDeps {
  store: Store;
  openThread(id: string): void;
  openSettings(anchor: DOMRect): void;
  onToggle(open: boolean): void;
}

type Tab = "open" | "resolved";

interface Group {
  key: string;
  label: string;
  here: boolean;
  threads: Thread[];
  latest: number;
}

/**
 * Every thread of the project in one place — open or resolved, grouped by
 * page, this page first. Another page's thread opens where you are, with a
 * way to go there.
 */
export function createThreadList(ctx: WidgetContext, deps: ListDeps): ThreadList {
  let tab: Tab = "open";
  const openTab = h("button", { attrs: { type: "button", role: "tab" } });
  const resolvedTab = h("button", { attrs: { type: "button", role: "tab" } });
  const gear = h("button", { className: "sbtn push", attrs: { type: "button", "aria-label": "Settings", title: "Settings" } }, icon("gear", 16));
  const closeBtn = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Close" } }, icon("close", 14));
  const items = h("div", { className: "items" });
  const pop = h("div", { className: "pop wide", attrs: { role: "dialog", "aria-label": "Comments" }, hidden: true },
    h("div", { className: "head" }, h("span", { className: "title big", text: "Comments" }), gear, closeBtn),
    h("div", { className: "tabs" }, h("div", { className: "seg", attrs: { role: "tablist", "aria-label": "Filter" } }, openTab, resolvedTab)),
    items);
  ctx.layer.append(pop);

  function status(t: Thread, here: boolean, onPage: boolean): string {
    const name = agentName(t.agentKind);
    if (t.resolved) return `Resolved · ${ago(t.updatedAt)}`;
    const lastAgent = [...t.messages].reverse().find((m) => m.from === "agent");
    let line = isHeld(t)
      ? "Queued in pointr"
      : t.waiting
        ? `Waiting for ${name}`
        : `${name} replied · ${ago(lastAgent?.at ?? t.updatedAt)}`;
    if (here && !onPage) line += " · not on the page right now";
    return line;
  }

  function item(t: Thread, here: boolean): HTMLButtonElement {
    const onPage = here && findThreadTarget(t, ctx.isOwn) !== null;
    const kind = t.resolved ? "resolved" : here && !onPage ? "gone" : t.waiting ? "waiting" : "replied";
    const mini = h("span", { className: `mini ${kind}` }, t.resolved ? icon("check", 11) : t.waiting ? icon("person", 11) : ">_");
    const button = h("button", { className: "item", attrs: { type: "button" } },
      mini,
      h("span", { className: "lines" },
        h("span", { className: "l1" }, h("span", { className: "c", text: threadLabel(t) }), h("span", { className: "x", text: t.messages[0]?.text ?? "" })),
        h("span", { className: "l2", text: status(t, here, onPage) }),
      ),
      t.unread ? h("span", { className: "udot" }) : null,
    );
    button.addEventListener("click", () => {
      close();
      deps.openThread(t.id);
    });
    return button;
  }

  function groups(threads: Thread[]): Group[] {
    const byPage = new Map<string, Group>();
    for (const t of threads) {
      const key = `${t.port}${t.path}`;
      let group = byPage.get(key);
      if (!group) {
        const here = deps.store.isHere(t);
        // Another dev server of the same project shows its port.
        const label = t.port === deps.store.port ? t.path : `:${t.port}${t.path}`;
        group = { key, label, here, threads: [], latest: 0 };
        byPage.set(key, group);
      }
      group.threads.push(t);
      group.latest = Math.max(group.latest, t.updatedAt);
    }
    // This page first, then pages with unread replies, then the most recent.
    return [...byPage.values()].sort((a, b) => {
      if (a.here !== b.here) return a.here ? -1 : 1;
      const au = a.threads.some((t) => t.unread);
      const bu = b.threads.some((t) => t.unread);
      if (au !== bu) return au ? -1 : 1;
      return b.latest - a.latest;
    });
  }

  function render(): void {
    const all = deps.store.threads;
    const open = all.filter((t) => !t.resolved);
    const resolved = all.filter((t) => t.resolved);
    openTab.textContent = `Open · ${open.length}`;
    resolvedTab.textContent = `Resolved · ${resolved.length}`;
    openTab.classList.toggle("on", tab === "open");
    resolvedTab.classList.toggle("on", tab === "resolved");
    openTab.setAttribute("aria-selected", String(tab === "open"));
    resolvedTab.setAttribute("aria-selected", String(tab === "resolved"));

    const shown = tab === "open" ? open : resolved;
    items.replaceChildren();
    if (shown.length === 0) {
      items.append(h("div", { className: "empty", text: tab === "open"
        ? "No open comments in this project. Use the select button to add one."
        : "Nothing resolved yet. Resolved threads are kept for 30 days." }));
    }
    for (const group of groups(shown)) {
      items.append(h("div", { className: "ghead" },
        h("span", { className: "mono", text: group.label }),
        group.here ? h("span", { className: "here", text: "this page" }) : null));
      // Newest activity first inside a page.
      for (const t of [...group.threads].sort((a, b) => b.updatedAt - a.updatedAt)) items.append(item(t, group.here));
    }
    place(pop, null);
  }

  function close(): void {
    if (pop.hidden) return;
    pop.hidden = true;
    deps.onToggle(false);
  }

  openTab.addEventListener("click", () => {
    tab = "open";
    render();
  });
  resolvedTab.addEventListener("click", () => {
    tab = "resolved";
    render();
  });
  gear.addEventListener("click", () => deps.openSettings(pop.getBoundingClientRect()));
  closeBtn.addEventListener("click", () => close());

  return {
    get isOpen() {
      return !pop.hidden;
    },
    open() {
      pop.hidden = false;
      render();
      deps.onToggle(true);
    },
    close,
    refresh: () => {
      if (!pop.hidden) render();
    },
  };
}
