/**
 * outbox.ts — the offline message queue (LINKING-PROTOCOL §3: "messages
 * composed offline sit in the phone's outbox and post on reconnect").
 *
 * Design: a PURE reducer over OutboxState + a thin controller that persists
 * through an injected key-value store (AsyncStorage in the app, a fake in
 * tests). NOTHING here touches React Native at import time.
 *
 * Flush semantics (the honest ladder):
 *   · entries flush IN ORDER, one at a time, only while the link is
 *     connected and the app is foregrounded (the screens call flush());
 *   · a send is delivered by the SAME stream route the composer uses
 *     (POST /sessions/:id/messages/stream — the turn streams and the entry
 *     resolves on the terminal frame: done/stopped/error);
 *   · on terminal OR an HTTP-level refusal (4xx/5xx before the stream
 *     opened — validation, unknown session) the entry is REMOVED (the
 *     outcome is known; the transcript refetch shows the truth);
 *   · on a transport failure the flush STOPS with the entry kept — the
 *     next connected wake retries from the top (at-least-once delivery,
 *     documented: a turn whose terminal frame never reached the phone may
 *     be re-sent. The transcript is the truth; the rehydrate shows what
 *     actually landed, and the duplicate is visible and honest).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseStreamFrame } from "./sessions";
import type { SseSender } from "./api";
import type { SseStream } from "@/link/connection";

// ── the state (pure) ────────────────────────────────────────────────────────

export interface OutboxEntry {
  id: string;
  sessionId: string;
  content: string;
  /** Epoch ms of when the message was composed. */
  queuedAt: number;
}

export interface OutboxState {
  entries: OutboxEntry[];
}

export const EMPTY_OUTBOX: OutboxState = { entries: [] };

/** The AsyncStorage key — the ONLY key this module owns. */
export const OUTBOX_KEY = "acute.outbox.v1";

// ── the reducer (pure) ──────────────────────────────────────────────────────

function newEntryId(now: number, seq: number): string {
  return `ob-${now}-${seq}`;
}

/** Enqueue a composed-offline message (pure). */
export function enqueueOutbox(
  state: OutboxState,
  sessionId: string,
  content: string,
  now: number,
): OutboxState {
  const trimmed = content.trim();
  if (trimmed === "") return state;
  const entry: OutboxEntry = {
    id: newEntryId(now, state.entries.length),
    sessionId,
    content: trimmed,
    queuedAt: now,
  };
  return { entries: [...state.entries, entry] };
}

/** Remove one entry (delivered / refused / dismissed). */
export function removeOutboxEntry(state: OutboxState, id: string): OutboxState {
  return { entries: state.entries.filter((entry) => entry.id !== id) };
}

/** The entries for ONE session (the composer's dim chips render these). */
export function outboxForSession(state: OutboxState, sessionId: string): OutboxEntry[] {
  return state.entries.filter((entry) => entry.sessionId === sessionId);
}

// ── persistence (pure parse/serialize; the store is injected) ───────────────

export function serializeOutbox(state: OutboxState): string {
  return JSON.stringify(state);
}

/** Parse the persisted blob — corrupt/unknown shapes read as EMPTY (the
 * honest fallback: an unreadable queue never blocks the composer). */
export function parseOutbox(raw: string | null): OutboxState {
  if (raw === null) return EMPTY_OUTBOX;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return EMPTY_OUTBOX;
    }
    const entries = (parsed as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return EMPTY_OUTBOX;
    const valid: OutboxEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, sessionId, content, queuedAt } = entry as Record<string, unknown>;
      if (
        typeof id === "string" &&
        typeof sessionId === "string" &&
        typeof content === "string" &&
        typeof queuedAt === "number"
      ) {
        valid.push({ id, sessionId, content, queuedAt });
      }
    }
    return { entries: valid };
  } catch {
    return EMPTY_OUTBOX;
  }
}

// ── the controller (the app's singleton; the store is injected) ─────────────

/** The persistence seam — AsyncStorage satisfies it structurally. */
export interface OutboxStore {
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
}

export interface OutboxListener {
  (): void;
}

export interface FlushResult {
  /** Entries delivered (terminal frame or honest refusal) this run. */
  delivered: number;
  /** True when a transport failure stopped the flush early (entries kept). */
  blocked: boolean;
}

export class OutboxController {
  private state: OutboxState = EMPTY_OUTBOX;
  private readonly listeners = new Set<OutboxListener>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private flushing = false;
  private readonly store: OutboxStore;

  constructor(store: OutboxStore) {
    this.store = store;
  }

  /** Load once (idempotent); every public method awaits it. */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise === null) {
      this.loadPromise = this.store
        .load()
        .then((raw) => {
          this.state = parseOutbox(raw);
          this.loaded = true;
          this.notify();
        })
        .catch(() => {
          this.state = EMPTY_OUTBOX;
          this.loaded = true;
        });
    }
    return this.loadPromise;
  }

  /** Subscribe to state changes (the composer's chips). */
  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): OutboxState {
    return this.state;
  }

  /** Compose offline: the message lands in the queue. */
  async enqueue(sessionId: string, content: string, now = Date.now()): Promise<void> {
    await this.ensureLoaded();
    this.state = enqueueOutbox(this.state, sessionId, content, now);
    await this.persist();
  }

  /** Dismiss one pending entry (the chip's remove affordance). */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.state = removeOutboxEntry(this.state, id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(serializeOutbox(this.state));
    } catch {
      // Persistence failed — the in-memory queue still works this session.
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Flush in order while connected. One entry at a time, via the SAME
   * stream route the composer uses — the terminal frame (done/stopped/
   * error) or an HTTP-level refusal removes the entry; a transport failure
   * stops the whole flush (entries kept for the next wake).
   */
  async flush(sender: SseSender): Promise<FlushResult> {
    await this.ensureLoaded();
    if (this.flushing) return { delivered: 0, blocked: false };
    this.flushing = true;
    let delivered = 0;
    let blocked = false;
    try {
      while (true) {
        await this.ensureLoaded();
        const entry = this.state.entries[0];
        if (entry === undefined) break;
        const outcome = await sendOnce(sender, entry);
        if (outcome === "delivered" || outcome === "refused") {
          this.state = removeOutboxEntry(this.state, entry.id);
          await this.persist();
          delivered += 1;
          continue;
        }
        // "blocked" — transport failure; the entry stays, the next wake
        // retries (the manager has already flipped offline).
        blocked = true;
        break;
      }
    } finally {
      this.flushing = false;
    }
    return { delivered, blocked };
  }
}

/** Send ONE entry through the stream route; resolve on the first terminal
 * truth (frame, HTTP refusal, or transport failure). */
function sendOnce(
  sender: SseSender,
  entry: OutboxEntry,
): Promise<"delivered" | "refused" | "blocked"> {
  return new Promise((resolve) => {
    let settled = false;
    let stream: SseStream | null = null;
    const finish = (result: "delivered" | "refused" | "blocked"): void => {
      if (settled) return;
      settled = true;
      stream?.close();
      resolve(result);
    };
    try {
      stream = sender.sse(
        `/api/v1/sessions/${encodeURIComponent(entry.sessionId)}/messages/stream`,
        { method: "POST", bodyText: JSON.stringify({ content: entry.content }) },
      );
    } catch {
      finish("blocked");
      return;
    }
    stream.addEventListener("data", (ev) => {
      const frame = parseStreamFrame(ev.data);
      if (frame === null) return;
      const type = frame.type;
      if (type === "done" || type === "stopped") finish("delivered");
      else if (type === "error") finish("delivered"); // the turn errored — the outcome is KNOWN
    });
    stream.addEventListener("error", (err) => {
      // kind "http" = the host refused before streaming (validation/404/409)
      // — a definitive answer; anything else is transport (retry later).
      finish(err.kind === "http" ? "refused" : "blocked");
    });
    stream.addEventListener("close", () => {
      // The stream ended without a terminal frame — ambiguous. The turn
      // survives server-side (R42); the entry is REMOVED and the transcript
      // refetch owns the truth (at-least-once, documented in the header).
      finish("delivered");
    });
  });
}

// ── the app's singleton (AsyncStorage-backed; tests build their own) ───────

let instance: OutboxController | null = null;

export function getOutbox(): OutboxController {
  if (instance === null) {
    instance = new OutboxController({
      load: () => AsyncStorage.getItem(OUTBOX_KEY),
      save: (serialized) => AsyncStorage.setItem(OUTBOX_KEY, serialized),
    });
  }
  return instance;
}
