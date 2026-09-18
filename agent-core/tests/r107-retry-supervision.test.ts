// @vitest-environment node
//
// R107-b (F2 + F4): SUPERVISION PARITY for retried children, and the
// abort-aware slot queue.
//
// The R107-b review's findings:
//   · F2 (P1): retryChild ran its turn runners with NO AbortController, NO
//     registerTurn, NO watchdog, and NO signal — a retried child was
//     unstoppable (POST /stop found no registration) and unstallable (the
//     supervisor that stall-kills fresh delegations did not exist on the
//     retry path), while the parent's resumeTask polled its status forever.
//   · F4 (P1): acquireSlot's queue poll never consulted the caller's signal
//     — a child queued behind a full semaphore kept polling after its
//     parent turn was stopped, and started anyway the moment a slot freed.
//
// The fixes: retryChild replicates runChildTurn's supervision (fresh
// AbortController + registerTurn + the stall watchdog + the parent-abort
// cascade + unregister in finally, with the signal threaded into BOTH turn
// runners); acquireSlot checks the signal every tick and returns the honest
// ABORTED_WHILE_QUEUED marker; and sampleChildWatch's stall signal became
// RETRY-RELATIVE (min(lastEventAge, elapsed) — a retried child's OLD events
// never insta-kill a healthy retry).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import type { ChatFn } from "../src/agents/chat";
import { Orchestrator, getOrchestrator, sampleChildWatch } from "../src/agents/orchestrator";
import { abortTurn, liveTurnIds } from "../src/lib/turn-registry";
import { appendSessionEvent, createSession, getSession, listSessionEvents, listSubAgents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { setOrchestrationSettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-or-vtest-r107sup";

let tempDir = "";
let db: SqliteDatabase;
let orchestrator: Orchestrator;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r107sup-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // A FRESH instance per test (the r79 pattern) — no semaphore carry-over.
  orchestrator = getOrchestrator();
  generateTextMock.mockReset();
});

afterEach(() => {
  db.close();
  // No supervision state may leak across tests (the finally teardown).
  expect(liveTurnIds()).toEqual([]);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeParent(): { agentId: string; parentSessionId: string } {
  const agent = createAgent(db, {
    name: "R107 Supervision Agent",
    providerId: "openrouter",
    model: "test/r107-1",
  });
  const parent = createSession(db, { agentId: agent.id, mode: "single" });
  return { agentId: agent.id, parentSessionId: parent.id };
}

const keyring = (): ProviderKeyring => new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** A chat that fails instantly (the first attempt's death). */
const throwingChat: ChatFn = async () => {
  throw new Error("upstream 429");
};

/** Poll until fn() is true (bounded, honest label on timeout). */
async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(fn(), what).toBe(true);
}

describe("R107-b (F2): a retried child runs under the SAME supervision as a fresh delegation", () => {
  it("a retried child REGISTERS in the turn registry — POST /stop (abortTurn) finds it, the turn aborts, the parent gets the honest STOPPED-BY-THE-OWNER line, and the registry cleans up", async () => {
    const { parentSessionId } = makeParent();

    // First attempt dies → the child is failed + retryable.
    const failed = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: throwingChat },
      parentSessionId,
      "a task that fails once",
      "researcher",
    );
    expect(failed.ok).toBe(false);
    const childId = failed.sessionId!;
    expect(getSession(db, childId)?.status).toBe("failed");

    // The retry: a chat slow enough that the stop lands mid-flight (the
    // r52-b pattern — the abort lands between iterations).
    const slowChat: ChatFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { text: "retried (but stopped) output", usage, toolCalls: [] };
    };
    const frames: Array<Record<string, unknown>> = [];
    const emit = (event: unknown): void => {
      frames.push(event as Record<string, unknown>);
    };
    const retryPromise = orchestrator.retryChild(
      { db, keyring: keyring(), chat: slowChat },
      parentSessionId,
      childId,
      emit,
    );

    // THE REGISTRATION (the F2 core): pre-R107 there was none — the retry
    // was structurally unstoppable while the parent polled forever.
    await waitFor(() => liveTurnIds().includes(childId), 5_000, "the retried child registers its turn");
    // The running frame landed BEFORE we could have stopped it (registered
    // before the first running frame — the runChildTurn contract).
    expect(frames.some((f) => f.type === "subagent-status" && f.status === "running")).toBe(true);

    // A stop is not an error — the retry's stop persists NO NEW turn.error.
    // (Attempt 1's genuine upstream failure already wrote one — the honest
    // error path; the STOP of the retry must not add to it, the R42/R43
    // rule. Fix during the orchestrator completion pass: the original
    // assertion demanded ZERO turn.error rows on the whole log, which the
    // first attempt's legitimate failure row fails.)
    const turnErrorCountBeforeRetry = listSessionEvents(db, childId).filter(
      (e) => e.type === "turn.error",
    ).length;
    expect(turnErrorCountBeforeRetry).toBeGreaterThanOrEqual(1); // attempt 1's honest row

    // The owner's Stop (POST /sessions/:id/stop → abortTurn): it must find
    // the retried child.
    expect(abortTurn(childId, "owner")).toBe(true);

    const result = await retryPromise;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("STOPPED BY THE OWNER");
    expect(result.message).toContain(childId);
    // The terminal frame carries the honest WHY for the UI.
    const failedFrame = frames.find((f) => f.type === "subagent-status" && f.status === "failed");
    expect(failedFrame?.detail).toBe("stopped by the owner");
    // The teardown: registry entry gone, child failed.
    expect(liveTurnIds()).not.toContain(childId);
    expect(getSession(db, childId)?.status).toBe("failed");
    // The retry's stop added NO new turn.error row.
    expect(
      listSessionEvents(db, childId).filter((e) => e.type === "turn.error").length,
    ).toBe(turnErrorCountBeforeRetry);
  }, 15_000);

  it("the parent's abort CASCADES into a retried child (resumeTask forwards its signal — the F2 wiring)", async () => {
    const { parentSessionId } = makeParent();
    const failed = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: throwingChat },
      parentSessionId,
      "cascades on retry",
      "researcher",
    );
    const childId = failed.sessionId!;

    // The parent turn's controller — resumeTask receives its signal and
    // (post-F2) threads it into retryChild.
    const parentController = new AbortController();
    const slowChat: ChatFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { text: "should not be reported as completed", usage, toolCalls: [] };
    };
    const retryPromise = orchestrator.retryChild(
      { db, keyring: keyring(), chat: slowChat },
      parentSessionId,
      childId,
      undefined,
      parentController.signal,
    );
    await waitFor(() => liveTurnIds().includes(childId), 5_000, "the retry registers");
    // The parent's Stop lands AFTER the retry started.
    parentController.abort();
    const result = await retryPromise;
    // The cascaded abort: the child aborts between iterations → the honest
    // parent-stop report (not "completed" over stopped work).
    expect(result.ok).toBe(false);
    expect(result.message).toContain("aborted");
    expect(getSession(db, childId)?.status).toBe("failed");
  }, 15_000);

  it("the watchdog stall-kills a genuinely-silent retried child — and the RETRY-RELATIVE baseline means the failed attempt's OLD events alone never insta-kill it", async () => {
    const { agentId, parentSessionId } = makeParent();
    // The minimum bounds the settings validation allows (5 s watchdog,
    // 60 s stall threshold) — driven on FAKE time so the 65 s of silence
    // costs milliseconds.
    setOrchestrationSettings(db, { childWatchdogMs: 5_000, childStallTimeoutMs: 60_000 });

    const failed = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: throwingChat },
      parentSessionId,
      "a retry that hangs",
      "researcher",
    );
    const childId = failed.sessionId!;
    expect(getSession(db, childId)?.status).toBe("failed");

    // Age the failed attempt's events 10 minutes into the past (the r52-b
    // raw-table trick): pre-R107's raw lastEventAge would read them as an
    // insta-stall the moment any watchdog ticked.
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      childId,
    );

    vi.useFakeTimers();
    try {
      // A chat that NEVER resolves until its signal aborts — the hung
      // retried child (a dead provider connection).
      const hangingChat: ChatFn = (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => resolve({ text: "", usage, toolCalls: [] }),
            { once: true },
          );
        });
      const frames: Array<Record<string, unknown>> = [];
      const emit = (event: unknown): void => {
        frames.push(event as Record<string, unknown>);
      };
      const retryPromise = orchestrator.retryChild(
        { db, keyring: keyring(), chat: hangingChat },
        parentSessionId,
        childId,
        emit,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      // The retry is silent so far, but it just started — the OLD events do
      // NOT insta-kill it (the min(lastEventAge, elapsed) baseline).
      expect(getSession(db, childId)?.status).toBe("running");
      // A heartbeat frame arrived (the watchdog is LIVE on the retry path —
      // pre-R107 there was no watchdog there at all).
      expect(frames.some((f) => f.type === "subagent-status" && f.status === "running" && "watch" in f)).toBe(true);

      // +60 s of genuine silence past the retry start → the stall fires,
      // the supervisor aborts the child, the honest STALLED line comes back.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await retryPromise;
      expect(result.ok).toBe(false);
      expect(result.message).toContain("STALLED");
      expect(result.message).toContain("the supervisor stopped it");
      expect(getSession(db, childId)?.status).toBe("failed");
      const failedFrame = frames.find((f) => f.type === "subagent-status" && f.status === "failed");
      expect(String(failedFrame?.detail)).toContain("stalled");
      // The teardown ran (fake time: the interval must be cleared or the
      // process would never idle).
      expect(liveTurnIds()).not.toContain(childId);
      // The aged events belong to the FIRST attempt — the agent row is
      // untouched by the raw-table rewrite above (sanity for the fixture).
      expect(getSession(db, childId)?.agentId).toBe(agentId);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe("R107-b (F2): sampleChildWatch — the retry-relative stall baseline", () => {
  it("OLD events + a FRESH run start → NOT stalled (the retried-child shape; the raw age would have fired)", () => {
    const { agentId } = makeParent();
    const session = createSession(db, { agentId, mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId,
      payload: { role: "tool", toolName: "run_command", argsSummary: "command: node build.js", ok: true },
    });
    const now = Date.now();
    // The failed attempt's last event is 10 minutes old…
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      session.id,
    );
    // …but the RETRY started just now: effective age = min(10 min, ~0) ≈ 0.
    const retried = sampleChildWatch(db, session.id, now, 60_000, 0, 1);
    expect(retried.lastEventAgeMs).toBeGreaterThan(9 * 60_000); // the RAW age is honest
    expect(retried.stalled).toBe(false);
  });

  it("OLD events + an OLD run start → still stalled (the fresh-delegation semantics are unchanged)", () => {
    const { agentId } = makeParent();
    const session = createSession(db, { agentId, mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId,
      payload: { role: "tool", toolName: "run_command", argsSummary: "command: node build.js", ok: true },
    });
    const now = Date.now();
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""),
      session.id,
    );
    // Both the last event AND the run start are 10 minutes old — a genuine
    // silent hang, exactly the R52-b shape.
    expect(sampleChildWatch(db, session.id, now - 10 * 60_000, 60_000, 0, 1).stalled).toBe(true);
  });

  it("FRESH events stay healthy (no regression on the fresh-child path)", () => {
    const { agentId } = makeParent();
    const session = createSession(db, { agentId, mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId,
      payload: { role: "tool", toolName: "read_file", argsSummary: "path: a.txt", ok: true },
    });
    const now = Date.now();
    expect(sampleChildWatch(db, session.id, now - 30_000, 60_000, 0, 1).stalled).toBe(false);
    // …and past the threshold they stall. For a fresh child every event
    // post-dates the start, so the min() is a no-op — the EVENT's age is
    // what counts. Age the EVENT past the threshold (a genuinely silent
    // child), with the run start older still — the completed-pass fix:
    // the original assertion aged the START (elapsedMs) while leaving the
    // event fresh, which describes an ACTIVE child (min(≈0, 120s) = ≈0 —
    // healthy), not a stalled one.
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?").run(
      new Date(now - 120_000).toISOString().replace("T", " ").replace("Z", ""),
      session.id,
    );
    expect(sampleChildWatch(db, session.id, now - 130_000, 60_000, 0, 1).stalled).toBe(true);
  });
});

describe("R107-b (F4): the abort-aware slot queue (acquireSlot)", () => {
  it("a child queued behind a FULL semaphore aborts PROMPTLY when its parent turn stops — honest stopped-before-it-started line, no slot taken, the running sibling unaffected", async () => {
    const { parentSessionId } = makeParent();
    // ONE concurrency permit: the first child holds it, the second queues.
    setOrchestrationSettings(db, { maxParallel: 1 });

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const holdChat: ChatFn = () =>
      gateA.then(() => ({ text: "A finished after the gate", usage, toolCalls: [] }));

    const aPromise = orchestrator.delegateTask(
      { db, keyring: keyring(), chat: holdChat },
      parentSessionId,
      "holds the only slot",
      "researcher",
    );
    // A acquired the slot synchronously at call time (the reservation is in
    // delegateTask's synchronous prefix).
    await waitFor(() => listSubAgents(db, parentSessionId).length === 1, 5_000, "child A exists");

    const parentController = new AbortController();
    const bFrames: Array<Record<string, unknown>> = [];
    const bStartedAt = Date.now();
    const bPromise = orchestrator.delegateTask(
      { db, keyring: keyring(), chat: holdChat },
      parentSessionId,
      "queued behind A",
      "researcher",
      (event) => bFrames.push(event as Record<string, unknown>),
      parentController.signal,
    );
    // B emitted its queued frame (its runChildTurn prefix ran) and is now
    // polling for the slot.
    await waitFor(
      () => bFrames.some((f) => f.type === "subagent-status" && f.status === "queued"),
      5_000,
      "child B queued",
    );

    // The parent's Stop lands while B sits queued. Pre-R107 the poll never
    // consulted the signal: B waited until A finished (the gate NEVER opens
    // in this test — without the fix this await hangs to the test timeout).
    parentController.abort();
    const b = await bPromise;
    expect(b.ok).toBe(false);
    expect(b.output).toContain("stopped before it started");
    expect(b.output).toContain("concurrency slot");
    // PROMPT: within a couple of poll ticks (~100 ms each), not minutes.
    expect(Date.now() - bStartedAt).toBeLessThan(5_000);
    const bChild = getSession(db, b.sessionId!);
    expect(bChild?.status).toBe("failed");
    const failedFrame = bFrames.find((f) => f.type === "subagent-status" && f.status === "failed");
    expect(String(failedFrame?.detail)).toContain("stopped before it started");

    // A is UNAFFECTED — it still holds the slot and completes on its own.
    releaseA();
    const a = await aPromise;
    expect(a.ok).toBe(true);
    expect(getSession(db, a.sessionId!)?.status).toBe("completed");
  }, 15_000);

  it("an ALREADY-stopped parent never even reserves a slot: the child fails immediately with the stopped-before-it-started line", async () => {
    const { parentSessionId } = makeParent();
    const controller = new AbortController();
    controller.abort();
    const result = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: throwingChat },
      parentSessionId,
      "never starts",
      "researcher",
      undefined,
      controller.signal,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stopped before it started");
    // The chat NEVER ran (the signal was checked before any reservation).
    expect(getSession(db, result.sessionId!)?.status).toBe("failed");
  });
});
