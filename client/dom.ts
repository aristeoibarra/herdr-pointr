/**
 * Tiny DOM builder. Text goes in as text nodes, never as markup: thread
 * messages come from agents and from other tabs, so nothing the widget
 * renders from data may pass through innerHTML.
 */

type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  hidden?: boolean;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.className) el.className = options.className;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.hidden) el.hidden = true;
  for (const [name, value] of Object.entries(options.attrs ?? {})) el.setAttribute(name, value);
  for (const [type, handler] of Object.entries(options.on ?? {})) {
    if (handler) el.addEventListener(type, handler);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

const ICONS = {
  select: [
    "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
    "M10 10l6.5 2.6-2.8 1.1-1.1 2.8z",
  ],
  bubble: ["M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"],
  bubbleOff: ["M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M3 3l18 18"],
  chevron: ["M6 9l6 6 6-6"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  gear: [
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],
  camera: [
    "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z",
    "M15.5 13a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z",
  ],
  up: ["M12 19V5M6 11l6-6 6 6"],
  down: ["M12 5v14M6 13l6 6 6-6"],
  arrowRight: ["M5 12h14M13 6l6 6-6 6"],
  person: ["M15.5 9a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M5.5 19a6.5 6.5 0 0 1 13 0"],
  reopen: ["M4 12a8 8 0 1 0 2.3-5.7", "M4 4v5h5"],
} as const;

export type IconName = keyof typeof ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Stroke icons built as SVG nodes, so pages enforcing Trusted Types accept them. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** A spinning arc for "waiting" states. */
export function spinner(size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "spin");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "8");
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "#3F3F46");
  track.setAttribute("stroke-width", "2.5");
  const arc = document.createElementNS(SVG_NS, "path");
  arc.setAttribute("d", "M12 4a8 8 0 0 1 8 8");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "#FAFAFA");
  arc.setAttribute("stroke-width", "2.5");
  arc.setAttribute("stroke-linecap", "round");
  svg.append(track, arc);
  return svg;
}
