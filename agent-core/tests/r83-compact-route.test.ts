/**
 * ROUND-83 (R83): POST /sessions/:id/compact — the compaction affordance
 * the pre-R83 800K guard PROMISED ("run /compact") while no such command
 * existed anywhere (the audit's honesty violation §2.6). The route runs the
 * SAME assembleWithCompaction machinery the turn loop runs, with force: the
 * over-budget head is summarized into a dense briefing, the context.compact
 * event is PERSISTED (fork/revert inherit it, ADR-0010), and the next turn +
 * the context meter read it. The summarizer's own spend is metered (origin
 * 'compaction' — §2.12, the hidden-call audit).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import type { ChatFn } from "../src/agents/chat";
import { findLatestCompaction } from "../src/agents/compaction";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r83-compact";
const KEY = "sk-or-v1-r83-compact-test-key";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

/** The fake summarizer — a fixed dense briefing (what the real one writes). */
const fakeChat: ChatFn = async () => ({
  text: "The user asked to ship a feature. The agent created two files and fixed one bug.",
  usage: { inputTokens: 4_000, outputTokens: 200, totalTokens: 4_200 },
  toolCalls: [],
});

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r83-compact-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    chat: fakeChat,
  });
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

async function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } })) as LightMyRequestResponse;
}

/** A project session with agent + a long-ish conversation. */
function fixtureSession(
  model: string,
  messages: number,
): { sessionId: string; agentId: string } {
  const projectRoot = join(tempDir, `proj-${randomUUID().slice(0, 8)}`);
  mkdirSync(projectRoot, { recursive: true });
  const project = createProject(db, { name: "Compact", rootPath: projectRoot });
  const agent = createAgent(db, { name: "Compact Agent", providerId: "openrouter", model });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  for (let i = 0; i < messages; i += 1) {
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: `message ${i} — ${"context ".repeat(200)}` },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: `reply ${i} — ${"work ".repeat(200)}` },
    });
  }
  return { sessionId: session.id, agentId: agent.id };
}

describe("POST /api/v1/sessions/:id/compact (ROUND-83 R83)", () => {
  it("404s on an unknown session; auth required", async () => {
    const missing = await inject({ method: "POST", url: "/api/v1/sessions/sess_none/compact" });
    expect(missing.statusCode).toBe(404);
    const unauth = await app.inject({ method: "POST", url: "/api/v1/sessions/sess_none/compact" });
    expect(unauth.statusCode).toBe(401);
  });

  it("409s honestly: no agent → unconfigured model", async () => {
    // No agent bound.
    const agentRow = createAgent(db, { name: "Orphan Holder", providerId: "openrouter", model: "test/r83-c" });
    const noAgent = createSession(db, { agentId: agentRow.id, mode: "single" });
    db.prepare("UPDATE sessions SET agent_id = NULL WHERE id = ?").run(noAgent.id);
    const r1 = await inject({ method: "POST", url: `/api/v1/sessions/${noAgent.id}/compact` });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("CONFLICT");

    // Unconfigured model.
    const bare = createAgent(db, { name: "Bare", providerId: null, model: null });
    const bareSession = createSession(db, { agentId: bare.id, mode: "single" });
    const r2 = await inject({ method: "POST", url: `/api/v1/sessions/${bareSession.id}/compact` });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.message).toContain("no providerId/model");
  });

  it("a SINGLE-message session declines honestly: { compacted: false, reason } — nothing to summarize", async () => {
    upsertModel(db, "openrouter", { modelId: "test/r83-c", displayName: "R83 Compact", contextWindow: 200_000 });
    // ONE user message: planCompaction always keeps the final message, so
    // an empty to-summarize set declines even under force (the R71-e2
    // contract — a single message has nothing to compact).
    const projectRoot = join(tempDir, `proj-${randomUUID().slice(0, 8)}`);
    mkdirSync(projectRoot, { recursive: true });
    const project = createProject(db, { name: "Single", rootPath: projectRoot });
    const agent = createAgent(db, { name: "Single Agent", providerId: "openrouter", model: "test/r83-c" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "just one question" },
    });
    const response = await inject({ method: "POST", url: `/api/v1/sessions/${session.id}/compact` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.compacted).toBe(false);
    expect(String(body.reason)).toContain("nothing to compact");
    // Nothing was appended — the event log is untouched (no fake compaction).
    const events = listSessionEvents(db, session.id);
    expect(events.some((ev) => ev.type === "context.compact")).toBe(false);
  });

  it("an OVER-BUDGET session compacts: 200 { compacted: true, detail } + the persisted context.compact event + the summarizer's usage row (origin 'compaction')", async () => {
    // A small-but-SANE window (available must be positive: window − output −
    // margin): 12 000 − 1 000 − 8 000 = 3 000 available, and the fixture's
    // 24 messages ≈ 6k tokens — well over the line.
    upsertModel(db, "openrouter", { modelId: "test/r83-c2", displayName: "R83 Compact 2", contextWindow: 12_000, maxOutputTokens: 1_000 });
    const { sessionId } = fixtureSession("test/r83-c2", 12);
    const response = await inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.compacted).toBe(true);
    expect(body.throughSeq).toBeGreaterThan(0);
    expect(body.droppedMessages).toBeGreaterThan(0);

    // The event is on the log (the next turn + the meter read it).
    const events = listSessionEvents(db, sessionId);
    const compact = findLatestCompaction(events);
    expect(compact).not.toBeNull();
    expect(compact?.summary).toContain("ship a feature");

    // §2.12 closed: the summarizer's spend is a REAL usage row (origin
    // 'compaction', agentId NULL) — the hidden call is visible spend now.
    const usageRow = db
      .prepare("SELECT input_tokens, output_tokens, origin, agent_id FROM usage_events WHERE session_id = ?")
      .get(sessionId) as { input_tokens: number; output_tokens: number; origin: string; agent_id: string | null };
    expect(usageRow).toBeDefined();
    expect(usageRow.input_tokens).toBe(4_000);
    expect(usageRow.origin).toBe("compaction");
    expect(usageRow.agent_id).toBeNull();
  });

  it("a summarizer FAILURE degrades to the hard trim — the route still answers honestly, never a 500", async () => {
    upsertModel(db, "openrouter", { modelId: "test/r83-c3", displayName: "R83 Compact 3", contextWindow: 20_000 });
    // A chat that throws — assembleWithCompaction's catch → empty summary →
    // the legacy hard-trim fallback (compacted: false, no event).
    const throwingApp = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: async () => {
        throw new Error("summarizer down");
      },
    });
    try {
      const { sessionId } = fixtureSession("test/r83-c3", 12);
      const response = await throwingApp.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/compact`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.compacted).toBe(false);
      expect(String(body.reason)).toContain("nothing to compact");
    } finally {
      await throwingApp.close();
    }
  });
});
