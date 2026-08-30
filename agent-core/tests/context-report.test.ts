/**
 * ROUND-50 (R50-c1): the context donut's data source —
 * GET /api/v1/sessions/:id/context — plus the prompts.ts section split that
 * feeds its system-prompt slices.
 *
 * The route's job is honest ESTIMATION:
 *   - contextWindow: the models-table override for (providerId, model) →
 *     the catalog default → 200 000 (runtime.ts getModelContextWindow).
 *   - breakdown: systemPrompt (identity section), systemTools (tools section
 *     + 350 tokens/tool schema approximation), memory (digest section),
 *     messages (assembleHistory with attachments rendered), meta (index +
 *     custom-rules sections), mcpTools (honest 0 — no MCP system).
 *   - usedTokens = the SUM of all slices.
 *   - cache/sessionTotals: exact SQL SUMs over usage_events (requests =
 *     COUNT(*), cachedInputTokens null-safe, hitRate = cached/input with
 *     null before the first input token).
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

    // Exact SQL sums over the session's rows.
    expect(body.sessionTotals).toEqual({
      inputTokens: 50_000,
      outputTokens: 12_000,
      requests: 2,
      costUsd: 0.42,
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
    expect(body.sessionTotals).toEqual({ inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 });
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
    });
    expect(body.usage.main).toEqual({
      inputTokens: 50_000,
      outputTokens: 12_000,
      requests: 2,
      costUsd: 0.42,
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
    expect(sections.identity).toContain("## PERMISSION MODE");
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

// ── ROUND-51 (R51-d): the main-agent efficiency prompt rework ───────────────
// Owner: "It takes up way too many steps… It should work in an optimized
// way." These pins guard the surgical prompts.ts rework: the mandatory
// read-back verify is gone (smart verification), the budget line stops
// inviting step inflation, batching is taught, and every preserved directive
// (round-33 conversational, multi-turn completion, research loop, delegate
// parallelism) stays byte-present.

describe("prompt efficiency rework (ROUND-51 R51-d)", () => {
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
  };

  it("the EFFICIENCY section exists between AGENTIC LOOP and FILE EDITING RULES, with all four teachings", () => {
    const full = buildProjectSystemPrompt(ctx);
    expect(full).toContain("## EFFICIENCY — FEWEST STEPS THAT FULLY SOLVE THE TASK");
    // Placement: right after the AGENTIC LOOP example, before FILE EDITING RULES.
    const effIdx = full.indexOf("## EFFICIENCY");
    expect(effIdx).toBeGreaterThan(full.indexOf("## AGENTIC LOOP"));
    expect(effIdx).toBeLessThan(full.indexOf("## FILE EDITING RULES"));
    // The four teachings.
    expect(full).toContain("UNDERSTAND FIRST");
    expect(full).toContain("MULTIPLE independent tool calls in the SAME message");
    expect(full).toContain("PLAN ONCE");
    expect(full).toContain("FEWEST STEPS: more steps ≠ more thorough");
    expect(full).toContain("CONCISE REASONING");
    // Included when tools are present — and it rides the identity meter slice
    // (the context donut's systemPrompt bucket), never tools/memory/meta.
    const sections = buildSystemPromptSections(ctx);
    expect(sections.identity).toContain("## EFFICIENCY — FEWEST STEPS THAT FULLY SOLVE THE TASK");
    expect(sections.tools).not.toContain("EFFICIENCY");
  });

  it("the mandatory read-back verify is GONE — smart verification replaces it in BOTH the loop rules and FILE EDITING rule 6", () => {
    const full = buildProjectSystemPrompt(ctx);
    // The old mandate (and its example turn) must not appear anywhere.
    expect(full).not.toContain("verify the save");
    expect(full).not.toContain("read_file it back");
    expect(full).not.toContain("(verify save)");
    expect(full).not.toContain("Verify after edit");
    // AGENTIC LOOP rule: a successful write IS the confirmation.
    expect(full).toContain("A successful write_file/edit_file response is itself confirmation");
    expect(full).toContain("do NOT re-read a file you just wrote unless something indicates a problem");
    // FILE EDITING RULES rule 6 carries the same semantics.
    expect(full).toContain("**Smart verification**");
    expect(full).toContain("only when risk exists — complex edits, high-stakes files, or surprising results");
  });

  it("the budget line no longer invites step inflation (a cap, not a target — anti-lazy-stop kept)", () => {
    const full = buildProjectSystemPrompt(ctx);
    expect(full).not.toContain("Use it when needed");
    expect(full).not.toContain("budget of up to");
    // The maxTurns injection survives (Round-28 WS-F contract: the model is
    // told its real cap)…
    expect(full).toContain("up to 30 round-trips are available");
    // …framed as fewest-steps, with the anti-lazy-stop FAILURE clause intact.
    expect(full).toContain("FEWEST steps that genuinely complete and verify the work, not step count for its own sake");
    expect(full).toContain("Stopping early on a multi-step task is a FAILURE");
  });

  it("batching is taught everywhere it must be (TOOL USE rule, lean 4-turn example, TASK PLANNING)", () => {
    const full = buildProjectSystemPrompt(ctx);
    // TOOL USE: independent calls batch; dependent calls wait.
    expect(full).toContain("BATCHED into ONE message");
    expect(full).not.toContain("ONE tool per message");
    // The workflow example is the lean 4-turn batched shape (no serial turns
    // 5–7, no verify-read-back turn).
    expect(full).toContain("turn 1 (batched discovery)");
    expect(full).not.toContain("turn 5:");
    expect(full).not.toContain("turn 6:");
    expect(full).not.toContain("turn 7:");
    // TASK PLANNING's batching line.
    expect(full).toContain(
      "Batch your initial reads: understanding the request fully first is ONE message with parallel tool calls, not a long serial exploration",
    );
  });

  it("regression pins: conversational rule, multi-turn completion, research loop, delegate parallelism all intact", () => {
    const full = buildProjectSystemPrompt(ctx);
    // Round-33: no tools for chat.
    expect(full).toContain("CONVERSATIONAL REQUESTS ARE DIFFERENT (round-33)");
    expect(full).toContain("reply directly and naturally WITHOUT calling any tools");
    // The multi-turn completion directive (no stopping after one call).
    expect(full).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(full).toContain("DO NOT summarize and stop after one tool call");
    // The research → save-files loop.
    expect(full).toContain("research → save findings to a file → research the next sub-topic → append → repeat");
    // The parallel delegate_task guidance.
    expect(full).toContain("call delegate_task MULTIPLE TIMES in ONE message to run sub-agents concurrently");
  });
});
