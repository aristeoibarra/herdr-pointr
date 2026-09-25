import { finder } from "@medv/finder";

import type { AnchorPos } from "./api.ts";
import { inspectComponent } from "./frameworks/index.ts";

export interface ElementPayload {
  selector: string;
  tag: string;
  id: string | null;
  /** Which framework adapter recognized the element, or null for plain DOM. */
  framework: string | null;
  component: string | null;
  componentStack: string[];
  props: Record<string, string> | null;
  source: string | null;
  role: string | null;
  accessibleName: string | null;
  text: string;
  /** The text around this element — see contextOf. */
  context: string;
  /** Where it sat on the page — see posOf. */
  pos: AnchorPos;
  /** What the elements shaped like it nearby read — see peersOf. */
  peers: string[];
  styles: Record<string, string>;
  box: { x: number; y: number; w: number; h: number };
  html: string;
}

const STYLE_PROPS = [
  "display", "position", "boxSizing", "width", "height", "padding", "margin", "gap",
  "flexDirection", "justifyContent", "alignItems", "flexWrap",
  "gridTemplateColumns", "gridTemplateRows",
  "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign",
  "textTransform", "whiteSpace",
  "color", "backgroundColor", "backgroundImage", "opacity",
  "borderRadius", "borderWidth", "borderStyle", "borderColor", "boxShadow",
  "transform", "overflow", "zIndex", "cursor",
] as const;

/**
 * Values that carry no information, per property.
 *
 * The old filter was one set of five strings matched against every property,
 * which let most of the noise through: on a real send, 65% of the style block
 * was defaults. `position: static` and `flexWrap: nowrap` read like findings
 * and are just what CSS does when nobody said otherwise.
 *
 * `fontFamily`, `transition` and `outline` are not in STYLE_PROPS at all.
 * fontFamily is inherited and enormous (the emoji fallback stack alone is
 * ~80 characters); the other two are almost never what a change request is
 * about, and when they are, the class list in the HTML says it better.
 */
const DEFAULTS: Record<string, readonly string[]> = {
  position: ["static"],
  boxSizing: ["border-box", "content-box"],
  flexDirection: ["row"],
  flexWrap: ["nowrap"],
  justifyContent: ["normal", "flex-start"],
  alignItems: ["normal", "stretch"],
  fontWeight: ["400"],
  textAlign: ["start", "left"],
  opacity: ["1"],
  overflow: ["visible"],
  cursor: ["auto", "default"],
  borderStyle: ["none", "solid"],
  lineHeight: ["normal"],
};

const SKIP_VALUES = new Set(["none", "normal", "auto", "0px", "0s", "rgba(0, 0, 0, 0)"]);

/**
 * Tailwind's shadow utilities emit a ring/offset scaffold of fully transparent
 * shadows before the real ones — four of them, ~120 characters, saying nothing.
 */
function trimShadow(value: string): string {
  const trimmed = value
    .replace(/rgba\(0,\s*0,\s*0,\s*0\)(?:\s+-?[\d.]+px){2,4}\s*,?\s*/g, "")
    .replace(/,\s*$/, "")
    .trim();
  return trimmed;
}

function captureStyles(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    let value = cs.getPropertyValue(camelToKebab(prop)).trim();
    if (prop === "boxShadow") value = trimShadow(value);
    if (!value || SKIP_VALUES.has(value)) continue;
    if (DEFAULTS[prop]?.includes(value)) continue;
    out[prop] = value;
  }
  // A border colour and style describe a border that isn't there.
  if (!("borderWidth" in out)) {
    delete out["borderStyle"];
    delete out["borderColor"];
  }
  return out;
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Stable, readable selector — finder strips Tailwind utility noise for us. */
export function buildSelector(el: Element): string {
  try {
    return finder(el, {
      idName: (name) => /^[a-zA-Z][\w-]{2,}$/.test(name) && !/^:r/.test(name),
      attr: (name) =>
        name === "data-testid" ||
        name === "data-test" ||
        name === "role" ||
        name === "aria-label" ||
        name === "name",
      className: (name) =>
        !/^[a-z]+-/.test(name) &&
        !/[:[\]/#.]/.test(name) &&
        !/^[A-Za-z0-9_-]{1,2}$/.test(name) &&
        !/_[A-Za-z0-9]{5,}$/.test(name),
      timeoutMs: 1000,
    });
  } catch {
    return el.tagName.toLowerCase();
  }
}

function accessibleName(el: Element): string | null {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  // Only short text reads as a "name"; long text is container noise (already in `text`).
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text && text.length <= 50 ? text : null;
}

/**
 * outerHTML with the parts no agent reads removed.
 *
 * An inline icon carries a few hundred characters of bezier coordinates —
 * a single lucide icon was 350 of the 912 characters of HTML in a real send.
 * The tag and its class still say which icon it is, which is all anyone needs.
 */
function compactHtml(el: Element): string {
  const clone = el.cloneNode(true);
  if (!(clone instanceof Element)) return el.outerHTML;
  for (const svg of clone.querySelectorAll("svg")) {
    svg.replaceChildren();
    for (const attr of [...svg.attributes]) {
      if (attr.name !== "class" && !attr.name.startsWith("aria-")) svg.removeAttribute(attr.name);
    }
  }
  return clone.outerHTML;
}

const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

const POSITIONS = /:nth-(?:of-type|child)\(\d+\)/g;

/** Whether a selector picks its element by position among siblings. */
export function isPositional(selector: string): boolean {
  return selector.includes(":nth-");
}

/** The selector without positions: every element built the same way. */
export function shapeOf(selector: string): string {
  return selector.replace(POSITIONS, "");
}

/**
 * What surrounds an element: the text of its nearest ancestor that has any
 * beyond the element's own, with the element's cut out and its place marked
 * — up to 90 characters each side. Editing the element leaves this
 * unchanged; the page reshuffling so a positional selector lands on a
 * neighbour does not. A button alone in its cell says nothing about which
 * row it is in, so the walk goes on up to the row.
 */
export function contextOf(el: Element): string {
  const own = squash(el.textContent ?? "");
  let scope = el.parentElement;
  for (let hops = 0; scope && hops < 4; hops++, scope = scope.parentElement) {
    const whole = squash(scope.textContent ?? "");
    if (whole === own) continue;
    const at = own ? whole.indexOf(own) : -1;
    if (at < 0) return whole.slice(0, 180);
    return `${whole.slice(Math.max(0, at - 90), at)}…${whole.slice(at + own.length, at + own.length + 90)}`;
  }
  return "";
}

/** The element's box in document pixels, and the viewport width it was measured at. */
export function posOf(el: Element): AnchorPos {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2 + window.scrollX),
    y: Math.round(rect.top + rect.height / 2 + window.scrollY),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    vw: window.innerWidth,
  };
}

/**
 * What the elements built like this one read, the nearest six on each side
 * in document order. Only for a positional selector, where the element is
 * told from its siblings by place alone: when it is removed, the next one
 * slides into that place, and this is how the pin knows it for the neighbour.
 */
export function peersOf(el: Element, selector: string): string[] {
  if (!isPositional(selector)) return [];
  let all: Element[];
  try {
    all = [...document.querySelectorAll(shapeOf(selector))];
  } catch {
    return [];
  }
  const at = all.indexOf(el);
  if (at < 0 || all.length > 60) return [];
  const near = [...all.slice(Math.max(0, at - 6), at), ...all.slice(at + 1, at + 7)];
  const texts = near.map((peer) => squash(peer.textContent ?? "").slice(0, 40)).filter(Boolean);
  return [...new Set(texts)];
}

export function buildElementPayload(el: Element): ElementPayload {
  const rect = el.getBoundingClientRect();
  const info = inspectComponent(el);
  // data-source is only present if the optional Babel plugin is enabled, and
  // when it is, it is exact — so it beats whatever the adapter could infer.
  const sourceEl = el.closest("[data-source]");
  const selector = buildSelector(el);
  return {
    selector,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    framework: info?.framework ?? null,
    component: info?.component ?? null,
    componentStack: info?.componentStack ?? [],
    props: info?.props ?? null,
    source: sourceEl?.getAttribute("data-source") ?? info?.source ?? null,
    role: el.getAttribute("role"),
    accessibleName: accessibleName(el),
    text: (el.textContent ?? "").trim(),
    context: contextOf(el),
    pos: posOf(el),
    peers: peersOf(el, selector),
    styles: captureStyles(el),
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
    html: compactHtml(el),
  };
}
