import type { domToPng } from "modern-screenshot";

type DomToPng = typeof domToPng;

declare global {
  interface Window {
    /** Set by the screenshot bundle (client/screenshot.ts) once it has run. */
    __pointrDomToPng?: DomToPng;
  }
}

let pending: Promise<DomToPng> | null = null;

/**
 * The rasterizer, fetched from the bridge on first use. It is roughly half the
 * widget's weight and most sends never take a screenshot, so it stays out of
 * the bundle every localhost tab loads.
 *
 * A failed load clears the memo, so the next attempt fetches again instead of
 * replaying the same rejection for the life of the page.
 */
export function loadDomToPng(bridgeOrigin: string): Promise<DomToPng> {
  const ready = window.__pointrDomToPng;
  if (ready !== undefined) return Promise.resolve(ready);
  if (pending !== null) return pending;

  pending = new Promise<DomToPng>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${bridgeOrigin}/screenshot.js`;
    script.async = true;
    script.onload = () => {
      const loaded = window.__pointrDomToPng;
      if (loaded === undefined) reject(new Error("screenshot bundle did not register"));
      else resolve(loaded);
    };
    script.onerror = () => reject(new Error("screenshot bundle failed to load"));
    (document.head ?? document.documentElement).appendChild(script);
  });
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
