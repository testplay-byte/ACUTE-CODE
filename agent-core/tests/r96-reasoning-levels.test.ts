/**
 * ROUND-96 (R96-F) tests — the MODEL-AWARE reasoning LEVELS round.
 *
 * The owner's report, verbatim: "The other issue which I apparently saw was
 * that our system was not able to detect which reasoning levels the models
 * supported. I tested a model which supported high and max but it apparently
 * did not detect that properly and was showing the default options. This
 * should not happen. It needs to be improved and handled better."
 *
 * Root causes fixed by this round (survey of 2026-09-13, checked against the
 * LIVE OpenRouter catalog):
 *  1. normalizeReasoningEfforts FOLDED xhigh/max DOWN to "high" — the
 *     owner's deepseek/deepseek-v4.1-flash (['max','high','low'], default
 *     'high') rendered a menu IDENTICAL to the unknown-capabilities default.
 *  2. Legacy rows (added before R95) never re-merged — the catalog merge ran
 *     only inside the Add Models dialog's route.
 *
 * Coverage (all mocked — NO live calls):
 *  · normalizeReasoningEfforts: ['max','high','low'] and ['xhigh','high']
 *    survive VERBATIM; "none" (a disable switch) is dropped; ordering is
 *    canonical (the shared vocabulary's).
 *  · extractReasoningSupport (via GET /providers/:id/models with a catalog
 *    mock): default_effort parsed + normalized; absent → undefined; a
 *    "none"/unrecognized default reads as absent.
 *  · The WIRE ORACLE (aiSdkChat with the provider factories mocked; the
 *    recorded request body asserted): a ['max','high','low'] model + level
 *    max → reasoning.effort "max" (NOT "high"); level max on ['xhigh','high']
 *    → "xhigh"; level high on ['medium','low'] → "medium" (stepped down);
 *    a ladder-less supported model + a level → the max_tokens budget ONLY
 *    (the R95-G effort-XOR-max_tokens contract preserved); level xhigh rides
 *    verbatim on a ladder that holds it.
 *  · The storage round-trip: defaultEffort serializes canonically and is
 *    dropped when out-of-vocabulary.
 *  · The LEGACY AUTO-REFRESH (GET /providers/:id/models-config): a stored
 *    NULL-reasoning row + a catalog mock carrying supported_efforts → the
 *    read returns the MERGED support (no user action, first read of a
 *    session); a fetch FAILURE leaves the rows as stored (best-effort,
 *    never a failed request) and the failure cooldown stops re-fetching.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring, clearModelCache, normalizeReasoningEfforts } from "../src/providers/registry";
import { clearLegacyReasoningRefreshState } from "../src/routes/providers";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { resolveModelReasoningSupport, upsertModel } from "../src/storage/models";
import { buildServer } from "../src/server";
import type { ModelReasoningSupport, ThinkingLevel } from "shared";

const TOKEN = "test-token-r96f";
const KEY = "sk-or-vtest-r96f";

/* ── The chat-adapter mock harness (chat-format.test.ts's pattern) ────────── */

const createOpenAICompatibleMock = vi.hoisted(() => vi.fn(() => ({
  chatModel: (model: string) => ({ kind: "openai-compatible", model }),
})));
const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

import { aiSdkChat } from "../src/agents/chat";

const baseInput = {
  apiKey: "sk-test",
  model: "deepseek/deepseek-v4.1-flash",
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.2,
  maxTurns: 4,
};

/** The body-capturing global fetch: records every outgoing JSON body. */
function capturingFetch(): { bodies: string[] } {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  return { bodies };
}

/** Drive ONE level through the real adapter wiring: aiSdkChat builds the
 * model with buildThinkingFetch as its fetch, then we invoke that fetch the
 * way the SDK would — the recorded body is the WIRE truth. */
async function wireEffort(
  level: ThinkingLevel,
  support: ModelReasoningSupport | null | undefined,
): Promise<{ reasoning?: { effort?: string; max_tokens?: number } }> {
  createOpenAICompatibleMock.mockClear();
  await aiSdkChat({
    ...baseInput,
    provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    thinkingLevel: level,
    reasoningSupport: support ?? null,
  });
  const config = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as {
    fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  };
  const { bodies } = capturingFetch();
  await config.fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: baseInput.model, messages: [] }),
  });
  vi.unstubAllGlobals();
  return JSON.parse(bodies[0]) as { reasoning?: { effort?: string; max_tokens?: number } };
}

function reasoning(efforts: string[], defaultEffort?: string): ModelReasoningSupport {
  return {
    supported: true,
    efforts: efforts as ModelReasoningSupport["efforts"],
    ...(defaultEffort !== undefined ? { defaultEffort: defaultEffort as ModelReasoningSupport["defaultEffort"] } : {}),
  };
}

/* ── The route-harness (r95-reasoning-metadata.test.ts's pattern) ─────────── */

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  clearModelCache();
  clearLegacyReasoningRefreshState();
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r96f-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  // The wire-oracle harness needs a resolved generateText (the adapter maps
  // its usage onto the turn output).
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    steps: [],
  });
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/* ── 1. The vocabulary: the model's OWN rungs survive verbatim ───────────── */

describe("R96-F: normalizeReasoningEfforts (the folded-away top rungs return)", () => {
  it("the owner's model ['max','high','low'] survives VERBATIM — not folded to [low, high]", () => {
    // deepseek/deepseek-v4.1-flash, live 2026-09-13 (the survey's exact case).
    expect(normalizeReasoningEfforts(["max", "high", "low"])).toEqual(["low", "high", "max"]);
  });

  it("['xhigh','high'] survives verbatim (z-ai/glm-5.2, live)", () => {
    expect(normalizeReasoningEfforts(["xhigh", "high"])).toEqual(["high", "xhigh"]);
  });

  it("'none' is dropped — a DISABLE switch, not an effort (grok-4.3 ['high','medium','low','none'])", () => {
    expect(normalizeReasoningEfforts(["high", "medium", "low", "none"])).toEqual(["low", "medium", "high"]);
  });

  it("ordering is canonical (the shared vocabulary's), with dedupe and unrecognized values dropped", () => {
    expect(normalizeReasoningEfforts(["ultra", "max", "low", "max", "xhigh"])).toEqual([
      "low",
      "xhigh",
      "max",
    ]);
  });
});

/* ── 2. default_effort parsing (extractReasoningSupport via the route) ────── */

describe("R96-F: extractReasoningSupport parses default_effort (via GET /providers/:id/models)", () => {
  async function catalogReasoning(entry: Record<string, unknown>): Promise<ModelReasoningSupport | undefined> {
    // The registry's model cache is 5 minutes — clear it so each probe sees
    // ITS OWN catalog (not the previous probe's cached body).
    clearModelCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [entry] }), { status: 200 })),
    );
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{ id: string; reasoningSupport?: ModelReasoningSupport }>;
    return models[0]?.reasoningSupport;
  }

  it("parses the published default and keeps the ladder verbatim (the owner's model)", async () => {
    expect(
      await catalogReasoning({
        id: "deepseek/deepseek-v4.1-flash",
        supported_parameters: ["reasoning", "tools"],
        reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
      }),
    ).toEqual({ supported: true, efforts: ["low", "high", "max"], defaultEffort: "high" });
  });

  it("an xhigh ladder + default parses (z-ai/glm-5.3: ['max','high','low'] default 'max')", async () => {
    expect(
      await catalogReasoning({
        id: "z-ai/glm-5.3",
        supported_parameters: ["reasoning"],
        reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "max" },
      }),
    ).toEqual({ supported: true, efforts: ["low", "high", "max"], defaultEffort: "max" });
  });

  it("absent default_effort → NO defaultEffort field (undefined)", async () => {
    expect(
      await catalogReasoning({
        id: "test/no-default",
        supported_parameters: ["reasoning"],
        reasoning: { supported_efforts: ["high", "medium", "low"] },
      }),
    ).toEqual({ supported: true, efforts: ["low", "medium", "high"] });
  });

  it("a 'none' or unrecognized default reads as ABSENT (a disable switch is not a rung)", async () => {
    expect(
      await catalogReasoning({
        id: "openai/gpt-5.1",
        supported_parameters: ["reasoning"],
        reasoning: { supported_efforts: ["high", "medium", "low", "none"], default_effort: "none" },
      }),
    ).toEqual({ supported: true, efforts: ["low", "medium", "high"] });
    expect(
      await catalogReasoning({
        id: "test/junk-default",
        supported_parameters: ["reasoning"],
        reasoning: { supported_efforts: ["high"], default_effort: "ultra" },
      }),
    ).toEqual({ supported: true, efforts: ["high"] });
  });
});

/* ── 3. The WIRE ORACLE: the recorded request body ────────────────────────── */

describe("R96-F: the wire mapping (the recorded request body)", () => {
  it("deepseek ['max','high','low'] + level max → reasoning.effort === \"max\" (NOT \"high\")", async () => {
    // The owner's exact case: "I tested a model which supported high and max
    // but it apparently did not detect that properly" — the R95 fold sent
    // "high" here, silently downgrading the pick.
    const body = await wireEffort("max", reasoning(["low", "high", "max"]));
    expect(body.reasoning?.effort).toBe("max");
    expect(body.reasoning?.max_tokens).toBeUndefined();
  });

  it("level max on an ['xhigh','high'] model → \"xhigh\" (stepped DOWN, never up)", async () => {
    const body = await wireEffort("max", reasoning(["high", "xhigh"]));
    expect(body.reasoning?.effort).toBe("xhigh");
  });

  it("level high on a ['medium','low'] model → \"medium\" (stepped down; nemotron-3-super's live ladder)", async () => {
    const body = await wireEffort("high", reasoning(["low", "medium"]));
    expect(body.reasoning?.effort).toBe("medium");
  });

  it("level xhigh on an ['xhigh','high'] model rides VERBATIM (the new rung is selectable)", async () => {
    const body = await wireEffort("xhigh", reasoning(["high", "xhigh"]));
    expect(body.reasoning?.effort).toBe("xhigh");
  });

  it("a LADDER-LESS supported model + a level → the max_tokens budget ONLY, no effort key (the XOR preserved)", async () => {
    // Lesson #96 (the R95-G live-fire correction): OpenRouter REJECTS a
    // body carrying BOTH reasoning.effort and reasoning.max_tokens. The
    // ladder-less shape is the budget's one and only home.
    const body = await wireEffort("high", reasoning([]));
    expect(body.reasoning).toEqual({ max_tokens: 8192 });
  });

  it("UNKNOWN support + a level → the level verbatim, no budget (the R50 passthrough)", async () => {
    const body = await wireEffort("max", null);
    expect(body.reasoning).toEqual({ effort: "max" });
  });
});

/* ── 4. The storage round-trip: defaultEffort rides canonically ───────────── */

describe("R96-F: the reasoning_support blob round-trips defaultEffort", () => {
  it("serializes canonically (ordered efforts + the default) and serves it back", () => {
    const row = upsertModel(db, "openrouter", {
      modelId: "deepseek/deepseek-v4.1-flash",
      reasoningSupport: { supported: true, efforts: ["max", "high", "low"], defaultEffort: "high" },
    });
    expect(row.reasoningSupport).toEqual({
      supported: true,
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
    });
    expect(resolveModelReasoningSupport(db, "openrouter", "deepseek/deepseek-v4.1-flash")).toEqual({
      supported: true,
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
    });
  });

  it("an out-of-vocabulary defaultEffort is DROPPED by the defensive read, never trusted", () => {
    const row = upsertModel(db, "openrouter", { modelId: "test/legacy" });
    db.prepare("UPDATE models SET reasoning_support = ? WHERE id = ?").run(
      JSON.stringify({ supported: true, efforts: ["high"], defaultEffort: "none" }),
      row.id,
    );
    expect(getModelSupport("test/legacy")).toEqual({ supported: true, efforts: ["high"] });
  });
});

function getModelSupport(modelId: string): ModelReasoningSupport | null {
  return resolveModelReasoningSupport(db, "openrouter", modelId);
}

/* ── 5. The LEGACY AUTO-REFRESH (models-config serves merged rows) ─────────── */

describe("R96-F: the legacy auto-refresh (GET /providers/:id/models-config)", () => {
  /** The owner's pre-R95 row: added before migration 0035, reasoning NULL. */
  function legacyRow(): void {
    upsertModel(db, "openrouter", { modelId: "deepseek/deepseek-v4.1-flash" });
  }

  it("a stored NULL row + a catalog carrying supported_efforts → the read returns the MERGED support", async () => {
    legacyRow();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "deepseek/deepseek-v4.1-flash",
                supported_parameters: ["reasoning"],
                reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(response.statusCode).toBe(200);
    // The SAME response carries the detected ladder — the owner's models
    // upgrade on the FIRST models-config read of a session, no user action.
    const models = response.json().models as Array<{
      modelId: string;
      reasoningSupport: ModelReasoningSupport | null;
    }>;
    expect(models.find((m) => m.modelId === "deepseek/deepseek-v4.1-flash")?.reasoningSupport).toEqual(
      {
        supported: true,
        efforts: ["low", "high", "max"],
        defaultEffort: "high",
      },
    );
    // …and it PERSISTED (the next session reads it without any fetch).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveModelReasoningSupport(db, "openrouter", "deepseek/deepseek-v4.1-flash")).toEqual({
      supported: true,
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
    });
  });

  it("an owner-SET row is never touched by the refresh (the NULL guard)", async () => {
    upsertModel(db, "openrouter", {
      modelId: "deepseek/deepseek-v4.1-flash",
      reasoningSupport: { supported: true, efforts: ["low"] },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "deepseek/deepseek-v4.1-flash",
                  supported_parameters: ["reasoning"],
                  reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(response.statusCode).toBe(200);
    expect(resolveModelReasoningSupport(db, "openrouter", "deepseek/deepseek-v4.1-flash")).toEqual({
      supported: true,
      efforts: ["low"],
    });
  });

  it("a fetch FAILURE leaves the rows as stored — best-effort, never a failed request", async () => {
    legacyRow();
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{ modelId: string; reasoningSupport: unknown }>;
    expect(models.find((m) => m.modelId === "deepseek/deepseek-v4.1-flash")?.reasoningSupport).toBeNull();
    expect(resolveModelReasoningSupport(db, "openrouter", "deepseek/deepseek-v4.1-flash")).toBeNull();

    // The failure COOLDOWN: an immediate second read does not re-fetch (one
    // dead-provider attempt per 5-minute window — the modelCache's cadence).
    const again = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(again.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no NULL rows → no catalog fetch at all (the steady state is free)", async () => {
    upsertModel(db, "openrouter", {
      modelId: "deepseek/deepseek-v4.1-flash",
      reasoningSupport: { supported: true, efforts: ["low", "high", "max"], defaultEffort: "high" },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
