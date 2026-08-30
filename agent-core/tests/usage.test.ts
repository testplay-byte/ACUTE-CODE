import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendSessionEvent, createSession, recordUsage } from "../src/storage/sessions";
import { createProject } from "../src/storage/projects";
import {
  getDetailedUsage,
  getUsageSummary,
  type DetailedUsage,
  type DetailedUsageProject,
  type DetailedUsageSession,
  type UsageDayBucket,
} from "../src/storage/usage";
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

/* ── ROUND-52 (R52-b): GET /usage/detailed — the in-app /usage screen's
 * aggregation (the PUBLIC usage.json export's logic, private shape: raw
 * ids/titles/roles, plus a windowed zero-filled day series). ────────────── */

/** Seeds: 2 projects; Alpha owns a main session + one sub-agent child; the
 * main session has 3 tool.use events (one failed) + 2 usage rows on
 * test/model-1; the child has 1 tool.use + 1 usage row on test/model-2. */
function seedDetailedUsage() {
  const alpha = createProject(db, { name: "Alpha", rootPath: "/tmp/usage-alpha", color: "#3B82F6" });
  const beta = createProject(db, { name: "Beta", rootPath: "/tmp/usage-beta" });
  const parent = createSession(db, {
    agentId: "agt_test",
    mode: "single",
    projectId: alpha.id,
    title: "Ship the feature",
  });
  const child = createSession(db, {
    agentId: "agt_test",
    mode: "single",
    projectId: alpha.id,
    parentSessionId: parent.id,
    subRole: "researcher",
    title: "Research sub-task",
  });

  recordUsage(db, {
    agentId: "agt_test",
    sessionId: parent.id,
    provider: "openrouter",
    model: "test/model-1",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.25,
    ts: isoDaysAgo(0),
  });
  recordUsage(db, {
    agentId: "agt_test",
    sessionId: parent.id,
    provider: "openrouter",
    model: "test/model-1",
    inputTokens: 30,
    outputTokens: 20,
    cachedInputTokens: 10,
    costUsd: 0.05,
    ts: isoDaysAgo(1),
  });
  recordUsage(db, {
    agentId: "agt_test",
    sessionId: child.id,
    provider: "openrouter",
    model: "test/model-2",
    inputTokens: 200,
    outputTokens: 80,
    cachedInputTokens: 40,
    costUsd: 0.5,
    ts: isoDaysAgo(0),
  });

  appendSessionEvent(db, parent.id, {
    type: "tool.use",
    agentId: "agt_test",
    payload: { role: "tool", toolName: "read_file", ok: true, argsSummary: "src/index.ts" },
  });
  appendSessionEvent(db, parent.id, {
    type: "tool.use",
    agentId: "agt_test",
    payload: { role: "tool", toolName: "read_file", ok: false, argsSummary: "missing.txt" },
  });
  appendSessionEvent(db, parent.id, {
    type: "tool.use",
    agentId: "agt_test",
    payload: { role: "tool", toolName: "write_file", ok: true, argsSummary: "notes.md" },
  });
  appendSessionEvent(db, child.id, {
    type: "tool.use",
    agentId: "agt_test",
    payload: { role: "tool", toolName: "read_file", ok: true, argsSummary: "docs.md" },
  });

  return { alpha, beta, parent, child };
}

describe("GET /api/v1/usage/detailed (ROUND-52 R52-b)", () => {
  it("aggregates totals, tools, models and the projects → sessions drill-down", async () => {
    const { alpha, parent, child } = seedDetailedUsage();

    const detailed: DetailedUsage = getDetailedUsage(db, { days: 30 });

    // Whole-history rollups.
    expect(detailed.totals).toEqual({
      projects: 2,
      sessions: 1, // main sessions only…
      subagentSessions: 1, // …children counted separately
      toolCalls: 4,
      requests: 3,
      tokens: { input: 330, output: 150, cached: 50 },
      costUsd: 0.8,
    });

    // Global tool leaderboard: count-desc + failure counts.
    expect(detailed.tools).toEqual([
      { tool: "read_file", count: 3, failures: 1 },
      { tool: "write_file", count: 1, failures: 0 },
    ]);

    // Model mix: per-model calls/tokens/cost, call-count order.
    expect(detailed.models).toEqual([
      { model: "test/model-1", calls: 2, tokens: { input: 130, output: 70, cached: 10 }, costUsd: 0.3 },
      { model: "test/model-2", calls: 1, tokens: { input: 200, output: 80, cached: 40 }, costUsd: 0.5 },
    ]);

    // Projects: most-recently-active first; Alpha carries both sessions.
    expect(detailed.projects).toHaveLength(2);
    const alphaSection = detailed.projects.find((p) => p.id === alpha.id) as DetailedUsageProject;
    const betaSection = detailed.projects.find((p) => p.id !== alpha.id) as DetailedUsageProject;
    // Beta has no sessions (null lastActivity) so Alpha sorts first — the
    // drill-down is a "what happened lately" list.
    expect(detailed.projects[0].id).toBe(alpha.id);
    expect(betaSection.lastActivity).toBeNull();
    expect(alphaSection.synthetic).toBe(false);
    expect(alphaSection.sessionCount).toBe(1);
    expect(alphaSection.totals).toEqual({
      sessions: 1,
      subagents: 1,
      toolCalls: 4,
      requests: 3,
      costUsd: 0.8,
      tokens: { input: 330, output: 150, cached: 50 },
    });
    expect(alphaSection.subagents).toEqual({
      count: 1,
      toolCalls: 1,
      requests: 1,
      tokens: { input: 200, output: 80, cached: 40 },
      costUsd: 0.5,
    });

    // PRIVATE shape: raw ids/titles — the export script's hashing/redaction
    // must NOT leak into the in-app endpoint.
    const parentRow = alphaSection.sessions.find((s) => s.id === parent.id) as DetailedUsageSession;
    const childRow = alphaSection.sessions.find((s) => s.id === child.id) as DetailedUsageSession;
    expect(parentRow).toMatchObject({
      title: "Ship the feature",
      isSubagent: false,
      parentId: null,
      role: null,
      requests: 2,
      toolCallCount: 3,
      subagentCount: 1, // the child is counted on its parent
      model: "test/model-1", // dominant model by token volume
    });
    expect(parentRow.toolCalls).toEqual([
      { tool: "read_file", count: 2, failures: 1 },
      { tool: "write_file", count: 1, failures: 0 },
    ]);
    expect(childRow).toMatchObject({
      title: "Research sub-task",
      isSubagent: true,
      parentId: parent.id, // RAW parent id — nesting key for the UI
      role: "researcher",
      requests: 1,
      toolCallCount: 1,
      model: "test/model-2",
    });

    // The idle project still lists (empty, zero totals).
    expect(betaSection.sessions).toEqual([]);
    expect(betaSection.totals.sessions).toBe(0);

    // Windowed day series: zero-filled, ascending, requests bucketed per day.
    expect(detailed.days).toHaveLength(30);
    expect(detailed.days[29]).toEqual({
      date: utcDayKey(0),
      inputTokens: 300,
      outputTokens: 130,
      requests: 2,
      costUsd: 0.75,
    });
    expect(detailed.days[28]).toEqual({
      date: utcDayKey(1),
      inputTokens: 30,
      outputTokens: 20,
      requests: 1,
      costUsd: 0.05,
    });
    expect(detailed.days[10]).toEqual({ ...ZERO_DAY, date: utcDayKey(19) });
    expect(Number.isFinite(Date.parse(detailed.generatedAt))).toBe(true);
  });

  it("groups orphaned sessions (no/unknown project_id) into a synthetic section", () => {
    const stray = createSession(db, {
      agentId: "agt_test",
      mode: "single",
      projectId: null,
      title: "Legacy session",
    });
    recordUsage(db, {
      agentId: "agt_test",
      sessionId: stray.id,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      ts: isoDaysAgo(0),
    });

    const detailed = getDetailedUsage(db, { days: 7 });
    expect(detailed.days).toHaveLength(7); // explicit window honored
    const unassigned = detailed.projects.find((p) => p.synthetic);
    expect(unassigned?.name).toBe("Unassigned sessions");
    expect(unassigned?.sessionCount).toBe(1);
    expect(unassigned?.sessions[0]?.id).toBe(stray.id);
    expect(detailed.totals.projects).toBe(0); // synthetic rows never count as projects
  });

  it("serves the same shape over HTTP with the default 30-day window", async () => {
    seedDetailedUsage();
    const response = await authInject("/api/v1/usage/detailed");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.days).toHaveLength(30);
    expect(body.totals.requests).toBe(3);
    expect(body.projects).toHaveLength(2);
    expect(body.tools[0]).toEqual({ tool: "read_file", count: 3, failures: 1 });
  });

  it("rejects days=0 and days=91 with 400 VALIDATION", async () => {
    for (const value of ["0", "91"]) {
      const response = await authInject(`/api/v1/usage/detailed?days=${value}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe("query.days");
    }
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/usage/detailed" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("returns an empty-but-valid snapshot for a fresh database", async () => {
    const response = await authInject("/api/v1/usage/detailed?days=7");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.days).toHaveLength(7);
    expect(body.totals).toEqual({
      projects: 0,
      sessions: 0,
      subagentSessions: 0,
      toolCalls: 0,
      requests: 0,
      tokens: { input: 0, output: 0, cached: 0 },
      costUsd: 0,
    });
    expect(body.projects).toEqual([]);
    expect(body.tools).toEqual([]);
    expect(body.models).toEqual([]);
  });
});
