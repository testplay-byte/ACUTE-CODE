import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring, clearModelCache } from "../src/providers/registry";
import { MODEL_CATALOG } from "../src/storage/models";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProviderRecord } from "../src/storage/providers";
import { buildServer } from "../src/server";

const TOKEN = "test-token-7c2d";
const KEY = "sk-or-test-4f8a";
// ROUND-47: a second, distinguishable key for slot-scoped probe tests.
const SLOT2_KEY = "sk-or-slot2-9d31";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  clearModelCache();
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-providers-"));
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
    // Best-effort: Windows sometimes holds file handles briefly after close.
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

function modelsPayload(): Record<string, unknown> {
  return {
    data: [
      { id: "test/model-a", name: "Model A" },
      { id: "test/model-b" },
      { id: 123 }, // junk entry is skipped
      "nope",
    ],
  };
}

describe("GET /api/v1/providers", () => {
  it("seeds exactly one enabled openrouter row on a fresh database, before any request", () => {
    const fresh = openDatabase(join(tempDir, `${randomUUID()}.db`));
    try {
      const rows = fresh.prepare("SELECT id, enabled FROM providers").all() as Array<{
        id: string;
        enabled: number;
      }>;
      expect(rows).toEqual([
        { id: "openrouter", enabled: 1 },
        { id: "anthropic", enabled: 1 },
        { id: "openai", enabled: 1 },
        { id: "google", enabled: 1 },
        { id: "nvidia", enabled: 1 }, // R80: the NIM seed
      ]);
    } finally {
      fresh.close();
    }
  });

  it("keeps the seed idempotent across repeated opens of the same database", () => {
    const path = join(tempDir, `${randomUUID()}.db`);
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path);
    try {
      // The PK on providers.id backstops the existence check: no duplicates.
      const rows = second.prepare("SELECT id FROM providers").all() as { id: string }[];
      expect(rows.map((row) => row.id)).toEqual(["anthropic", "google", "nvidia", "openai", "openrouter"]);
    } finally {
      second.close();
    }
  });

  it("lists the seeded openrouter record with hasKey=false when unconfigured", async () => {
    const bare = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const response = await bare.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      // ROUND-92 (R92-D): keyCount joins the ProviderView — the DEDUPED pool
      // size (0 for every unconfigured seed here). ROUND-113 (R113-a):
      // configured joins too — false for every keyless seed (the "add a
      // key" tier); hasKey is now POOL-AWARE but stays false with no keys
      // at all.
      expect(response.json()).toEqual({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            kind: "openai-compatible",
            baseUrl: "https://api.anthropic.com/v1",
            // R37 review #9: the Anthropic endpoint speaks the Messages API —
            // seeding chat-completions shipped a 404-by-default provider.
            apiFormat: "anthropic-messages",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
            configured: false,
            keyCount: 0,
          },
          {
            id: "google",
            name: "Google",
            kind: "openai-compatible",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            apiFormat: "chat-completions",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
            configured: false,
            keyCount: 0,
          },
          {
            id: "nvidia",
            name: "NVIDIA",
            kind: "openai-compatible",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiFormat: "chat-completions",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
            configured: false,
            keyCount: 0,
          },
          {
            id: "openai",
            name: "OpenAI",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiFormat: "chat-completions",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
            configured: false,
            keyCount: 0,
          },
          {
            id: "openrouter",
            name: "OpenRouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api/v1",
            apiFormat: "chat-completions",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
            configured: false,
            keyCount: 0,
          },
        ],
      });
    } finally {
      await bare.close();
    }
  });

  it("reports hasKey=true when the env-injected key is present, without leaking it", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/providers" });
    expect(response.statusCode).toBe(200);
    const openrouter = response.json().providers.find(
      (provider: { id: string }) => provider.id === "openrouter",
    );
    expect(openrouter.hasKey).toBe(true);
    // R113-a: a keyed seed is configured (keyCount > 0); the keyless seeds
    // in the same list are not.
    expect(openrouter.configured).toBe(true);
    const anthropic = response.json().providers.find(
      (provider: { id: string }) => provider.id === "anthropic",
    );
    expect(anthropic.configured).toBe(false);
    expect(response.body).not.toContain(KEY);
  });

  it("creates the openrouter row exactly once across repeated listings", async () => {
    await authInject({ method: "GET", url: "/api/v1/providers" });
    await authInject({ method: "GET", url: "/api/v1/providers" });
    const rows = db.prepare("SELECT id FROM providers").all() as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["anthropic", "google", "nvidia", "openai", "openrouter"]);
  });

  it("keeps custom rows and adds no duplicates when an existing database is reopened", () => {
    const path = join(tempDir, `${randomUUID()}.db`);
    const first = openDatabase(path);
    try {
      createProviderRecord(first, {
        id: "prv_groq",
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
      });
    } finally {
      first.close();
    }
    const second = openDatabase(path);
    try {
      const rows = second.prepare("SELECT id FROM providers").all() as { id: string }[];
      expect(rows.map((row) => row.id).sort()).toEqual([
        "anthropic",
        "google",
        "nvidia",
        "openai",
        "openrouter",
        "prv_groq",
      ]);
    } finally {
      second.close();
    }
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});

/* ── R113-a: the honest `configured` flag + POOL-AWARE `hasKey` ────────────
 *
 * Pre-R113, hasKey read ONLY the primary env slot (keyring.has), so a
 * provider whose keys lived solely in pool slots ≥ 1 read
 * hasKey:false with keyCount:2 — and the desktop's client-side filter HID a
 * perfectly configured provider. The fix: hasKey = keyCount > 0 (the same
 * deduped pool the turn runners juggle), plus the NEW `configured` bit —
 * true for CUSTOM rows (the user explicitly created them, keyless or not)
 * or any held key. */
describe("R113-a: GET /providers — pool-aware hasKey + configured", () => {
  it("hasKey is POOL-AWARE: keys only in pool slots ≥ 1 now read hasKey:true", async () => {
    const pooled = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        // NO primary slot — exactly the owner's broken case.
        ACUTE_PROVIDER_OPENROUTER_SLOT1: "sk-pool-only-1",
        ACUTE_PROVIDER_OPENROUTER_SLOT2: "sk-pool-only-2",
      }),
    });
    try {
      const response = await pooled.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const openrouter = (
        response.json().providers as Array<{ id: string; hasKey: boolean; configured: boolean; keyCount: number }>
      ).find((p) => p.id === "openrouter");
      // THE FIX: pre-R113 this read hasKey:false, keyCount:2.
      expect(openrouter).toMatchObject({ hasKey: true, configured: true, keyCount: 2 });
    } finally {
      await pooled.close();
    }
  });

  it("a CUSTOM row counts as configured even with NO key (the user made it)", async () => {
    // prv_groq is custom (not in RESERVED_PROVIDER_IDS) and keyless.
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { name: "Local NIM", baseUrl: "http://localhost:8000/v1" },
    });
    expect(created.statusCode).toBe(201);
    const row = (created.json() as { id: string; hasKey: boolean; configured: boolean });
    expect(row.hasKey).toBe(false);
    expect(row.configured).toBe(true);
  });

  it("the three fields derive from ONE pool snapshot and never disagree", async () => {
    const mixed = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY, // primary + a duplicate-value slot
        ACUTE_PROVIDER_OPENROUTER_SLOT2: KEY,
        ACUTE_PROVIDER_OPENROUTER_SLOT3: SLOT2_KEY,
      }),
    });
    try {
      const response = await mixed.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const openrouter = (
        response.json().providers as Array<{
          id: string;
          hasKey: boolean;
          configured: boolean;
          keyCount: number;
        }>
      ).find((p) => p.id === "openrouter");
      // Deduped pool: {KEY (slots 0+2), SLOT2_KEY (slot 3)} → 2 keys.
      expect(openrouter).toEqual(
        expect.objectContaining({ hasKey: true, configured: true, keyCount: 2 }),
      );
      // Invariant: hasKey === (keyCount > 0) on EVERY row.
      const rows = response.json().providers as Array<{ hasKey: boolean; keyCount: number }>;
      for (const r of rows) expect(r.hasKey).toBe(r.keyCount > 0);
    } finally {
      await mixed.close();
    }
  });
});

describe("POST /api/v1/providers", () => {
  it("registers a custom OpenAI-compatible provider", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: "prv_groq",
      name: "Groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      enabled: true,
      hasKey: false,
    });

    const listed = await authInject({ method: "GET", url: "/api/v1/providers" });
    const ids = listed
      .json()
      .providers.map((provider: { id: string }) => provider.id)
      .sort();
    expect(ids).toEqual(["anthropic", "google", "nvidia", "openai", "openrouter", "prv_groq"]);
  });

  it("accepts an explicit id and honors an env-injected key for it", async () => {
    const withKey = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_MY_PROXY: "sk-mine" }),
    });
    try {
      const created = await withKey.inject({
        method: "POST",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "my-proxy", name: "My Proxy", baseUrl: "http://localhost:9/v1" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ id: "my-proxy", hasKey: true });
      expect(created.body).not.toContain("sk-mine");
    } finally {
      await withKey.close();
    }
  });

  const badBodies: Array<{ name: string; payload: unknown; field: string }> = [
    { name: "missing name", payload: { baseUrl: "https://x.test/v1" }, field: "body.name" },
    { name: "empty name", payload: { name: "  ", baseUrl: "https://x.test/v1" }, field: "body.name" },
    { name: "missing baseUrl", payload: { name: "X" }, field: "body.baseUrl" },
    { name: "malformed URL", payload: { name: "X", baseUrl: "not-a-url" }, field: "body.baseUrl" },
    {
      name: "non-http protocol",
      payload: { name: "X", baseUrl: "ftp://x.test/v1" },
      field: "body.baseUrl",
    },
    { name: "empty id", payload: { name: "X", baseUrl: "https://x.test/v1", id: " " }, field: "body.id" },
  ];
  for (const testCase of badBodies) {
    it(`rejects ${testCase.name} with 400 VALIDATION`, async () => {
      const response = await authInject({
        method: "POST",
        url: "/api/v1/providers",
        payload: testCase.payload as Record<string, unknown>,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe(testCase.field);
    });
  }

  it("R89-B1: a KEYLESS reserved row is ADOPTED in place (the owner's 'already exists' bug)", async () => {
    // anthropic is seeded but has NO key → invisible in the UI. Adding the
    // preset with a fresh name configures THAT row (200 adopted), never 409.
    const seeded = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "anthropic", name: "Fake Anthropic", baseUrl: "https://x.test/v1" },
    });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json()).toMatchObject({
      id: "anthropic",
      name: "Fake Anthropic",
      adopted: true,
      hasKey: false,
    });

    // The adoption is a real row update: the list shows the new name once a
    // key lands (hasKey true).
    const key = await authInject({
      method: "PUT",
      url: "/api/v1/providers/anthropic/key",
      payload: { value: "sk-test-adopt" },
    });
    expect(key.statusCode).toBe(204);
    const adopted = await authInject({ method: "GET", url: "/api/v1/providers" });
    const row = (adopted.json().providers as Array<{ id: string; name: string; hasKey: boolean }>).find(
      (p) => p.id === "anthropic",
    );
    expect(row).toMatchObject({ name: "Fake Anthropic", hasKey: true });
  });

  it("R89-B1: a CONFIGURED row at the wanted id derives a fresh id from the NAME (same-type adds)", async () => {
    // Configure the nvidia seed first (adopt + key).
    const adopt = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1" },
    });
    expect(adopt.statusCode).toBe(200);
    await authInject({
      method: "PUT",
      url: "/api/v1/providers/nvidia/key",
      payload: { value: "nvapi-test-1" },
    });

    // A SECOND NVIDIA under a different name: id nvidia is taken + has a key
    // → the request derives prv_<name-slug> and creates it (the owner's
    // "10 OpenRouter providers" rule).
    const second = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "nvidia", name: "NVIDIA Work", baseUrl: "https://integrate.api.nvidia.com/v1" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ id: "prv_nvidia-work", name: "NVIDIA Work" });

    // And a third with the same derived slug → walks the -2 suffix.
    const third = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "nvidia", name: "NVIDIA Work", baseUrl: "https://integrate.api.nvidia.com/v1" },
    });
    expect(third.statusCode).toBe(409); // same NAME — the real rule
    expect(third.json().error.details.field).toBe("body.name");
  });

  it("R89-B1: the NAME is the uniqueness key — a duplicate name 409s with field body.name", async () => {
    const first = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "edge", name: "Edge", baseUrl: "https://edge.test/v1" },
    });
    expect(first.statusCode).toBe(201);
    // The row is keyless → ADOPTABLE under the SAME name (re-add the preset
    // = configure it): not a name conflict with itself.
    const again = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "edge", name: "Edge", baseUrl: "https://edge-2.test/v1" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ adopted: true, baseUrl: "https://edge-2.test/v1" });

    // A DIFFERENT provider under the name "Edge" → 409 body.name.
    const clash = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { name: "Edge", baseUrl: "https://elsewhere.test/v1" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("CONFLICT");
    expect(clash.json().error.details.field).toBe("body.name");
  });

  it("ROUND-37 (kept): a reserved id whose row was deleted can be re-claimed (tombstone cleared)", async () => {
    const del = await authInject({ method: "DELETE", url: "/api/v1/providers/anthropic" });
    expect(del.statusCode).toBe(204);
    const resurrected = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic-messages" },
    });
    expect(resurrected.statusCode).toBe(201);
    expect(resurrected.json()).toMatchObject({ id: "anthropic", apiFormat: "anthropic-messages" });
  });
});

describe("GET /api/v1/providers/:id/models", () => {
  it("fetches the endpoint's /models and caches in-memory for 5 minutes", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(JSON.stringify(modelsPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      models: [
        { id: "test/model-a", name: "Model A" },
        { id: "test/model-b", name: "test/model-b" },
      ],
      cached: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);

    const second = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(second.statusCode).toBe(200);
    expect(second.json().cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // served from cache
  });

  it("returns 502 PROVIDER_ERROR when the upstream fetch fails, without leaking the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED ${KEY}`);
      }),
    );
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PROVIDER_ERROR");
    expect(response.body).not.toContain(KEY);
    expect(response.body).toContain("***");

    // A failed fetch is not cached: the error path leaves nothing behind.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(modelsPayload()))));
    const retried = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/models" });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().cached).toBe(false);
  });

  it("returns 502 on a non-200 upstream status and on an unusable body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const unauthorized = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models",
    });
    expect(unauthorized.statusCode).toBe(502);
    expect(unauthorized.json().error.message).toContain("HTTP 401");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nope: true }))));
    const malformed = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models",
    });
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json().error.code).toBe("PROVIDER_ERROR");
  });

  it("404s for an unknown provider id", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/providers/nope/models" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/providers/:id/test", () => {
  it("with a model: runs a one-token completion against {baseUrl}/chat/completions — the REAL key+model probe", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { model: "test/model-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      model: "test/model-a",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body)).model).toBe("test/model-a");

    // The completion probe never touches the model catalog.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a model: probes {baseUrl}/models for reachability and says so", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit | undefined) =>
        new Response(JSON.stringify(modelsPayload()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bare = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(bare.statusCode).toBe(200);
    const body = bare.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain("Reachable");
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models");
  });

  it("reports ok:false (HTTP 200) when the upstream rejects the KEY — never a fake success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { model: "test/model-a" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("key rejected");
    expect(body.message).toContain("Invalid API key");
  });

  it("reports ok:false (HTTP 200) when the upstream rejects the MODEL id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "No endpoints found for model" } }), {
            status: 404,
          }),
      ),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { model: "totally/bogus-model" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("model id");
    expect(body.message).toContain("No endpoints found");
  });

  it("returns 409 CONFLICT when no key is stored for the provider", async () => {
    const unkeyed = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const response = await unkeyed.inject({
        method: "POST",
        url: "/api/v1/providers/openrouter/test",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
      expect(response.json().error.message).toContain("no API key stored");
      expect(response.json().error.details.providerId).toBe("openrouter");
    } finally {
      await unkeyed.close();
    }
  });

  it("404s for an unknown provider id before touching the keyring or network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({ method: "POST", url: "/api/v1/providers/nope/test" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream transport failure to 502 PROVIDER_ERROR with a scrubbed message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED ${KEY}`);
      }),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("PROVIDER_ERROR");
    expect(response.body).not.toContain(KEY);
    expect(response.body).toContain("***");
    expect(response.json().error.details.providerId).toBe("openrouter");
  });

  it("maps a non-200 reachability answer (no model) to 502 PROVIDER_ERROR naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 500 })));
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: {},
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("HTTP 500");
  });

  it("rejects a malformed body with 400 VALIDATION", async () => {
    const badModel = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { model: "" },
    });
    expect(badModel.statusCode).toBe(400);
    expect(badModel.json().error.details.field).toBe("body.model");
  });

  // ── ROUND-47 (R47-b): {slot} — slot-scoped key probes ───────────────────

  it("ROUND-47: with {slot: 2} the probe carries THAT pool slot's key, not the primary", async () => {
    // The keyring maps slot 2 to ACUTE_PROVIDER_OPENROUTER_SLOT2 (slot 0 is
    // the primary ACUTE_PROVIDER_OPENROUTER — see slotEnvVarName).
    const pooled = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY,
        ACUTE_PROVIDER_OPENROUTER_SLOT2: SLOT2_KEY,
      }),
    });
    try {
      let seenAuth = "";
      const fetchMock = vi.fn(
        async (_url: string, init: RequestInit | undefined) => {
          seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      // Model + slot combine: the full key+model probe runs against the
      // SLOT key (the Key Pool UI's per-slot Test button).
      const response = await pooled.inject({
        method: "POST",
        url: "/api/v1/providers/openrouter/test",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { model: "test/model-a", slot: 2 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        model: "test/model-a",
      });
      expect(seenAuth).toBe(`Bearer ${SLOT2_KEY}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Neither key value ever reaches the response body.
      expect(response.body).not.toContain(SLOT2_KEY);
      expect(response.body).not.toContain(KEY);
    } finally {
      await pooled.close();
    }
  });

  it("ROUND-47: {slot: 0} explicitly given probes the PRIMARY key (slot 0 == the primary pool slot)", async () => {
    let seenAuth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit | undefined) => {
        seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }),
    );
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { slot: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(seenAuth).toBe(`Bearer ${KEY}`);
  });

  it("ROUND-47: a slot that holds no key is 409 CONFLICT naming provider AND slot", async () => {
    // The default app holds only the primary key — slot 2 is empty.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/test",
      payload: { slot: 2 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("no API key stored");
    expect(response.json().error.message).toContain("slot 2");
    expect(response.json().error.message).toContain("Settings → Models & Providers");
    expect(response.json().error.details).toEqual({ providerId: "openrouter", slot: 2 });
    // Empty slot → the probe never fires.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const badSlots: Array<{ name: string; slot: unknown }> = [
    { name: "non-numeric string", slot: "abc" },
    { name: "negative", slot: -1 },
    { name: "too large", slot: 99 },
    { name: "fractional", slot: 1.5 },
    { name: "null", slot: null },
  ];
  for (const testCase of badSlots) {
    it(`ROUND-47: rejects slot=${String(testCase.slot)} (${testCase.name}) with 400 VALIDATION`, async () => {
      const response = await authInject({
        method: "POST",
        url: "/api/v1/providers/openrouter/test",
        payload: { slot: testCase.slot },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe("body.slot");
    });
  }
});

describe("POST /internal/providers/keys (shell key handoff)", () => {
  it("rotates the in-memory key so the next test uses it — and hasKey reflects it", async () => {
    const rotated = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const push = await rotated.inject({
        method: "POST",
        url: "/internal/providers/keys",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { providerId: "openrouter", keyName: "main", value: `rotated-${KEY}`, action: "set" },
      });
      expect(push.statusCode).toBe(204);

      const listed = await rotated.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const row = (listed.json().providers as Array<{ id: string; hasKey: boolean }>).find(
        (p) => p.id === "openrouter",
      );
      expect(row?.hasKey).toBe(true);

      // The probe actually carries the rotated key.
      let seenAuth = "";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit | undefined) => {
          seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }),
      );
      const test = await rotated.inject({
        method: "POST",
        url: "/api/v1/providers/openrouter/test",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { model: "test/model-a" },
      });
      expect(test.statusCode).toBe(200);
      expect(test.json().ok).toBe(true);
      expect(seenAuth).toBe(`Bearer rotated-${KEY}`);
    } finally {
      await rotated.close();
    }
  });

  it("requires the bearer token like every other route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "openrouter", value: "x" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed payload with 400 and never echoes the value", async () => {
    const response = await authInject({
      method: "POST",
      url: "/internal/providers/keys",
      payload: { providerId: "NOT-A-SLUG", value: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("x");
  });
});

// ── R93-A5: the slot-1 pool listing (the owner's "keys added but not
// shown" report) ─────────────────────────────────────────────────────────
// The R92-D3 UI lowered MIN_POOL_SLOT to 1, so the FIRST added pool key
// lands at slot 1 — but poolInfo's maxSlot scan still counted only slots
// >= 2, so a [primary + slot 1] provider listed just Key 1 in the API
// keys card while the provider row's chip said "2 keys".
describe("GET /api/v1/providers/:id/keys (R93: slot 1 is listed)", () => {
  it("a [primary + slot 1] pool lists BOTH keys (the first added key is visible)", async () => {
    const SLOT1_KEY = "sk-or-slot1-r93a1";
    const pooled = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY,
        ACUTE_PROVIDER_OPENROUTER_SLOT1: SLOT1_KEY,
      }),
    });
    try {
      const response = await pooled.inject({
        method: "GET",
        url: "/api/v1/providers/openrouter/keys",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const keys = response.json().keys as Array<{
        slot: number;
        hasKey: boolean;
        masked: string | null;
      }>;
      // Both slots present — the card renders Key 1 (primary) + Key 2 (slot 1).
      expect(keys.map((k) => k.slot)).toEqual([0, 1]);
      expect(keys.every((k) => k.hasKey)).toBe(true);
      expect(keys[1]!.masked).toBe(`${SLOT1_KEY.slice(0, 4)}…${SLOT1_KEY.slice(-4)}`);
      // The key VALUE never leaves the process.
      expect(response.body).not.toContain(SLOT1_KEY);
    } finally {
      await pooled.close();
    }
  });

  it("a [primary + slot 2] pool keeps listing every slot (no regression)", async () => {
    const pooled = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({
        ACUTE_PROVIDER_OPENROUTER: KEY,
        ACUTE_PROVIDER_OPENROUTER_SLOT2: SLOT2_KEY,
      }),
    });
    try {
      const response = await pooled.inject({
        method: "GET",
        url: "/api/v1/providers/openrouter/keys",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const keys = response.json().keys as Array<{ slot: number; hasKey: boolean }>;
      expect(keys.map((k) => k.slot)).toEqual([0, 1, 2]);
      expect(keys[0]!.hasKey).toBe(true);
      expect(keys[1]!.hasKey).toBe(false);
      expect(keys[2]!.hasKey).toBe(true);
    } finally {
      await pooled.close();
    }
  });

  it("a primary-only provider lists exactly one key (the pre-pool shape)", async () => {
    const response = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/keys",
    });
    expect(response.statusCode).toBe(200);
    const keys = response.json().keys as Array<{ slot: number; hasKey: boolean }>;
    expect(keys).toEqual([{ slot: 0, hasKey: true, masked: expect.any(String) }]);
  });
});

describe("GET /api/v1/providers/:id/key (ROUND-47: route REMOVED)", () => {
  it("404s — the raw key value is never served; the PUT at the same path STAYS", async () => {
    // The round-19 "view/copy" route returned the RAW key — the only route
    // that ever violated the "keys never appear in any response" invariant
    // of this group. Nothing called it (verified: src/, src-tauri/,
    // onboarding/ only PUT); R47-b removed it.
    const response = await authInject({ method: "GET", url: "/api/v1/providers/openrouter/key" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(response.body).not.toContain(KEY);

    // The update route at the same path survives untouched (the settings UI
    // saves keys through it).
    const put = await authInject({
      method: "PUT",
      url: "/api/v1/providers/openrouter/key",
      payload: { value: "sk-or-rotated-b0ba" },
    });
    expect(put.statusCode).toBe(204);
    const listed = await authInject({ method: "GET", url: "/api/v1/providers" });
    const row = (listed.json().providers as Array<{ id: string; hasKey: boolean }>).find(
      (p) => p.id === "openrouter",
    );
    expect(row?.hasKey).toBe(true);
    expect(listed.body).not.toContain("sk-or-rotated-b0ba");
  });
});

describe("GET /api/v1/models/catalog (ROUND-47)", () => {
  it("serves the full catalog + both defaults + the recommended pins, straight from the constants", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/models/catalog" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
    // The array IS MODEL_CATALOG, entry for entry — never a drift-prone copy.
    expect(body.models).toEqual(MODEL_CATALOG);
    expect(body.models).toHaveLength(MODEL_CATALOG.length);
    expect(body.defaultModelId).toBe("z-ai/glm-5.2:free");
    expect(body.subagentDefaultModelId).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(body.recommendedModelIds[0]).toBe(body.defaultModelId);
  });

  it("spot-checks a known free model: free, tool-capable, real context window", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/models/catalog" });
    const glm = response
      .json()
      .models.find((m: { modelId: string }) => m.modelId === "z-ai/glm-5.2:free");
    expect(glm).toMatchObject({
      free: true,
      supportsTools: true,
      contextWindow: 256_000,
    });
  });

  it("requires the bearer token like every other route in the scope", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/models/catalog" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});

/* ── ROUND-50 (R50-d): per-model config routes — pricing round-trip, null
   clearing, strict 400s ──────────────────────────────────────────────────
   The Settings "Configure model" dialog now writes pricing/limits through
   POST /providers/:id/models (upsert) and PATCH /models/:id. These tests
   pin the wire contract: every whitelisted field round-trips, explicit null
   CLEARS a stored value back to unknown, and a wrong type is a 400 naming
   the field (never a silently dropped "successful" save). */
describe("POST /api/v1/providers/:id/models + PATCH /api/v1/models/:id (ROUND-50 R50-d)", () => {
  const FULL_MODEL = {
    modelId: "test/priced-model",
    displayName: "Priced Model",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0.15,
    inputPriceCachedPerMtok: 0.02,
    outputPricePerMtok: 0.6,
    supportsThinking: true,
    hidden: false,
  };

  it("POST upserts a model with the FULL advanced config and round-trips every field", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: FULL_MODEL,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      providerId: "openrouter",
      modelId: "test/priced-model",
      displayName: "Priced Model",
      contextWindow: 200000,
      maxOutputTokens: 32768,
      inputPricePerMtok: 0.15,
      inputPriceCachedPerMtok: 0.02,
      outputPricePerMtok: 0.6,
      supportsThinking: true,
      hidden: false,
    });

    // …and the stored row is served back by models-config verbatim.
    const listed = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    const row = listed
      .json()
      .models.find((m: { modelId: string }) => m.modelId === "test/priced-model");
    expect(row).toMatchObject({
      inputPricePerMtok: 0.15,
      inputPriceCachedPerMtok: 0.02,
      outputPricePerMtok: 0.6,
    });
  });

  it("POST re-upsert of an existing model KEEPS supportsThinking/hidden when omitted (no reset-to-false)", async () => {
    await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { ...FULL_MODEL, supportsThinking: true, hidden: true },
    });
    // A catalog-picker bulk add re-upserts with ONLY the modelId + pricing —
    // the toggles must survive (the old `=== true` coercion wiped them).
    const reUpserted = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/priced-model", inputPricePerMtok: 0.2 },
    });
    expect(reUpserted.statusCode).toBe(201);
    expect(reUpserted.json()).toMatchObject({
      supportsThinking: true,
      hidden: true,
      inputPricePerMtok: 0.2,
    });
  });

  it("PATCH round-trips new pricing and null CLEARS a stored price back to unknown", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: FULL_MODEL,
    });
    const rowId = created.json().id as string;

    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: {
        inputPricePerMtok: 1.25,
        outputPricePerMtok: 10,
        inputPriceCachedPerMtok: null,
        contextWindow: 128000,
        maxOutputTokens: null,
        supportsThinking: false,
        hidden: true,
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      inputPricePerMtok: 1.25,
      outputPricePerMtok: 10,
      inputPriceCachedPerMtok: null,
      contextWindow: 128000,
      maxOutputTokens: null,
      supportsThinking: false,
      hidden: true,
    });

    // The nulls PERSISTED (the old `input.x ?? existing.x` collapsed null
    // into "keep" — this is the regression pin for the storage fix).
    const listed = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    const row = listed
      .json()
      .models.find((m: { id: string }) => m.id === rowId);
    expect(row.inputPriceCachedPerMtok).toBeNull();
    expect(row.maxOutputTokens).toBeNull();
    expect(row.outputPricePerMtok).toBe(10);
  });

  it.each([
    ["inputPricePerMtok", "0.15"],
    ["outputPricePerMtok", "free"],
    ["contextWindow", true],
    ["maxOutputTokens", []],
  ])("PATCH rejects a malformed %s with 400 VALIDATION (no silent drop)", async (field, bad) => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: FULL_MODEL,
    });
    const rowId = created.json().id as string;

    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { [field]: bad },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe(`body.${field}`);

    // And the stored value is UNCHANGED — the patch was rejected whole.
    const listed = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    const row = listed
      .json()
      .models.find((m: { id: string }) => m.id === rowId);
    expect(row[field]).toBe(FULL_MODEL[field as keyof typeof FULL_MODEL]);
  });

  it("PATCH rejects malformed toggles and displayName the same way", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: FULL_MODEL,
    });
    const rowId = created.json().id as string;

    const badToggle = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { supportsThinking: "yes" },
    });
    expect(badToggle.statusCode).toBe(400);
    expect(badToggle.json().error.details.field).toBe("body.supportsThinking");

    const badName = await authInject({
      method: "PATCH",
      url: `/api/v1/models/${rowId}`,
      payload: { displayName: 42 },
    });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error.details.field).toBe("body.displayName");
  });

  it("POST rejects a malformed pricing field with 400 VALIDATION (the picker's bulk add must not half-save lies)", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/bad-pricing", inputPricePerMtok: "0.15" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.inputPricePerMtok");

    const listed = await authInject({
      method: "GET",
      url: "/api/v1/providers/openrouter/models-config",
    });
    expect(
      listed
        .json()
        .models.some((m: { modelId: string }) => m.modelId === "test/bad-pricing"),
    ).toBe(false);
  });

  it("PATCH 404s for an unknown model row id (the api-layer 404 mapping is honest)", async () => {
    const response = await authInject({
      method: "PATCH",
      url: "/api/v1/models/mdl_does-not-exist",
      payload: { inputPricePerMtok: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("requires the bearer token like every other route in the scope", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openrouter/models",
      payload: { modelId: "test/unauthenticated" },
    });
    expect(post.statusCode).toBe(401);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/models/mdl_x",
      payload: { hidden: true },
    });
    expect(patch.statusCode).toBe(401);
  });
});

// ── R91-A: the FORCE-DELETE (the owner's v0.88.0 report: "when I tried to
// delete an OpenRouter provider, it apparently was not getting deleted" —
// the default agent's openrouter reference 409'd every attempt). The three
// contracts: the unforced 409 still exists (with the force hint in the
// message), ?force=1 RESETS the referencing agents to the no-provider state
// and deletes anyway, and the reset is visible through GET /agents.
describe("R91-A: DELETE /providers/:id force (the agent-reference unblock)", () => {
  it("the unforced delete of a referenced provider still 409s — now with the force hint in the message", async () => {
    // The seeded default agent (Acute) references openrouter.
    const del = await authInject({ method: "DELETE", url: "/api/v1/providers/openrouter" });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
    expect(del.json().error.message).toContain("force=1");
    // The provider is still there (the refusal is honest, not a delete).
    const list = await authInject({ method: "GET", url: "/api/v1/providers" });
    expect((list.json().providers as Array<{ id: string }>).some((p) => p.id === "openrouter")).toBe(true);
  });

  it("?force=1 deletes the referenced provider AND resets the agents to the no-provider state", async () => {
    // Before: the default agent carries providerId openrouter + a model.
    const before = await authInject({ method: "GET", url: "/api/v1/agents?includeTemplates=false" });
    const acute = (before.json().agents as Array<{ id: string; providerId: string | null; model: string | null }>).find(
      (a) => a.id === "agt_default_nova",
    );
    expect(acute).toBeDefined();
    expect(acute!.providerId).toBe("openrouter");

    const del = await authInject({ method: "DELETE", url: "/api/v1/providers/openrouter?force=1" });
    expect(del.statusCode).toBe(204);

    // The provider is gone.
    const list = await authInject({ method: "GET", url: "/api/v1/providers" });
    expect((list.json().providers as Array<{ id: string }>).some((p) => p.id === "openrouter")).toBe(false);

    // The agent was RESET — no provider, no model (the composer's picker
    // asks for a model on the next send, exactly like a fresh agent).
    const after = await authInject({ method: "GET", url: "/api/v1/agents?includeTemplates=false" });
    const reset = (after.json().agents as Array<{ id: string; providerId: string | null; model: string | null }>).find(
      (a) => a.id === "agt_default_nova",
    );
    expect(reset!.providerId).toBeNull();
    expect(reset!.model).toBeNull();

    // The built-in's tombstone holds: the boot seed will not resurrect it
    // (the re-add is a FRESH create at the reserved id — 201, the same R37
    // contract as the unforced delete's re-claim).
    const resurrected = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(resurrected.statusCode).toBe(201);
    expect(resurrected.json()).toMatchObject({ id: "openrouter" });
  });

  it("an UNREFERENCED provider deletes identically with and without force (the R37 contract kept)", async () => {
    const plain = await authInject({ method: "DELETE", url: "/api/v1/providers/anthropic" });
    expect(plain.statusCode).toBe(204);
    const forced = await authInject({ method: "DELETE", url: "/api/v1/providers/google?force=1" });
    expect(forced.statusCode).toBe(204);
  });
});
