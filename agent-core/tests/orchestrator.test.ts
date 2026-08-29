// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The suite runs against the real aiSdkChat adapter with ONLY the AI SDK
// mocked at the module boundary — no network, no keys, full stack otherwise.
// ROUND-48 (R48-e1): jsonSchema is also mocked — the delegate_task tool-wiring
// + prompt-honesty tests build the REAL project toolset (buildProjectTools),
// whose input schemas wrap through it.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { aiSdkChat } from "../src/agents/chat";
import type { ChatFn } from "../src/agents/chat";
import { getOrchestrator, Orchestrator } from "../src/agents/orchestrator";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createSession, getSession, listSessionEvents, listSubAgents, subAgentCode } from "../src/storage/sessions";
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

  it("ROUND-49: memory settings round-trip via /settings/memory (the master switch)", async () => {
    const initial = await authInject({ method: "GET", url: "/api/v1/settings/memory" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ enabled: true });

    const off = await authInject({
      method: "PUT",
      url: "/api/v1/settings/memory",
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ enabled: false });

    // Persists across a GET.
    const reread = await authInject({ method: "GET", url: "/api/v1/settings/memory" });
    expect(reread.json()).toEqual({ enabled: false });

    // Invalid payload → 400 with the field named.
    const invalid = await authInject({
      method: "PUT",
      url: "/api/v1/settings/memory",
      payload: { enabled: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json())).toContain("body.enabled");

    // Restore ON (other tests in this file rely on defaults).
    const on = await authInject({
      method: "PUT",
      url: "/api/v1/settings/memory",
      payload: { enabled: true },
    });
    expect(on.json()).toEqual({ enabled: true });

    // ROUND-49 (live-browser find): the CORS allow-methods list must include
    // PUT — it was missing, so every cross-origin PUT (this toggle, key-pool
    // slots, viewport) died at preflight with "Failed to fetch" while
    // GET/POST/PATCH worked. Pin the preflight contract for the browser
    // origins the UI actually uses.
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/settings/memory",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(String(preflight.headers["access-control-allow-methods"])).toContain("PUT");
    expect(String(preflight.headers["access-control-allow-origin"])).toBe("http://localhost:5173");
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

describe("ROUND-48 (R48-e1): sub-agent codes, signal forwarding, honest aborts", () => {
  function makeParent(): { agentId: string; parentSessionId: string } {
    const agent = createAgent(db, {
      name: "R48 Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    return { agentId: agent.id, parentSessionId: parent.id };
  }

  it("subAgentCode is deterministic, exactly 4 chars [A-Z0-9], and distinguishes ids", () => {
    const id = "sess_0b8af6e6-6e88-4c96-b7d3-8c9dbb1a5db1";
    const code = subAgentCode(id);
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(subAgentCode(id)).toBe(code); // pure — same id, same code, forever
    const other = subAgentCode("sess_1c8af6e6-6e88-4c96-b7d3-8c9dbb1a5db2");
    expect(other).toMatch(/^[A-Z0-9]{4}$/);
    expect(other).not.toBe(code); // different ids → different codes
  });

  it("every subagent-status envelope carries the child's code — same value as the /subagents row", async () => {
    const { parentSessionId } = makeParent();
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parentSessionId,
      "code check",
      "researcher",
      emit,
    );
    expect(result.ok).toBe(true);
    const childId = result.sessionId!;

    const statuses = envelopes.filter((e) => e.type === "subagent-status");
    // queued → running → completed (at least).
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    for (const s of statuses) {
      expect(s).toMatchObject({
        type: "subagent-status",
        sessionId: childId,
        parentSessionId,
        role: "researcher",
        task: "code check",
        code: subAgentCode(childId),
      });
      expect(s.code).toMatch(/^[A-Z0-9]{4}$/);
    }

    // The polled list row carries the SAME code (the UI join key).
    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${parentSessionId}/subagents`,
    });
    expect(response.statusCode).toBe(200);
    const subagents = response.json().subagents;
    expect(subagents).toHaveLength(1);
    expect(subagents[0].code).toBe(subAgentCode(childId));
    expect(subagents[0].code).toMatch(/^[A-Z0-9]{4}$/);
  });

  it("delegateTask forwards an ALREADY-aborted signal — the child never calls the provider (ABORTED outcome)", async () => {
    const { parentSessionId } = makeParent();
    const models: string[] = [];
    const chat: ChatFn = async (input) => {
      models.push(input.model);
      return { text: "should never run", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    const controller = new AbortController();
    controller.abort();

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parentSessionId,
      "never runs",
      "researcher",
      undefined,
      controller.signal,
    );

    // The child stopped BETWEEN iterations (i.e., before iteration 0's call).
    expect(result.ok).toBe(false);
    expect(result.output).toContain("aborted");
    expect(models).toEqual([]); // no provider call at all
    expect(getSession(db, result.sessionId!)?.status).toBe("failed");
    // Honest log: the task message landed, and a STOP is not an error —
    // no turn.error event (mirrors the streamed path's R42/R43 rule).
    expect(listSessionEvents(db, result.sessionId!).map((e) => e.type)).toEqual(["message.user"]);
  });

  it("aborting BETWEEN iterations stops the child honestly — partial work persists, no turn.error", async () => {
    const { parentSessionId } = makeParent();
    const controller = new AbortController();
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      if (calls === 1) {
        // The owner stops the parent DURING the first iteration's provider
        // call — the iteration completes (its work is real), then the loop's
        // between-iterations check must stop the child.
        controller.abort();
        return {
          text: "working on it",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: [{ name: "read_file", argsSummary: "path: notes.md", ok: true, outputSummary: "42 chars" }],
        };
      }
      return { text: "unreachable", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parentSessionId,
      "multi-step task",
      "researcher",
      undefined,
      controller.signal,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("aborted");
    expect(calls).toBe(1); // the SECOND iteration never started
    const types = listSessionEvents(db, result.sessionId!).map((e) => e.type);
    expect(types).toContain("tool.use"); // iteration 1's work persisted
    expect(types).toContain("message.assistant");
    expect(types).not.toContain("turn.error"); // a stop is not an error
    expect(getSession(db, result.sessionId!)?.status).toBe("failed");
  });

  it("the delegate_task TOOL forwards toolDeps.signal into the child turn (call-site wiring)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const controller = new AbortController();
    controller.abort();
    const models: string[] = [];
    const chat: ChatFn = async (input) => {
      models.push(input.model);
      return { text: "never", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };

    const { buildProjectTools } = await import("../src/tools/index");
    const tools = (await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: parentSessionId,
      agentId,
      seq: 1,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat,
      signal: controller.signal,
    })) as unknown as Record<
      string,
      { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }
    >;
    expect(tools.delegate_task).toBeDefined();

    // With the signal already aborted, the spawned child must stop before its
    // first provider call — proof the tool passed toolDeps.signal through.
    const res = await tools.delegate_task.execute({ task: "signal forwarding check" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("aborted");
    expect(models).toEqual([]);
  });

  it("LIVE per-step events (stretch): a chat adapter reporting onStepFinish streams tool/text frames DURING the call — no duplicate post-call batch", async () => {
    const { parentSessionId } = makeParent();
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);

    // Simulates ONE generateText call with TWO internal steps (the AI SDK's
    // multi-step tool loop): step 1 runs a tool + writes text, step 2 writes
    // the final text. The adapter reports each step through onStepFinish
    // exactly like the real generateText hook.
    const chat: ChatFn = async (input) => {
      input.onStepFinish?.({
        text: "reading the file ",
        toolCalls: [{ name: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" }],
      });
      input.onStepFinish?.({ text: "Done. Final report.", toolCalls: [] });
      return {
        text: "reading the file Done. Final report.", // SDK semantics: steps concatenate
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [{ name: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" }],
      };
    };

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parentSessionId,
      "live steps check",
      "researcher",
      emit,
    );
    expect(result.ok).toBe(true);

    // The child's inner frames, in order: the tool call + result + the step's
    // text arrive LIVE (per step), then the final step's text, then ONE
    // finish marker. The post-call batch (ROUND-40) must NOT re-emit them.
    const innerEvents = envelopes
      .filter((e) => e.type === "subagent-event")
      .map((e) => e.inner as Record<string, unknown>);
    expect(innerEvents.map((e) => e.type)).toEqual([
      "tool-call",
      "tool-result",
      "text-delta",
      "text-delta",
      "finish",
    ]);
    expect(innerEvents[0]).toMatchObject({ toolName: "read_file", argsSummary: "path: a.md" });
    expect(innerEvents[1]).toMatchObject({ toolName: "read_file", ok: true, outputSummary: "10 chars" });
    expect(innerEvents[2]).toMatchObject({ text: "reading the file " });
    expect(innerEvents[3]).toMatchObject({ text: "Done. Final report." });

    // Persistence stays POST-CALL and unchanged (ADR-0010 ordering): the
    // audit trail is the same as the batch path.
    expect(listSessionEvents(db, result.sessionId!).map((e) => e.type)).toEqual([
      "message.user",
      "tool.use",
      "message.assistant",
    ]);
  });

  it("aiSdkChat passes onStepFinish through to generateText and normalizes the SDK step (adapter half of the stretch)", async () => {
    const snapshots: Array<{ text: string; toolCalls: unknown[] }> = [];
    const promise = aiSdkChat({
      provider: { id: "openrouter", baseUrl: "https://example.test" },
      apiKey: "sk-test",
      model: "test/model-1",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.1,
      maxTurns: 4,
      onStepFinish: (step) => snapshots.push(step),
    });
    // The mocked generateText received the passthrough — invoke it exactly
    // like the real SDK would (once per finished step).
    const options = generateTextMock.mock.calls[0][0] as {
      onStepFinish?: (step: unknown) => void;
    };
    expect(typeof options.onStepFinish).toBe("function");
    options.onStepFinish?.({
      text: "step text",
      toolResults: [
        { toolName: "read_file", input: { path: "a.md" }, output: { ok: true, output: "10 chars" } },
      ],
    });
    await promise;
    // Normalized through the SAME extractToolCalls conversion the post-call
    // audit list uses — live frames and persisted frames agree.
    expect(snapshots).toEqual([
      {
        text: "step text",
        toolCalls: [{ name: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" }],
      },
    ]);
  });

  it("ROUND-49: children KEEP the SUB-AGENTS section below the depth cap (nested delegation); at the cap it is omitted", async () => {
    const { buildProjectSystemPrompt } = await import("../src/agents/prompts");
    const base = { projectName: "P", rootPath: "/tmp/p", toolNames: ["read_file", "write_file", "run_command"] };
    expect(buildProjectSystemPrompt(base)).not.toContain("SUB-AGENTS (delegate_task)");
    expect(
      buildProjectSystemPrompt({ ...base, toolNames: [...base.toolNames, "delegate_task"] }),
    ).toContain("SUB-AGENTS (delegate_task)");

    // Integration: the ACTUAL child turn prompt (prepareTurn builds it from
    // the child's real toolset). ROUND-49: a depth-1 child of a main session
    // runs with the FULL tool set INCLUDING delegate_task (the owner's
    // "exactly like the main agent — only the context and keys differ");
    // only sessions at/beyond MAX_DELEGATION_DEPTH lose it (recursion guard).
    const project = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "R49 Prompt", rootPath: tempDir },
    });
    const projectId = project.json().id as string;
    const agent = createAgent(db, {
      name: "R49 Prompt Agent",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single", projectId });
    const systems: string[] = [];
    const chat: ChatFn = async (input) => {
      systems.push(input.system);
      return { text: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    // Depth-1 child: delegate_task PRESENT (nested delegation).
    const result = await new Orchestrator().delegateTask(
      { db, keyring, chat },
      parent.id,
      "prompt honesty check (depth 1)",
      "researcher",
    );
    expect(result.ok).toBe(true);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("SUB-AGENTS (delegate_task)");
    expect(systems[0]).toContain("write_file"); // full project toolset
    const childId = result.sessionId as string;

    // Depth-2 grandchild: still below MAX_DELEGATION_DEPTH (3) → keeps it too.
    systems.length = 0;
    const deep = await new Orchestrator().delegateTask(
      { db, keyring, chat },
      childId,
      "prompt honesty check (depth 2)",
      "coder",
    );
    expect(deep.ok).toBe(true);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("SUB-AGENTS (delegate_task)");
    const grandchildId = deep.sessionId as string;

    // Depth-3 great-grandchild: AT the cap (MAX_DELEGATION_DEPTH = 3 → a
    // session at depth 3 can no longer delegate) → delegate_task STRIPPED
    // (the recursion guard) while the project tools remain fully intact.
    systems.length = 0;
    const capped = await new Orchestrator().delegateTask(
      { db, keyring, chat },
      grandchildId,
      "prompt honesty check (depth 3 — capped)",
      "coder",
    );
    expect(capped.ok).toBe(true);
    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain("SUB-AGENTS (delegate_task)");
    expect(systems[0]).not.toContain("delegate_task"); // not in the tool list either
    expect(systems[0]).toContain("write_file"); // project tools intact
    expect(systems[0]).toContain("You have access to these tools");
  });
});
