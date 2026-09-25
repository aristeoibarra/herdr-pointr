/**
 * Keeps the store current without holding a connection open.
 *
 * The widget is injected into every localhost tab, and a browser allows only
 * a handful of HTTP/1.1 connections per host across all of them — a stream
 * per tab would starve the bridge. So it asks once on load, then only while
 * a thread is waiting for a reply and the tab is visible, and more slowly the
 * longer the wait. A reply to a comment is not a chat message: a few seconds
 * late is fine.
 */

import type { Api, Thread } from "./api.ts";
import type { WidgetContext } from "./context.ts";
import type { Store } from "./store.ts";

export interface Poller {
  /** Asks now, or right after the request in flight. */
  kick(): void;
}

function ageDelay(since: number): number {
  const age = Date.now() - since;
  if (age < 2 * 60_000) return 3_000;
  if (age < 10 * 60_000) return 10_000;
  return 30_000;
}

export function createPoller(
  ctx: WidgetContext,
  api: Api,
  store: Store,
  onUpdate: (replied: Thread[]) => void,
): Poller {
  let timer = 0;
  let inflight = false;
  let again = false;
  let failures = 0;

  function schedule(): void {
    window.clearTimeout(timer);
    if (ctx.signal.aborted || document.hidden || !store.hasWaiting()) return;
    const backoff = Math.min(30_000, 3_000 * 2 ** failures);
    timer = window.setTimeout(kick, Math.max(ageDelay(store.oldestWaitingAt()), backoff));
  }

  async function fetchNow(): Promise<void> {
    inflight = true;
    try {
      const res = await api.threads(location.href, store.rev);
      failures = 0;
      onUpdate(store.apply(res));
    } catch {
      failures += 1;
    } finally {
      inflight = false;
      if (again) {
        again = false;
        void fetchNow();
      } else {
        schedule();
      }
    }
  }

  function kick(): void {
    if (ctx.signal.aborted) return;
    if (inflight) {
      again = true;
      return;
    }
    void fetchNow();
  }

  document.addEventListener(
    "visibilitychange",
    () => (document.hidden ? window.clearTimeout(timer) : kick()),
    { signal: ctx.signal },
  );
  ctx.signal.addEventListener("abort", () => window.clearTimeout(timer));

  return { kick };
}
