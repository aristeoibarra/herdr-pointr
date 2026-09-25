/**
 * The widget's copy of the project's threads, fed by polling and by the
 * answers to its own requests. Every other part reads from here.
 */

import type { LiveAgent, Thread, ThreadsResponse } from "./api.ts";
import { pageKey } from "./navigation.ts";

export interface Store {
  readonly threads: readonly Thread[];
  /** null until the first answer: nothing has been compared yet. */
  readonly rev: number | null;
  /** The page's upstream port, as the bridge reads it. */
  readonly port: string;
  readonly herdr: boolean;
  readonly agents: Readonly<Record<string, LiveAgent>>;
  readonly resolvedCount: number;
  /**
   * Takes a poll answer. Returns the threads that gained a reply since the
   * last one — never on the first load, which only shows what is there.
   */
  apply(res: ThreadsResponse): Thread[];
  /** Merges a thread returned by one of the widget's own requests. */
  upsert(thread: Thread): void;
  /** Drops a thread the bridge no longer has — one cancelled before its agent saw it. */
  remove(id: string): void;
  get(id: string): Thread | undefined;
  onPage(): Thread[];
  otherPageUnread(): Thread[];
  anyUnread(): boolean;
  hasWaiting(): boolean;
  /** When the longest-waiting thread was last written to, for poll pacing. */
  oldestWaitingAt(): number;
  subscribe(listener: () => void): void;
}

const agentMessages = (t: Thread): number => t.messages.filter((m) => m.from === "agent").length;

export function createStore(): Store {
  let threads: Thread[] = [];
  let rev: number | null = null;
  let port = "";
  let herdr = true;
  let agents: Record<string, LiveAgent> = {};
  let resolvedCount = 0;
  const listeners: Array<() => void> = [];
  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const onPage = (): Thread[] => {
    const page = pageKey();
    return threads.filter((t) => t.port === port && t.path === page);
  };

  return {
    get threads() {
      return threads;
    },
    get rev() {
      return rev;
    },
    get port() {
      return port;
    },
    get herdr() {
      return herdr;
    },
    get agents() {
      return agents;
    },
    get resolvedCount() {
      return resolvedCount;
    },

    apply(res) {
      const first = rev === null;
      port = res.port;
      herdr = res.herdr;
      agents = res.agents;
      rev = res.rev;
      const replied: Thread[] = [];
      if (res.threads) {
        const before = new Map(threads.map((t) => [t.id, t]));
        for (const next of res.threads) {
          const prev = before.get(next.id);
          if (!first && next.unread && (!prev || agentMessages(next) > agentMessages(prev))) replied.push(next);
        }
        threads = res.threads;
        resolvedCount = res.resolvedCount;
      }
      emit();
      return replied;
    },

    upsert(thread) {
      const known = threads.some((t) => t.id === thread.id);
      if (thread.resolved) {
        if (known) resolvedCount += 1;
        threads = threads.filter((t) => t.id !== thread.id);
      } else if (known) {
        threads = threads.map((t) => (t.id === thread.id ? thread : t));
      } else {
        threads = [...threads, thread];
      }
      emit();
    },

    remove(id) {
      threads = threads.filter((t) => t.id !== id);
      emit();
    },

    get: (id) => threads.find((t) => t.id === id),
    onPage,
    otherPageUnread() {
      const page = pageKey();
      return threads.filter((t) => t.unread && (t.port !== port || t.path !== page));
    },
    anyUnread: () => threads.some((t) => t.unread),
    hasWaiting: () => threads.some((t) => t.waiting),
    oldestWaitingAt() {
      const waiting = threads.filter((t) => t.waiting).map((t) => t.updatedAt);
      return waiting.length > 0 ? Math.min(...waiting) : Date.now();
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
