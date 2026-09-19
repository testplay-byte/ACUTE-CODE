/**
 * ROUND-113 (R113-a) — the EVENTS BUS unit suite (lib/events-bus.ts): the
 * in-memory pub/sub foundation the whole backend event fan-out rides.
 *
 *   1. DELIVERY — every publish helper fans its frame out to every
 *      subscriber, with the exact wire shapes downstream agents
 *      (R113-b desktop / R113-e mobile) code against.
 *   2. UNSUBSCRIBE — the returned function removes exactly its subscriber.
 *   3. FAULT ISOLATION — a THROWING subscriber is logged + skipped: never
 *      does a publish propagate into the caller (a turn, a route, a
 *      storage helper must not fail because a watcher's socket died) —
 *      the notification-bus contract, verbatim.
 *   4. SINGLETON — getEventsBus() is one bus per process (the route, the
 *      storage hooks, and the tests all share the same instance).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventsBus, type EventsBusFrame } from "../src/lib/events-bus";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R113-a: the events bus", () => {
  it("delivers every publish helper's frame to every subscriber", () => {
    const bus = getEventsBus();
    const received: EventsBusFrame[] = [];
    const alsoReceived: EventsBusFrame[] = [];
    const unsubscribeA = bus.subscribe((frame) => received.push(frame));
    const unsubscribeB = bus.subscribe((frame) => alsoReceived.push(frame));
    try {
      bus.publishSessionFrame("sess_1", "proj-1", "event", { seq: 7, status: "running" });
      bus.publishSessionFrame("sess_1", "proj-1", "status", { status: "queued" });
      bus.publishSessionFrame("sess_2", null, "created", { status: "queued" });
      bus.publishTurnFrame("sess_1", { type: "text-delta", text: "hi" });
      bus.publishProjectFrame("proj-9", "created");
      bus.publishSettingsFrame("appearance", { themeId: "clay", mode: "dark" });

      expect(received).toEqual([
        { type: "session", sessionId: "sess_1", projectId: "proj-1", kind: "event", seq: 7, status: "running" },
        { type: "session", sessionId: "sess_1", projectId: "proj-1", kind: "status", status: "queued" },
        { type: "session", sessionId: "sess_2", projectId: null, kind: "created", status: "queued" },
        { type: "turn", sessionId: "sess_1", frame: { type: "text-delta", text: "hi" } },
        { type: "project", projectId: "proj-9", kind: "created" },
        { type: "settings", domain: "appearance", value: { themeId: "clay", mode: "dark" } },
      ]);
      expect(alsoReceived).toEqual(received);
    } finally {
      unsubscribeA();
      unsubscribeB();
    }
  });

  it("omits optional seq/status fields instead of writing undefined", () => {
    const bus = getEventsBus();
    const received: EventsBusFrame[] = [];
    const unsubscribe = bus.subscribe((frame) => received.push(frame));
    try {
      bus.publishSessionFrame("sess_1", null, "created");
      // JSON round-trip mirrors the SSE wire: absent keys stay absent (a
      // client reading `frame.seq === undefined` vs "seq" in frame must
      // see the same thing on the wire as in-process).
      expect(JSON.parse(JSON.stringify(received[0]))).toEqual({
        type: "session",
        sessionId: "sess_1",
        projectId: null,
        kind: "created",
      });
    } finally {
      unsubscribe();
    }
  });

  it("unsubscribe removes exactly its subscriber", () => {
    const bus = getEventsBus();
    const kept: EventsBusFrame[] = [];
    const dropped: EventsBusFrame[] = [];
    const keepUnsub = bus.subscribe((frame) => kept.push(frame));
    const dropUnsub = bus.subscribe((frame) => dropped.push(frame));
    dropUnsub();
    try {
      bus.publishSettingsFrame("memory", { enabled: false });
      expect(kept).toHaveLength(1);
      expect(dropped).toHaveLength(0);
      // A second unsubscribe call is a harmless no-op.
      dropUnsub();
      bus.publishSettingsFrame("memory", { enabled: true });
      expect(kept).toHaveLength(2);
      expect(dropped).toHaveLength(0);
    } finally {
      keepUnsub();
    }
  });

  it("a throwing subscriber never breaks the publisher or the other subscribers", () => {
    const bus = getEventsBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const survived: EventsBusFrame[] = [];
    const unsubscribeBad = bus.subscribe(() => {
      throw new Error("watcher socket died");
    });
    const unsubscribeGood = bus.subscribe((frame) => survived.push(frame));
    try {
      expect(() => bus.publishTurnFrame("sess_1", { type: "done" })).not.toThrow();
      expect(survived).toEqual([{ type: "turn", sessionId: "sess_1", frame: { type: "done" } }]);
      // The failure is LOGGED (the operator's console carries it), not swallowed silently.
      expect(errorSpy).toHaveBeenCalledWith("[events-bus] subscriber threw:", expect.any(Error));
    } finally {
      unsubscribeBad();
      unsubscribeGood();
    }
  });

  it("is one process-wide singleton", () => {
    expect(getEventsBus()).toBe(getEventsBus());
  });
});
