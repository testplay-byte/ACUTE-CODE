/**
 * ROUND-50 (R50-c1): the context donut's data source —
 * GET /api/v1/sessions/:id/context — plus the prompts.ts section split that
 * feeds its system-prompt slices.
 *
 * The route's job is honest ESTIMATION:
 *   - contextWindow: the models-table override for (providerId, model) →
 *     the catalog default → 200 000 (runtime.ts getModelContextWindow) —
 *     ROUND-83 (R83): WITH contextWindowSource provenance + maxOutputTokens
 *     + available (resolveTurnBudget — the ONE budget the turn loop and the
 *     meter share).
 *   - breakdown: systemPrompt (identity section — R83: with the skills,
 *     task-modes, active-mode, environment, background-tasks sections a
 *     REAL turn carries), systemTools (tools section + R83: the MEASURED
 *     JSON schemas per effective tool, replacing the fixed 350/tool
 *     approximation), memory (digest section), messages (assembleHistory
 *     with attachments rendered — R83: with the newest compaction APPLIED),
 *     meta (index + custom-rules sections), mcpTools (honest 0 — no MCP
 *     system).
 *   - usedTokens = the SUM of all slices (R83: usedTokensBasis
 *     "estimated" — the wire says which number is a projection).
 *   - R83 `actual`: the provider's OWN number for the last request (the
 *     newest message.assistant stats carrier) — null before the first reply.
 *   - R83 `compaction`: the newest context.compact detail.
 *   - cache/sessionTotals: exact SQL SUMs over usage_events (requests =
 *     COUNT(*) = turns, R83: providerCalls = SUM(provider_calls); hitRate
 *     null before the first input token AND — R83 — when the provider
 *     never reported a cached tier: the SUM over all-NULL rows is NULL,
 *     never a fabricated 0%).
 *   - ROUND-51 (R51-c) `usage`: the Main agent / Sub-agents / Combined
 *     split — main = the session's own ledger (identical to sessionTotals),
 *     subagents = the sum over its DIRECT children's usage_events
 *     (parent_session_id = this session; grandchildren excluded —
 *     listSubAgents parity), combined = the sum. Flat fields unchanged.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { assembleHistory, getModelContextWindow } from "../src/agents/runtime";
import { buildProjectSystemPrompt, buildSystemPromptSections } from "../src/agents/prompts";
import { readCustomRules } from "../src/agents/prompts";
import { estimateMessageTokens } from "../src/context";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { appendSessionEvent, createSession, recordUsage } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { saveMemory } from "../src/storage/memory";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-ctx1";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-ctx-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

/** A ready-made project session with agent + a couple of chat events. */
async function fixtureSession(
  model: string,
): Promise<{ sessionId: string; agentId: string }> {
  // Unique root per call — projects.root_path has a UNIQUE constraint.
  const projectRoot = join(tempDir, `proj-${randomUUID().slice(0, 8)}`);
  mkdirSync(projectRoot, { recursive: true });
  const project = createProject(db, { name: `Ctx-${model}`, rootPath: projectRoot });
  const agent = createAgent(db, { name: "Ctx Agent", providerId: "openrouter", model });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: {
      role: "user",
      content: "please review",
      attachments: [{ name: "a.ts", size: 11, text: "const a=1;" }],
    },
  });
  appendSessionEvent(db, session.id, {
    type: "message.assistant",
    agentId: agent.id,
    payload: { role: "assistant", content: "Reviewed." },
  });
  return { sessionId: session.id, agentId: agent.id };
}

// ── The route ────────────────────────────────────────────────────────────────

describe("GET /api/v1/sessions/:id/context (ROUND-50 R50-c1)", () => {
  it("sums usage_events exactly (tokens, requests, cost) and computes the cache hit rate", async () => {
    const { sessionId, agentId } = await fixtureSession("test/model-1");
    const now = new Date().toISOString();
    recordUsage(db, {
      agentId,
      sessionId,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 30_000,
      outputTokens: 5_000,
      cachedInputTokens: 21_000,
      costUsd: 0.25,
      ts: now,
    });
    recordUsage(db, {
      agentId,
      sessionId,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 20_000,
      outputTokens: 7_000,
      // NO cachedInputTokens (a pre-0020-style row) — null-safe SUM.
      costUsd: 0.17,
      ts: now,
    });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Exact SQL sums over the session's rows (ROUND-83: providerCalls —
    // the real SDK-call count; both fixture rows use the default 1).
    expect(body.sessionTotals).toEqual({
      inputTokens: 50_000,
      outputTokens: 12_000,
      requests: 2,
      costUsd: 0.42,
      providerCalls: 2,
    });
    // Cache: inputTokens sum, null-safe cached sum, hitRate = cached/input.
    expect(body.cache).toEqual({
      inputTokens: 50_000,
      cachedInputTokens: 21_000,
      hitRate: 21_000 / 50_000,
    });
    // model/provider resolution: the session agent's own model.
    expect(body.model).toBe("test/model-1");
    expect(body.providerId).toBe("openrouter");
  });

  it("hitRate is null before any usage row exists (input = 0)", async () => {
    const { sessionId } = await fixtureSession("test/model-1");
    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cache).toEqual({ inputTokens: 0, cachedInputTokens: 0, hitRate: null });
    expect(body.sessionTotals).toEqual({ inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0, providerCalls: 0 });
  });

  // ── ROUND-51 (R51-c): the main / sub-agents / combined usage split ─────────
  it("usage split: main = own ledger, subagents = the DIRECT children's ledgers, combined = the sum", async () => {
    const { sessionId, agentId } = await fixtureSession("test/model-1");
    const now = new Date().toISOString();
    // Main: two rows (same fixture as the exact-sums test above).
    recordUsage(db, { agentId, sessionId, provider: "openrouter", model: "test/model-1", inputTokens: 30_000, outputTokens: 5_000, cachedInputTokens: 21_000, costUsd: 0.25, ts: now });
    recordUsage(db, { agentId, sessionId, provider: "openrouter", model: "test/model-1", inputTokens: 20_000, outputTokens: 7_000, costUsd: 0.17, ts: now });
    // Two sub-agent children with their own ledgers.
    const childA = createSession(db, { agentId, mode: "single", parentSessionId: sessionId, subRole: "coder" });
    const childB = createSession(db, { agentId, mode: "single", parentSessionId: sessionId, subRole: "tester" });
    recordUsage(db, { agentId, sessionId: childA.id, provider: "openrouter", model: "test/model-1", inputTokens: 8_000, outputTokens: 900, costUsd: 0.02, ts: now });
    recordUsage(db, { agentId, sessionId: childB.id, provider: "openrouter", model: "test/model-1", inputTokens: 5_000, outputTokens: 500, costUsd: 0.01, ts: now });
    recordUsage(db, { agentId, sessionId: childB.id, provider: "openrouter", model: "test/model-1", inputTokens: 1_000, outputTokens: 100, costUsd: 0.005, ts: now });
    // A GRANDCHILD (child of childA) is NOT this session's sub-agent — each
    // parent's report covers its own direct children (listSubAgents parity).
    const grandchild = createSession(db, { agentId, mode: "single", parentSessionId: childA.id });
    recordUsage(db, { agentId, sessionId: grandchild.id, provider: "openrouter", model: "test/model-1", inputTokens: 999, outputTokens: 99, costUsd: 0.009, ts: now });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The FLAT fields stay byte-identical (additive shape — old consumers keep working).
    expect(body.sessionTotals).toEqual({
      inputTokens: 50_000,
      outputTokens: 12_000,
      requests: 2,
      costUsd: 0.42,
      providerCalls: 2,
    });
    expect(body.usage.main).toEqual({
      inputTokens: 50_000,
      outputTokens: 12_000,
      requests: 2,
      costUsd: 0.42,
      providerCalls: 2,
    });
    // Sub-agents = the sum over the two DIRECT children (grandchild excluded).
    expect(body.usage.subagents).toEqual({
      inputTokens: 14_000,
      outputTokens: 1_500,
      requests: 3,
      costUsd: 0.035,
    });
    expect(body.usage.combined).toEqual({
      inputTokens: 64_000,
      outputTokens: 13_500,
      requests: 5,
      costUsd: 0.455,
      providerCalls: 2,
    });
  });

  it("usage split: a childless session reports ZERO sub-agents (combined = main)", async () => {
    const { sessionId, agentId } = await fixtureSession("test/model-1");
    recordUsage(db, {
      agentId,
      sessionId,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.001,
      ts: new Date().toISOString(),
    });
    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.usage.subagents).toEqual({ inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 });
    expect(body.usage.main).toEqual(body.sessionTotals);
    expect(body.usage.combined).toEqual(body.usage.main);
  });

  it("contextWindow resolution: models-table override → catalog default → 200 000 fallback", async () => {
    // 1. The models-table override wins for (providerId, model).
    const { sessionId: overrideSession } = await fixtureSession("test/model-1");
    upsertModel(db, "openrouter", { modelId: "test/model-1", contextWindow: 123_456 });
    const override = await authInject({ method: "GET", url: `/api/v1/sessions/${overrideSession}/context` });
    expect(override.json().contextWindow).toBe(123_456);

    // 2. The built-in catalog default (no models row).
    const { sessionId: catalogSession } = await fixtureSession("z-ai/glm-5.2:free");
    const catalog = await authInject({ method: "GET", url: `/api/v1/sessions/${catalogSession}/context` });
    expect(catalog.json().contextWindow).toBe(256_000); // the catalog entry

    // 3. Unknown model, no row → the 200 000 fallback.
    const { sessionId: fallbackSession } = await fixtureSession("totally/unknown-model");
    const fallback = await authInject({ method: "GET", url: `/api/v1/sessions/${fallbackSession}/context` });
    expect(fallback.json().contextWindow).toBe(200_000);

    // The helper itself is the shared source of truth (runtime budget + route).
    expect(getModelContextWindow(db, "openrouter", "test/model-1")).toBe(123_456);
    expect(getModelContextWindow(db, "openrouter", "z-ai/glm-5.2:free")).toBe(256_000);
    expect(getModelContextWindow(db, "openrouter", "totally/unknown-model")).toBe(200_000);
  });

  it("?model= overrides the session agent's model (the per-send picker)", async () => {
    const { sessionId } = await fixtureSession("test/model-1");
    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/context?model=z-ai/glm-5.2:free`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("z-ai/glm-5.2:free");
    expect(response.json().contextWindow).toBe(256_000);
  });

  it("breakdown: slice semantics + usedTokens = the exact sum of all slices", async () => {
    const { sessionId } = await fixtureSession("test/model-1");
    // Custom rules + a saved memory in THIS session's project root, so the
    // meta/memory slices are non-zero and attributable.
    const projRow = db
      .prepare("SELECT p.id AS id, p.root_path AS rootPath FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.id = ?")
      .get(sessionId) as { id: string; rootPath: string };
    writeFileSync(join(projRow.rootPath, ".acuterules"), "Always write tests first.", "utf8");
    saveMemory(db, { projectId: projRow.id, kind: "fact", content: "The build is pnpm-based." });

    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const breakdown = body.breakdown as Record<string, number>;

    // mcpTools is the honest zero (no MCP system yet — the UI shows "none").
    expect(breakdown.mcpTools).toBe(0);
    // The memory slice is non-zero (a memory digest section was injected).
    expect(breakdown.memory).toBeGreaterThan(0);
    // The meta slice carries the custom rules ("Always write tests first.").
    expect(breakdown.meta).toBeGreaterThan(0);
    // The messages slice equals assembleHistory's estimate with the
    // attachment rendered (the same assembly a real turn uses).
    expect(breakdown.messages).toBe(estimateMessageTokens(assembleHistory(db, sessionId)));
    // systemTools includes the 350-tokens-per-tool schema approximation…
    expect(breakdown.systemTools).toBeGreaterThan(350);
    // …and usedTokens is the exact sum of the slices.
    expect(body.usedTokens).toBe(
      breakdown.systemPrompt + breakdown.systemTools + breakdown.memory +
      breakdown.messages + breakdown.meta + breakdown.mcpTools,
    );
  });

  it("404s on an unknown session; 409 when the agent is unconfigured; auth required", async () => {
    const missing = await authInject({ method: "GET", url: "/api/v1/sessions/sess_none/context" });
    expect(missing.statusCode).toBe(404);

    const agentNoModel = createAgent(db, { name: "Bare", providerId: null, model: null });
    const bare = createSession(db, { agentId: agentNoModel.id, mode: "single" });
    const conflict = await authInject({ method: "GET", url: `/api/v1/sessions/${bare.id}/context` });
    expect(conflict.statusCode).toBe(409);

    const unauth = await app.inject({ method: "GET", url: `/api/v1/sessions/${bare.id}/context` });
    expect(unauth.statusCode).toBe(401);
  });
});

// ── ROUND-83 (R83): the honest meter — actual / compaction / budget / hitRate ─
describe("GET /api/v1/sessions/:id/context (ROUND-83 R83 additions)", () => {
  it("the budget trio + provenance: contextWindowSource, maxOutputTokens, available, usedTokensBasis — for all three resolution paths", async () => {
    // Override path.
    upsertModel(db, "openrouter", { modelId: "test/r83-a", displayName: "A", contextWindow: 123_456, maxOutputTokens: 4_096 });
    const { sessionId: overrideSession } = await fixtureSession("test/r83-a");
    const override = (await authInject({ method: "GET", url: `/api/v1/sessions/${overrideSession}/context` })).json();
    expect(override.contextWindow).toBe(123_456);
    expect(override.contextWindowSource).toBe("override");
    expect(override.maxOutputTokens).toBe(4_096);
    expect(override.available).toBe(123_456 - 4_096 - 8_000);
    expect(override.usedTokensBasis).toBe("estimated");

    // Catalog path.
    const { sessionId: catalogSession } = await fixtureSession("z-ai/glm-5.2:free");
    const catalog = (await authInject({ method: "GET", url: `/api/v1/sessions/${catalogSession}/context` })).json();
    expect(catalog.contextWindowSource).toBe("catalog");

    // Default path — the honest "assumed" label.
    const { sessionId: fallbackSession } = await fixtureSession("totally/unknown-r83");
    const fallback = (await authInject({ method: "GET", url: `/api/v1/sessions/${fallbackSession}/context` })).json();
    expect(fallback.contextWindowSource).toBe("default");
    expect(fallback.maxOutputTokens).toBe(32_768);
    expect(fallback.available).toBe(200_000 - 32_768 - 8_000);
  });

  it("§3.1 the actual block: null before the first provider reply; the NEWEST stats-carrier afterwards (with model + ts)", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r83-a2");
    // Before any stats carrier: null — NEVER a fabricated 0.
    const before = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    expect(before.actual).toBeNull();

    // Two stats carriers — the NEWEST one is the ground truth.
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: { role: "assistant", content: "first", usage: { inputTokens: 1_000, outputTokens: 100 }, model: "test/r83-a2" },
    });
    const older = appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: {
        role: "assistant",
        content: "second",
        // R83: the carrier carries cachedInputTokens when the iteration reported one.
        usage: { inputTokens: 2_500, outputTokens: 250, cachedInputTokens: 900 },
        model: "test/r83-a2",
      },
    });
    const after = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    expect(after.actual).toEqual({
      inputTokens: 2_500,
      outputTokens: 250,
      cachedInputTokens: 900,
      at: older.ts,
      model: "test/r83-a2",
    });

    // A LATER carrier WITHOUT cachedInputTokens → the honest null (the
    // absence is "not reported", never 0).
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId,
      payload: { role: "assistant", content: "third", usage: { inputTokens: 3_000, outputTokens: 30 }, model: "test/r83-a2" },
    });
    const third = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    expect(third.actual.inputTokens).toBe(3_000);
    expect(third.actual.cachedInputTokens).toBeNull();
  });

  it("§2.4/§3.2c closed: after a compaction the messages estimate DROPS (the model receives summary + tail, not the raw log) + the compaction field carries the detail", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r83-a3");
    // A long conversation.
    for (let i = 0; i < 6; i += 1) {
      appendSessionEvent(db, sessionId, {
        type: "message.user",
        agentId,
        payload: { role: "user", content: `question ${i} ${"detail ".repeat(150)}` },
      });
    }
    const before = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    expect(before.compaction).toBeUndefined();

    // The compaction event (what a real turn's assembleWithCompaction persists).
    const rawBefore = estimateMessageTokens(assembleHistory(db, sessionId));
    appendSessionEvent(db, sessionId, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "The user asked six questions. The agent answered all.", throughSeq: 7, droppedMessages: 4, tokensSaved: 500 },
    });
    const after = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    // The compaction badge data.
    expect(after.compaction).toEqual({ throughSeq: 7, droppedMessages: 4, tokensSaved: 500 });
    // The messages slice dropped (summary + kept tail < the raw log).
    expect(after.breakdown.messages).toBeLessThan(rawBefore);
    expect(after.breakdown.messages).toBeGreaterThan(0);
    expect(before.breakdown.messages).toBe(rawBefore);
  });

  it("§2.10 closed: hitRate is NULL (not 0) when the provider never reported a cached tier — the SUM over all-NULL rows is NULL", async () => {
    const { sessionId, agentId } = await fixtureSession("test/r83-a4");
    const now = new Date().toISOString();
    // Two rows, NO cached tier reported (the R83 write path: null).
    recordUsage(db, { agentId, sessionId, provider: "openrouter", model: "test/r83-a4", inputTokens: 30_000, outputTokens: 5_000, cachedInputTokens: null, costUsd: 0.25, ts: now });
    recordUsage(db, { agentId, sessionId, provider: "openrouter", model: "test/r83-a4", inputTokens: 20_000, outputTokens: 7_000, cachedInputTokens: null, costUsd: 0.17, ts: now });
    const body = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    expect(body.cache.inputTokens).toBe(50_000);
    // The DISPLAY total keeps the COALESCE (0 for old consumers)…
    expect(body.cache.cachedInputTokens).toBe(0);
    // …but the RATE is null — "not reported", never a fabricated 0%.
    expect(body.cache.hitRate).toBeNull();
  });

  it("§3.2a closed: the meter counts the SKILLS + TASK-MODES sections a real turn carries (the under-count fix)", async () => {
    const { sessionId } = await fixtureSession("test/r83-a5");
    // Enable a skill in the DB — the meter's SKILLS section appears.
    const skillRow = db
      .prepare("SELECT id FROM skills LIMIT 1")
      .get() as { id: string } | undefined;
    if (skillRow === undefined) {
      db.prepare(
        "INSERT INTO skills (id, name, description, body, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', 1, ?, ?)",
      ).run(`skl_${randomUUID().slice(0, 8)}`, "code-review", "Review code changes carefully.", "Full body.", new Date().toISOString(), new Date().toISOString());
    } else {
      db.prepare("UPDATE skills SET enabled = 1 WHERE id = ?").run(skillRow.id);
    }
    const withSkill = (await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` })).json();
    // The identity slice now includes the SKILLS lines (findMode/skills flow
    // through the SAME resolver the turn uses) — the pre-R83 meter counted
    // NONE of them while labeling a slice "Memory & skills".
    expect(withSkill.breakdown.systemPrompt).toBeGreaterThan(0);
    // And the tool-schema measurement replaced the 350-per-tool constant:
    // the schema tokens are the REAL serialized sizes (distinct per tool).
    expect(withSkill.breakdown.systemTools).toBeGreaterThan(0);
  });
});

// ── prompts.ts section split (the meter's system-prompt slices) ─────────────

describe("buildSystemPromptSections (ROUND-50 R50-c1 refactor — behavior identical)", () => {
  const ctx = {
    projectName: "CtxProject",
    rootPath: "/tmp/ctx",
    toolNames: ["read_file", "write_file", "run_command", "todo_write", "web_fetch", "index_project", "memory_save"],
    maxTurns: 40,
    customRules: "Always write tests first.",
    memoryDigest: "- The build is pnpm-based.",
    indexSummary: {
      projectId: "p",
      totalFiles: 3,
      totalSymbols: 12,
      topFiles: [{ path: "src/a.ts", count: 6 }],
      topSymbols: [],
      indexedAt: new Date().toISOString(),
    } as Parameters<typeof buildProjectSystemPrompt>[0]["indexSummary"],
    permissionMode: "plan" as const,
  };

  it("the four sections are an exact PARTITION of the composed prompt's lines (same tagged builder)", () => {
    const full = buildProjectSystemPrompt(ctx);
    const sections = buildSystemPromptSections(ctx);

    const fullLines = full.split("\n");
    const sectionLines = [
      ...sections.identity.split("\n"),
      ...sections.tools.split("\n"),
      ...sections.memory.split("\n"),
      ...sections.meta.split("\n"),
    ];
    // Multiset equality: every line of the composed prompt lands in exactly
    // one section (order-insensitive — the sections interleave in the real
    // prompt, which is why both views share ONE ordered tagged builder).
    expect([...sectionLines].sort()).toEqual([...fullLines].sort());
  });

  it("each slice carries exactly its own content (identity sans tools/memory/meta; tools = names; memory = digest; meta = rules+index)", () => {
    const sections = buildSystemPromptSections(ctx);
    // Identity: the persona text WITHOUT the tool list / memory / rules.
    expect(sections.identity).toContain("expert software engineer");
    // ROUND-81: the operating-mode section (renamed from "## PERMISSION
    // MODE") rides the identity bucket with the R81 plan narration.
    expect(sections.identity).toContain("## OPERATING MODE");
    expect(sections.identity).toContain("You are in PLAN mode: read-only");
    expect(sections.identity).not.toContain("## TOOL USE");
    expect(sections.identity).not.toContain("Project memory");
    expect(sections.identity).not.toContain("PROJECT RULES");
    // Tools: the tool-names section.
    expect(sections.tools).toContain("## TOOL USE");
    expect(sections.tools).toContain("read_file, write_file, run_command");
    // Memory: the digest section.
    expect(sections.memory).toContain("## Project memory");
    expect(sections.memory).toContain("The build is pnpm-based.");
    // Meta: codebase index + custom rules.
    expect(sections.meta).toContain("## CODEBASE AWARENESS");
    expect(sections.meta).toContain("PROJECT RULES");
    expect(sections.meta).toContain("Always write tests first.");
  });

  it("readCustomRules picks up .acuterules from the project root", () => {
    const rulesDir = join(tempDir, `rules-${randomUUID().slice(0, 8)}`);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, ".acuterules"), "Always write tests first.", "utf8");
    expect(readCustomRules(rulesDir)).toContain("Always write tests first.");
    expect(readCustomRules(tempDir)).toBeUndefined(); // no rules at the bare temp root
  });
});

// ── ROUND-51 (R51-d) → ROUND-70 (R70-c, D2): the efficiency rework, re-pinned ──
// Owner: "It takes up way too many steps… It should work in an optimized
// way." R51-d's smart-verification + fewest-steps posture is now taught
// INSIDE the merged AGENTIC LOOP (R70-c consolidated the four-way overlap:
// agentic-loop + efficiency + task-planning + todo-tracking). These pins
// hold the rework's semantics in their new home + the removal itself.

describe("prompt efficiency rework (ROUND-51 R51-d, consolidated ROUND-70 R70-c)", () => {
  const ctx = {
    projectName: "EffProject",
    rootPath: "/tmp/eff",
    toolNames: [
      "read_file",
      "write_file",
      "edit_file",
      "search_code",
      "list_dir",
      "todo_write",
      "delegate_task",
    ],
    maxTurns: 30,
    maxOuterLoops: 5,
  };

  it("the merged AGENTIC LOOP carries the six phases; the three overlap sections are GONE", () => {
    const full = buildProjectSystemPrompt(ctx);
    // ROUND-99 (R99-G): the six-phase loop — INTAKE opens it (the owner's
    // analyze-the-request-FIRST meta-directive), the R70-c five phases
    // keep their numbers untouched.
    expect(full).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(full).toContain("0. INTAKE");
    for (const phase of ["1. PLAN", "2. EXPLORE", "3. ACT", "4. VERIFY", "5. FINISH"]) {
      expect(full).toContain(phase);
    }
    expect(full.indexOf("0. INTAKE")).toBeLessThan(full.indexOf("1. PLAN"));
    // The retired sections never compose (any ctx — this one is maximal for
    // the old gates: todo_write + delegate present).
    expect(full).not.toContain("## EFFICIENCY");
    expect(full).not.toContain("## TASK PLANNING");
    expect(full).not.toContain("## TODO TRACKING");
    // The efficiency teachings live in EXPLORE/ACT now.
    expect(full).toContain("independent discovery calls BATCHED in parallel");
    expect(full).toContain("Do not re-explore between steps or re-read files already in context");
    expect(full).toContain("the FEWEST steps that genuinely complete the work");
    // The PLAN phase absorbed the todo guidance (todo_write-gated below).
    expect(full).toContain("tasks with 3+ steps get a todo_write list UP FRONT");
    expect(full).toContain("update after EACH sub-task (never batch completions)");
    expect(full).toContain("a snapshot, not a delta");
    // VERIFY absorbed the 3+ file edits adversarial-review affordance.
    expect(full).toContain("for 3+ file edits, consider a delegate_task adversarial review");
    // Rides the identity meter slice, never tools/memory/meta.
    const sections = buildSystemPromptSections(ctx);
    expect(sections.identity).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(sections.identity).not.toContain("## EFFICIENCY");
    expect(sections.tools).not.toContain("EXPLORE");
  });

  it("the PLAN todo lines are todo_write-gated (the old todo-tracking gate, kept)", () => {
    const noTodo = buildProjectSystemPrompt({ ...ctx, toolNames: ctx.toolNames.filter((t) => t !== "todo_write") });
    expect(noTodo).not.toContain("tasks with 3+ steps get a todo_write list UP FRONT");
    expect(noTodo).toContain("1. PLAN");
    const withTodo = buildProjectSystemPrompt(ctx);
    expect(withTodo).toContain("tasks with 3+ steps get a todo_write list UP FRONT");
  });

  it("the mandatory read-back verify is GONE — smart verification replaces it in BOTH the loop and FILE EDITING", () => {
    const full = buildProjectSystemPrompt(ctx);
    // The old mandate (and its example turn) must not appear anywhere.
    expect(full).not.toContain("verify the save");
    expect(full).not.toContain("read_file it back");
    expect(full).not.toContain("(verify save)");
    expect(full).not.toContain("Verify after edit");
    // ACT rule: a successful write IS the confirmation.
    expect(full).toContain("A successful write_file/edit_file response is itself confirmation");
    expect(full).toContain("re-read only when something indicates a problem");
    // R107-a (F8): FILE EDITING rule 6 retired — its risk list merged into
    // rule 1 (the review's "three near-copies of the verify doctrine").
    expect(full).not.toContain("**Smart verification**");
    expect(full).toContain("Re-read only when a tool warns the file changed on disk, an edit fails, or the change is high-stakes (complex edit, critical file)");
  });

  it("the budget line no longer invites step inflation (a cap, not a target — anti-lazy-stop kept, outer loops named)", () => {
    const full = buildProjectSystemPrompt(ctx);
    expect(full).not.toContain("Use it when needed");
    expect(full).not.toContain("budget of up to");
    // The maxTurns injection survives (Round-28 WS-F contract: the model is
    // told its real cap)…
    // R99-G re-pin: the line opens with a capital U after the dash and — the
    // numbers-audit point — now carries "a limit to keep working within,
    // never a target to fill" (the owner's "hard numbers become targets").
    expect(full).toContain("Up to 30 tool round-trips per iteration");
    expect(full).toContain("never a target to fill");
    // …framed as fewest-steps, with the anti-lazy-stop clause intact…
    expect(full).toContain("FEWEST steps that genuinely complete and verify the work, not step count for its own sake");
    expect(full).toContain("so is stopping early on a multi-step task");
    // …and the outer-iteration cap is named honestly (R70-c D2), as a
    // LIMIT — never a target (R99-G's hard-numbers fix; conscious re-pin
    // of the old "keep working within them" phrasing).
    expect(full).toContain("5 outer iterations exist — a limit to keep working within, never a target to fill");
  });

  it("batching is taught everywhere it must be (TOOL USE rule, EXPLORE phase)", () => {
    const full = buildProjectSystemPrompt(ctx);
    // TOOL USE: independent calls batch; dependent calls wait.
    expect(full).toContain("BATCHED into ONE message");
    expect(full).not.toContain("ONE tool per message");
    // EXPLORE is the batched-discovery teaching (the lean 4-turn example was
    // folded into the phases — the old example turns 5–7 never return).
    expect(full).toContain("2. EXPLORE");
    expect(full).not.toContain("turn 5:");
    expect(full).not.toContain("turn 6:");
    expect(full).not.toContain("turn 7:");
  });

  it("regression pins: conversational rule, multi-turn completion, research loop, delegate parallelism all intact", () => {
    const full = buildProjectSystemPrompt(ctx);
    // Round-33: no tools for chat.
    expect(full).toContain("CONVERSATIONAL REQUESTS ARE DIFFERENT (round-33)");
    expect(full).toContain("reply directly and naturally WITHOUT calling any tools");
    // The multi-turn completion directive (no stopping after one call).
    expect(full).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(full).toContain("DO NOT summarize and stop after one tool call");
    // R107-a (F16): the R28-era research special case retired from the
    // loop (the loop's own phases + todo tracking carry the posture);
    // pinned GONE so it cannot silently return.
    expect(full).not.toContain("research → save findings to a file → research the next sub-topic → append → repeat");
    // The parallel delegate_task guidance.
    expect(full).toContain("call delegate_task MULTIPLE TIMES in ONE message to run sub-agents concurrently");
  });
});
