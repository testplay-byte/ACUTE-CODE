// @vitest-environment node
/**
 * ROUND-43 (R43-5) — the temporary sub-agent provider section, backend half:
 *
 *  1. orchestration.subagentModel storage: default null (inherit), round-trip,
 *     clear-to-null (row deleted), catalog + tool-capability validation.
 *  2. orchestrator wiring: delegateTask/retryChild run children on the
 *     override when set and on the agent's model when null — the override
 *     never rewrites the seeded agent records (children only).
 *  3. PUT /settings/orchestration accepts string ids + null and 400s bad ones.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { Orchestrator } from "../src/agents/orchestrator";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { createSession, getSession } from "../src/storage/sessions";
import { createAgent, getAgent } from "../src/storage/agents";
import {
  getOrchestrationSettings,
  setOrchestrationSettings,
} from "../src/storage/settings";
import { SUBAGENT_DEFAULT_MODEL_ID } from "../src/storage/models";

const TOKEN = "test-token-r43-5";
const KEY = "sk-or-vtest-r43a";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r43-subagent-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
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
  method: "GET" | "PUT";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A ChatFn spy that records the model id every turn actually ran on. */
function spyChat(): { chat: ChatFn; models: string[] } {
  const models: string[] = [];
  const chat: ChatFn = async (input) => {
    models.push(input.model);
    return {
      text: "child report",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    };
  };
  return { chat, models };
}

describe("R43-5: orchestration.subagentModel storage", () => {
  it("defaults to null (children inherit the agent's model)", () => {
    expect(getOrchestrationSettings(db)).toEqual({
      maxParallel: 5,
      perKeyLimit: 3,
      subagentModel: null,
      // ROUND-52 (R52-b): the child-supervisor knobs (heartbeat cadence +
      // stall threshold) joined the settings object.
      childWatchdogMs: 15_000,
      childStallTimeoutMs: 300_000,
    });
  });

  it("round-trips a valid tool-capable catalog id and clears back to null", () => {
    const set = setOrchestrationSettings(db, { subagentModel: SUBAGENT_DEFAULT_MODEL_ID });
    expect(set.subagentModel).toBe(SUBAGENT_DEFAULT_MODEL_ID);
    expect(getOrchestrationSettings(db).subagentModel).toBe(SUBAGENT_DEFAULT_MODEL_ID);

    const cleared = setOrchestrationSettings(db, { subagentModel: null });
    expect(cleared.subagentModel).toBeNull();
    expect(getOrchestrationSettings(db).subagentModel).toBeNull();
    // Clear removes the row entirely — absent key = inherit.
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'orchestration.subagentModel'")
      .get() as { value: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("rejects unknown model ids and tool-less models on write", () => {
    expect(() => setOrchestrationSettings(db, { subagentModel: "vendor/unknown-model" })).toThrow(
      /known catalog model id/,
    );
    // The one free catalog entry WITHOUT tool support — sub-agents are
    // mandated tool users (ROUND-39), so it must be refused.
    expect(() =>
      setOrchestrationSettings(db, { subagentModel: "nvidia/nemotron-3.5-content-safety:free" }),
    ).toThrow(/tool calling/);
    // Nothing was persisted by the failed writes.
    expect(getOrchestrationSettings(db).subagentModel).toBeNull();
  });
});

describe("R43-5: orchestrator child-model override wiring", () => {
  it("children inherit the agent's model when subagentModel is null", async () => {
    const agent = createAgent(db, {
      name: "Main",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const { chat, models } = spyChat();

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parent.id,
      "inherit check",
      "researcher",
    );

    expect(result.ok).toBe(true);
    expect(models).toEqual(["test/orch-1"]);
  });

  it("children run on the override when set — and the agent record is untouched", async () => {
    setOrchestrationSettings(db, { subagentModel: SUBAGENT_DEFAULT_MODEL_ID });
    const agent = createAgent(db, {
      name: "Main",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const { chat, models } = spyChat();

    const result = await new Orchestrator().delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      parent.id,
      "override check",
      "coder",
    );

    expect(result.ok).toBe(true);
    expect(models).toEqual([SUBAGENT_DEFAULT_MODEL_ID]);
    // The override changes what CHILDREN run on — never the seeded agent row.
    expect(getAgent(db, agent.id)?.model).toBe("test/orch-1");
  });

  it("retryChild honors the same override", async () => {
    const agent = createAgent(db, {
      name: "Main",
      providerId: "openrouter",
      model: "test/orch-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const { chat, models } = spyChat();
    const deps = { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat };

    const first = await new Orchestrator().delegateTask(deps, parent.id, "first run", "tester");
    expect(models).toEqual(["test/orch-1"]); // pre-override behavior

    // The owner sets the temporary override; the retry of the SAME child
    // picks it up.
    setOrchestrationSettings(db, { subagentModel: SUBAGENT_DEFAULT_MODEL_ID });
    const retried = await new Orchestrator().retryChild(deps, parent.id, first.sessionId!);
    expect(retried.ok).toBe(true);
    expect(models[models.length - 1]).toBe(SUBAGENT_DEFAULT_MODEL_ID);
    expect(getSession(db, first.sessionId!)?.status).toBe("completed");
  });
});

describe("R43-5: PUT /settings/orchestration subagentModel route contract", () => {
  it("accepts a valid catalog id, reflects it on GET, and clears via null", async () => {
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: SUBAGENT_DEFAULT_MODEL_ID },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().subagentModel).toBe(SUBAGENT_DEFAULT_MODEL_ID);

    const get = await authInject({ method: "GET", url: "/api/v1/settings/orchestration" });
    expect(get.json().subagentModel).toBe(SUBAGENT_DEFAULT_MODEL_ID);

    const cleared = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().subagentModel).toBeNull();
  });

  it("400s unknown ids and tool-less models", async () => {
    const unknown = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: "not/a-real-model" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain("known catalog model id");

    const toolless = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: "nvidia/nemotron-3.5-content-safety:free" },
    });
    expect(toolless.statusCode).toBe(400);
    expect(JSON.stringify(toolless.json())).toContain("tool calling");

    // Non-string non-null garbage is ignored (partial-patch semantics).
    const ignored = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: 42 },
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().subagentModel).toBeNull();
  });
});
