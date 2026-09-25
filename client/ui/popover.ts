const MARGIN = 12;
/** Room kept free above the dock in the bottom-right corner. */
const DOCK_SPACE = 72;

/**
 * Places a fixed popover next to an anchor rect: below it, else above it,
 * else beside it, always inside the viewport. With no anchor it sits in the
 * dock's corner — where a thread from another page opens.
 */
export function place(pop: HTMLElement, anchor: DOMRect | null): void {
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (!anchor) {
    left = vw - width - 16;
    top = vh - DOCK_SPACE - height;
  } else {
    left = Math.min(Math.max(anchor.left, MARGIN), vw - width - MARGIN);
    const below = anchor.bottom + 10;
    const above = anchor.top - height - 10;
    if (below + height <= vh - DOCK_SPACE) {
      top = below;
    } else if (above >= MARGIN) {
      top = above;
    } else {
      top = Math.min(Math.max(anchor.top, MARGIN), vh - height - MARGIN);
      left = anchor.right + 10 + width <= vw - MARGIN ? anchor.right + 10 : Math.max(MARGIN, anchor.left - width - 10);
    }
  }
  pop.style.left = `${Math.max(MARGIN, left)}px`;
  pop.style.top = `${Math.max(MARGIN, top)}px`;
}

/** Positions a fixed outline over an element's box. */
export function outline(el: HTMLElement, rect: DOMRect, pad = 0): void {
  el.style.left = `${rect.left - pad}px`;
  el.style.top = `${rect.top - pad}px`;
  el.style.width = `${rect.width + pad * 2}px`;
  el.style.height = `${rect.height + pad * 2}px`;
}
