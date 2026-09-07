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
        return {
          text: "Part one is done — now for part two.",
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
