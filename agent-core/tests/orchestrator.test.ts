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
import type { ChatFn, StreamChatFn, StreamChatInput } from "../src/agents/chat";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { getOrchestrator, Orchestrator } from "../src/agents/orchestrator";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createSession, getSession, listSessionEvents, listSubAgents, subAgentCode } from "../src/storage/sessions";
import { setOrchestrationSettings } from "../src/storage/settings";
import { createAgent } from "../src/storage/agents";
import { SUBAGENT_DEFAULT_MODEL_ID } from "../src/storage/models";

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

  // ROUND-64 (R64-e, owner: per-API-key usage stats): the child's usage row
  // lands on the POOL SLOT the orchestrator reserved for it — observable in
  // usage_events.key_slot (migration 0024), which is exactly what the
  // /usage screen's per-key cards group by.
  // ROUND-92 (R92-D, re-pin): the ROUND-36 "children prefer non-primary
  // slots so the primary isn't burdened" bias is GONE — one pool serves
  // everyone (main agent included), so a lone child starts on the PRIMARY
  // (least-loaded, lowest slot). The load-spreading is still observable
  // when perKeyLimit forces a second concurrent child onto the next slot.
  it("ROUND-64: a pooled child's usage row records the reserved slot; a pool-less child records slot 0", async () => {
    const agent = createAgent(db, {
      name: "Orchestrator",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    // A lone pooled child: both slots idle → the primary (slot 0) — the
    // pre-R92 code would have picked slot 2 here (the removed bias).
    const pooled = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY, ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2 }), chat: aiSdkChat },
      parent.id,
      "pooled task",
      "researcher",
    );
    expect(pooled.ok).toBe(true);
    const pooledSlot = pooled.sessionId === undefined
      ? undefined
      : (
          db
            .prepare("SELECT key_slot FROM usage_events WHERE session_id = ?")
            .get(pooled.sessionId) as { key_slot: number } | undefined
        )?.key_slot;
    expect(pooledSlot).toBe(0); // R92-D: the primary — no non-primary bias

    // No pool → the child shares the primary under the per-key limit.
    const poolless = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "pool-less task",
      "researcher",
    );
    expect(poolless.ok).toBe(true);
    const poollessSlot = poolless.sessionId === undefined
      ? undefined
      : (
          db
            .prepare("SELECT key_slot FROM usage_events WHERE session_id = ?")
            .get(poolless.sessionId) as { key_slot: number } | undefined
        )?.key_slot;
    expect(poollessSlot).toBe(0); // honest: the primary key

    // Load-spreading STILL works: with perKeyLimit=1 a second CONCURRENT
    // child cannot take slot 0 → it reserves slot 2. (The reservations are
    // synchronous at call time, so the two un-awaited calls order
    // deterministically: child A → slot 0, child B → slot 2.)
    setOrchestrationSettings(db, { perKeyLimit: 1 });
    const spreadParent = createSession(db, { agentId: agent.id, mode: "single" });
    const pool = { ACUTE_PROVIDER_OPENROUTER: KEY, ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY2 };
    const childA = orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring(pool), chat: aiSdkChat },
      spreadParent.id,
      "spread task A",
      "researcher",
    );
    const childB = orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring(pool), chat: aiSdkChat },
      spreadParent.id,
      "spread task B",
      "researcher",
    );
    const [a, b] = await Promise.all([childA, childB]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const slotOf = (sessionId: string | undefined): number | undefined =>
      sessionId === undefined
        ? undefined
        : (
            db
              .prepare("SELECT key_slot FROM usage_events WHERE session_id = ?")
              .get(sessionId) as { key_slot: number } | undefined
          )?.key_slot;
    expect(slotOf(a.sessionId)).toBe(0);
    expect(slotOf(b.sessionId)).toBe(2);
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
    // ROUND-75 (R75): swept sessions stay RETRYABLE (queued — the R43
    // persistTurnError resting state) instead of terminal `failed`, and the
    // sweep writes the honest INTERRUPTION event into the timeline.
    expect(getSession(db, stale.id)?.status).toBe("queued");
    const events = listSessionEvents(db, stale.id);
    const error = events.find((e) => e.type === "turn.error");
    expect(error).toBeDefined();
    expect((error!.payload as Record<string, unknown>).code).toBe("INTERRUPTED");
  });

  it("orchestration settings round-trip with clamping", async () => {
    const initial = await authInject({ method: "GET", url: "/api/v1/settings/orchestration" });
    expect(initial.statusCode).toBe(200);
    // ROUND-52 (R52-b): the supervisor settings joined the payload.
    expect(initial.json()).toEqual({
      maxParallel: 5,
      perKeyLimit: 3,
      subagentModel: null,
      childWatchdogMs: 15_000,
      childStallTimeoutMs: 300_000,
    });

    const updated = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { maxParallel: 20, perKeyLimit: 10 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      maxParallel: 20,
      perKeyLimit: 10,
      subagentModel: null,
      childWatchdogMs: 15_000,
      childStallTimeoutMs: 300_000,
    });

    const invalid = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { maxParallel: 500 },
    });
    expect(invalid.statusCode).toBe(400);

    // ROUND-52 (R52-b): the supervisor knobs round-trip + validate.
    const watch = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { childWatchdogMs: 30_000, childStallTimeoutMs: 600_000 },
    });
    expect(watch.statusCode).toBe(200);
    expect(watch.json()).toEqual({
      maxParallel: 20,
      perKeyLimit: 10,
      subagentModel: null,
      childWatchdogMs: 30_000,
      childStallTimeoutMs: 600_000,
    });
    const badWatch = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { childWatchdogMs: 1_000 },
    });
    expect(badWatch.statusCode).toBe(400);
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

  it("ROUND-65: debug settings round-trip via /settings/debug (default off, the self-report switch)", async () => {
    // Default OFF — prompts stay byte-identical for every existing session.
    const initial = await authInject({ method: "GET", url: "/api/v1/settings/debug" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ enabled: false });

    const on = await authInject({
      method: "PUT",
      url: "/api/v1/settings/debug",
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true });

    // Persists across a GET.
    const reread = await authInject({ method: "GET", url: "/api/v1/settings/debug" });
    expect(reread.json()).toEqual({ enabled: true });

    // Invalid payload -> 400 with the field named.
    const invalid = await authInject({
      method: "PUT",
      url: "/api/v1/settings/debug",
      payload: { enabled: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json())).toContain("body.enabled");

    // A non-object JSON body (array) is rejected before touching the store.
    const invalidBody = await authInject({
      method: "PUT",
      url: "/api/v1/settings/debug",
      payload: [] as unknown as Record<string, unknown>,
    });
    expect(invalidBody.statusCode).toBe(400);

    // Restore OFF (the honest default other suites rely on).
    const off = await authInject({
      method: "PUT",
      url: "/api/v1/settings/debug",
      payload: { enabled: false },
    });
    expect(off.json()).toEqual({ enabled: false });
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

  // ROUND-58 (R58-d): the key-reveal route — the owner explicitly asked for
  // visible keys, consciously reversing the R47 no-keys-in-responses
  // invariant for this single authenticated route (keys are still never
  // logged). Sibling semantics: 404 for an unknown provider, bearer wall.
  describe("POST /providers/:id/keys/reveal (ROUND-58 R58-d)", () => {
    it("returns the FULL value of every configured slot (primary + pool)", async () => {
      // Slot 3 was added + removed by the test above; the fresh beforeEach
      // keyring holds the primary + SLOT2. Ask for a reveal.
      const res = await authInject({ method: "POST", url: "/api/v1/providers/openrouter/keys/reveal" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        keys: [
          { slot: 0, value: KEY },
          { slot: 2, value: KEY2 },
        ],
      });
    });

    it("includes slots written through the pool routes (PUT /keys/:slot)", async () => {
      await authInject({
        method: "PUT",
        url: "/api/v1/providers/openrouter/keys/5",
        payload: { value: "sk-or-vtest-36c" },
      });
      const res = await authInject({ method: "POST", url: "/api/v1/providers/openrouter/keys/reveal" });
      expect(res.statusCode).toBe(200);
      const slots = (res.json().keys as Array<{ slot: number; value: string }>).map((k) => k.slot);
      expect(slots).toContain(5);
      expect(
        (res.json().keys as Array<{ slot: number; value: string }>).find((k) => k.slot === 5)?.value,
      ).toBe("sk-or-vtest-36c");
    });

    it("404s for an unknown provider (same envelope as the sibling routes)", async () => {
      const res = await authInject({ method: "POST", url: "/api/v1/providers/nope/keys/reveal" });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).toContain("no provider with id nope");
    });

    it("is behind the bearer wall like every other route", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/providers/openrouter/keys/reveal" });
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.json())).toContain("bearer token");
    });
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
    // R107-b (F4) contract update: an already-aborted parent signal is now
    // caught at acquireSlot's ENTRY check — the child never reserves a slot,
    // never registers a turn, never calls the provider. The honest line says
    // "stopped before it started" (the pre-R107 path ran the child turn and
    // reported a runner-level "aborted" — same essence, this is the cheaper,
    // more honest shape).
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stopped before it started");
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
    // first provider call — proof the tool passed toolDeps.signal through
    // (R107-b F4: the acquireSlot entry check catches it — no slot, no turn,
    // no call).
    const res = await tools.delegate_task.execute({ task: "signal forwarding check" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("stopped before it started");
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
    // ROUND-96 (R96-B): the RAW args ride the normalized call too (the
    // loop-guard's exact-identity feed — display argsSummary, identity args).
    expect(snapshots).toEqual([
      {
        text: "step text",
        toolCalls: [
          { name: "read_file", args: { path: "a.md" }, argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" },
        ],
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

// ─── ROUND-50 (R50-b): children run the STREAMED path + model on status
// frames + the /subagents row's model — the owner's "streamed live just like
// the main agent" + stats-footer directives. ─────────────────────────────────

describe("ROUND-50 (R50-b): streamed sub-agent delegation", () => {
  /** A streamed child adapter: one outer iteration with raw thinking, text
   * deltas AROUND a tool call, and a usage-carrying finish — exactly the
   * frame sequence streamAiSdkChat produces. */
  const streamedChild: StreamChatFn = async function* () {
    yield { type: "thinking-delta", delta: "Reading the target files first." };
    yield { type: "text-delta", delta: "Fixing the auth module." };
    yield { type: "tool-call", toolName: "read_file", argsSummary: "path: src/auth.ts" };
    yield { type: "tool-result", toolName: "read_file", argsSummary: "path: src/auth.ts", ok: true, outputSummary: "42 chars" };
    yield { type: "text-delta", delta: " Done." };
    yield { type: "finish", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
  };

  it("delegateTask WITH chatStream runs the STREAMED path — the child's raw deltas ride the parent's emit live", async () => {
    const agent = createAgent(db, {
      name: "R50b Streamed",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);
    const chat: ChatFn = async () => ({
      text: "compaction summary",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, chatStream: streamedChild },
      parent.id,
      "fix the auth module",
      "coder",
      emit,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Fixing the auth module. Done.");
    expect(getSession(db, result.sessionId!)?.status).toBe("completed");

    // The child's inner frames arrive as DELTA-shaped live events (the
    // STREAMED turn path) — token-level text-delta with `delta`, a
    // thinking-delta, the tool pair, and a finish that CARRIES USAGE. The
    // sync path's step snapshots would carry `text` + a bare finish instead
    // (pinned by the next test).
    const inners = envelopes
      .filter((e) => e.type === "subagent-event")
      .map((e) => e.inner as Record<string, unknown>);
    expect(inners.map((e) => e.type)).toEqual([
      "thinking-delta",
      "text-delta",
      "tool-call",
      "tool-result",
      "text-delta",
      "finish",
    ]);
    expect(inners[0]).toMatchObject({ delta: "Reading the target files first." });
    expect(inners[1]).toMatchObject({ type: "text-delta", delta: "Fixing the auth module." });
    expect((inners[1] as { text?: unknown }).text).toBeUndefined();
    expect(inners[2]).toMatchObject({ toolName: "read_file", argsSummary: "path: src/auth.ts" });
    expect(inners[3]).toMatchObject({ toolName: "read_file", ok: true, outputSummary: "42 chars" });
    expect(inners[5]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });

    // Persistence: the streamed path's interleaved event log (ADR-0010) —
    // interim assistant segment (thinking + text), the tool call, the final
    // assistant segment.
    expect(listSessionEvents(db, result.sessionId!).map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant",
      "tool.use",
      "message.assistant",
    ]);

    // The /subagents row: usage-ledger tokens + the model the child ran on.
    // (report = the LAST persisted assistant segment — the streamed path
    // flushes "Fixing the auth module." before the tool call and " Done."
    // after it; the delegation's OUTPUT carries the full iteration text.)
    const row = listSubAgents(db, parent.id)[0];
    expect(row).toMatchObject({
      id: result.sessionId,
      status: "completed",
      inputTokens: 7,
      outputTokens: 3,
      model: "test/orch-1",
      report: " Done.",
    });

    // The GET route passes the model through verbatim (no field whitelist).
    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${parent.id}/subagents`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().subagents[0]).toMatchObject({
      id: result.sessionId,
      model: "test/orch-1",
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("every subagent-status frame carries the effective model (agent.model when no override)", async () => {
    const agent = createAgent(db, {
      name: "R50b Model",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const statuses: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => {
      const ev = event as Record<string, unknown>;
      if (ev.type === "subagent-status") statuses.push(ev);
    };
    const chat: ChatFn = async () => ({
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, chatStream: streamedChild },
      parent.id,
      "model frame check",
      "researcher",
      emit,
    );
    expect(result.ok).toBe(true);
    expect(statuses.length).toBeGreaterThanOrEqual(3); // queued → running → completed
    for (const s of statuses) {
      expect(s.model).toBe("test/orch-1");
    }
  });

  it("orchestration.subagentModel overrides BOTH the child's model and the status frames' model field", async () => {
    setOrchestrationSettings(db, { subagentModel: SUBAGENT_DEFAULT_MODEL_ID });
    const agent = createAgent(db, {
      name: "R50b Override",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const models: string[] = [];
    const emit = (event: unknown) => {
      const ev = event as Record<string, unknown>;
      if (ev.type === "subagent-status") models.push(String(ev.model));
    };
    const chat: ChatFn = async () => ({
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, chatStream: streamedChild },
      parent.id,
      "override check",
      "researcher",
      emit,
    );
    expect(result.ok).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set([SUBAGENT_DEFAULT_MODEL_ID]));
    // The usage-ledger-derived /subagents row model follows the override.
    expect(listSubAgents(db, parent.id)[0]?.model).toBe(SUBAGENT_DEFAULT_MODEL_ID);
  });

  it("NO chatStream → the SYNC fallback keeps step-snapshot semantics (text-delta carries `text`, finish carries no usage)", async () => {
    const agent = createAgent(db, {
      name: "R50b Sync",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);

    // A sync adapter reporting live steps through onStepFinish — the
    // pre-R50-b delegation behavior, byte-for-byte.
    const chat: ChatFn = async (input) => {
      input.onStepFinish?.({
        text: "reading the file ",
        toolCalls: [{ name: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" }],
      });
      input.onStepFinish?.({ text: "Done. Final report.", toolCalls: [] });
      return {
        text: "reading the file Done. Final report.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [{ name: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "10 chars" }],
      };
    };

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parent.id,
      "sync fallback check",
      "researcher",
      emit,
    );
    expect(result.ok).toBe(true);

    const inners = envelopes
      .filter((e) => e.type === "subagent-event")
      .map((e) => e.inner as Record<string, unknown>);
    expect(inners.map((e) => e.type)).toEqual([
      "tool-call",
      "tool-result",
      "text-delta",
      "text-delta",
      "finish",
    ]);
    // Step-snapshot shape: the FULL step text, no token-level `delta`; the
    // finish frame carries NO usage (tokens stay on the polled row).
    expect(inners[2]).toMatchObject({ text: "reading the file " });
    expect((inners[2] as { delta?: unknown }).delta).toBeUndefined();
    expect(inners[4]).toMatchObject({ type: "finish" });
    expect((inners[4] as { usage?: unknown }).usage).toBeUndefined();
  });

  it("the delegate_task TOOL forwards chatStream (prepareTurn toolDeps wiring) — its child runs STREAMED", async () => {
    // End-to-end wiring proof: a STREAMED parent turn (the main agent's
    // route) executes the delegate_task tool from its toolset — the tool's
    // toolDeps must carry the chatStream prepareTurn forwarded, so the
    // spawned child runs the streamed path too (delta-shaped frames riding
    // the parent's emit).
    const project = await authInject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "R50b Wiring", rootPath: tempDir },
    });
    const projectId = project.json().id as string;
    const agent = createAgent(db, {
      name: "R50b Wiring Agent",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single", projectId });
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);

    let calls = 0;
    const chat: ChatFn = async () => ({
      text: "sync chat unused",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    // The PARENT's streamed adapter executes delegate_task directly (the
    // model's tool call, simulated); the second invocation is the CHILD's
    // own streamed turn.
    const chatStream: StreamChatFn = async function* (input: StreamChatInput) {
      calls += 1;
      if (calls === 1) {
        const tools = input.tools as unknown as Record<
          string,
          { execute: (i: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }
        >;
        const res = await tools.delegate_task.execute({ task: "grandchild work", role: "researcher" });
        // NOTE: the text deliberately avoids delegation words — the R49
        // tool-intent nudge would otherwise spend a second iteration on a
        // zero-tool reply that merely MENTIONS delegating.
        yield { type: "text-delta", delta: `ok=${res.ok}` };
      } else {
        yield { type: "text-delta", delta: "child final report" };
      }
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat, chatStream },
      parent.id,
      "delegate the work",
      emit,
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2); // parent iteration + the child's streamed turn

    // The child's frames ride the parent's emit as DELTA-shaped subagent-event
    // envelopes — toolDeps.chatStream → delegate_task → orchestrator →
    // runStreamedAgentTurn.
    const childEvents = envelopes.filter((e) => e.type === "subagent-event") as Array<{
      inner?: Record<string, unknown>;
    }>;
    const childText = childEvents.find((e) => e.inner?.type === "text-delta");
    expect(childText?.inner).toMatchObject({ type: "text-delta", delta: "child final report" });
    const childFinish = childEvents.find((e) => e.inner?.type === "finish");
    expect(childFinish?.inner).toMatchObject({ usage: { inputTokens: 1, outputTokens: 1 } });
    // The child completed + is linked under the parent.
    const children = listSubAgents(db, parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("completed");
    expect(children[0]?.model).toBe("test/orch-1");
  });
});

// ── R93-B4: the sub-agent key-pool + NULL-row fixes ─────────────────────────

describe("R93-B4: the empty-pool fast failure + the mainModel fallback", () => {
  it("a delegation to a provider with NO keys fails FAST with the honest, actionable message (never a forever-queued child)", async () => {
    const agent = createAgent(db, {
      name: "Keyless",
      providerId: "nvidia", // no ACUTE_PROVIDER_NVIDIA in the keyring
      model: "nim/test",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    const result = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: aiSdkChat },
      parent.id,
      "count the files",
      "researcher",
    );

    // The delegation returns immediately with the honest refusal — the
    // pre-R93 acquireSlot polled FOREVER (the child stayed queued, the
    // parent's delegate_task never returned).
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no API keys configured");
    expect(result.output).toContain("Settings → Models & Providers");
    expect(result.output).toContain("nvidia");
    // The child is marked failed (not stuck queued).
    const child = getSession(db, result.sessionId!);
    expect(child?.status).toBe("failed");
  });

  it("a NULL agent row (no providerId/model) falls back to the PARENT turn's effective pair — the child runs, no 409", async () => {
    const agent = createAgent(db, { name: "Blank", providerId: null, model: null });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    // The parent turn's effective pair (what ToolDeps.mainModel threads
    // through): openrouter + test/fallback-1.
    const result = await orchestrator.delegateTask(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        mainModel: { providerId: "openrouter", modelId: "test/fallback-1" },
      },
      parent.id,
      "count the files",
      "researcher",
    );

    // The child RAN (the generateText mock answers) — pre-R93 every child
    // 409'd "has no providerId/model configured".
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Sub-agent report: task done.");
    const child = getSession(db, result.sessionId!);
    expect(child?.status).toBe("completed");
  });

  it("a CONFIGURED agent row still wins over the mainModel fallback (the durable pair is stable)", async () => {
    const agent = createAgent(db, {
      name: "Durable",
      providerId: "openrouter",
      model: "test/durable-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    let seenModel = "";
    generateTextMock.mockImplementation(async (input: { model?: unknown }) => {
      seenModel = String((input as { model?: { modelId?: string } }).model?.modelId ?? "");
      return {
        text: "Sub-agent report: task done.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    });

    await orchestrator.delegateTask(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        mainModel: { providerId: "openrouter", modelId: "test/transient-override" },
      },
      parent.id,
      "count the files",
      "researcher",
    );
    expect(seenModel).toBe("test/durable-1");
  });
});
