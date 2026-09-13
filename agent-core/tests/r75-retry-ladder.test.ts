/**
 * ROUND-75 (R75) regression tests — the TRANSIENT-API RETRY LADDER.
 *
 * The owner's spec, verbatim: a provider failure due to timeout / rate
 * limit / network retries immediately, then waits 1.5 min → 5 min →
 * 10 min → 30 min (one final attempt) before giving up, notifying the
 * user, and showing the error; any OTHER failure class (auth, unknown)
 * never auto-retries — it fails fast through the honest R43 error path.
 *
 * Coverage:
 *  · Unit: the schedule constants (the owner's exact numbers), the
 *    transient split, waitForRetry (deadline/abort/tick), the active-wait
 *    registry, the wait formatter.
 *  · Streamed integration: the immediate rung recovers (500 → retry →
 *    success, visible meta.retry frames); a rate limit that never heals
 *    exhausts the ladder honestly (6 attempts, terminal 502 with the
 *    attempts count, the persisted turn.error carries it, meta.retry
 *    frames every rung); a non-transient second failure stops the ladder
 *    (500 → retry → 401 → terminal at attempts=2); a user STOP during a
 *    wait aborts immediately (ABORTED, never an error).
 *  · Sync integration: the immediate rung recovers a sub-agent turn; the
 *    R75 swallow fix — a failure after partial replies returns 502 (the
 *    old code returned ok:true and the orchestrator believed the lie).
 *
 * ROUND-94 (R94-D1) additions: malformed_response joins the transient
 * ladder (the owner's literal "Generation failed: unknown object" dead
 * end — classification → ladder, no special-casing), and the ONE
 * unknown-class-with-PROGRESS retry: `unknown` stays fail-fast EXCEPT
 * when the dying turn already did real work, then exactly one bounded
 * extra attempt (visible meta.retry card, attempt 2 of 2) before the
 * honest terminal path.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { classifyProviderError, isTransientApiFailure } from "../src/agents/error-classification";
import {
  RETRY_LADDER_MS,
  RETRY_TICK_MS,
  RETRY_TOTAL_ATTEMPTS,
  clearActiveRetryWait,
  formatRetryWaitMs,
  getActiveRetryWait,
  registerActiveRetryWait,
  waitForRetry,
} from "../src/lib/retry";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r75-retry";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r75-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r75-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

const rateLimitError = (): Error => new Error("429 Too Many Requests: rate limited on test/r75-1");
const networkError = (): Error => new Error("500 Internal Server Error from provider");
const authError = (): Error => {
  const err = new Error("401 Unauthorized: invalid API key");
  (err as Error & { statusCode?: number }).statusCode = 401;
  return err;
};

/* ── Unit: the owner's schedule, verbatim ──────────────────────────────────── */

describe("R75: the retry ladder constants (the owner's spec)", () => {
  it("RETRY_LADDER_MS is exactly [immediate, 1.5 min, 5 min, 10 min, 30 min]", () => {
    expect(RETRY_LADDER_MS).toEqual([0, 90_000, 300_000, 600_000, 1_800_000]);
  });

  it("six total attempts (initial + five rungs)", () => {
    expect(RETRY_TOTAL_ATTEMPTS).toBe(6);
  });

  it("the tick cadence fits inside the shortest non-zero rung", () => {
    expect(RETRY_TICK_MS).toBeLessThanOrEqual(90_000);
  });

  it("formatRetryWaitMs phrases the rungs the way the owner did", () => {
    expect(formatRetryWaitMs(0)).toBe("immediately");
    expect(formatRetryWaitMs(90_000)).toBe("1.5 min");
    expect(formatRetryWaitMs(300_000)).toBe("5 min");
    expect(formatRetryWaitMs(600_000)).toBe("10 min");
    expect(formatRetryWaitMs(1_800_000)).toBe("30 min");
    expect(formatRetryWaitMs(2_000)).toBe("2 s");
  });
});

describe("R75: the transient split (error-classification)", () => {
  it("rate_limit / network / timeout are transient — the ladder applies", () => {
    expect(isTransientApiFailure("rate_limit")).toBe(true);
    expect(isTransientApiFailure("network")).toBe(true);
    expect(isTransientApiFailure("timeout")).toBe(true);
  });

  it("auth / context_window_exceeded / unknown are NOT transient — fail fast", () => {
    expect(isTransientApiFailure("auth")).toBe(false);
    expect(isTransientApiFailure("context_window_exceeded")).toBe(false);
    expect(isTransientApiFailure("unknown")).toBe(false);
  });

  it("a 429 classifies as rate_limit; a 5xx as network; an abort as timeout", () => {
    expect(classifyProviderError(rateLimitError()).class).toBe("rate_limit");
    expect(classifyProviderError(networkError()).class).toBe("network");
    expect(classifyProviderError(authError()).class).toBe("auth");
    const timeoutErr = new Error("the call timed out");
    timeoutErr.name = "TimeoutError";
    expect(classifyProviderError(timeoutErr).class).toBe("timeout");
  });
});

describe("R75: waitForRetry (pure timing, abort-aware)", () => {
  it("resolves completed at the deadline (fake clock)", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForRetry({ waitMs: 5_000 });
      const state = vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await state;
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves aborted the moment the signal fires — mid-wait, no timer needed", async () => {
    const controller = new AbortController();
    const p = waitForRetry({ waitMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(p).resolves.toBe("aborted");
  });

  it("an already-aborted signal resolves immediately without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForRetry({ waitMs: 60_000, signal: controller.signal })).resolves.toBe("aborted");
  });

  it("a zero wait completes without touching timers (the immediate rung)", async () => {
    await expect(waitForRetry({ waitMs: 0 })).resolves.toBe("completed");
  });

  it("ticks the remaining time and never ticks past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const ticks: number[] = [];
      const p = waitForRetry({ waitMs: 10_000, tickMs: 4_000, onTick: (ms) => ticks.push(ms) });
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(p).resolves.toBe("completed");
      expect(ticks.length).toBe(2); // 4s and 8s — the 12s mark is past the deadline
      expect(ticks[0]).toBeGreaterThan(0);
      expect(ticks.every((ms) => ms > 0 && ms <= 10_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R75: the active-wait registry (supervisor interplay)", () => {
  it("register / get / clear round-trips", () => {
    const entry = {
      sessionId: "ses_r75_wait",
      attempt: 3,
      totalAttempts: RETRY_TOTAL_ATTEMPTS,
      waitMs: 300_000,
      startedAt: Date.now(),
      until: Date.now() + 300_000,
    };
    expect(getActiveRetryWait(entry.sessionId)).toBeUndefined();
    registerActiveRetryWait(entry);
    expect(getActiveRetryWait(entry.sessionId)?.attempt).toBe(3);
    clearActiveRetryWait(entry.sessionId);
    expect(getActiveRetryWait(entry.sessionId)).toBeUndefined();
  });
});

/* ── Streamed integration: the ladder inside runStreamedAgentTurn ─────────── */

describe("R75: the streamed ladder", () => {
  it("the IMMEDIATE rung recovers a transient failure — one retry, visible meta.retry frame, success", async () => {
    const { sessionId, keyring } = setup("R75-Stream-Recover");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) throw networkError();
      yield { type: "text-delta", delta: "Recovered — the work is done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2); // failed once, the immediate rung retried once
    const retryFrames = emitted.filter((e) => e.type === "meta.retry");
    expect(retryFrames).toHaveLength(1);
    expect(retryFrames[0]?.attempt).toBe(2); // the upcoming attempt number
    expect(retryFrames[0]?.totalAttempts).toBe(6);
    expect(retryFrames[0]?.errorClass).toBe("network");
    expect(String(retryFrames[0]?.message)).toContain("retrying (attempt 2 of 6)");
    // No error ever persisted — the turn recovered.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a rate limit that never heals exhausts the ladder honestly: 6 attempts, terminal 502, persisted attempts", async () => {
    const { sessionId, keyring } = setup("R75-Stream-Exhaust");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      throw rateLimitError();
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runStreamedAgentTurn(
        { db, keyring, chat: summarizerChat, chatStream },
        sessionId,
        "do the work",
        (event) => emitted.push(event as Record<string, unknown>),
      );
      // Advance the whole ladder: the immediate rung fires without a timer;
      // the four timed rungs (90s / 300s / 600s / 1800s) fire in sequence as
      // each wait resolves and the next begins.
      await vi.advanceTimersByTimeAsync(90_000 + 300_000 + 600_000 + 1_800_000 + 5_000);
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(502);
        expect(outcome.code).toBe("PROVIDER_ERROR");
        expect(outcome.details?.attempts).toBe(6);
        expect(String(outcome.message)).toContain("auto-retry ladder exhausted");
        expect(outcome.details?.errorClass).toBe("rate_limit");
      }
      expect(streamCalls).toBe(6); // the initial call + all five rungs
      // A meta.retry frame per rung (ticks add more — assert the key shape).
      const retryFrames = emitted.filter((e) => e.type === "meta.retry");
      const attempts = retryFrames.map((e) => e.attempt as number);
      expect(attempts).toContain(2);
      expect(attempts).toContain(6);
      // The persisted failure carries the attempts + class for the card.
      const events = listSessionEvents(db, sessionId);
      const error = events.find((e) => e.type === "turn.error");
      expect(error).toBeDefined();
      const payload = error!.payload as Record<string, unknown>;
      expect(payload.attempts).toBe(6);
      expect(payload.errorClass).toBe("rate_limit");
      // The session stays retryable.
      const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
      expect(row.status).toBe("queued");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NON-transient second failure stops the ladder: 500 → immediate retry → 401 → terminal at attempts=2", async () => {
    const { sessionId, keyring } = setup("R75-Stream-Stop");
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) throw networkError();
      throw authError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      () => undefined,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.details?.attempts).toBe(2);
      expect(outcome.details?.errorClass).toBe("auth"); // the TERMINAL class is the auth failure
    }
    expect(streamCalls).toBe(2); // no third call — auth never auto-retries
  });

  it("a user STOP during a wait aborts immediately: ABORTED outcome, never a turn.error", async () => {
    const { sessionId, keyring } = setup("R75-Stream-AbortWait");
    const controller = new AbortController();
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      throw networkError();
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runStreamedAgentTurn(
        { db, keyring, chat: summarizerChat, chatStream },
        sessionId,
        "do the work",
        () => undefined,
        undefined,
        controller.signal,
      );
      // Let attempt 1 fail and the immediate rung retry (attempt 2 fails
      // too, arming the 90-second rung)…
      await vi.advanceTimersByTimeAsync(0);
      // …then the owner hits Stop mid-wait.
      controller.abort();
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("ABORTED");
        expect(outcome.status).toBe(499);
      }
      // A stop is not an error — nothing persisted, session not failed.
      expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── Sync integration: sub-agent turns get the same ladder + the swallow fix ─ */

describe("R75: the sync ladder + the swallow fix", () => {
  it("the immediate rung recovers a transient failure on the sync path (sub-agents)", async () => {
    const { sessionId, keyring } = setup("R75-Sync-Recover");
    let chatCalls = 0;
    const chat: ChatFn = async () => {
      chatCalls += 1;
      if (chatCalls === 1) throw networkError();
      return {
        text: "Recovered sync reply.",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        toolCalls: [],
      };
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "do the sync work");
    expect(outcome.ok).toBe(true);
    expect(chatCalls).toBe(2);
  });

  it("R75 swallow fix: a failure AFTER partial replies returns 502 — never the ok:true lie", async () => {
    const { sessionId, keyring } = setup("R75-Sync-Swallow");
    let chatCalls = 0;
    const chat: ChatFn = async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        // A tool call makes the loop ITERATE (a zero-tool reply ends the
        // turn) — the failure then lands on the LATER iteration, after
        // partial replies, which is exactly the swallow-fix case.
        // ROUND-96 (R96-B): TOOLS ONLY — under the new completion rule a
        // tool-using iteration with non-empty text is the model's own STOP,
        // so a narrating iteration 1 would end the turn before the failing
        // iteration 2 ever ran. The mid-work shape (no text) is what keeps
        // the loop honest here.
        return {
          text: "",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          toolCalls: [
            { name: "read_file", argsSummary: "path: README.md", ok: true, outputSummary: "200 chars" },
          ],
        };
      }
      // The second iteration dies with a NON-transient error (auth) so the
      // ladder stays out of the way of the swallow assertion.
      throw authError();
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "two-part work");

    // The OLD code returned ok:true here — the orchestrator marked the
    // child completed and the parent model built on half-done work.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.details?.errorClass).toBe("auth");
    }
    // The partial reply AND the error are both in the timeline, and the
    // session stays retryable (queued).
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual(["message.user", "tool.use", "message.assistant", "turn.error"]);
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
    // The real spend of the completed iteration is recorded (the usage row).
    const usage = db
      .prepare("SELECT input_tokens, output_tokens FROM usage_events WHERE session_id = ?")
      .all(sessionId) as Array<{ input_tokens: number; output_tokens: number }>;
    expect(usage).toHaveLength(1);
    expect(usage[0]?.input_tokens).toBe(10);
    expect(usage[0]?.output_tokens).toBe(20);
  });
});

/* ── ROUND-94 (R94-D1): malformed_response on the ladder + the
   unknown-with-PROGRESS retry — the owner's "Generation failed: unknown
   object" instant dead end ──────────────────────────────────────────────── */

describe("R94-D1: malformed_response rides the transient ladder", () => {
  it("'Generation failed: unknown object' retries on the IMMEDIATE rung and recovers — never an instant dead end", async () => {
    const { sessionId, keyring } = setup("R94-Malformed-Ladder");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      // The owner's literal v0.91.0 failure, verbatim.
      if (streamCalls === 1) throw new Error("Generation failed: unknown object");
      yield { type: "text-delta", delta: "Recovered — the work is done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    // Pre-R94 this failed FAST (class unknown → no ladder → the instant
    // dead end the owner reported). Now: one immediate-rung retry, then
    // success.
    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    const retryFrames = emitted.filter((e) => e.type === "meta.retry");
    expect(retryFrames).toHaveLength(1);
    expect(retryFrames[0]?.errorClass).toBe("malformed_response");
    expect(String(retryFrames[0]?.providerError)).toContain("unknown object");
    expect(String(retryFrames[0]?.classMessage)).toContain("unknown object");
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a malformed failure that never heals exhausts the ladder honestly (attempts = totalAttempts)", async () => {
    const { sessionId, keyring } = setup("R94-Malformed-Exhaust");
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      throw new Error("Generation failed: unknown object");
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runStreamedAgentTurn(
        { db, keyring, chat: summarizerChat, chatStream },
        sessionId,
        "do the work",
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(90_000 + 300_000 + 600_000 + 1_800_000 + 5_000);
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.details?.errorClass).toBe("malformed_response");
        expect(outcome.details?.attempts).toBe(6);
        expect(String(outcome.message)).toContain("auto-retry ladder exhausted");
      }
      const error = listSessionEvents(db, sessionId).find((e) => e.type === "turn.error");
      expect(error).toBeDefined();
      expect((error!.payload as Record<string, unknown>).errorClass).toBe("malformed_response");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R94-D1: the ONE unknown-class-with-PROGRESS retry", () => {
  /** An error NO pattern predicts — class stays `unknown` (the R75
   * fail-fast contract for the fresh case; the progress case is what
   * R94-D1 carves out). */
  const novelUnknownError = (): Error => new Error("the provider exploded in a novel way");

  it("an UNKNOWN failure after tool progress retries ONCE (visible card, attempt 2 of 2) and recovers — streamed", async () => {
    const { sessionId, keyring } = setup("R94-Unknown-Progress");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) {
        // Iteration 1: REAL work (a tool call) — the progress that earns
        // the retry (the owner's exact shape: sub-agents had finished).
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.txt" };
        yield { type: "tool-result", toolName: "write_file", argsSummary: "path: a.txt", ok: true, outputSummary: "ok" };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
        return;
      }
      if (streamCalls === 2) throw novelUnknownError();
      // Call 3 — the ONE retry: succeeds.
      yield { type: "text-delta", delta: "Recovered — Task completed." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runStreamedAgentTurn(
        { db, keyring, chat: summarizerChat, chatStream },
        sessionId,
        "do the work",
        (event) => emitted.push(event as Record<string, unknown>),
      );
      // Iteration 1 runs; iteration 2 dies; the 5-second wait elapses; the
      // retry (iteration 2 re-run) succeeds. TWO advances: the runtime's
      // startup microtasks ride the FIRST advance's flush, so the wait's
      // setTimeout(5s) registers with the fake clock ALREADY at ~5.1s —
      // its deadline (~10.1s) only falls inside a SECOND window.
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(true);
      expect(streamCalls).toBe(3);
      // The visible retry card — the frame shape the UI already renders.
      const retryFrames = emitted.filter((e) => e.type === "meta.retry");
      expect(retryFrames).toHaveLength(1);
      expect(retryFrames[0]?.attempt).toBe(2);
      expect(retryFrames[0]?.totalAttempts).toBe(2);
      expect(retryFrames[0]?.errorClass).toBe("unknown");
      expect(String(retryFrames[0]?.message)).toContain("retrying (attempt 2 of 2)");
      expect(String(retryFrames[0]?.providerError)).toContain("novel way");
      // No error persisted — the turn recovered.
      expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the retry is ONE: a second unknown failure ends through the honest terminal path with attempts=2", async () => {
    const { sessionId, keyring } = setup("R94-Unknown-Progress-Twice");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.txt" };
        yield { type: "tool-result", toolName: "write_file", argsSummary: "path: a.txt", ok: true, outputSummary: "ok" };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
        return;
      }
      throw novelUnknownError();
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runStreamedAgentTurn(
        { db, keyring, chat: summarizerChat, chatStream },
        sessionId,
        "do the work",
        (event) => emitted.push(event as Record<string, unknown>),
      );
      // TWO advances (same fake-clock shape as the recover test above: the
      // wait's timer registers with the clock already at ~5.1s — the second
      // window covers its ~10.1s deadline, the terminal path needs no more).
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      const outcome = await turnPromise;

      // Exactly TWO attempts (the initial + the one retry), then terminal.
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(502);
        expect(outcome.details?.errorClass).toBe("unknown");
        expect(outcome.details?.attempts).toBe(2);
      }
      expect(streamCalls).toBe(3);
      // ONE retry card, never a second.
      expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(1);
      const error = listSessionEvents(db, sessionId).find((e) => e.type === "turn.error");
      expect(error).toBeDefined();
      expect((error!.payload as Record<string, unknown>).attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a FRESH no-progress unknown error still fails fast — one call, no retry card (the R75 contract intact)", async () => {
    const { sessionId, keyring } = setup("R94-Unknown-Fresh");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      // The VERY FIRST call dies unclassified — nothing was done yet.
      throw novelUnknownError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.details?.attempts).toBe(1);
      expect(outcome.details?.errorClass).toBe("unknown");
    }
    expect(streamCalls).toBe(1);
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(0);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(true);
  });

  it("the SYNC twin: a sub-agent iteration-2 unknown failure after iteration-1 work retries once", async () => {
    const { sessionId, keyring } = setup("R94-Unknown-Progress-Sync");
    let chatCalls = 0;
    const chat: ChatFn = async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        // Iteration 1: a tool-using reply — the persisted progress.
        // ROUND-96 (R96-B): TOOLS ONLY — under the new completion rule a
        // tool-using iteration with non-empty text is the model's own STOP
        // (the loop breaks before the failing iteration 2 ever runs); the
        // mid-work shape keeps the loop continuing, which is what this
        // test needs (the pre-R96 comment's phrase-avoidance note is now
        // structural: NO text at all).
        return {
          text: "",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          toolCalls: [
            { name: "read_file", argsSummary: "path: README.md", ok: true, outputSummary: "200 chars" },
          ],
        };
      }
      if (chatCalls === 2) throw novelUnknownError();
      return {
        text: "Recovered sync — done.",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        toolCalls: [],
      };
    };

    vi.useFakeTimers();
    try {
      const turnPromise = runSingleAgentTurn({ db, keyring, chat }, sessionId, "two-part work");
      // TWO advances (the same fake-clock shape as the streamed twins: the
      // wait's timer registers with the clock already at ~5.1s; the second
      // window covers its ~10.1s deadline).
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      await vi.advanceTimersByTimeAsync(5_000 + 100);
      const outcome = await turnPromise;

      expect(outcome.ok).toBe(true);
      expect(chatCalls).toBe(3);
      expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
