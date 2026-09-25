/** Screenshot capture: a tight crop of an element, or the viewport with the selection outlined. */

import { loadDomToPng } from "./shot-loader.ts";

/**
 * Rasterizing waits on every image and font the element pulls in, and a picked
 * container can be the whole page — `domToPng` has no timeout of its own, so
 * without these the composer sits on "Sending…" forever with no way back.
 */
export const SHOT_TIMEOUT_MS = 15_000;
export const SEND_TIMEOUT_MS = 20_000;
/** Base64 chars, kept under the bridge's 5 MB body cap with room for the prompt. */
export const MAX_SHOT_CHARS = 4_000_000;

export class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

/**
 * The underlying work keeps running (neither domToPng nor a stalled decode can
 * be cancelled) — this only stops the UI from waiting on it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new TimeoutError()), ms);
    const done = (): void => window.clearTimeout(timer);
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const area = (el: Element): number => {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
};

/** PNG of the largest selected element — a tight crop, no surroundings. */
export async function captureElement(bridge: string, targets: Element[]): Promise<string | null> {
  const target = targets.reduce<Element | null>(
    (best, el) => (best && area(best) >= area(el) ? best : el),
    null,
  );
  if (!target) return null;
  const domToPng = await loadDomToPng(bridge);
  return domToPng(target, { scale: 1, backgroundColor: "#ffffff" });
}

/** The whole visible viewport with every selected element outlined — context, not a crop. */
export async function captureViewport(bridge: string, targets: Element[], rootId: string): Promise<string | null> {
  const boxes = targets.map((el) => el.getBoundingClientRect());
  const domToPng = await loadDomToPng(bridge);
  const png = await domToPng(document.body, {
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#ffffff",
    filter: (node) => !(node instanceof Element && node.id === rootId),
    style: {
      transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
      transformOrigin: "top left",
    },
  });
  return drawHighlights(png, boxes);
}

function drawHighlights(dataUrl: string, boxes: DOMRect[]): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0);
      const scale = img.width / window.innerWidth;
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = Math.max(2, 3 * scale);
      for (const r of boxes) {
        ctx.strokeRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
      }
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
