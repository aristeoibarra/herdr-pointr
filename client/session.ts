/**
 * Per-tab state that outlives a reload: sessionStorage, which a navigation
 * within the same origin keeps. A convenience only — every read and write is
 * allowed to fail (private windows, blocked storage).
 */

import { readAnchor, type Anchor } from "./api.ts";
import { pageKey } from "./navigation.ts";

const OPEN_KEY = "pointr-open";
const COMPOSE_KEY = "pointr-compose";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJSON(key: string, remove: boolean): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    if (remove) sessionStorage.removeItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not kept */
  }
}

/**
 * The thread open in this tab, and the page it belongs open on: a reload of
 * that page reopens it, and so does arriving there through Go to page. Any
 * other page leaves it closed — it must not follow you around.
 */
export function rememberOpenThread(id: string | null, page: string = pageKey()): void {
  writeJSON(OPEN_KEY, id === null ? null : { id, page });
}

export function takeOpenThread(): string | null {
  const mark = readJSON(OPEN_KEY, true);
  if (!isRecord(mark) || typeof mark["id"] !== "string" || mark["page"] !== pageKey()) return null;
  return mark["id"];
}

/** A new comment being written: its text and the elements it is about. */
export interface ComposeDraft {
  page: string;
  text: string;
  anchors: Anchor[];
}

export function saveComposeDraft(draft: ComposeDraft | null): void {
  writeJSON(COMPOSE_KEY, draft);
}

/** The draft for this page, if there is one. Taken: it is restored once. */
export function takeComposeDraft(): ComposeDraft | null {
  const draft = readJSON(COMPOSE_KEY, true);
  if (!isRecord(draft) || draft["page"] !== pageKey() || typeof draft["text"] !== "string") return null;
  const raw = draft["anchors"];
  const anchors = Array.isArray(raw) ? raw.map(readAnchor).filter((a): a is Anchor => a !== null) : [];
  return anchors.length > 0 ? { page: pageKey(), text: draft["text"], anchors } : null;
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
