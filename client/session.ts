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
