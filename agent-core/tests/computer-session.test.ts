/**
 * ROUND-61 (R61): the ControlSession tests — snapshot store semantics
 * (consume-on-write, keep-8, TTL), frame registry (freshness, image→global),
 * the kill switch, held-button ownership, the monitor ring, and stats.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FRAME_AGE_MS, resetComputerSessionForTests, getComputerSession } from "../src/computer/session";

afterEach(() => {
  resetComputerSessionForTests();
});

function makeElements(count: number): { index: number; kind: "button"; name: string; flags: ["pressable"] }[] {
  return Array.from({ length: count }, (_, i) => ({ index: i, kind: "button" as const, name: `btn-${i}`, flags: ["pressable" as const] }));
}

describe("ROUND-61 (R61): ComputerSession — lifecycle", () => {
  it("ensureStarted opens once; state() reports active with stats reset", () => {
    const s = resetComputerSessionForTests();
    expect(s.active()).toBe(false);
    s.ensureStarted("linux");
    expect(s.active()).toBe(true);
    expect(s.state().backendKind).toBe("linux");
    expect(s.state().stats.actionsSent).toBe(0);
    // A second ensure does not reset or duplicate the session_start event.
    s.record("action", "did");
    s.ensureStarted("linux");
    const starts = s.state().events.filter((e) => e.kind === "session_start");
    expect(starts).toHaveLength(1);
  });

  it("the kill switch stops everything and is ENFORCED (not advisory)", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const { releasedHeld } = s.stop("task complete");
    expect(releasedHeld).toBeNull();
    expect(s.isKillSwitchActive()).toBe(true);
    expect(s.active()).toBe(false);
    expect(s.stopReasonOrNull()).toBe("task complete");
  });

  it("stop releases the held button (the sanctioned auto-release point)", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    s.holdButton({ pid: 42, windowId: 7 }, { x: 100, y: 200 });
    const { releasedHeld } = s.stop("cleanup");
    expect(releasedHeld).toEqual({ point: { x: 100, y: 200 } });
    expect(s.hasHeld()).toBe(false);
  });
});

describe("ROUND-61 (R61): ComputerSession — snapshot store (doc 03 §1)", () => {
  it("registerSnapshot stamps monotonic ids and createdAt", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const a = s.registerSnapshot({
      app: { pid: 1, title: "A" },
      window: { title: "A", windowId: 1, bounds: [0, 0, 10, 10] },
      surface: { kind: "window", actualWindowId: 1, lifecycle: "stable" },
      elements: makeElements(3),
    });
    const b = s.registerSnapshot({
      app: { pid: 1, title: "A" },
      window: { title: "A", windowId: 1, bounds: [0, 0, 10, 10] },
      surface: { kind: "window", actualWindowId: 1, lifecycle: "stable" },
      elements: makeElements(3),
    });
    expect(a.stateId).toBe("s-1");
    expect(b.stateId).toBe("s-2");
    expect(b.createdAt).toBeGreaterThanOrEqual(a.createdAt);
    expect(s.getSnapshot("s-1")?.snapshot.elements).toHaveLength(3);
  });

  it("markConsumed implements supersession: any element WRITE kills the token", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const snap = s.registerSnapshot({
      app: { pid: 1, title: "A" },
      window: { title: "A", windowId: 1, bounds: [0, 0, 10, 10] },
      surface: { kind: "window", actualWindowId: 1, lifecycle: "stable" },
      elements: makeElements(3),
    });
    expect(s.getSnapshot(snap.stateId)?.consumed).toBe(false);
    s.markConsumed(snap.stateId);
    expect(s.getSnapshot(snap.stateId)?.consumed).toBe(true);
  });

  it("keep-last-8: the oldest non-consumed snapshot is evicted (consumed tokens stay refusable)", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const snap = s.registerSnapshot({
        app: { pid: i, title: `A${i}` },
        window: { title: `A${i}`, windowId: i, bounds: [0, 0, 10, 10] },
        surface: { kind: "window", actualWindowId: i, lifecycle: "stable" },
        elements: makeElements(1),
      });
      ids.push(snap.stateId);
      if (i === 2) s.markConsumed(snap.stateId); // one consumed in the middle
    }
    // Eviction keeps 8 + the consumed one stays until TTL (honest refusals).
    expect(s.getSnapshot("s-1")).toBeUndefined();
    expect(s.getSnapshot("s-2")).toBeUndefined();
    expect(s.getSnapshot("s-3")?.consumed).toBe(true); // the consumed survivor
    expect(s.getSnapshot("s-10")).toBeDefined();
  });

  it("observations are counted for the monitor stats", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    s.registerSnapshot({ app: { pid: 1, title: "A" }, window: { title: "A", windowId: 1, bounds: [0, 0, 10, 10] }, surface: { kind: "window", actualWindowId: 1, lifecycle: "stable" }, elements: makeElements(1) });
    expect(s.state().stats.observations).toBe(1);
  });
});

describe("ROUND-61 (R61): ComputerSession — frame registry (doc 03 §4)", () => {
  it("registerFrame stamps frameId; latestFrame() is the newest; imageToGlobal applies scale + origin", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const { frameId } = s.registerFrame(
      { width: 3840, height: 2160, scale: 2.0, origin: { x: 100, y: 50 } },
      { kind: "display" },
      { pid: 9, windowId: 0 },
      1,
    );
    expect(frameId).toBe("f-1");
    const frame = s.getFrame("f-1");
    expect(frame?.origin).toEqual({ x: 100, y: 50 });
    // Retina: 3840 image px over 2.0 scale = 1920 pt wide.
    expect(s.imageToGlobal(frame!, 3840, 2160)).toEqual({ x: 100 + 1920, y: 50 + 1080 });
    expect(s.latestFrame()?.frameId).toBe("f-1");
  });

  it("frameIsFresh honors MAX_FRAME_AGE_MS (10s) and age kills it", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    const { frameId } = s.registerFrame({ width: 10, height: 10, scale: 1, origin: { x: 0, y: 0 } }, { kind: "display" }, { pid: 1, windowId: 0 }, 1);
    const frame = s.getFrame(frameId)!;
    expect(s.frameIsFresh(frame, frame.capturedAt)).toBe(true);
    expect(s.frameIsFresh(frame, frame.capturedAt + MAX_FRAME_AGE_MS)).toBe(true);
    expect(s.frameIsFresh(frame, frame.capturedAt + MAX_FRAME_AGE_MS + 1)).toBe(false);
  });

  it("keep-last-8 frames with oldest-first eviction", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    for (let i = 0; i < 10; i++) {
      s.registerFrame({ width: i + 1, height: 1, scale: 1, origin: { x: i, y: 0 } }, { kind: "display" }, { pid: 1, windowId: 0 }, 1);
    }
    expect(s.getFrame("f-1")).toBeUndefined();
    expect(s.getFrame("f-2")).toBeUndefined();
    expect(s.getFrame("f-10")).toBeDefined();
  });
});

describe("ROUND-61 (R61): ComputerSession — the monitor ring (owner's mini window)", () => {
  it("record() pushes newest-first, caps at 200, and stats counters work", () => {
    const s = resetComputerSessionForTests();
    s.ensureStarted("linux");
    s.record("intent", "first");
    s.record("action", "second");
    const events = s.state().events;
    expect(events[0]?.label).toBe("second");
    expect(events[1]?.label).toBe("first");
    for (let i = 0; i < 210; i++) s.record("action", `e${i}`);
    expect(s.state().events.length).toBe(200);
    s.countActionSent();
    s.countActionRefused();
    s.countVisionCall();
    expect(s.state().stats).toMatchObject({ actionsSent: 1, actionsRefused: 1, visionCalls: 1 });
  });

  it("the process singleton is shared (getComputerSession) and resetForTests clears it", () => {
    const s = getComputerSession();
    expect(getComputerSession()).toBe(s);
    resetComputerSessionForTests();
    expect(getComputerSession().active()).toBe(false);
    expect(getComputerSession().state().events).toHaveLength(0);
  });
});
