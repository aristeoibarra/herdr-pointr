/**
 * Per-tab state that outlives a reload: sessionStorage, which a navigation
 * within the same origin keeps. A convenience only — every read and write is
 * allowed to fail (private windows, blocked storage).
 */

const OPEN_KEY = "pointr-open";

export function rememberOpenThread(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(OPEN_KEY, id);
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* not kept */
  }
}

export function takeOpenThread(): string | null {
  try {
    const id = sessionStorage.getItem(OPEN_KEY);
    sessionStorage.removeItem(OPEN_KEY);
    return id;
  } catch {
    return null;
  }
}

const draftKey = (id: string): string => `pointr-draft:${id}`;

/** A reply being written, kept across the reload an agent's edit can trigger. */
export function saveDraft(id: string, text: string): void {
  try {
    if (text.trim()) sessionStorage.setItem(draftKey(id), text);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    /* not kept */
  }
}

export function readDraft(id: string): string {
  try {
    return sessionStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}
