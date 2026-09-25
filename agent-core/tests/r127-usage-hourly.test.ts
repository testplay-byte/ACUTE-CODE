/**
 * ROUND-127 (the hourly view): the granularity seam's pins — the owner's
 * directive: "if I select it to seven days … instead of seven days, it would
 * show me a much better kind of view, like hourly based". The laws:
 *
 *   · storage: getUsageSummary({granularity:"hour"}) buckets by UTC HOUR
 *     ("YYYY-MM-DDThh" keys, substr(ts,1,13)), zero-fills from the window's
 *     first midnight to the CURRENT hour (no future buckets), ascending;
 *   · storage: the DAY path is byte-identical when granularity is
 *     absent or "day" (the historical contract, untouched);
 *   · storage: getDetailedUsage threads the granularity + ECHOES it;
 *   · route: granularity=hour is served; garbage values 400-VALIDATION;
 *     hour with days > 14 400s (the 336-bucket cap);
 *   · route: the DEFAULT (absent param) response carries
 *     granularity:"day" and day-key dates — the mobile/dashboard compat law.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { recordUsage } from "../src/storage/sessions";
import { getDetailedUsage, getUsageSummary } from "../src/storage/usage";
import { buildServer } from "../src/server";
import type { UsageRecord } from "shared";

const TOKEN = "test-token-usage-hour-r127";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-usage-hour-"));
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
    /* best-effort (Windows file handles) */
  }
});

async function authInject(url: string): Promise<LightMyRequestResponse> {
  return (await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

function todayUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** A usage ts at a specific UTC offset from midnight (ms into the day). */
function isoAtMsIntoDay(daysBack: number, msIntoDay: number): string {
  return new Date(todayUtcMidnight() - daysBack * 86_400_000 + msIntoDay).toISOString();
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
    ts: isoAtMsIntoDay(0, 12 * 3_600_000),
    ...overrides,
  });
}

describe("R127 getUsageSummary — granularity=hour", () => {
  it("buckets by UTC hour with 13-char keys, zero-filled ascending to the CURRENT hour", () => {
    // Two rows in DIFFERENT hours of today + one row 3 days back.
    seedUsage({ ts: isoAtMsIntoDay(0, 10 * 3_600_000 + 5 * 60_000) }); // 10:05
    seedUsage({ ts: isoAtMsIntoDay(0, 10 * 3_600_000 + 30 * 60_000), inputTokens: 7 }); // 10:30 — same hour, folds
    seedUsage({ ts: isoAtMsIntoDay(3, 23 * 3_600_000) }); // 3 days back, 23:00

    const summary = getUsageSummary(db, { days: 7, granularity: "hour" });
    expect(summary.days.length).toBe(7 * 24 - (24 - new Date().getUTCHours() - 1));
    // Every key is the hour shape…
    for (const bucket of summary.days) {
      expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    }
    // …ascending, ending at the CURRENT hour (no future buckets)…
    const last = summary.days[summary.days.length - 1];
    expect(last.date).toBe(new Date().toISOString().slice(0, 13));
    // …the 10:00 hour carries BOTH rows (input 107), the rest are zeros.
    const todayKey = new Date().toISOString().slice(0, 10);
    const tenAm = summary.days.find((b) => b.date === `${todayKey}T10`);
    expect(tenAm?.inputTokens).toBe(107);
    expect(tenAm?.requests).toBe(2);
    expect(tenAm?.outputTokens).toBe(100);
    // The 3-days-back 23:00 row is INSIDE the window.
    const threeDaysBack = new Date(todayUtcMidnight() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const backRow = summary.days.find((b) => b.date === `${threeDaysBack}T23`);
    expect(backRow?.requests).toBe(1);
    // Totals fold the whole window.
    expect(summary.totals.requests).toBe(3);
  });

  it("an hour bucket OUTSIDE the window is excluded", () => {
    // 8 days back — outside the 7-day hour window.
    seedUsage({ ts: isoAtMsIntoDay(8, 5 * 3_600_000) });
    const summary = getUsageSummary(db, { days: 7, granularity: "hour" });
    expect(summary.totals.requests).toBe(0);
  });

  it("the DAY path is byte-identical with granularity absent or \"day\"", () => {
    seedUsage({ ts: isoAtMsIntoDay(0, 10 * 3_600_000) });
    const absent = getUsageSummary(db, { days: 3 });
    const day = getUsageSummary(db, { days: 3, granularity: "day" });
    // R128 CI fix: generatedAt is a per-call timestamp — on the 3-4x slower
    // Windows runner the two calls straddled a millisecond boundary and the
    // "byte-identical" deep-equal flaked (run 36197681737). The identical-DAY-
    // PATH contract is everything EXCEPT that timestamp; strip it before the
    // deep compare and pin it separately (same UTC day, fresh).
    const { generatedAt: _absentAt, ...absentRest } = absent;
    const { generatedAt: _dayAt, ...dayRest } = day;
    expect(dayRest).toEqual(absentRest);
    expect(new Date(day.generatedAt).toISOString().slice(0, 10)).toBe(
      new Date(absent.generatedAt).toISOString().slice(0, 10),
    );
    // And the day keys are the 10-char shape.
    for (const bucket of absent.days) {
      expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("R127 getDetailedUsage — the granularity thread + echo", () => {
  it("threads hour into the series and echoes it; day stays the default", () => {
    seedUsage({ ts: isoAtMsIntoDay(0, 9 * 3_600_000) });
    const hour = getDetailedUsage(db, { days: 7, granularity: "hour" });
    expect(hour.granularity).toBe("hour");
    expect(hour.days.length).toBeGreaterThan(7 * 24 - 24); // ≥ 145 buckets
    for (const bucket of hour.days) {
      expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    }
    const dayDefault = getDetailedUsage(db, { days: 7 });
    expect(dayDefault.granularity).toBe("day");
    expect(dayDefault.days.length).toBe(7);
  });
});

describe("R127 GET /api/v1/usage/detailed — the granularity route contract", () => {
  it("granularity=hour serves the hourly series + echo", async () => {
    seedUsage({ ts: isoAtMsIntoDay(0, 9 * 3_600_000) });
    const res = await authInject("/api/v1/usage/detailed?days=7&granularity=hour");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.granularity).toBe("hour");
    expect(body.days.length).toBeGreaterThan(7 * 24 - 24);
  });

  it("the DEFAULT (absent param) carries granularity:\"day\" + day keys (the compat law)", async () => {
    seedUsage({});
    const res = await authInject("/api/v1/usage/detailed?days=7");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.granularity).toBe("day");
    expect(body.days).toHaveLength(7);
    for (const bucket of body.days) {
      expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("a garbage granularity 400s with VALIDATION + the field name", async () => {
    const res = await authInject("/api/v1/usage/detailed?days=7&granularity=week");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.field).toBe("query.granularity");
  });

  it("granularity=hour with days > 14 400s (the 336-bucket cap)", async () => {
    const res = await authInject("/api/v1/usage/detailed?days=30&granularity=hour");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.field).toBe("query.granularity");
  });

  it("granularity=day stays byte-compatible with the historical URL", async () => {
    seedUsage({});
    const explicit = await authInject("/api/v1/usage/detailed?days=7&granularity=day");
    const absent = await authInject("/api/v1/usage/detailed?days=7");
    expect(explicit.statusCode).toBe(200);
    expect(absent.statusCode).toBe(200);
    // generatedAt differs by ms — compare the series + rollups instead.
    const a = JSON.parse(explicit.body);
    const b = JSON.parse(absent.body);
    expect(a.days).toEqual(b.days);
    expect(a.totals).toEqual(b.totals);
    expect(a.models).toEqual(b.models);
  });
});
