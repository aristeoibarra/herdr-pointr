import type { Thread } from "./api.ts";
import type { Store } from "./store.ts";

const NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
  cursor: "Cursor",
  copilot: "Copilot",
};

/** How an agent kind reads in the UI. */
export function agentName(kind: string): string {
  if (!kind) return "the agent";
  return NAMES[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

export interface WaitingText {
  title: string;
  sub: string;
  warn: boolean;
}

/**
 * What a waiting thread says, from the live state of its agent. herdr does
 * not track turns, so "finished without replying" cannot be told apart from
 * "not there yet" — the thread just waits, and says what the agent is doing.
 */
export function waitingText(t: Thread, store: Store): WaitingText {
  const name = agentName(t.agentKind);
  if (!store.herdr) return { title: "herdr isn't answering", sub: "The reply shows up here once it is back.", warn: true };
  const live = store.agents[t.pane];
  if (!live) return { title: `${name}'s terminal was closed`, sub: "Reply to send it to another agent.", warn: true };
  if (live.status === "blocked") {
    return { title: `${name} needs an approval in its terminal`, sub: "Answer it there; the comment is waiting.", warn: true };
  }
  const last = t.messages[t.messages.length - 1];
  if (live.status === "working") {
    if (last?.busyAtSend) return { title: `Sent while ${name} was busy — queued`, sub: "The reply shows up here.", warn: false };
    return { title: `${name} is working…`, sub: live.title || "The reply shows up here.", warn: false };
  }
  return { title: `Waiting for ${name}'s reply`, sub: "The reply shows up here.", warn: false };
}

/** "just now", "3 min", "2 h", then a date. */
export function ago(at: number): string {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return new Date(at).toLocaleDateString();
}

/** A one-line name for what a thread is about. */
export function threadLabel(t: Thread): string {
  const a = t.anchors[0];
  if (!a) return "comment";
  if (a.component) return a.component;
  return a.id ? `${a.tag}#${a.id}` : a.tag || "element";
}
