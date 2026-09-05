import { beforeEach, describe, expect, it } from "vitest";
import {
  computerMonitorDecayArmed,
  resetComputerMonitorDecayForTest,
  resetComputerMonitorForTests,
  useComputerMonitorStore,
} from "./computer-monitor-store";

/**
 * ROUND-67 (R67-C): the TURN-HOLD mechanism — the owner's report: the
 * "Agent is using your computer" mini window DISAPPEARED while the agent was
 * still thinking between computer tool calls (the 6s liveActivity decay is
 * per-EVENT, not per-TURN). The store now exposes the hold actions the
 * ORCHESTRATOR's stream-store hook wires (this store owns the mechanism
 * ONLY — see the store docblock for the full contract):
 *   · holdForTurn(sessionId) — sets the hold, never bumps liveActivity,
 *     never arms the decay.
 *   · releaseTurnHold(sessionId) — the turn ended; the decay then rests the
 *     event signal on its own 6s schedule.
 *   · noteStopSignal(sessionId?) — a stop_computer_control frame arrived:
 *     rest liveActivity + clear the hold(s) NOW.
 * The surface (ComputerMiniWindow) computes live from (liveActivity || any
 * hold) — pinned in ComputerMiniWindow.test.tsx; these are the store-level
 * contracts.
 */

beforeEach(() => {
  resetComputerMonitorForTests();
  resetComputerMonitorDecayForTest();
});

describe("ROUND-67 (R67-C): holdForTurn / releaseTurnHold", () => {
  it("holdForTurn sets the hold WITHOUT bumping liveActivity or arming the decay", () => {
    const s = useComputerMonitorStore.getState();
    s.holdForTurn("session-1");
    const after = useComputerMonitorStore.getState();
    expect(after.turnHolds).toEqual({ "session-1": true });
    expect(after.liveActivity).toBe(false);
    expect(computerMonitorDecayArmed()).toBe(false);
    // Idempotent — re-holding an open turn is a no-op (no new object, no
    // notification storm).
    s.holdForTurn("session-1");
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-1": true });
  });

  it("multiple turns can hold at once; release clears only that turn's hold", () => {
    const s = useComputerMonitorStore.getState();
    s.holdForTurn("session-1");
    s.holdForTurn("session-2");
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-1": true, "session-2": true });
    s.releaseTurnHold("session-1");
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-2": true });
    // Releasing an unheld turn is a safe no-op.
    s.releaseTurnHold("session-1");
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-2": true });
  });

  it("releaseTurnHold does NOT rest liveActivity (the decay owns the event signal)", () => {
    const s = useComputerMonitorStore.getState();
    s.pushLiveEvent({ kind: "action", tool: "left_click" });
    expect(useComputerMonitorStore.getState().liveActivity).toBe(true);
    s.holdForTurn("session-1");
    s.releaseTurnHold("session-1");
    // The last computer-use event may be < 6s old: the decay timer still
    // arms and liveActivity stays true until it fires (or noteStopSignal).
    expect(useComputerMonitorStore.getState().liveActivity).toBe(true);
    expect(computerMonitorDecayArmed()).toBe(true);
  });

  it("the live-flap prevention: the decay FIRING while a hold is open leaves a live signal", () => {
    const s = useComputerMonitorStore.getState();
    s.pushLiveEvent({ kind: "action", tool: "left_click" });
    s.holdForTurn("session-1");
    // The 6s timer fires while the agent is thinking (simulated by the
    // exported test hook — it runs the timer's exact setState).
    resetComputerMonitorDecayForTest();
    expect(useComputerMonitorStore.getState().liveActivity).toBe(false);
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-1": true });
    // The surface's live selector ORs the hold in — that is the pill's
    // pinned behavior (ComputerMiniWindow.test.tsx "no flap" test).
  });
});

describe("ROUND-67 (R67-C): noteStopSignal (the stop_computer_control frame rest)", () => {
  it("rests liveActivity, cancels the decay, and clears ALL holds when unscoped", () => {
    const s = useComputerMonitorStore.getState();
    s.pushLiveEvent({ kind: "receipt", tool: "stop_computer_control" }); // the raw frame RE-ARMS the decay (kind is "receipt")
    expect(computerMonitorDecayArmed()).toBe(true);
    s.holdForTurn("session-1");
    s.holdForTurn("session-2");
    s.noteStopSignal();
    const after = useComputerMonitorStore.getState();
    expect(after.liveActivity).toBe(false);
    expect(after.turnHolds).toEqual({});
    expect(computerMonitorDecayArmed()).toBe(false);
  });

  it("a scoped stop clears only that session's hold", () => {
    const s = useComputerMonitorStore.getState();
    s.holdForTurn("session-1");
    s.holdForTurn("session-2");
    s.noteStopSignal("session-1");
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({ "session-2": true });
    expect(useComputerMonitorStore.getState().liveActivity).toBe(false);
  });

  it("the session_stop FRAME kind still rests liveActivity (the pre-existing channel, holds untouched)", () => {
    const s = useComputerMonitorStore.getState();
    s.pushLiveEvent({ kind: "action", tool: "left_click" });
    s.holdForTurn("session-1");
    s.pushLiveEvent({ kind: "session_stop" });
    const after = useComputerMonitorStore.getState();
    expect(after.liveActivity).toBe(false);
    expect(computerMonitorDecayArmed()).toBe(false);
    // The hold is NOT cleared by a session_stop frame — only the turn
    // lifecycle (releaseTurnHold) or the explicit stop signal clears it.
    expect(after.turnHolds).toEqual({ "session-1": true });
  });
});

describe("ROUND-67 (R67-C): clear/reset hygiene", () => {
  it("clear() resets the holds with the rest of the store", () => {
    const s = useComputerMonitorStore.getState();
    s.holdForTurn("session-1");
    s.pushLiveEvent({ kind: "action", tool: "left_click" });
    s.clear();
    const after = useComputerMonitorStore.getState();
    expect(after.turnHolds).toEqual({});
    expect(after.liveActivity).toBe(false);
  });

  it("resetComputerMonitorForTests resets the holds too (test isolation)", () => {
    useComputerMonitorStore.getState().holdForTurn("session-1");
    resetComputerMonitorForTests();
    expect(useComputerMonitorStore.getState().turnHolds).toEqual({});
  });
});
