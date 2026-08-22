import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { recordUsage } from "../src/storage/sessions";
import { getUsageSummary, type UsageDayBucket } from "../src/storage/usage";
import { buildServer } from "../src/server";
import type { UsageRecord } from "shared";

const TOKEN = "test-token-usage-9c2f";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-usage-"));
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

async function authInject(url: string): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** Mirrors the UTC day-bucketing contract: date(ts) on stored ISO strings. */
function utcDayKey(daysBack: number): string {
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtcMidnight - daysBack * 86_400_000).toISOString().slice(0, 10);
}

/** A usage ts at noon UTC of the day `daysBack` days ago — always inside its day. */
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
    model: "test/model-1",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.25,
    ts: isoDaysAgo(0),
    ...overrides,
  });
}

const ZERO_DAY: UsageDayBucket = {
  date: expect.any(String),
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  costUsd: 0,
};

describe("GET /api/v1/usage/summary", () => {
  it("buckets by day ascending, zero-fills empty days, and sums totals over the default 14-day window", async () => {
    // Today gets two rows so per-day aggregation is proven; one row yesterday;
    // one row 20 days back sits outside the window and must be excluded.
    seedUsage({});
    seedUsage({ inputTokens: 40, outputTokens: 10, costUsd: 0.5 });
    seedUsage({ ts: isoDaysAgo(1), inputTokens: 200, outputTokens: 80, costUsd: 1.25 });
    seedUsage({ ts: isoDaysAgo(20), inputTokens: 999_999, outputTokens: 999_999, costUsd: 99 });

    const response = await authInject("/api/v1/usage/summary");
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.days).toHaveLength(14);
    expect(body.days.map((day: UsageDayBucket) => day.date)).toEqual(
      Array.from({ length: 14 }, (_, index) => utcDayKey(13 - index)),
    );

    const today: UsageDayBucket = body.days[13];
    expect(today.date).toBe(utcDayKey(0));
    expect(today).toEqual({
      date: utcDayKey(0),
      inputTokens: 140,
      outputTokens: 60,
      requests: 2,
      costUsd: 0.75,
    });

    const yesterday: UsageDayBucket = body.days[12];
    expect(yesterday).toEqual({
      date: utcDayKey(1),
      inputTokens: 200,
      outputTokens: 80,
      requests: 1,
      costUsd: 1.25,
    });

    // Mid-window gap day is zero-filled, not missing.
    expect(body.days[6]).toEqual({ ...ZERO_DAY, date: utcDayKey(7) });
    // The out-of-window row never appears as a bucket.
    expect(body.days.map((day: UsageDayBucket) => day.date)).not.toContain(utcDayKey(20));

    expect(body.totals).toEqual({ inputTokens: 340, outputTokens: 140, requests: 3, costUsd: 2 });
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
  });

  it("honors an explicit days window", async () => {
    seedUsage({});
    seedUsage({ ts: isoDaysAgo(1), inputTokens: 200, outputTokens: 80, costUsd: 1.25 });

    const response = await authInject("/api/v1/usage/summary?days=1");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.days).toEqual([
      { date: utcDayKey(0), inputTokens: 100, outputTokens: 50, requests: 1, costUsd: 0.25 },
    ]);
    expect(body.totals).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      requests: 1,
      costUsd: 0.25,
    });
  });

  it("returns a fully zero-filled series for an empty database", async () => {
    const viaHttp = await authInject("/api/v1/usage/summary?days=3");
    expect(viaHttp.statusCode).toBe(200);
    expect(viaHttp.json()).toEqual({
      days: [2, 1, 0].map((back) => ({ ...ZERO_DAY, date: utcDayKey(back) })),
      totals: { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 },
      generatedAt: expect.any(String),
    });
    expect(getUsageSummary(db, { days: 1 }).days).toEqual([
      { ...ZERO_DAY, date: utcDayKey(0) },
    ]);
  });

  const badDays = ["0", "91", "-3", "abc", "1.5", ""];
  for (const value of badDays) {
    it(`rejects days=${JSON.stringify(value)} with 400 VALIDATION`, async () => {
      const response = await authInject(`/api/v1/usage/summary?days=${encodeURIComponent(value)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe("query.days");
    });
  }

  it("requires the bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/usage/summary" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
