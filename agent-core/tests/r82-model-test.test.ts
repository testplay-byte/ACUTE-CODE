/**
 * ROUND-82 (R82, owner: "a test button … to check if the model is working
 * properly or not") — the PER-MODEL test probe, POST /api/v1/models/:id/test:
 *
 *   · Row-id address space: the route takes the ROW id (mdl_…, the same id
 *     PATCH/DELETE /models/:id use) — 404 for unknown rows.
 *   · Route guards (before any network): 409 provider-missing (the model row
 *     references a provider that no longer exists — a dangling reference),
 *     409 no-baseUrl, 409 no-key (slot-aware: body.slot 0-31 mirrors the
 *     R47-b /providers/:id/test contract; an empty slot 409s naming the slot).
 *   · testModelResponse branches on provider.apiFormat — chat-completions
 *     POST {base}/chat/completions {model, messages, max_tokens: 64,
 *     temperature: 0, stream: false}; anthropic-messages POST {base}/messages
 *     with x-api-key + anthropic-version headers; responses POST
 *     {base}/responses {model, input, max_output_tokens: 64}.
 *   · The verdict is HTTP 200 BOTH ways (a probe that RAN and got a NO is a
 *     successful test call): {ok, latencyMs, providerId, model, checks:
 *     {http, auth, modelAccepted, nonEmptyContent}, contentPreview?, usage?,
 *     reason?} — 401 → auth:false; 404 → modelAccepted:false with the RAW
 *     provider body in the reason (the R80 raw-messages discipline — the
 *     EOL'd-NIM 410 shows verbatim); a 200-with-error-body (some
 *     OpenAI-compatible gateways) → modelAccepted:false; empty content 200 →
 *     nonEmptyContent:false.
 *   · Transport failures → 502 PROVIDER_ERROR (scrubbed).
 *   · Key scrubbing: the resolved key never appears unmasked anywhere, and
 *     key SHAPES (sk-…/nvapi-…) in surfaced content are masked (the
 *     lib/secret-shapes.ts consolidation).
 *
 * Route-level app.inject patterns follow providers.test.ts (the
 * /providers/:id/test suite this route mirrors).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  createProviderRecord,
  updateProviderRecord,
} from "../src/storage/providers";
import { upsertModel } from "../src/storage/models";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r82mt";
// Key shapes ≥16 chars past the prefix so the secret-SHAPE regexes can fire
// (sk-…/nvapi-… patterns — see lib/secret-shapes.ts).
const KEY = "sk-or-vtest-r82mt-9876543210";
const SLOT2_KEY = "sk-or-slot2-r82mt-1234567890";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "test/gw-model";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r82mt-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // The custom provider the model rows under test belong to (the Settings
  // "Add provider" shape — real row, real baseUrl).
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: GW_BASE });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_OPENROUTER_SLOT2: SLOT2_KEY,
      ACUTE_PROVIDER_PRV_GW: KEY,
      ACUTE_PROVIDER_ANTHROPIC: KEY,
    }),
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

/** A configured model row (the mdl_… id the route addresses). */
function makeModelRow(providerId = GW_ID, modelId = GW_MODEL): string {
  return upsertModel(db, providerId, { modelId }).id;
}

/** The healthy chat-completions 200 body a probe expects. */
function chatOkBody(text = "pong"): Record<string, unknown> {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 9, completion_tokens: 1 },
  };
}

describe("R82: POST /api/v1/models/:id/test — route guards (before any network)", () => {
  it("404s an unknown model ROW id (mdl_ address space) without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: "/api/v1/models/mdl_nope/test",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(response.json().error.message).toContain("no model with id mdl_nope");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("409s a model row whose PROVIDER no longer exists (the dangling reference)", async () => {
    const rowId = makeModelRow();
    // The schema's FK cascades model rows away on provider delete, so the
    // dangling-reference state the guard exists for (defense-in-depth for
    // hand-edited/older DBs) is produced with the FK check suspended for
    // this one statement only.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM providers WHERE id = ?").run(GW_ID);
    db.pragma("foreign_keys = ON");
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("no longer exists");
    expect(response.json().error.message).toContain(GW_MODEL);
    expect(response.json().error.details).toEqual({
      providerId: GW_ID,
      modelId: GW_MODEL,
    });
  });

  it("409s a provider with NO baseUrl — the probe has nowhere to go", async () => {
    const rowId = makeModelRow();
    const gateway = (await import("../src/storage/providers")).getProviderRecord(db, GW_ID)!;
    updateProviderRecord(db, { ...gateway, baseUrl: null });
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("no baseUrl");
    expect(response.json().error.message).toContain(GW_ID);
    expect(response.json().error.details.providerId).toBe(GW_ID);
  });

  it("409s when NO key is stored for the model's provider (a separate keyless app)", async () => {
    const rowId = makeModelRow();
    const keyless = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
    });
    try {
      const response = await keyless.inject({
        method: "POST",
        url: `/api/v1/models/${rowId}/test`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
      expect(response.json().error.message).toContain(`no API key stored for provider '${GW_ID}'`);
      expect(response.json().error.message).toContain("Settings → Models & Providers");
      expect(response.json().error.details.providerId).toBe(GW_ID);
    } finally {
      await keyless.close();
    }
  });

  it("with {slot: 2}: an EMPTY slot is 409 CONFLICT naming provider AND slot", async () => {
    const rowId = makeModelRow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // This app's keyring holds only the gateway's PRIMARY key — slot 2 is
    // empty for a custom provider (slot 2 is mapped, just unfilled).
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: { slot: 2 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain(`provider '${GW_ID}' slot 2`);
    expect(response.json().error.details).toEqual({ providerId: GW_ID, slot: 2 });
    // Empty slot → the probe never fires.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with {slot: 2}: a FILLED slot's key is the one the probe carries", async () => {
    // Model row under openrouter — whose slot 2 IS filled in this keyring.
    const rowId = makeModelRow("openrouter", "test/model-a");
    let seenAuth = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit | undefined) => {
      seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
      return new Response(JSON.stringify(chatOkBody()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: { slot: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(seenAuth).toBe(`Bearer ${SLOT2_KEY}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Neither key value ever reaches the response body.
    expect(response.body).not.toContain(SLOT2_KEY);
    expect(response.body).not.toContain(KEY);
  });

  it("rejects a bad slot with 400 VALIDATION (the 0-31 pool, R47-b contract)", async () => {
    const rowId = makeModelRow();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: { slot: 99 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.slot");
  });
});

describe("R82: testModelResponse — the chat-completions branch", () => {
  it("a happy 200 completion is ok:true with every check, the content preview, and usage", async () => {
    const rowId = makeModelRow();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(JSON.stringify(chatOkBody()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      providerId: GW_ID,
      model: GW_MODEL,
      checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true },
      contentPreview: "pong",
      usage: { inputTokens: 9, outputTokens: 1 },
    });
    // The request the probe really sent: {baseUrl}/chat/completions, the
    // resolved key, the exact probe body (64 tokens, temperature 0, no
    // stream — a cheap, deterministic completion).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GW_BASE}/chat/completions`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: GW_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
      max_tokens: 64,
      temperature: 0,
      stream: false,
    });
  });

  it("a 200 with EMPTY content is ok:false — nonEmptyContent is the failing check", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 })),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      providerId: GW_ID,
      model: GW_MODEL,
      checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: false },
    });
    expect(response.json().reason).toContain("empty response");
    expect(response.json().reason).toContain("HTTP 200");
  });

  it("a 401 is ok:false with auth:false and the raw rejection text in the reason", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual({ http: true, auth: false, modelAccepted: true, nonEmptyContent: false });
    expect(body.reason).toContain("key rejected by provider (HTTP 401)");
    expect(body.reason).toContain("Invalid API key");
  });

  it("a 404 is ok:false with modelAccepted:false and the RAW provider body in the reason", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "No endpoints found for the requested model: " + GW_MODEL },
            }),
            { status: 404 },
          ),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual({ http: true, auth: true, modelAccepted: false, nonEmptyContent: false });
    // The R80 raw-messages discipline: the real body rides the reason —
    // "NVIDIA model X is EOL'd" shows the provider's own words.
    expect(body.reason).toContain("provider rejected the request (HTTP 404)");
    expect(body.reason).toContain("No endpoints found for the requested model");
    expect(body.reason).toContain("check the model id");
  });

  it("a 200 WITH an error body (some OpenAI-compatible gateways) fails modelAccepted", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "model is deprecated, use v2" } }),
            { status: 200 },
          ),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.modelAccepted).toBe(false);
    expect(body.reason).toContain("HTTP 200 with an error body");
    expect(body.reason).toContain("model is deprecated, use v2");
  });
});

describe("R82: testModelResponse — the anthropic-messages branch", () => {
  it("uses x-api-key + anthropic-version headers and parses content[].text + usage", async () => {
    // The seeded built-in anthropic row carries apiFormat
    // "anthropic-messages" + baseUrl https://api.anthropic.com/v1.
    const rowId = makeModelRow("anthropic", "claude-r82-test");
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "pong" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      providerId: "anthropic",
      model: "claude-r82-test",
      checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true },
      contentPreview: "pong",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    // The anthropic dialect: POST {base}/messages, x-api-key (NOT bearer),
    // the version header, {model, max_tokens, messages}.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-r82-test",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
    });
  });
});

describe("R82: testModelResponse — the responses branch", () => {
  it("posts {base}/responses with the Responses shape and parses output_text", async () => {
    // No builtin row carries the responses format today — set it on the
    // custom gateway row (the ProviderRecord.apiFormat escape hatch).
    const gateway = (await import("../src/storage/providers")).getProviderRecord(db, GW_ID)!;
    updateProviderRecord(db, { ...gateway, apiFormat: "responses" });
    const rowId = makeModelRow();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(
          JSON.stringify({
            output_text: "pong",
            usage: { input_tokens: 6, output_tokens: 3 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      providerId: GW_ID,
      model: GW_MODEL,
      checks: { http: true, auth: true, modelAccepted: true, nonEmptyContent: true },
      contentPreview: "pong",
      usage: { inputTokens: 6, outputTokens: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GW_BASE}/responses`);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: GW_MODEL,
      input: "Reply with exactly one word: pong",
      max_output_tokens: 64,
    });
  });
});

describe("R82: POST /models/:id/test — transport failures and key scrubbing", () => {
  it("maps a transport throw to 502 PROVIDER_ERROR with a scrubbed message", async () => {
    const rowId = makeModelRow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED ${KEY}`);
      }),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PROVIDER_ERROR");
    expect(response.body).not.toContain(KEY);
    expect(response.body).toContain("***");
    expect(response.json().error.details).toEqual({ providerId: GW_ID, modelId: GW_MODEL });
  });

  it("SCRUB PIN: a provider body echoing the KEY is masked — no unmasked key anywhere in the response", async () => {
    const rowId = makeModelRow();
    // The provider's 404 body quotes the very key that sent the request.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: `key ${KEY} is not authorized for model ${GW_MODEL}` },
            }),
            { status: 404 },
          ),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    // The exact key value is replaced with the masked form wherever the
    // body surfaced it.
    expect(response.json().reason).toContain("***");
    // THE invariant: the unmasked key NEVER reaches the response.
    expect(response.body).not.toContain(KEY);
  });

  it("SHAPE SCRUB: a key-SHAPED secret in the reply content is masked in contentPreview", async () => {
    const rowId = makeModelRow();
    // The model echoes a FOREIGN nvapi- key (not the resolved one — only
    // the shape regexes can catch it; the shared secret-shapes helper).
    const foreign = "nvapi-foreignkey0987654321";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(chatOkBody(`leaked ${foreign} here`)), { status: 200 })),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/models/${rowId}/test`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(response.json().contentPreview).toContain("nvapi-***");
    // The unmasked shape never reaches the response.
    expect(response.body).not.toContain(foreign);
  });
});
