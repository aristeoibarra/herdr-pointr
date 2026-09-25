/**
 * Finds a thread's element again — on a later load, or after the page
 * changed under its pin — from the photo taken when the comment was made.
 *
 * Two passes. The first takes only proof: the id, a selector without
 * positions, or a positional one whose element still reads the same, by its
 * own text or, when that was edited, by the text around it.
 *
 * The second weighs every look-alike at once — its text, what surrounds it,
 * whether the agent's reply quotes it, the selector's shape, where it sat —
 * and takes the best only when it clearly beats the next. Most of the time
 * the element went missing because the agent edited it, and the agent's
 * reply says what it reads now. What it must not do is land on a neighbour:
 * when the element was removed, the next one slides into its place and
 * matches its selector. A candidate reading like one of the element's old
 * neighbours is taken for exactly that, and no pin beats a pin on the wrong
 * element.
 */

import type { Anchor, Thread } from "./api.ts";
import { buildSelector, contextOf, isPositional, peersOf, posOf, shapeOf } from "./capture.ts";
import { inspectComponent } from "./frameworks/index.ts";

type IsOwn = (node: EventTarget | null) => boolean;

export interface Found {
  el: Element;
  /** Proven by the first pass. A weighed guess is worth renewing the photo for. */
  sure: boolean;
}

export interface ThreadTarget extends Found {
  /** Which of the thread's anchors found it. */
  index: number;
}

/** A weighed candidate is taken at this score, and only this far ahead of the next. */
const ACCEPT = 4;
const MARGIN = 2;
const MAX_CANDIDATES = 400;
const MAX_TEXT_NODES = 20_000;

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
const textOf = (el: Element): string => squash(el.textContent ?? "");

function sameTag(el: Element, a: Anchor): boolean {
  return !a.tag || el.tagName.toLowerCase() === a.tag;
}

function query(selector: string): Element[] {
  if (!selector) return [];
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

/** Its own text is what was stored — equal, or its start when the stored one was cut. */
function reads(el: Element, a: Anchor): boolean {
  const want = a.text.replace(/…$/, "");
  if (!want) return false;
  const text = textOf(el);
  return want.length >= 120 || a.text.endsWith("…") ? text.startsWith(want) : text === want;
}

/** A context that is only the marker says nothing about which element it was. */
function informative(context: string): boolean {
  return context.replace("…", "").trim() !== "";
}

function sameContext(el: Element, a: Anchor): boolean {
  return informative(a.context) && contextOf(el) === a.context;
}

/**
 * Its text sets it apart: nothing else built the same way reads the same. A
 * row's "Edit" button reads like every other row's, so for it only the text
 * around it — the row — can prove anything.
 */
function readsAlone(el: Element, a: Anchor): boolean {
  return reads(el, a) && !query(shapeOf(a.selector)).some((other) => other !== el && reads(other, a));
}

/** The first pass: an element the photo proves, or nothing. */
function prove(a: Anchor, isOwn: IsOwn): Element | null {
  const usable = (el: Element | null): el is Element => el !== null && sameTag(el, a) && !isOwn(el);
  if (a.id) {
    const el = document.getElementById(a.id);
    if (usable(el)) return el;
  }
  const matches = query(a.selector).filter(usable);
  const [only] = matches;
  if (only && matches.length === 1 && !isPositional(a.selector)) return only;
  const agreeing = matches.filter((el) => sameContext(el, a) || readsAlone(el, a));
  if (agreeing.length === 1 && agreeing[0]) return agreeing[0];
  // data-source (the optional Babel plugin) names the file and line: the
  // element carrying it, or the one inside it that still reads the same.
  if (a.source) {
    for (const scope of query(`[data-source="${CSS.escape(a.source)}"]`)) {
      if (isOwn(scope)) continue;
      if (sameTag(scope, a) && (reads(scope, a) || sameContext(scope, a))) return scope;
      const inner = [...scope.querySelectorAll(a.tag || "*")].filter((el) => reads(el, a) || sameContext(el, a));
      if (inner.length === 1 && inner[0]) return inner[0];
    }
  }
  return null;
}

/**
 * Reads like one of the element's old neighbours, not like the element: that
 * neighbour, slid into its place — or its node, reused by a list re-render.
 */
export function readsLikeNeighbour(el: Element, a: Anchor): boolean {
  const text = textOf(el);
  if (!text || reads(el, a)) return false;
  const [before = "", after = ""] = a.context.split("…");
  return a.peers.includes(text.slice(0, 40)) || (text.length >= 2 && (after.startsWith(text) || before.endsWith(text)));
}

/** Dice similarity over character pairs, 0 to 1. */
function similarity(x: string, y: string): number {
  const a = x.toLowerCase();
  const b = y.toLowerCase();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) {
      pairs.set(pair, left - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

/** Counts only once it is more alike than not. */
const close = (x: string, y: string): number => {
  const s = similarity(x, y);
  return s >= 0.5 ? s : 0;
};

const QUOTED = /["“”«»'`‘’]([^"“”«»'`‘’\n]{1,80})["“”«»'`‘’]/g;

/** Strings the agent quoted: how a reply names text it put on the page. */
function quotedIn(replies: string): string[] {
  return [...replies.matchAll(QUOTED)].map((m) => squash(m[1] ?? "")).filter((q) => q.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 3 when the reply quotes this text, 1 when it only says it, else 0. Quoted
 * counts at any length — `"I"` is exactly what a roman numeral edit leaves;
 * said without quotes, a short text shows up in any prose by chance.
 */
function mentioned(replies: string, quoted: string[], text: string): number {
  if (quoted.includes(text)) return 3;
  if (text.length < 3 || text.length > 80) return 0;
  const word = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(text)}(?:$|[^\\p{L}\\p{N}])`, "u");
  return word.test(replies) ? 1 : 0;
}

/** Text nodes holding any of the needles, for the candidates that did not keep their selector. */
function textNodesWith(needles: string[]): Text[] {
  const found: Text[] = [];
  if (!document.body || needles.length === 0) return found;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let seen = 0; seen < MAX_TEXT_NODES && found.length < 100; seen++) {
    const node = walker.nextNode();
    if (!(node instanceof Text)) break;
    const data = node.data;
    if (needles.some((needle) => data.includes(needle))) found.push(node);
  }
  return found;
}

function longestWord(text: string): string {
  return text.replace(/…$/, "").split(" ").reduce((best, word) => (word.length > best.length ? word : best), "");
}

const within = (now: number, then: number): boolean => Math.abs(now - then) <= Math.max(4, then * 0.15);

/**
 * 2 for the same box in the same place, 0.5 for close by; nothing at another
 * viewport width. The box, not only the place: the card around a number and
 * the label above it sit just as close.
 */
function nearness(el: Element, a: Anchor): number {
  const pos = a.pos;
  if (!pos || Math.abs(window.innerWidth - pos.vw) > pos.vw * 0.1) return 0;
  const now = posOf(el);
  if (now.w === 0 && now.h === 0) return 0;
  const distance = Math.hypot(now.x - pos.x, now.y - pos.y);
  if (distance < 8 && within(now.w, pos.w) && within(now.h, pos.h)) return 2;
  return distance < 60 ? 0.5 : 0;
}

function infoOf(el: Element): ReturnType<typeof inspectComponent> {
  try {
    return inspectComponent(el);
  } catch {
    return null;
  }
}

/** The second pass: the clear best of every look-alike, or nothing. */
function weigh(a: Anchor, isOwn: IsOwn, replies: string): Element | null {
  const bySelector = new Set(query(a.selector));
  const shape = shapeOf(a.selector);
  const shaped = shape !== a.selector ? query(shape) : [];
  const byShape = new Set(shaped.length <= 200 ? shaped : []);
  const quoted = quotedIn(replies);

  const pool = new Set<Element>();
  const add = (el: Element | null): void => {
    if (el && pool.size < MAX_CANDIDATES && sameTag(el, a) && !isOwn(el)) pool.add(el);
  };
  for (const el of bySelector) add(el);
  for (const el of byShape) add(el);
  // Elements that lost their selector along the way: whatever still holds
  // the stored text, or the text the agent quoted, and a few ancestors.
  const needles = [longestWord(a.text), ...quoted].filter((needle) => needle.length >= 3);
  for (const node of textNodesWith(needles)) {
    let el = node.parentElement;
    for (let hops = 0; el && hops < 5; hops++, el = el.parentElement) add(el);
  }
  if (a.source) {
    for (const scope of query(`[data-source="${CSS.escape(a.source)}"]`)) {
      add(scope);
      for (const el of [...scope.querySelectorAll(a.tag || "*")].slice(0, 50)) add(el);
    }
  }

  const want = a.text.replace(/…$/, "");
  // Text shared with look-alikes ("Edit" on every row) says little; then
  // what surrounds it decides, and different surroundings count against.
  const shared = [...pool].filter((el) => reads(el, a)).length > 1;
  const scored: Array<{ el: Element; score: number }> = [];
  for (const el of pool) {
    const text = textOf(el);
    const same = reads(el, a);
    let score = 0;
    if (want) score += same ? (shared ? 1 : 4) : 3 * close(text, want);
    if (informative(a.context)) {
      const around = contextOf(el);
      const alike = around === a.context ? 1 : close(around, a.context);
      score += alike === 1 ? 5 : 4 * alike;
      if (same && shared && alike === 0) score -= 3;
    }
    if (!same && text) {
      if (readsLikeNeighbour(el, a)) score -= 6;
      score += mentioned(replies, quoted, text);
    }
    if (bySelector.has(el)) score += isPositional(a.selector) ? 1.5 : 3;
    if (byShape.has(el)) score += 1;
    if (a.component) {
      const component = infoOf(el)?.component ?? "";
      // A list renders every row with the same component: it can only tell against.
      if (component === a.component) score += 1;
      else if (component) score -= 3;
    }
    if (a.source && el.closest("[data-source]")?.getAttribute("data-source") === a.source) score += 3;
    score += nearness(el, a);
    scored.push({ el, score });
  }
  scored.sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  if (!best || best.score < ACCEPT || (next && best.score - next.score < MARGIN)) return null;
  return best.el;
}

export interface FindOptions {
  /** What the agent wrote in the thread: it usually quotes the element's new text. */
  replies?: string;
  /** Proof only, no weighing. */
  proofOnly?: boolean;
}

export function findAnchor(a: Anchor, isOwn: IsOwn, options: FindOptions = {}): Found | null {
  const proven = prove(a, isOwn);
  if (proven) return { el: proven, sure: true };
  if (options.proofOnly) return null;
  const guessed = weigh(a, isOwn, options.replies ?? "");
  return guessed ? { el: guessed, sure: false } : null;
}

/** Everything the thread's agent said, for the weighing. */
export function repliesOf(t: Thread): string {
  return t.messages.filter((m) => m.from === "agent").map((m) => m.text).join("\n");
}

/**
 * The first of a thread's elements still on the page. Every anchor is tried
 * for proof before any is weighed: a proven second element beats a guessed
 * first one.
 */
export function findThreadTarget(t: Thread, isOwn: IsOwn, options: FindOptions = {}): ThreadTarget | null {
  for (const [index, a] of t.anchors.entries()) {
    const el = prove(a, isOwn);
    if (el) return { el, sure: true, index };
  }
  if (options.proofOnly) return null;
  const replies = options.replies ?? repliesOf(t);
  for (const [index, a] of t.anchors.entries()) {
    const el = weigh(a, isOwn, replies);
    if (el) return { el, sure: false, index };
  }
  return null;
}

/** A fresh photo of an element, in the shape the bridge stores. */
export function anchorFor(el: Element): Anchor {
  const selector = buildSelector(el);
  const info = infoOf(el);
  return {
    selector,
    tag: el.tagName.toLowerCase(),
    id: el.id,
    component: info?.component ?? "",
    framework: info?.framework ?? "",
    source: el.closest("[data-source]")?.getAttribute("data-source") ?? info?.source ?? "",
    text: textOf(el).slice(0, 120),
    context: contextOf(el),
    pos: posOf(el),
    peers: peersOf(el, selector),
  };
}

/** What an element reads and what surrounds it: a change here is a change to the element. */
export function lookOf(el: Element): string {
  return `${textOf(el)}\u0000${contextOf(el)}`;
}
