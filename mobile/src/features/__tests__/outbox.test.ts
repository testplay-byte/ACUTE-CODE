/**
 * outbox.test.ts — the offline queue: the pure reducer (enqueue/remove/
 * per-session view), the honest persistence parse (corrupt blobs read as
 * EMPTY), and the controller's flush ladder (in order, one at a time;
 * terminal frames and HTTP refusals remove; transport failures keep).
 * Fake stores + fake SSE senders — zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { SseSender } from "../api";
import type { SseStream } from "@/link/connection";
import type { SseError, SseEvent } from "@/types/acute-net";
import {
  EMPTY_OUTBOX,
  enqueueOutbox,
  OutboxController,
  outboxForSession,
  parseOutbox,
  removeOutboxEntry,
  serializeOutbox,
  type OutboxStore,
} from "../outbox";

// ── the fake stream: records the open + lets the test drive events ─────────

class FakeStream implements SseStream {
  readonly eventId: number;
  readonly openedWith: { url: string; method?: string; bodyText?: string };
  closed = false;
  private readonly dataListeners = new Set<(ev: SseEvent) => void>();
  private readonly errorListeners = new Set<(err: SseError) => void>();
  private readonly closeListeners = new Set<() => void>();
  private static nextId = 1;

  constructor(openedWith: { url: string; method?: string; bodyText?: string }) {
    this.openedWith = openedWith;
    this.eventId = FakeStream.nextId++;
  }

  addEventListener(type: "data", listener: (ev: SseEvent) => void): SseStream;
  addEventListener(type: "error", listener: (err: SseError) => void): SseStream;
  addEventListener(type: "close", listener: () => void): SseStream;
  addEventListener(type: string, listener: unknown): SseStream {
    if (type === "data") this.dataListeners.add(listener as (ev: SseEvent) => void);
    if (type === "error") this.errorListeners.add(listener as (err: SseError) => void);
    if (type === "close") this.closeListeners.add(listener as () => void);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  // Test-side drivers.
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener({ data });
  }
  emitError(err: SseError): void {
    for (const listener of this.errorListeners) listener(err);
  }
  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }
}

/** Build a sender whose opens resolve via the given script, deferred one
 * tick so the flush's listeners attach BEFORE the events fire (the real
 * native module can never emit before the caller subscribes). */
function makeSseSender(script: (open: FakeStream, index: number) => void) {
  const opens: FakeStream[] = [];
  const sender: SseSender = {
    sse(path, init = {}) {
      const stream = new FakeStream({ url: path, method: init.method, bodyText: init.bodyText });
      opens.push(stream);
      const index = opens.length - 1;
      setTimeout(() => script(stream, index), 0);
      return stream;
    },
  };
  return { sender, opens };
}

function memoryStore(): OutboxStore & { saved: string[] } {
  let blob: string | null = null;
  const saved: string[] = [];
  return {
    saved,
    async load() {
      return blob;
    },
    async save(serialized) {
      blob = serialized;
      saved.push(serialized);
    },
  };
}

// ── the reducer ─────────────────────────────────────────────────────────────

describe("outbox — the pure reducer", () => {
  it("enqueues trimmed messages with ids and timestamps", () => {
    const state = enqueueOutbox(EMPTY_OUTBOX, "sess_1", "  hello  ", 1000);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.content).toBe("hello");
    expect(state.entries[0]?.sessionId).toBe("sess_1");
    expect(state.entries[0]?.queuedAt).toBe(1000);
    expect(state.entries[0]?.id).toMatch(/^ob-\d+-\d+$/);
  });

  it("never enqueues an empty message", () => {
    expect(enqueueOutbox(EMPTY_OUTBOX, "sess_1", "   ", 1000)).toBe(EMPTY_OUTBOX);
  });

  it("removes entries by id and keeps the rest in order", () => {
    let state = enqueueOutbox(EMPTY_OUTBOX, "sess_1", "one", 1000);
    state = enqueueOutbox(state, "sess_1", "two", 2000);
    const removed = removeOutboxEntry(state, state.entries[0]!.id);
    expect(removed.entries.map((entry) => entry.content)).toEqual(["two"]);
    expect(removeOutboxEntry(state, "missing")).toStrictEqual(state);
  });

  it("filters the per-session view (the composer's chips)", () => {
    let state = enqueueOutbox(EMPTY_OUTBOX, "sess_1", "one", 1000);
    state = enqueueOutbox(state, "sess_2", "two", 2000);
    expect(outboxForSession(state, "sess_1").map((entry) => entry.content)).toEqual(["one"]);
    expect(outboxForSession(state, "sess_2")).toHaveLength(1);
    expect(outboxForSession(state, "sess_3")).toHaveLength(0);
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe("outbox — persistence", () => {
  it("round-trips serialize → parse", () => {
    const state = enqueueOutbox(EMPTY_OUTBOX, "sess_1", "hello", 1000);
    expect(parseOutbox(serializeOutbox(state))).toEqual(state);
  });

  it("reads corrupt blobs as EMPTY (the honest fallback)", () => {
    expect(parseOutbox(null)).toEqual(EMPTY_OUTBOX);
    expect(parseOutbox("not json")).toEqual(EMPTY_OUTBOX);
    expect(parseOutbox('{"entries": "nope"}')).toEqual(EMPTY_OUTBOX);
    expect(parseOutbox('[]')).toEqual(EMPTY_OUTBOX);
  });

  it("drops individually-invalid entries but keeps the valid ones", () => {
    const blob = JSON.stringify({
      entries: [
        { id: "a", sessionId: "sess_1", content: "ok", queuedAt: 1 },
        { id: 7, sessionId: "sess_1", content: "bad id", queuedAt: 2 },
        { id: "c", content: "missing session", queuedAt: 3 },
      ],
    });
    const state = parseOutbox(blob);
    expect(state.entries.map((entry) => entry.id)).toEqual(["a"]);
  });
});

// ── the controller + the flush ladder ───────────────────────────────────────

describe("outbox — the controller", () => {
  it("persists on enqueue and reloads on the next controller", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_1", "hello", 1000);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toBe(serializeOutbox({ entries: controller.getState().entries }));

    const second = new OutboxController(store);
    await second.enqueue("sess_2", "again", 2000); // forces the load
    expect(second.getState().entries.map((entry) => entry.content)).toEqual(["hello", "again"]);
  });

  it("notifies subscribers on every change (load included — an honest 0)", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    const events: number[] = [];
    const unsubscribe = controller.subscribe(() => events.push(controller.getState().entries.length));
    await controller.enqueue("sess_1", "one", 1000);
    await controller.enqueue("sess_1", "two", 2000);
    expect(events).toEqual([0, 1, 2]);
    unsubscribe();
    await controller.enqueue("sess_1", "three", 3000);
    expect(events).toEqual([0, 1, 2]);
  });

  it("flushes in order, one at a time, removing on terminal frames", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_1", "first", 1000);
    await controller.enqueue("sess_2", "second", 2000);
    const { sender, opens } = makeSseSender((stream, index) => {
      if (index === 0) {
        // first entry: the turn runs and completes
        stream.emitData('{"type":"text-delta","delta":"ok"}');
        stream.emitData('{"type":"done"}');
        stream.emitClose();
      } else {
        // second entry: stopped turn (the owner stopped it remotely)
        stream.emitData('{"type":"stopped"}');
        stream.emitClose();
      }
    });
    const result = await controller.flush(sender);
    expect(result.delivered).toBe(2);
    expect(result.blocked).toBe(false);
    expect(controller.getState().entries).toHaveLength(0);
    expect(opens.map((open) => open.openedWith.bodyText)).toEqual([
      '{"content":"first"}',
      '{"content":"second"}',
    ]);
    expect(opens.map((open) => open.openedWith.url)).toEqual([
      "/api/v1/sessions/sess_1/messages/stream",
      "/api/v1/sessions/sess_2/messages/stream",
    ]);
    // each completed stream was closed by the controller
    expect(opens.every((open) => open.closed)).toBe(true);
  });

  it("removes the entry on an HTTP refusal (the host's definitive no)", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_gone", "hello", 1000);
    const { sender } = makeSseSender((stream) => {
      stream.emitError({ kind: "http", message: "server answered HTTP 404", status: 404 });
      stream.emitClose();
    });
    const result = await controller.flush(sender);
    expect(result.delivered).toBe(1);
    expect(controller.getState().entries).toHaveLength(0);
  });

  it("KEEPS the entry and stops the flush on a transport failure", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_1", "first", 1000);
    await controller.enqueue("sess_1", "second", 2000);
    const { sender, opens } = makeSseSender((stream) => {
      stream.emitError({ kind: "network", message: "host unreachable" });
      stream.emitClose();
    });
    const result = await controller.flush(sender);
    expect(result.delivered).toBe(0);
    expect(result.blocked).toBe(true);
    expect(controller.getState().entries.map((entry) => entry.content)).toEqual(["first", "second"]);
    expect(opens).toHaveLength(1); // stopped at the first transport failure
  });

  it("removes on an ambiguous close-without-terminal (at-least-once, documented)", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_1", "hello", 1000);
    const { sender } = makeSseSender((stream) => {
      stream.emitData('{"type":"text-delta","delta":"partial"}');
      stream.emitClose(); // no terminal frame
    });
    const result = await controller.flush(sender);
    expect(result.delivered).toBe(1);
    expect(controller.getState().entries).toHaveLength(0);
  });

  it("guards concurrent flushes (the in-flight flag)", async () => {
    const store = memoryStore();
    const controller = new OutboxController(store);
    await controller.enqueue("sess_1", "hello", 1000);
    // The first flush holds on a stream that never emits (a turn still
    // running server-side) — it stays pending, exactly like real life.
    const holding = makeSseSender(() => {});
    void controller.flush(holding.sender);
    // The second flush, while the first is in flight, is an honest no-op.
    const second = await controller.flush(makeSseSender(() => {}).sender);
    expect(second).toEqual({ delivered: 0, blocked: false });
    expect(controller.getState().entries).toHaveLength(1);
  });
});
