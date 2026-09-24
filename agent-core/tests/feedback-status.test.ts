/**
 * ROUND-125 (R125-B) — the FEEDBACK STATUS REGISTRY (agents/feedback-status.ts)
 * + the mid-turn checkpoint's pure ARM predicate, pinned at the unit level.
 *
 * The registry is a module-level singleton (one sidecar process = one live
 * feedback write), so each test re-imports a FRESH module instance via
 * vi.resetModules() — the transitions are then pinned from the honest
 * pristine idle state every time, never from whatever the previous test
 * left behind.
 *
 *   1. THE SHAPE — readFeedbackStatus's idle form (the exact field set the
 *      GET /feedback/status route mirrors) + the copy semantics (a caller
 *      mutating the returned object can never corrupt the live registry).
 *   2. THE TRANSITIONS — idle → writing → written (begin sets the live
 *      fields + clears the stale error; end flips writing off and records
 *      the outcome/entries/timestamp) and idle → writing → failed (the
 *      error excerpt recorded, capped at 300 chars).
 *   3. THE OVERLAP GUARD — a stale run token's end is DROPPED: a newer
 *      write owns the registry, so an earlier (mid-turn) write completing
 *      after a later (turn-end) write began can never flip writing to
 *      false while the newer call is still in flight.
 *   4. THE CLEAR-ROUTE RESET — resetFeedbackWriteStatus wipes the
 *      LAST-WRITE fields (the viewer's Clear must leave no "Last entry"
 *      line pointing at a deleted file) while a live write's fields stay.
 *   5. THE ARM PREDICATE — shouldArmFeedbackCheckpoint's truth table (the
 *      exact thresholds the SSE route's counters feed) + the settle
 *      constant (the documented ~2 s window).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Type-only import: erased at runtime, so vi.resetModules() below still
// hands every test a FRESH singleton instance.
import type { FeedbackIssueCounters } from "../src/agents/feedback-status";

type StatusModule = typeof import("../src/agents/feedback-status");

let mod: StatusModule;

beforeEach(async () => {
  // A fresh module per test — the singleton starts from its honest idle
  // state (writing:false, everything null), exactly like a booted sidecar.
  vi.resetModules();
  mod = await import("../src/agents/feedback-status");
});

// ── 1. THE SHAPE ─────────────────────────────────────────────────────────────

describe("R125-B: readFeedbackStatus — the shape", () => {
  it("the pristine idle state carries the exact field set the status route mirrors", () => {
    expect(mod.readFeedbackStatus()).toEqual({
      writing: false,
      phase: "turn-end",
      sessionId: null,
      startedAt: null,
      lastWriteTs: null,
      lastWriteOutcome: null,
      lastEntries: null,
      lastError: null,
    });
  });

  it("returns a COPY — mutating it can never corrupt the live registry", () => {
    const snapshot = mod.readFeedbackStatus();
    snapshot.writing = true;
    snapshot.sessionId = "sess_hacked";
    expect(mod.readFeedbackStatus().writing).toBe(false);
    expect(mod.readFeedbackStatus().sessionId).toBeNull();
  });
});

// ── 2. THE TRANSITIONS ───────────────────────────────────────────────────────

describe("R125-B: idle → writing → written/failed", () => {
  it("begin sets the live fields (writing/phase/session/startedAt) and clears the stale error", () => {
    const first = mod.beginFeedbackWrite("sess_a", "turn-end");
    mod.endFeedbackWrite(first, { ok: false, error: "boom" });
    expect(mod.readFeedbackStatus().lastError).toBe("boom");

    // The second write begins but is deliberately never ended here — the
    // test reads the LIVE mid-flight state (the run token is not needed:
    // no end call, and each test gets a fresh module anyway).
    mod.beginFeedbackWrite("sess_b", "mid-turn");
    const mid = mod.readFeedbackStatus();
    expect(mid.writing).toBe(true);
    expect(mid.phase).toBe("mid-turn");
    expect(mid.sessionId).toBe("sess_b");
    expect(mid.startedAt).not.toBeNull();
    // A fresh write starts with a clean error slate — the strip never shows
    // the PREVIOUS failure while the next write is in flight.
    expect(mid.lastError).toBeNull();
    // The last-write fields survive until the new write completes.
    expect(mid.lastWriteOutcome).toBe("failed");
  });

  it("a SUCCESSFUL end flips writing off and records outcome + entries + timestamp", () => {
    const run = mod.beginFeedbackWrite("sess_ok", "turn-end");
    mod.endFeedbackWrite(run, { ok: true, entries: 3 });
    expect(mod.readFeedbackStatus()).toMatchObject({
      writing: false,
      phase: "turn-end",
      sessionId: "sess_ok",
      lastWriteTs: expect.any(String),
      lastWriteOutcome: "written",
      lastEntries: 3,
      lastError: null,
    });
    // The timestamps are honest ISO instants (the strip's clock formatting
    // depends on Date being able to parse them).
    expect(new Date(mod.readFeedbackStatus().lastWriteTs as string).getTime()).not.toBeNaN();
    expect(new Date(mod.readFeedbackStatus().startedAt as string).getTime()).not.toBeNaN();
  });

  it("a FAILED end records the failed outcome + the error excerpt (capped at 300 chars)", () => {
    const run = mod.beginFeedbackWrite("sess_bad", "mid-turn");
    mod.endFeedbackWrite(run, { ok: false, error: "x".repeat(500) });
    const status = mod.readFeedbackStatus();
    expect(status.writing).toBe(false);
    expect(status.lastWriteOutcome).toBe("failed");
    expect(status.lastError).toBe(`${"x".repeat(300)}…`);
    // lastEntries is the last SUCCESSFUL write's count — a failure does not
    // fabricate one.
    expect(status.lastEntries).toBeNull();
  });
});

// ── 3. THE OVERLAP GUARD ─────────────────────────────────────────────────────

describe("R125-B: the overlap guard (stale run tokens are dropped)", () => {
  it("an EARLIER write completing after a LATER one began cannot flip writing to false", () => {
    // The real overlap: the mid-turn checkpoint (run 1) is still in flight
    // when the turn ends and the turn-end phase begins (run 2).
    const checkpointRun = mod.beginFeedbackWrite("sess_x", "mid-turn");
    const turnEndRun = mod.beginFeedbackWrite("sess_x", "turn-end");
    expect(mod.readFeedbackStatus().phase).toBe("turn-end"); // the newer run owns the registry

    // The checkpoint's model call finishes LAST in this ordering — its end
    // must be dropped, not applied (writing would falsely read false while
    // the turn-end call is still running).
    mod.endFeedbackWrite(checkpointRun, { ok: true, entries: 1 });
    expect(mod.readFeedbackStatus().writing).toBe(true);

    // The turn-end write completes — only now does the registry go idle,
    // and its outcome is the NEWER write's.
    mod.endFeedbackWrite(turnEndRun, { ok: true, entries: 2 });
    expect(mod.readFeedbackStatus()).toMatchObject({
      writing: false,
      lastWriteOutcome: "written",
      lastEntries: 2,
    });
  });
});

// ── 4. THE CLEAR-ROUTE RESET ─────────────────────────────────────────────────

describe("R125-B: resetFeedbackWriteStatus (the Clear-route hook)", () => {
  it("wipes the LAST-WRITE fields but leaves a live write's fields alone", () => {
    const run = mod.beginFeedbackWrite("sess_live", "turn-end");
    mod.endFeedbackWrite(run, { ok: true, entries: 5 });

    // The route's DELETE /feedback/file fires this after the wipe: the
    // strip's "Last entry … · N entries" line must not describe a deleted
    // file.
    mod.resetFeedbackWriteStatus();
    expect(mod.readFeedbackStatus()).toMatchObject({
      lastWriteTs: null,
      lastWriteOutcome: null,
      lastEntries: null,
      lastError: null,
    });

    // A write in flight while the owner clears is STILL in flight (its
    // entry re-creates the file when it lands — the ledger's write chain
    // orders clear-then-append).
    const live = mod.beginFeedbackWrite("sess_live2", "mid-turn");
    mod.resetFeedbackWriteStatus();
    expect(mod.readFeedbackStatus()).toMatchObject({
      writing: true,
      sessionId: "sess_live2",
      phase: "mid-turn",
    });
    // And it still ends honestly.
    mod.endFeedbackWrite(live, { ok: true, entries: 1 });
    expect(mod.readFeedbackStatus().writing).toBe(false);
  });
});

// ── 5. THE ARM PREDICATE ─────────────────────────────────────────────────────

describe("R125-B: shouldArmFeedbackCheckpoint — the arm truth table", () => {
  const counters = (patch: Partial<FeedbackIssueCounters>): FeedbackIssueCounters => ({
    failedTools: 0,
    approvalDenials: 0,
    retryEvents: 0,
    ...patch,
  });

  it("quiet turns never arm (the routine cases)", () => {
    expect(mod.shouldArmFeedbackCheckpoint(counters({}))).toBe(false);
    // One failed tool is normal operation; two is bad luck, not an incident.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ failedTools: 1 }))).toBe(false);
    expect(mod.shouldArmFeedbackCheckpoint(counters({ failedTools: 2 }))).toBe(false);
    // ONE denial is the owner steering — routine, never an incident alone.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ approvalDenials: 1 }))).toBe(false);
    // ONE retry rung is the R75 ladder doing its job.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ retryEvents: 1 }))).toBe(false);
    // One failure + nothing else, one retry + nothing else: still quiet.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ failedTools: 1, retryEvents: 1 }))).toBe(false);
  });

  it("the three arm conditions (any ONE arms)", () => {
    // Three failed tool calls in one turn = a tool-reliability incident.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ failedTools: 3 }))).toBe(true);
    // The owner denied AND a call failed: the agent fights both its tools
    // and its owner.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ approvalDenials: 1, failedTools: 1 }))).toBe(true);
    // The retry ladder climbed a SECOND rung: the first retry did not save
    // the turn.
    expect(mod.shouldArmFeedbackCheckpoint(counters({ retryEvents: 2 }))).toBe(true);
    // Past the thresholds stays armed (monotonic — counters never decrease
    // within a turn).
    expect(mod.shouldArmFeedbackCheckpoint(counters({ failedTools: 7, approvalDenials: 2, retryEvents: 4 }))).toBe(true);
  });

  it("the settle window is the documented ~2 s (the guard's constant pin)", () => {
    // The route cannot see the future; the window is how "don't run in the
    // last ~2 s before the stream closes" is implemented. The pin keeps a
    // future tweak from silently changing the checkpoint's timing story.
    expect(mod.FEEDBACK_CHECKPOINT_SETTLE_MS).toBe(2000);
  });
});
