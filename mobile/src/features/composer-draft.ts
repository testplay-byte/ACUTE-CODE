/**
 * composer-draft.ts — the PER-SESSION composer drafts (R125-D): the owner's
 * v0.117.0 device verdict — "if I write a message and then switch to another
 * session, it should remember which message was typed there." The draft text
 * used to live ONLY in Composer's internal useState, so leaving the session
 * screen (or switching sessions) lost whatever was typed. This module
 * persists one draft per session id, mirroring outbox.ts's architecture
 * exactly: a pure state + honest parse/serialize, an INJECTED key-value
 * store seam (AsyncStorage in the app, fakes in tests), ONE owned storage
 * key, and an app singleton. NOTHING here touches React Native at import
 * time beyond the AsyncStorage import the singleton wires.
 *
 * The grammar:
 *   · saveComposerDraft(sessionId, text) — FIRE-AND-FORGET: never throws,
 *     never blocks the composer (the caller writes `void …`). The composer
 *     owns the ~400ms trailing DEBOUNCE (src/components/composer.tsx) — this
 *     module persists IMMEDIATELY and best-effort, so the debounce is a UI
 *     concern, not a storage one, and the module stays jest-testable without
 *     fake timers. A BLANK draft ("") is no draft: saving empty CLEARS the
 *     session's entry (the map never accumulates "" tombstones).
 *   · loadComposerDraft(sessionId) — the session's draft, "" when absent
 *     (the caller's `setDraft` only fires for non-empty text — an empty
 *     hydrate must not stomp a fresh keystroke).
 *   · clearComposerDraft(sessionId) — the send path: the message left the
 *     composer, the persisted copy dies with it.
 *   · CAP: 20,000 UTF-16 units per draft — a draft is not a document; the
 *     cap keeps one pathological paste from bloating the single JSON map
 *     every session share. (The cap slices code units, so a surrogate pair
 *     split exactly at the boundary reads as one replacement character —
 *     honest, acceptable for a draft.)
 *
 * Persisted shape (one JSON map under the ONE owned key): {"drafts":
 * {"<sessionId>": "<text>"}} — corrupt/unknown blobs read as EMPTY (an
 * unreadable store never blocks the composer; the worst case is a lost
 * draft, the pre-R125-D status quo).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

// ── the state (pure) ────────────────────────────────────────────────────────

/** The persisted map — one draft text per session id. */
export interface ComposerDraftsState {
  drafts: Record<string, string>;
}

export const EMPTY_DRAFTS: ComposerDraftsState = { drafts: {} };

/** The AsyncStorage key — the ONLY key this module owns. */
export const COMPOSER_DRAFTS_KEY = "acute.composer.drafts.v1";

/** A draft is not a document — the persisted text cap (UTF-16 units). */
export const COMPOSER_DRAFT_MAX_CHARS = 20_000;

// ── persistence (pure parse/serialize; the store is injected) ───────────────

export function serializeDrafts(state: ComposerDraftsState): string {
  return JSON.stringify(state);
}

/** Parse the persisted blob — corrupt/unknown shapes read as EMPTY (the
 * honest fallback: an unreadable store never blocks the composer). Only
 * STRING values under non-empty STRING keys survive. */
export function parseDrafts(raw: string | null): ComposerDraftsState {
  if (raw === null) return EMPTY_DRAFTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return EMPTY_DRAFTS;
    }
    const drafts = (parsed as Record<string, unknown>).drafts;
    if (typeof drafts !== "object" || drafts === null || Array.isArray(drafts)) {
      return EMPTY_DRAFTS;
    }
    const valid: Record<string, string> = {};
    for (const [sessionId, text] of Object.entries(drafts)) {
      if (sessionId !== "" && typeof text === "string") valid[sessionId] = text;
    }
    return { drafts: valid };
  } catch {
    return EMPTY_DRAFTS;
  }
}

// ── the controller (the app's singleton; the store is injected) ─────────────

/** The persistence seam — AsyncStorage satisfies it structurally. */
export interface ComposerDraftStore {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
}

export class ComposerDraftsController {
  private state: ComposerDraftsState = EMPTY_DRAFTS;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly store: ComposerDraftStore;

  constructor(store: ComposerDraftStore) {
    this.store = store;
  }

  /** Load once (idempotent); every public method awaits it. */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise === null) {
      this.loadPromise = this.store
        .load()
        .then((raw) => {
          this.state = parseDrafts(raw);
          this.loaded = true;
        })
        .catch(() => {
          this.state = EMPTY_DRAFTS;
          this.loaded = true;
        });
    }
    return this.loadPromise;
  }

  /** Persist the session's draft (blank CLEARS — a blank draft is no draft;
   * the cap applies on the way in). */
  async save(sessionId: string, text: string): Promise<void> {
    if (sessionId === "") return;
    await this.ensureLoaded();
    const drafts = { ...this.state.drafts };
    if (text === "") delete drafts[sessionId];
    else drafts[sessionId] = text.slice(0, COMPOSER_DRAFT_MAX_CHARS);
    this.state = { drafts };
    await this.persist();
  }

  /** The session's draft — "" when absent (never a throw). */
  async load(sessionId: string): Promise<string> {
    if (sessionId === "") return "";
    await this.ensureLoaded();
    return this.state.drafts[sessionId] ?? "";
  }

  /** Remove the session's draft (the send path). */
  async clear(sessionId: string): Promise<void> {
    await this.save(sessionId, "");
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(serializeDrafts(this.state));
    } catch {
      // Persistence failed — the in-memory map still works this session.
    }
  }
}

// ── the app's singleton (AsyncStorage-backed; tests build their own) ───────

let instance: ComposerDraftsController | null = null;

export function getComposerDrafts(): ComposerDraftsController {
  if (instance === null) {
    instance = new ComposerDraftsController({
      load: () => AsyncStorage.getItem(COMPOSER_DRAFTS_KEY),
      save: (serialized) => AsyncStorage.setItem(COMPOSER_DRAFTS_KEY, serialized),
    });
  }
  return instance;
}

// ── the composer's three verbs (fire-and-forget over the singleton) ────────

/**
 * Persist the session's draft — FIRE-AND-FORGET: never throws, best-effort,
 * immediate (the COMPOSER owns the ~400ms trailing debounce; see the module
 * header). Blank text clears the entry. The 20,000-unit cap applies inside.
 */
export async function saveComposerDraft(sessionId: string, text: string): Promise<void> {
  try {
    await getComposerDrafts().save(sessionId, text);
  } catch {
    // A refused store never blocks the composer — the in-session typing
    // still works; only the cross-session memory degrades.
  }
}

/** The session's draft — "" when absent (never a throw). */
export async function loadComposerDraft(sessionId: string): Promise<string> {
  try {
    return await getComposerDrafts().load(sessionId);
  } catch {
    return "";
  }
}

/** Remove the session's draft (the send path — never a throw). */
export async function clearComposerDraft(sessionId: string): Promise<void> {
  try {
    await getComposerDrafts().clear(sessionId);
  } catch {
    // Same law: the send must never fail over a draft that failed to die.
  }
}
