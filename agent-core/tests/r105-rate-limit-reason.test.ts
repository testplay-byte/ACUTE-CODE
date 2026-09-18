/**
 * ROUND-105 (R105-C) regression tests — the rate-limit REASON taxonomy +
 * the reason-aware rung floor + the provider lessons storage.
 *
 * The owner's directive chain: the free-model benchmarks (round-105 §2 D)
 * showed OpenRouter's free tier failing with DAILY-CAP 429s whose bodies
 * say exactly why ("free-models-per-day… Add $credits") — but the R75
 * ladder treated every rate limit identically (Retry-After ?? the 90 s →
 * 5 min rungs), burning four attempts against a cap that resets at
 * midnight. The oh-my-pi study's rate-limit taxonomy (MIT) named the fix:
 * classify WHY, then let the reason pick the honest wait.
 *
 * Coverage:
 *  · classifyRateLimitReason — the quota shapes (OpenRouter's literal
 *    free-models-per-day, daily/monthly caps, quota exceeded, the credits
 *    family), the capacity shapes (at capacity / overloaded), the generic
 *    rate shapes (RPM/TPM, too many requests, bare "rate limit"), the
 *    bare-429 default, and the honest undefined for bodies that say
 *    neither.
 *  · classifyProviderError THREADS the reason — a 429 with a quota body
 *    classifies rate_limit + reason "quota"; a pattern-matched rate limit
 *    threads its reason; NON-rate classes never carry a reason field
 *    (additive-only: existing classifications are byte-identical).
 *  · effectiveRungWaitMs — the quota floor (10 min beats the 90 s rung AND
 *    an optimistic 5 s Retry-After; a LONGER provider Retry-After still
 *    wins), and the byte-identical pre-R105 behavior for rate / capacity /
 *    undefined (Retry-After replaces the rung when present, else the rung).
 *  · recordProviderLesson / listProviderLessons — the migration's table,
 *    the upsert counting, and the never-throws telemetry rule.
 *  · The RUN-LEVEL integration leg — a streamed turn whose chat fails with
 *    the owner's literal OpenRouter daily-cap body sees its meta.retry
 *    frame floored at 10 minutes EVEN with customized 0-ms rungs (the
 *    R80-family tests kept their rate-shaped fixtures precisely so the
 *    settings-driven rungs stay pinnable); an AbortSignal escapes the wait
 *    so the test never sits the floor out.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  classifyProviderError,
  classifyRateLimitReason,
} from "../src/agents/error-classification";
import {
  effectiveRungWaitMs,
  RATE_LIMIT_QUOTA_FLOOR_MS,
} from "../src/lib/retry";
import {
  listProviderLessons,
  recordProviderLesson,
} from "../src/storage/provider-lessons";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

/** The AI SDK's APICallError shape ({statusCode} + a real body). */
function apiCallError(statusCode: number, message: string): Error {
  const err = new Error(message);
  err.name = "AI_APICallError";
  (err as Error & { statusCode?: number }).statusCode = statusCode;
  return err;
}

/* ── classifyRateLimitReason — the pure taxonomy ──────────────────────────── */

describe("R105-C classifyRateLimitReason", () => {
  it("the QUOTA shapes — the allocation itself is spent", () => {
    // OpenRouter's literal free-tier daily cap (the owner's free-model path).
    expect(
      classifyRateLimitReason("Rate limit exceeded: free-models-per-day. Add $credits or upgrade", 429),
    ).toBe("quota");
    expect(classifyRateLimitReason("You have exceeded your daily request limit", 429)).toBe("quota");
    expect(classifyRateLimitReason("daily usage cap reached", 429)).toBe("quota");
    expect(classifyRateLimitReason("Your monthly limit has been reached", 429)).toBe("quota");
    expect(classifyRateLimitReason("API quota exceeded for this account", 429)).toBe("quota");
    expect(classifyRateLimitReason("insufficient credits: add funds to continue", 429)).toBe("quota");
    expect(classifyRateLimitReason("out of credits", 429)).toBe("quota");
  });

  it("the CAPACITY shapes — the provider is overloaded, not the account", () => {
    expect(classifyRateLimitReason("The model is at capacity right now", 429)).toBe("capacity");
    expect(classifyRateLimitReason("provider is overloaded, please retry later", 429)).toBe("capacity");
    expect(classifyRateLimitReason("Capacity exceeded", 429)).toBe("capacity");
  });

  it("the generic RATE shapes — classic throttling", () => {
    expect(classifyRateLimitReason("Too many requests, slow down", 429)).toBe("rate");
    expect(classifyRateLimitReason("Rate limit of 20 RPM exceeded", 429)).toBe("rate");
    expect(classifyRateLimitReason("429", 429)).toBe("rate"); // bare 429, no body
    expect(classifyRateLimitReason("rate limit exceeded", null)).toBe("rate");
  });

  it("the honest undefined — a rate-limit body that says neither why", () => {
    // Reaches the function only from inside a rate_limit classification in
    // production; direct calls with shapeless text + no 429 stay undefined.
    expect(classifyRateLimitReason("something went wrong", null)).toBeUndefined();
    expect(classifyRateLimitReason("", null)).toBeUndefined();
  });

  it("quota beats capacity beats rate (the specific-first order)", () => {
    // A body that matches BOTH quota and generic rate wording → quota.
    expect(classifyRateLimitReason("rate limit exceeded: free-models-per-day", 429)).toBe("quota");
    // A body that matches both capacity and generic rate wording → capacity.
    expect(classifyRateLimitReason("rate limit: the server is overloaded", 429)).toBe("capacity");
  });
});

/* ── classifyProviderError threads the reason (additive-only) ─────────────── */

describe("R105-C classifyProviderError reason threading", () => {
  it("a 429 with a quota body carries rateLimitReason 'quota'", () => {
    const classified = classifyProviderError(
      apiCallError(429, "Rate limit exceeded: free-models-per-day. Add $credits"),
    );
    expect(classified.class).toBe("rate_limit");
    expect(classified.rateLimitReason).toBe("quota");
  });

  it("a pattern-matched rate limit (no status) threads its reason too", () => {
    const classified = classifyProviderError(new Error("Too many requests"));
    expect(classified.class).toBe("rate_limit");
    expect(classified.rateLimitReason).toBe("rate");
  });

  it("a 429 with a shapeless body gets the honest 'rate' default", () => {
    const classified = classifyProviderError(apiCallError(429, "slow down a moment"));
    expect(classified.class).toBe("rate_limit");
    expect(classified.rateLimitReason).toBe("rate");
  });

  it("NON-rate classes never carry a reason — existing classes are unchanged", () => {
    expect(classifyProviderError(apiCallError(401, "bad key")).rateLimitReason).toBeUndefined();
    expect(classifyProviderError(new Error("socket hang up")).rateLimitReason).toBeUndefined();
    expect(classifyProviderError(new Error("prompt is too long")).rateLimitReason).toBeUndefined();
    // The class pin (the R78 contract) — no class ever moved.
    expect(classifyProviderError(apiCallError(500, "overloaded upstream")).class).toBe("network");
  });
});

/* ── effectiveRungWaitMs — the reason-aware rung ──────────────────────────── */

describe("R105-C effectiveRungWaitMs", () => {
  it("quota floors the wait at 10 minutes — beating the 90 s rung", () => {
    expect(effectiveRungWaitMs(90_000, null, "quota")).toBe(RATE_LIMIT_QUOTA_FLOOR_MS);
  });

  it("quota beats an optimistic short Retry-After (a daily cap has no meaningful one)", () => {
    expect(effectiveRungWaitMs(90_000, 5_000, "quota")).toBe(RATE_LIMIT_QUOTA_FLOOR_MS);
  });

  it("quota still honors a LONGER provider Retry-After (and a longer rung)", () => {
    expect(effectiveRungWaitMs(90_000, 1_800_000, "quota")).toBe(1_800_000);
    expect(effectiveRungWaitMs(1_800_000, null, "quota")).toBe(1_800_000);
  });

  it("rate / capacity / undefined keep the pre-R105 behavior byte-identically", () => {
    // Retry-After replaces the rung when present…
    expect(effectiveRungWaitMs(90_000, 5_000, "rate")).toBe(5_000);
    expect(effectiveRungWaitMs(90_000, 5_000, "capacity")).toBe(5_000);
    expect(effectiveRungWaitMs(90_000, 5_000, undefined)).toBe(5_000);
    // …else the schedule rung stands.
    expect(effectiveRungWaitMs(90_000, null, "rate")).toBe(90_000);
    expect(effectiveRungWaitMs(90_000, null, "capacity")).toBe(90_000);
    expect(effectiveRungWaitMs(90_000, null, undefined)).toBe(90_000);
  });
});

/* ── the provider lessons storage ─────────────────────────────────────────── */

describe("R105-C provider lessons storage", () => {
  let tempDir = "";
  let db: SqliteDatabase;

  beforeEach(() => {
    if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r105lessons-"));
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  });

  afterEach(() => {
    db.close();
  });

  it("migration 0039 created the table; the upsert counts and timestamps", () => {
    recordProviderLesson(db, "openrouter", "deepseek/deepseek-chat-v3.1:free", "quota");
    recordProviderLesson(db, "openrouter", "deepseek/deepseek-chat-v3.1:free", "quota");
    recordProviderLesson(db, "openrouter", "deepseek/deepseek-chat-v3.1:free", "rate");
    recordProviderLesson(db, "anthropic", "claude-sonnet-4", "capacity");

    const lessons = listProviderLessons(db);
    expect(lessons).toHaveLength(3);
    const quota = lessons.find(
      (l) => l.model === "deepseek/deepseek-chat-v3.1:free" && l.reason === "quota",
    );
    expect(quota?.count).toBe(2);
    expect(quota?.providerId).toBe("openrouter");
    expect(quota?.firstTs).toBeGreaterThan(0);
    expect(quota?.lastTs).toBeGreaterThanOrEqual(quota!.firstTs);
    // Distinct reasons stay distinct rows.
    const rate = lessons.find(
      (l) => l.model === "deepseek/deepseek-chat-v3.1:free" && l.reason === "rate",
    );
    expect(rate?.count).toBe(1);
  });

  it("never throws — the telemetry rule (a broken write can't take a turn down)", () => {
    // A closed db is the loudest failure mode available in-process.
    db.close();
    expect(() => recordProviderLesson(db, "openrouter", "m", "quota")).not.toThrow();
    expect(listProviderLessons(db)).toEqual([]);
  });
});

/* ── the run-level integration leg (the floor through a real turn) ────────── */

describe("R105-C the quota floor through a real streamed turn", () => {
  let tempDir = "";
  let db: SqliteDatabase;

  beforeEach(() => {
    if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r105floor-"));
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  });

  afterEach(() => {
    db.close();
  });

  it("the daily-cap body floors the meta.retry wait at 10 min even with a 0-ms rung (the frame + the lesson both land)", async () => {
    const { runStreamedAgentTurn } = await import("../src/agents/runtime");
    const { createSession } = await import("../src/storage/sessions");
    const { createAgent } = await import("../src/storage/agents");
    const { createProject } = await import("../src/storage/projects");
    const { setRetrySettings } = await import("../src/storage/settings");
    const { ProviderKeyring } = await import("../src/providers/registry");

    const project = createProject(db, { name: "R105-Floor", rootPath: join(tempDir, "R105-Floor") });
    const agent = createAgent(db, { name: "R105 Floor Agent", providerId: "openrouter", model: "test/r105-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    // A 0-ms rung 1: without the floor this retries immediately; the quota
    // body must floor it at RATE_LIMIT_QUOTA_FLOOR_MS.
    setRetrySettings(db, { maxAttempts: 3, waitMinutes: [0, 0.01] });

    let calls = 0;
    const chatStream = async function* (): AsyncGenerator<never, void, unknown> {
      calls += 1;
      throw new Error("Rate limit exceeded: free-models-per-day. Add $10 credits to get more");
    };
    const chat = async () => ({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] });

    const emitted: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const turn = runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-r105" }),
        chat,
        chatStream: chatStream as never,
      },
      session.id,
      "hello",
      (event) => {
        emitted.push(event as Record<string, unknown>);
        // The frame is emitted BEFORE the wait starts — abort the moment it
        // lands so the test never sits the 10-minute floor out.
        if ((event as Record<string, unknown>).type === "meta.retry") controller.abort();
      },
      undefined,
      controller.signal,
    );
    const outcome = await turn;

    // TWO provider calls — the documented abort-during-wait self-correction
    // (the ladder comment: "the next call throws on the aborted signal and
    // the catch routes to ABORTED"): the aborted wait continues to the next
    // loop-top (no signal guard there — loop-top delivery runs first), the
    // second chat call starts, and ITS catch's signal.aborted check returns
    // the honest ABORTED outcome. The floor was never RIDDEN — no third
    // call, no 10-minute hang.
    expect(calls).toBe(2);
    const retry = emitted.find((e) => e.type === "meta.retry");
    // THE FLOOR: the frame's wait is 10 minutes, not the 0-ms rung.
    expect(retry?.waitMs).toBe(RATE_LIMIT_QUOTA_FLOOR_MS);
    // The additive reason field rides the wire (quota — the daily cap).
    expect(retry?.rateLimitReason).toBe("quota");
    // The LESSON landed too (the write-only telemetry row).
    const lessons = listProviderLessons(db);
    expect(lessons.some((l) => l.model === "test/r105-1" && l.reason === "quota" && l.count === 1)).toBe(true);
    // The aborted wait ends the turn honestly (not a fake success).
    expect(outcome.ok).toBe(false);
  });
});
