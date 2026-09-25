/**
 * Finds a thread's element again on a later load, from what was stored when
 * the comment was made.
 *
 * A selector without positions (an id, a test id, a class) is trusted even
 * when the text changed — the agent may just have edited that text, and
 * dropping the pin exactly when the reply lands would be the worst moment.
 * A positional one (nth-of-type) only counts when the content still agrees:
 * after the DOM shifts it points at a neighbour, and a pin on the wrong
 * element misleads where no pin would not.
 */

import type { Anchor, Thread } from "./api.ts";
import { inspectComponent } from "./frameworks/index.ts";

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

function sameTag(el: Element, a: Anchor): boolean {
  return !a.tag || el.tagName.toLowerCase() === a.tag;
}

function contentMatches(el: Element, a: Anchor): boolean {
  const want = a.text.replace(/…$/, "");
  if (want && squash(el.textContent ?? "").slice(0, want.length) === want) return true;
  if (a.component) {
    try {
      return inspectComponent(el)?.component === a.component;
    } catch {
      return false;
    }
  }
  return false;
}

function query(selector: string): Element[] {
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

export function findAnchor(a: Anchor, isOwn: (node: EventTarget | null) => boolean): Element | null {
  if (a.id) {
    const el = document.getElementById(a.id);
    if (el && sameTag(el, a) && !isOwn(el)) return el;
  }
  const matches = a.selector ? query(a.selector).filter((el) => sameTag(el, a) && !isOwn(el)) : [];
  const positional = a.selector.includes(":nth-");
  const [only] = matches;
  if (matches.length === 1 && only && (!positional || contentMatches(only, a))) return only;
  if (matches.length > 1) {
    const agreeing = matches.filter((el) => contentMatches(el, a));
    if (agreeing.length === 1 && agreeing[0]) return agreeing[0];
  }
  // data-source (the optional Babel plugin) names the file and line: the
  // element carrying it, or the one inside it that still matches.
  if (a.source) {
    for (const scope of query(`[data-source="${CSS.escape(a.source)}"]`)) {
      if (isOwn(scope)) continue;
      if (sameTag(scope, a) && contentMatches(scope, a)) return scope;
      const inner = [...scope.querySelectorAll(a.tag || "*")].filter((el) => contentMatches(el, a));
      if (inner.length === 1 && inner[0]) return inner[0];
    }
  }
  return null;
}

/** The first of a thread's elements still on the page. */
export function findThreadTarget(t: Thread, isOwn: (node: EventTarget | null) => boolean): Element | null {
  for (const a of t.anchors) {
    const el = findAnchor(a, isOwn);
    if (el) return el;
  }
  return null;
}
