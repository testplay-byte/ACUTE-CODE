/**
 * draft-store.ts — ROUND-125 (R125-3): the PER-SESSION composer drafts.
 *
 * The owner's ask (verbatim): "the message should be remembered for each one
 * of the sessions separately, like if I write a message and then switch to
 * another section, then it should remember which message was typed there."
 *
 * Before this module the chat panel held ONE `input` string for every
 * session: switching sessions kept the same draft in the composer (or, on
 * remount, lost it entirely) — the typed message followed the USER instead
 * of staying with the CONVERSATION it was written for.
 *
 * DESIGN (the stream-store's localStorage neighbors are the precedent —
 * small, synchronous, defensive):
 *   · ONE localStorage key holds a JSON map { sessionId → draft }.
 *   · The chat panel flushes the outgoing session's draft and loads the
 *     incoming one on session switch; a debounced writer persists edits
 *     while typing; the send path CLEARS the entry (a sent message is not a
 *     draft).
 *   · Bounded: at most MAX_SESSION_DRAFTS entries (recency-evicted — the
 *     map is rewritten in last-touched order) and MAX_DRAFT_CHARS per draft
 *     (a draft is a message, not a document; over-long input is stored
 *     truncated, never throws).
 *   · Never throws: localStorage can be unavailable (private mode, quota,
 *     SSR) — every operation degrades to a no-op and loadSessionDraft
 *     answers "" (the pre-R125 behavior).
 *
 * Pure + dependency-free (localStorage reached through a module-level seam
 * so the tests can inject a fake — the repo's injected-store pattern).
 */

/** The single owned key (namespaced + versioned like the store's other keys). */
const DRAFTS_KEY = "acute.session-drafts.v1";

/** A draft is a message, not a document — the stored-text cap. */
export const MAX_DRAFT_CHARS = 20_000;

/** The map's eviction bound (most-recently-touched wins; the rest go). */
export const MAX_SESSION_DRAFTS = 50;

/** The localStorage seam (tests inject a fake; production reads the global). */
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): DraftStorage | null {
  try {
    // The classic guard: localStorage itself can throw on ACCESS in locked
    // down environments — reach it once, inside the try.
    const ls = globalThis.localStorage;
    return ls === null || ls === undefined ? null : (ls as DraftStorage);
  } catch {
    return null;
  }
}

/** The injectable seam (module-level; reset between tests). */
let storage: DraftStorage | null = browserStorage();

/** Test seam: swap the backing store (null = the unavailable-storage leg). */
export function setDraftStorageForTest(next: DraftStorage | null): void {
  storage = next;
}

/** The parsed map — {} on a missing/corrupt/oversized blob (never throws). */
function readMap(): Record<string, string> {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(DRAFTS_KEY);
    if (raw === null || raw === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") out[key] = value;
    }
    return out;
  } catch {
    // Corrupt JSON (a partial write, a hand-edited blob) — start over rather
    // than crash; the next save rewrites the file clean.
    return {};
  }
}

/** The serialized write (the cap + the eviction ride here). */
function writeMap(map: Record<string, string>): void {
  if (storage === null) return;
  try {
    // Eviction: keep the newest MAX_SESSION_DRAFTS entries. JS object keys
    // preserve INSERTION order and the load/save cycle below re-inserts the
    // touched session LAST — so slicing from the END keeps the freshest.
    const keys = Object.keys(map);
    if (keys.length > MAX_SESSION_DRAFTS) {
      const keep = new Set(keys.slice(keys.length - MAX_SESSION_DRAFTS));
      for (const key of keys) {
        if (!keep.has(key)) delete map[key];
      }
    }
    storage.setItem(DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded / storage disabled — the draft just doesn't persist
    // (the in-memory composer text is unaffected; the user loses nothing
    // they can see).
  }
}

/**
 * Persist a session's draft. A blank/whitespace-only draft DELETES the
 * entry (an emptied composer is not a draft to restore). Over-long text is
 * capped at MAX_DRAFT_CHARS.
 */
export function saveSessionDraft(sessionId: string, text: string): void {
  if (sessionId === "") return;
  const trimmed = text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text;
  const map = readMap();
  if (trimmed.trim() === "") {
    if (sessionId in map) {
      delete map[sessionId];
      writeMap(map);
    }
    return;
  }
  if (map[sessionId] === trimmed) return; // no-op write (the debounce's tail)
  // Re-insert so the touched session is LAST (the eviction's recency order).
  delete map[sessionId];
  map[sessionId] = trimmed;
  writeMap(map);
}

/** The session's stored draft ("" when absent — never null, never throws). */
export function loadSessionDraft(sessionId: string): string {
  if (sessionId === "") return "";
  const map = readMap();
  const value = map[sessionId];
  return typeof value === "string" ? value : "";
}

/** Remove a session's draft (the send path — a sent message is not a draft). */
export function clearSessionDraft(sessionId: string): void {
  if (sessionId === "") return;
  const map = readMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeMap(map);
}
