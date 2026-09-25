import type { Thread } from "../api.ts";
import { findThreadTarget } from "../anchor.ts";
import type { WidgetContext } from "../context.ts";
import { h, icon } from "../dom.ts";
import { pageKey } from "../navigation.ts";
import { agentName, ago, threadLabel } from "../status-text.ts";
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

/**
 * The page's open threads, plus replies waiting on other pages of the same
 * project — the one place a reply elsewhere can be seen without going there.
 */
export function createThreadList(ctx: WidgetContext, deps: ListDeps): ThreadList {
  const page = h("span", { className: "sub-label" });
  const gear = h("button", { className: "sbtn push", attrs: { type: "button", "aria-label": "Settings", title: "Settings" } }, icon("gear", 16));
  const closeBtn = h("button", { className: "sbtn", attrs: { type: "button", "aria-label": "Close" } }, icon("close", 14));
  const items = h("div", { className: "items" });
  const foot = h("div", { className: "lfoot" });
  const pop = h("div", { className: "pop wide", attrs: { role: "dialog", "aria-label": "Comments" }, hidden: true },
    h("div", { className: "head" }, h("span", { className: "title big", text: "Comments" }), page, gear, closeBtn), items, foot);
  ctx.layer.append(pop);

  function item(t: Thread, otherPage: boolean): HTMLButtonElement {
    const name = agentName(t.agentKind);
    const onPage = !otherPage && findThreadTarget(t, ctx.isOwn) !== null;
    const lastAgent = [...t.messages].reverse().find((m) => m.from === "agent");
    let status = t.waiting ? `Waiting for ${name}` : `${name} replied · ${ago(lastAgent?.at ?? t.updatedAt)}`;
    if (otherPage) status = `${name} replied on ${t.path}`;
    else if (!onPage) status += " · not on the page right now";
    const mini = h("span", { className: `mini ${onPage || otherPage ? (t.waiting ? "waiting" : "replied") : "gone"}` },
      t.waiting ? icon("person", 11) : ">_");
    const button = h("button", { className: `item${otherPage ? " other" : ""}`, attrs: { type: "button" } },
      mini,
      h("span", { className: "lines" },
        h("span", { className: "l1" }, h("span", { className: "c", text: threadLabel(t) }), h("span", { className: "x", text: t.messages[0]?.text ?? "" })),
        h("span", { className: "l2", text: status }),
      ),
      t.unread ? h("span", { className: "udot" }) : null,
    );
    button.addEventListener("click", () => {
      close();
      deps.openThread(t.id);
    });
    return button;
  }

  function render(): void {
    const here = deps.store.onPage();
    const others = deps.store.otherPageUnread();
    page.textContent = pageKey();
    items.replaceChildren();
    if (here.length === 0) items.append(h("div", { className: "empty", text: "No comments on this page yet. Use the select button to add one." }));
    for (const t of here) items.append(item(t, false));
    if (others.length > 0) {
      items.append(h("div", { className: "section", text: "Replies on other pages" }));
      for (const t of others) items.append(item(t, true));
    }
    const resolved = deps.store.resolvedCount;
    foot.textContent = resolved === 1 ? "1 resolved thread in this project" : `${resolved} resolved threads in this project`;
    place(pop, null);
  }

  function close(): void {
    if (pop.hidden) return;
    pop.hidden = true;
    deps.onToggle(false);
  }

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
