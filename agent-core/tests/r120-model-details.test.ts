/**
 * ROUND-120 (R120-M, §1 item 20 — the mobile model editor's SMART FETCH:
 * "fetch the model's real info from the provider … parse context_length /
 * max_completion_tokens / pricing fields when present") — the per-model
 * catalog DETAILS extraction on GET /providers/:id/models.
 *
 * Coverage:
 *  · an OpenRouter-shaped entry yields `details`: context_length →
 *    contextWindow, top_provider.max_completion_tokens → maxOutputTokens,
 *    the per-token pricing strings scaled ×1e6 to USD/Mtok (prompt /
 *    completion / input_cache_read; 0 stays the honest 0), tools in
 *    supported_parameters → supportsTools, and the architecture
 *    input_modalities membership → vision/audio/video.
 *  · a PLAIN OpenAI listing ({id, object, owned_by}) carries NO details key
 *    (additive absence — the phone renders its "provider didn't serve
 *    model details" line, never a fabricated 0).
 *  · malformed values skip ONE field at a time (a junk pricing string never
 *    takes the context window down with it); negative/zero sizing is not
 *    a context window.
 *  · the details ride the SAME 5-minute cache as the rest of the entry.
 *
 * Style: providers.test.ts's route pattern (fetch stub + authInject). NOT
 * gated in the R120-M worktree (no agent-core node_modules — per the wave
 * rules the full ladder runs on the merged tree).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring, clearModelCache } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r120m";
const KEY = "sk-or-vtest-r120m";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  clearModelCache();
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r120m-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
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
    /* best-effort (Windows file-handle lag) */
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

function stubModels(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe("R120-M: GET /providers/:id/models serves the per-model catalog details", () => {
  it("an OpenRouter-shaped entry yields the scaled pricing trio + sizing + the modality/tool hints", async () => {
    stubModels({
      data: [
        {
          id: "test/vision-reasoner",
          name: "Test Vision Reasoner",
          context_length: 256000,
          top_provider: { max_completion_tokens: 230400 },
          pricing: {
            prompt: "0.0000025",
            completion: "0.00001",
            input_cache_read: "0.00000125",
          },
          supported_parameters: ["max_tokens", "reasoning", "tools"],
          architecture: { input_modalities: ["text", "image", "audio"] },
        },
      ],
    });
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(response.statusCode).toBe(200);
    const models = response.json().models as Array<{
      id: string;
      details?: Record<string, unknown>;
    }>;
    expect(models[0].details).toEqual({
      contextWindow: 256000,
      maxOutputTokens: 230400,
      inputPricePerMtok: 2.5,
      outputPricePerMtok: 10,
      inputPriceCachedPerMtok: 1.25,
      supportsTools: true,
      supportsVision: true,
      supportsAudio: true,
      supportsVideo: false,
    });
  });

  it("a free model's 0 pricing stays the honest 0 — never skipped, never negative", async () => {
    stubModels({
      data: [
        {
          id: "test/free-model",
          pricing: { prompt: "0", completion: 0, input_cache_read: "" },
          context_length: 131072,
        },
      ],
    });
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    const models = response.json().models as Array<{
      details?: Record<string, unknown>;
    }>;
    expect(models[0].details).toEqual({
      contextWindow: 131072,
      inputPricePerMtok: 0,
      outputPricePerMtok: 0,
      // input_cache_read "" does not parse → the field is absent, not 0.
    });
  });

  it("a PLAIN OpenAI listing carries NO details key (additive absence)", async () => {
    stubModels({
      data: [
        { id: "gpt-test", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-plain", name: "Plain" },
      ],
    });
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    const models = response.json().models as Array<{
      details?: unknown;
    }>;
    expect(models[0].details).toBeUndefined();
    expect(models[1].details).toBeUndefined();
    // The R95 reasoning field stays absent too — the entry is untouched.
    expect(models[0]).toEqual({ id: "gpt-test", name: "gpt-test" });
  });

  it("malformed values skip ONE field at a time — never the whole entry", async () => {
    stubModels({
      data: [
        {
          id: "test/partial",
          context_length: "lots", // junk → skipped
          top_provider: { max_completion_tokens: 8192 },
          pricing: { prompt: "not-a-number", completion: "0.000002" }, // prompt skipped, completion parses
          supported_parameters: "nope", // not an array → supportsTools absent
          architecture: { input_modalities: ["text", "image"] },
        },
      ],
    });
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    const models = response.json().models as Array<{
      details?: Record<string, unknown>;
    }>;
    expect(models[0].details).toEqual({
      maxOutputTokens: 8192,
      outputPricePerMtok: 2,
      supportsVision: true,
      supportsAudio: false,
      supportsVideo: false,
    });
  });

  it("the details ride the SAME 5-minute cache (a second call is cached:true, one fetch)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "test/cached", context_length: 1000000 }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    const second = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(first.json().cached).toBe(false);
    expect(second.json().cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const models = second.json().models as Array<{ details?: { contextWindow?: number } }>;
    expect(models[0].details?.contextWindow).toBe(1000000);
  });
});
