// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The suite runs against the real aiSdkChat adapter with ONLY the AI SDK
// mocked at the module boundary — no network, no keys, full stack otherwise.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { aiSdkChat } from "../src/agents/chat";
import { getOrchestrator, Orchestrator } from "../src/agents/orchestrator";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createSession, getSession, listSubAgents } from "../src/storage/sessions";
import { setOrchestrationSettings } from "../src/storage/settings";
import { createAgent } from "../src/storage/agents";

const TOKEN = "test-token-36";
const KEY = "sk-or-vtest-36a";
const KEY2 = "sk-or-vtest-36b";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-orch-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2,
    }),
  });
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "Sub-agent report: task done.",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
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
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

describe("ROUND-36: sub-agent orchestration (ADR-0022)", () => {
  it("delegateTask creates a child session bound to the parent and returns its report", async () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    const result = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "count the files",
      "researcher",
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Sub-agent report: task done.");
    expect(result.output).toContain(`[subagent session: ${result.sessionId}`);
    // The child is linked + completed.
    const child = getSession(db, result.sessionId!);
    expect(child?.parentSessionId).toBe(parent.id);
    expect(child?.subRole).toBe("researcher");
    expect(child?.status).toBe("completed");
  });

  it("lists children with computed status/progress via GET /sessions/:id/subagents", async () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();
    const first = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "task one",
      "researcher",
    );

    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${parent.id}/subagents`,
    });
    expect(response.statusCode).toBe(200);
    const subagents = response.json().subagents;
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: first.sessionId,
      subRole: "researcher",
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
      report: "Sub-agent report: task done.",
    });
  });

  it("children are EXCLUDED from GET /sessions unless includeChildren=1", async () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();
    await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "hidden child",
      "coder",
    );

    const plain = await authInject({ method: "GET", url: "/api/v1/sessions" });
    expect(plain.json().sessions.map((s: { id: string }) => s.id)).toEqual([parent.id]);

    const withChildren = await authInject({
      method: "GET",
      url: "/api/v1/sessions?includeChildren=1",
    });
    expect(withChildren.json().total).toBe(2);
  });

  it("concurrency limits: maxParallel gates total children; queued children wait then run", async () => {
    setOrchestrationSettings(db, { maxParallel: 1, perKeyLimit: 1 });
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });
    const deps = { db, keyring, chat: aiSdkChat };

    // Slow first child so the second must queue.
    let releaseFirst: (() => void) | undefined;
    generateTextMock.mockReset();
    generateTextMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ text: "first done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
        }),
    );
    generateTextMock.mockResolvedValue({
      text: "later done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const statuses: string[] = [];
    // ROUND-40: emit widened to (unknown) => void so it can carry both
    // subagent-status + subagent-event envelopes. Narrow to status here.
    const emit = (e: unknown) => {
      const ev = e as { type?: string; status?: unknown };
      if (ev.type === "subagent-status" && typeof ev.status === "string") statuses.push(ev.status);
    };
    const firstPromise = orchestrator.delegateTask(deps, parent.id, "slow task", "researcher", emit);
    const secondPromise = orchestrator.delegateTask(deps, parent.id, "queued task", "coder", emit);
    await new Promise((r) => setTimeout(r, 50));
    // First runs; second is queued (semaphore = 1).
    expect(statuses).toContain("running");
    expect(getSession(db, parent.id)).toBeDefined();
    const children = listSubAgents(db, parent.id);
    expect(children).toHaveLength(2);
    expect(children.find((c) => c.title === "queued task")?.status).toBe("queued");

    releaseFirst?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(statuses.filter((s) => s === "completed").length).toBeGreaterThanOrEqual(2);
    expect(listSubAgents(db, parent.id).every((c) => c.status === "completed")).toBe(true);
  });

  it("retryChild resumes a failed child from its event log", async () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();
    const deps = {
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: aiSdkChat,
    };

    // First attempt FAILS.
    generateTextMock.mockReset();
    generateTextMock.mockRejectedValueOnce(new Error("upstream 429"));
    const failed = await orchestrator.delegateTask(deps, parent.id, "will fail once", "researcher");
    expect(failed.ok).toBe(false);
    expect(getSession(db, failed.sessionId!)?.status).toBe("failed");

    // The model then SUCCEEDS — the retry sees prior progress? The failed
    // attempt left a user message (progress) → the retry message tells it to
    // continue; runSingleAgentTurn appends + succeeds.
    generateTextMock.mockResolvedValue({
      text: "resumed and finished",
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    });
    const retried = await orchestrator.retryChild(deps, parent.id, failed.sessionId!);
    expect(retried.ok).toBe(true);
    expect(getSession(db, failed.sessionId!)?.status).toBe("completed");
  });

  it("boot sweep flips stale running sessions to failed (retryable)", () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const stale = createSession(db, { agentId: agent.id, mode: "single" });
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(stale.id);
    const swept = Orchestrator.sweepStaleRunning(db);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getSession(db, stale.id)?.status).toBe("failed");
  });

  it("orchestration settings round-trip with clamping", async () => {
    const initial = await authInject({ method: "GET", url: "/api/v1/settings/orchestration" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ maxParallel: 5, perKeyLimit: 3, subagentModel: null });

    const updated = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { maxParallel: 20, perKeyLimit: 10 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ maxParallel: 20, perKeyLimit: 10, subagentModel: null });

    const invalid = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { maxParallel: 500 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("key pool: slots are listed masked, written, and removed", async () => {
    const list = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/keys" });
    expect(list.statusCode).toBe(200);
    const keys = list.json().keys;
    // The primary + SLOT2 are seeded in this suite's keyring.
    expect(keys.find((k: { slot: number }) => k.slot === 0)?.hasKey).toBe(true);
    expect(keys.find((k: { slot: number }) => k.slot === 2)?.hasKey).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain(KEY);
    expect(JSON.stringify(list.json())).not.toContain(KEY2);

    const added = await authInject({
      method: "PUT",
      url: "/api/v1/providers/openrouter/keys/3",
      payload: { value: "sk-or-vtest-36c" },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().keys.find((k: { slot: number }) => k.slot === 3)?.hasKey).toBe(true);

    const removed = await authInject({ method: "DELETE", url: "/api/v1/providers/openrouter/keys/3" });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().keys.find((k: { slot: number }) => k.slot === 3)?.hasKey).toBe(false);

    const primaryRefused = await authInject({ method: "DELETE", url: "/api/v1/providers/openrouter/keys/0" });
    expect(primaryRefused.statusCode).toBe(409);
  });
});
