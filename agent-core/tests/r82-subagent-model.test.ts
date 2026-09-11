/**
 * ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap) — the provider-scoped
 * sub-agent model:
 *
 *   · OrchestrationSettings.subagentModel is {providerId, modelId} | null.
 *     Reads normalize legacy bare strings → {providerId: "openrouter",
 *     modelId} (every pre-R82 value was an OpenRouter catalog id); the wire
 *     keeps the legacy string WRITE form for old callers.
 *   · PUT /settings/orchestration accepts the OBJECT form: the provider must
 *     EXIST (400 "does not exist" otherwise); tool-capability is enforced
 *     where KNOWABLE — an explicit supportsTools=false on the configured
 *     row rejects (sub-agents are mandated tool users, ROUND-39), while
 *     null/unknown (and rows that don't exist) pass — the honest tri-state,
 *     never the 0004-era "unknown means off" lie that made NIM rows
 *     unpickable.
 *   · delegateTask/retryChild pass {model, providerId} as the child's
 *     TurnModelOverride — the child turn routes to the REF's provider (the
 *     pre-R82 code sent the model string to the parent agent's provider).
 *
 * GET /models/configured (the picker feed that lists cross-provider rows)
 * is pinned in r82-capabilities.test.ts; the legacy-string read
 * normalization and the clear-to-null flows in r43-subagent-provider.test.ts.
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
import { createSession } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProviderRecord } from "../src/storage/providers";
import { upsertModel } from "../src/storage/models";
import {
  getOrchestrationSettings,
  setOrchestrationSettings,
} from "../src/storage/settings";

const TOKEN = "test-token-r82sub";
const KEY = "sk-or-vtest-r82sub";
const GW_KEY = "sk-gw-vtest-r82sub";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "nvidia/nemotron-3.5-lightning"; // a NIM-shaped id, no catalog source

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r82sub-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: GW_BASE });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: GW_KEY,
    }),
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

/** A ChatFn spy recording the (providerId, model) pair of every child turn
 *  (the r43-subagent-provider pattern, extended with the provider id). */
function spyChat(): { chat: ChatFn; seen: Array<{ providerId: string; model: string }> } {
  const seen: Array<{ providerId: string; model: string }> = [];
  const chat: ChatFn = async (input) => {
    seen.push({ providerId: input.provider.id, model: input.model });
    return {
      text: "child report",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    };
  };
  return { chat, seen };
}

describe("R82: orchestration.subagentModel object-form storage", () => {
  it("round-trips a custom-provider ref verbatim (JSON object under the hood)", () => {
    const set = setOrchestrationSettings(db, {
      subagentModel: { providerId: GW_ID, modelId: GW_MODEL },
    });
    expect(set.subagentModel).toEqual({ providerId: GW_ID, modelId: GW_MODEL });
    expect(getOrchestrationSettings(db).subagentModel).toEqual({
      providerId: GW_ID,
      modelId: GW_MODEL,
    });
    // The stored value is the JSON object form (the legacy string form
    // stays distinguishable on read).
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'orchestration.subagentModel'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ providerId: GW_ID, modelId: GW_MODEL });
  });

  it("rejects an unknown provider and a blank modelId on write (nothing persists)", () => {
    expect(() =>
      setOrchestrationSettings(db, { subagentModel: { providerId: "prv_missing", modelId: GW_MODEL } }),
    ).toThrow(/provider 'prv_missing' does not exist/);
    expect(() =>
      setOrchestrationSettings(db, { subagentModel: { providerId: GW_ID, modelId: "   " } }),
    ).toThrow(/non-empty string/);
    expect(getOrchestrationSettings(db).subagentModel).toBeNull();
  });

  it("degrades a CORrupt stored object to null — never a crash, never a wrong provider", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('orchestration.subagentModel', ?)").run(
      '{"providerId": "prv_gw"',
    );
    expect(getOrchestrationSettings(db).subagentModel).toBeNull();
    // …and a wrong-shaped object (blank fields) degrades the same way.
    db.prepare("UPDATE settings SET value = ? WHERE key = 'orchestration.subagentModel'").run(
      '{"providerId": "", "modelId": "x"}',
    );
    expect(getOrchestrationSettings(db).subagentModel).toBeNull();
  });
});

describe("R82: PUT /settings/orchestration subagentModel object-form route contract", () => {
  it("accepts a custom-provider ref (tool-capable configured row) and reflects it on GET", async () => {
    // A configured row whose tools bit is UNKNOWN (null — a NIM row the
    // catalog knows nothing about): the honest tri-state passes.
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().subagentModel).toEqual({ providerId: GW_ID, modelId: GW_MODEL });

    const get = await authInject({ method: "GET", url: "/api/v1/settings/orchestration" });
    expect(get.json().subagentModel).toEqual({ providerId: GW_ID, modelId: GW_MODEL });
  });

  it("accepts an EXPLICITLY tool-capable configured row (supportsTools: true)", async () => {
    upsertModel(db, GW_ID, { modelId: GW_MODEL, supportsTools: true });
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().subagentModel).toEqual({ providerId: GW_ID, modelId: GW_MODEL });
  });

  it("rejects an explicit supportsTools=false on the configured row (sub-agents are mandated tool users)", async () => {
    upsertModel(db, GW_ID, { modelId: GW_MODEL, supportsTools: false });
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } },
    });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(put.json())).toContain("NOT tool-capable");
    // The failed write persisted nothing.
    const get = await authInject({ method: "GET", url: "/api/v1/settings/orchestration" });
    expect(get.json().subagentModel).toBeNull();
  });

  it("400s an object form naming a provider that does not exist", async () => {
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: { providerId: "prv_missing", modelId: GW_MODEL } },
    });
    expect(put.statusCode).toBe(400);
    expect(JSON.stringify(put.json())).toContain("does not exist");
  });

  it("clears via null — and the LEGACY string form still writes (openrouter-scoped on read)", async () => {
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } },
    });
    const cleared = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().subagentModel).toBeNull();

    // The legacy bare-string write (an old caller) still works and reads
    // back openrouter-scoped.
    const legacy = await authInject({
      method: "PUT",
      url: "/api/v1/settings/orchestration",
      payload: { subagentModel: "nvidia/nemotron-3.5-lightning:free" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().subagentModel).toEqual({
      providerId: "openrouter",
      modelId: "nvidia/nemotron-3.5-lightning:free",
    });
  });
});

/* ── The R82 close-out bug (found by R82-TESTS, fixed same round) ────────────
 *
 * The orchestrator passes the provider-scoped ref down as the child's
 * TurnModelOverride, and prepareTurn then resolved the child's EFFECTIVE
 * provider from it… but runChildTurn and retryChild used to provision a
 * per-child keyring VIEW keyed on the PARENT AGENT's provider (acquireSlot
 * polled the agent's pool and the view carried only
 * slotEnvVarName(agentProvider, slot/0)). The child's prepareTurn therefore
 * found NO key for the override's provider → the turn 409'd "no API key for
 * provider 'prv_…'" before any chat call. The R82 close-out keyed the
 * view/slot on the EFFECTIVE provider.
 *
 * ROUND-92 (R92-D): the per-child keyring VIEW is GONE ENTIRELY — children
 * receive the PARENT keyring unchanged (the full deduped pool), so the
 * override's provider resolves its key through the same pool a main turn
 * uses, and a key-attributable failure juggles to the next pool key inside
 * the child's own turn (r92-key-pool.test.ts). These pins stay: the ref's
 * provider + model serve the child turns, the agent row is untouched. */
describe("R82: orchestrator child routing — the ref's PROVIDER serves the child turns", () => {
  it("delegateTask routes the child to the ref's provider + model (not the parent agent's)", async () => {
    // The configured NIM-style row: unknown tools (null) — accepted above.
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    setOrchestrationSettings(db, { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } });

    const agent = createAgent(db, {
      name: "Main",
      providerId: "openrouter",
      model: "test/parent-model",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const { chat, seen } = spyChat();
    // BOTH keys: openrouter for the agent-provider slot acquisition, GW for
    // the override the child should route to — the routing pin below is the
    // intended R82 §2.4.5 contract.
    const keyring = new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: GW_KEY,
    });

    const result = await new Orchestrator().delegateTask(
      { db, keyring, chat },
      parent.id,
      "route the child to the gateway",
      "researcher",
    );

    expect(result.ok, `the child turn failed: ${result.output}`).toBe(true);
    // THE routing pin: the child's chat input carried the REF's pair — the
    // custom provider id + the ref's model id (the pre-R82 code sent the
    // model string to the PARENT's openrouter, the §1 misroute's sub-agent
    // twin). Since R92-D the child resolves the ref's provider through the
    // shared parent pool — no per-child view to starve it.
    expect(seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
  });

  it("retryChild honors the same provider-scoped override", async () => {
    const agent = createAgent(db, {
      name: "Main",
      providerId: "openrouter",
      model: "test/parent-model",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const { chat, seen } = spyChat();
    const deps = {
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY,
        ACUTE_PROVIDER_PRV_GW: GW_KEY,
      }),
      chat,
    };

    // First run: no override → the agent's pair (this half works today).
    const first = await new Orchestrator().delegateTask(deps, parent.id, "first run", "tester");
    expect(first.ok).toBe(true);
    expect(seen).toEqual([{ providerId: "openrouter", model: "test/parent-model" }]);

    // The owner sets the provider-scoped ref; the retry of the SAME child
    // picks up the ref's provider.
    upsertModel(db, GW_ID, { modelId: GW_MODEL });
    setOrchestrationSettings(db, { subagentModel: { providerId: GW_ID, modelId: GW_MODEL } });
    const retried = await new Orchestrator().retryChild(deps, parent.id, first.sessionId!);
    expect(retried.ok, `the retried child failed: ${retried.message}`).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ providerId: GW_ID, model: GW_MODEL });
  });
});
