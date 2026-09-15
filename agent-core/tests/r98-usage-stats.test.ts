/**
 * ROUND-98 (R98-I2, owner: "Data & statistics … total tokens, peak tokens,
 * the 12-month token-activity heatmap, time-range graphs color-coded by
 * model name — same name across providers IS one model — the model-usage
 * donut, total cost, agent-health, and clear-all-data") — the backend
 * pins: getUsageStats/clearUsageData (storage) and GET /usage/stats +
 * DELETE /usage/data (routes).
 *
 * Coverage:
 *  · totals / peak (incl. the earliest-on-ties rule) / the zero-filled
 *    day series with byModel grouping / the model leaderboard with the
 *    SAME-NAME-two-providers rule + the DISTINCT providers list.
 *  · The months clamp (1–24) and the calendar-month window shape.
 *  · Agent health: turn.error grouped by errorClass with the payload's
 *    code as the honest fallback (rows with NEITHER skipped, never
 *    guessed); tool.use ok=0 grouped by toolName (null skipped).
 *  · clearUsageData deletes usage_events ONLY — sessions + session_events
 *    survive (pinned).
 *  · Routes: the 400 validation idiom, the 401 bearer wall, the DELETE
 *    contract ({deleted} + the ledger reads back zeroed).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendSessionEvent, createSession, recordUsage } from "../src/storage/sessions";
import { clearUsageData, getUsageStats, type UsageStats } from "../src/storage/usage";
import { buildServer } from "../src/server";
import type { UsageRecord } from "shared";

const TOKEN = "test-token-r98-stats-4b1d";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98-stats-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

async function authInject(
  method: "GET" | "DELETE",
  url: string,
): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/* Mirrors usage.test.ts's local helpers (the storage ones stay private —
 * the test re-derives the same UTC arithmetic instead of importing). */
function utcDayKey(daysBack: number): string {
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtcMidnight - daysBack * 86_400_000).toISOString().slice(0, 10);
}

/** The calendar-month key: months back, clamped to the target month's last day. */
function utcMonthsAgoKey(months: number): string {
  const now = new Date();
  const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** Every date key in the window [firstDay, today], ascending. */
function windowDates(firstDay: string): string[] {
  const out: string[] = [];
  const firstMs = Date.parse(`${firstDay}T00:00:00Z`);
  const lastMs = Date.parse(`${utcDayKey(0)}T00:00:00Z`);
  const dayCount = Math.round((lastMs - firstMs) / 86_400_000) + 1;
  for (let i = 0; i < dayCount; i += 1) {
    out.push(new Date(firstMs + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function isoDaysAgo(daysBack: number): string {
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtcMidnight - daysBack * 86_400_000 + 12 * 3_600_000).toISOString();
}

function seedUsage(overrides: Partial<UsageRecord>): void {
  recordUsage(db, {
    agentId: "agt_test",
    sessionId: "sess_test",
    provider: "openrouter",
    model: "glm-5.2",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.25,
    ts: isoDaysAgo(0),
    ...overrides,
  });
}

/** A turn.error event (payload fields per persistTurnError's shape). */
function seedTurnError(payload: Record<string, unknown>): void {
  const session = createSession(db, { agentId: "agt_test", mode: "single" });
  appendSessionEvent(db, session.id, {
    type: "turn.error",
    agentId: "agt_test",
    payload,
  });
}

/** A tool.use event; ok=0 marks a failure. */
function seedToolUse(toolName: string, ok: boolean): void {
  const session = createSession(db, { agentId: "agt_test", mode: "single" });
  appendSessionEvent(db, session.id, {
    type: "tool.use",
    agentId: "agt_test",
    payload: { role: "tool", toolName, ok, argsSummary: "x" },
  });
}

describe("R98-I2: getUsageStats storage", () => {
  it("aggregates totals, peak, zero-filled series with byModel grouping, and the model leaderboard", () => {
    // Today: glm-5.2 served by BOTH openrouter and openai (the owner's
    // same-name rule — ONE model), plus one gpt-4o row. Yesterday: one
    // glm-5.2 row. 13 months back: outside the default window.
    seedUsage({});
    seedUsage({ provider: "openai", model: "glm-5.2", inputTokens: 200, outputTokens: 80, costUsd: 0.5 });
    seedUsage({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 2,
    });
    seedUsage({ ts: isoDaysAgo(1), inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    seedUsage({
      ts: isoDaysAgo(397),
      inputTokens: 999_999,
      outputTokens: 999_999,
      costUsd: 99,
    });

    const stats: UsageStats = getUsageStats(db);

    // The default window is 12 calendar months.
    expect(stats.months).toBe(12);
    const expectedDates = windowDates(utcMonthsAgoKey(12));
    expect(stats.series.map((d) => d.date)).toEqual(expectedDates);

    // Totals: only the in-window rows count (the 13-month-old row excluded).
    expect(stats.totals).toEqual({
      inputTokens: 1310,
      outputTokens: 635,
      totalTokens: 1945,
      costUsd: 2.76,
      requests: 4,
      providerCalls: 4, // all rows default to 1
    });

    // Peak: today (300+130+1500=1930 tokens) beats yesterday (15).
    expect(stats.peak).toEqual({ date: utcDayKey(0), tokens: 1930 });

    // Zero-fill: yesterday's gap day before it is an EMPTY record ({}).
    const gapIdx = expectedDates.indexOf(utcDayKey(2));
    expect(stats.series[gapIdx]).toEqual({ date: utcDayKey(2), byModel: {} });

    // byModel grouping: today carries glm-5.2 (300 via two providers — ONE
    // key) + gpt-4o (1500); yesterday carries glm-5.2 (15).
    expect(stats.series[expectedDates.length - 1]).toEqual({
      date: utcDayKey(0),
      byModel: { "glm-5.2": 430, "gpt-4o": 1500 },
    });
    expect(stats.series[expectedDates.length - 2]).toEqual({
      date: utcDayKey(1),
      byModel: { "glm-5.2": 15 },
    });

    // The model leaderboard: tokens-desc, ONE glm-5.2 row (both providers),
    // providers[] from the DISTINCT scan sorted name-asc.
    expect(stats.models).toEqual([
      {
        model: "gpt-4o",
        inputTokens: 1000,
        outputTokens: 500,
        tokens: 1500,
        costUsd: 2,
        calls: 1,
        requests: 1,
        providers: ["openai"],
      },
      {
        model: "glm-5.2",
        inputTokens: 310,
        outputTokens: 135,
        tokens: 445,
        costUsd: 0.76,
        calls: 3,
        requests: 3,
        providers: ["openai", "openrouter"],
      },
    ]);

    expect(Number.isFinite(Date.parse(stats.generatedAt))).toBe(true);
  });

  it("counts providerCalls via SUM(COALESCE(provider_calls,1)) — the ROUND-83 real SDK-call total", () => {
    seedUsage({});
    recordUsage(
      db,
      {
        agentId: "agt_test",
        sessionId: "sess_test",
        provider: "openrouter",
        model: "glm-5.2",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        ts: isoDaysAgo(0),
      },
      2,
      { providerCalls: 5, origin: "turn" },
    );
    const stats = getUsageStats(db);
    expect(stats.totals.requests).toBe(2); // turns
    expect(stats.totals.providerCalls).toBe(6); // 1 + 5 real SDK calls
    expect(stats.models[0]?.calls).toBe(6);
    expect(stats.models[0]?.requests).toBe(2);
  });

  it("breaks peak-day ties by the EARLIEST date", () => {
    seedUsage({ inputTokens: 100, outputTokens: 100, ts: isoDaysAgo(0) });
    seedUsage({ inputTokens: 100, outputTokens: 100, ts: isoDaysAgo(1) });
    const stats = getUsageStats(db);
    expect(stats.peak).toEqual({ date: utcDayKey(1), tokens: 200 });
  });

  it("clamps months into 1–24 and scopes the calendar-month window", () => {
    seedUsage({});
    // months=0 clamps to 1 (one calendar month back through today).
    const oneMonth = getUsageStats(db, { months: 0 });
    expect(oneMonth.months).toBe(1);
    expect(oneMonth.series.map((d) => d.date)).toEqual(windowDates(utcMonthsAgoKey(1)));
    // months=99 clamps to 24 (the max window; the seeded row is inside).
    const twoYears = getUsageStats(db, { months: 99 });
    expect(twoYears.months).toBe(24);
    expect(twoYears.series.map((d) => d.date)).toEqual(windowDates(utcMonthsAgoKey(24)));
    expect(twoYears.totals.requests).toBe(1);
    // months=6: the series runs exactly from 6 calendar months ago.
    expect(getUsageStats(db, { months: 6 }).series).toHaveLength(windowDates(utcMonthsAgoKey(6)).length);
  });

  it("returns a fully zeroed snapshot for an empty database (peak null, empty models/health)", () => {
    const stats = getUsageStats(db, { months: 12 });
    expect(stats.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requests: 0,
      providerCalls: 0,
    });
    expect(stats.peak).toEqual({ date: null, tokens: 0 });
    expect(stats.series.length).toBeGreaterThan(300);
    expect(stats.series.every((d) => Object.keys(d.byModel).length === 0)).toBe(true);
    expect(stats.models).toEqual([]);
    expect(stats.health).toEqual({ turnErrors: [], toolFailures: [] });
  });

  it("health: turn.error groups by errorClass with the payload's code fallback; NEITHER is skipped, never guessed", () => {
    // Two rate_limit errors + one timeout (class only), one ABORTED (code
    // only), one with NEITHER field (skipped — never a fabricated label).
    seedTurnError({ code: "PROVIDER_RATE_LIMIT", errorClass: "rate_limit", message: "slow down" });
    seedTurnError({ code: "PROVIDER_RATE_LIMIT", errorClass: "rate_limit", message: "again" });
    seedTurnError({ code: "PROVIDER_TIMEOUT", errorClass: "timeout", message: "hung" });
    seedTurnError({ code: "ABORTED", message: "stopped" });
    seedTurnError({ message: "legacy row with no class and no code" });

    // tool.use: two read_file failures, one write_file failure, one OK call
    // (never counted), one with NO toolName (skipped).
    seedToolUse("read_file", false);
    seedToolUse("read_file", false);
    seedToolUse("write_file", false);
    seedToolUse("read_file", true);
    const session = createSession(db, { agentId: "agt_test", mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: "agt_test",
      payload: { role: "tool", ok: 0, argsSummary: "malformed" },
    });

    const stats = getUsageStats(db);
    // Ties break name-asc under SQLite's BINARY collation (uppercase first).
    expect(stats.health.turnErrors).toEqual([
      { name: "rate_limit", count: 2 },
      { name: "ABORTED", count: 1 },
      { name: "timeout", count: 1 },
    ]);
    expect(stats.health.toolFailures).toEqual([
      { name: "read_file", count: 2 },
      { name: "write_file", count: 1 },
    ]);
  });

  it("clearUsageData deletes usage_events ONLY — sessions + session_events survive", () => {
    const session = createSession(db, { agentId: "agt_test", mode: "single", title: "Keep me" });
    seedUsage({ sessionId: session.id });
    seedUsage({ sessionId: session.id, ts: isoDaysAgo(1) });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: "agt_test",
      payload: { role: "tool", toolName: "read_file", ok: true, argsSummary: "x" },
    });

    const deleted = clearUsageData(db);
    expect(deleted).toBe(2);

    // The ledger is empty — the stats read back zeroed.
    expect(db.prepare("SELECT COUNT(*) AS c FROM usage_events").get()).toEqual({ c: 0 });
    expect(getUsageStats(db).totals.requests).toBe(0);

    // …but the conversation + its event log survive untouched.
    const sessions = db.prepare("SELECT id, title FROM sessions").all() as Array<{ id: string; title: string | null }>;
    expect(sessions).toEqual([{ id: session.id, title: "Keep me" }]);
    const events = db.prepare("SELECT COUNT(*) AS c FROM session_events").all() as Array<{ c: number }>;
    expect(events).toEqual([{ c: 1 }]);

    // A second clear is an honest zero (idempotent, still returns changes).
    expect(clearUsageData(db)).toBe(0);
  });
});

describe("R98-I2: GET /usage/stats + DELETE /usage/data routes", () => {
  it("serves the storage shape over HTTP with the default 12-month window", async () => {
    seedUsage({});
    const response = await authInject("GET", "/api/v1/usage/stats");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.months).toBe(12);
    expect(body.totals).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.25,
      requests: 1,
      providerCalls: 1,
    });
    expect(body.peak).toEqual({ date: utcDayKey(0), tokens: 150 });
    expect(body.series).toHaveLength(windowDates(utcMonthsAgoKey(12)).length);
    expect(body.models[0]).toEqual({
      model: "glm-5.2",
      inputTokens: 100,
      outputTokens: 50,
      tokens: 150,
      costUsd: 0.25,
      calls: 1,
      requests: 1,
      providers: ["openrouter"],
    });
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
  });

  it("honors an explicit months window (the series shrinks)", async () => {
    const response = await authInject("GET", "/api/v1/usage/stats?months=6");
    expect(response.statusCode).toBe(200);
    expect(response.json().months).toBe(6);
    expect(response.json().series).toHaveLength(windowDates(utcMonthsAgoKey(6)).length);
  });

  const badMonths = ["0", "25", "-3", "abc", "1.5", ""];
  for (const value of badMonths) {
    it(`rejects months=${JSON.stringify(value)} with 400 VALIDATION`, async () => {
      const response = await authInject(
        "GET",
        `/api/v1/usage/stats?months=${encodeURIComponent(value)}`,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe("query.months");
    });
  }

  it("requires the bearer token on both routes", async () => {
    const get = await app.inject({ method: "GET", url: "/api/v1/usage/stats" });
    expect(get.statusCode).toBe(401);
    expect(get.json().error.code).toBe("UNAUTHORIZED");
    const del = await app.inject({ method: "DELETE", url: "/api/v1/usage/data" });
    expect(del.statusCode).toBe(401);
    expect(del.json().error.code).toBe("UNAUTHORIZED");
  });

  it("DELETE /usage/data returns {deleted} and zeroes the ledger (sessions survive)", async () => {
    const session = createSession(db, { agentId: "agt_test", mode: "single", title: "Keep" });
    seedUsage({ sessionId: session.id });
    seedUsage({ sessionId: session.id, ts: isoDaysAgo(1) });

    const response = await authInject("DELETE", "/api/v1/usage/data");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 2 });

    // The next stats read is zeroed, the session row survived.
    const stats = await authInject("GET", "/api/v1/usage/stats");
    expect(stats.json().totals.requests).toBe(0);
    expect(stats.json().peak).toEqual({ date: null, tokens: 0 });
    const sessions = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(sessions.c).toBe(1);

    // The second DELETE is an honest zero.
    const again = await authInject("DELETE", "/api/v1/usage/data");
    expect(again.json()).toEqual({ deleted: 0 });
  });
});
