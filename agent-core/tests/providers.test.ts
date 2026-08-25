import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { ProviderKeyring, clearModelCache } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProviderRecord } from "../src/storage/providers";
import { buildServer } from "../src/server";

const TOKEN = "test-token-7c2d";
const KEY = "sk-or-test-4f8a";

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
  method: "GET" | "POST" | "PATCH" | "DELETE";
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
      expect(rows.map((row) => row.id)).toEqual(["anthropic", "google", "openai", "openrouter"]);
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
      expect(response.json()).toEqual({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            kind: "openai-compatible",
            baseUrl: "https://api.anthropic.com/v1",
            apiFormat: "chat-completions",
            enabled: true,
            createdAt: expect.any(String),
            hasKey: false,
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
    expect(response.body).not.toContain(KEY);
  });

  it("creates the openrouter row exactly once across repeated listings", async () => {
    await authInject({ method: "GET", url: "/api/v1/providers" });
    await authInject({ method: "GET", url: "/api/v1/providers" });
    const rows = db.prepare("SELECT id FROM providers").all() as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["anthropic", "google", "openai", "openrouter"]);
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
    expect(ids).toEqual(["anthropic", "google", "openai", "openrouter", "prv_groq"]);
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

  it("ROUND-37: a reserved id with an EXISTING row is 409; an absent one is claimable (deleted-built-in resurrection)", async () => {
    // anthropic is seeded → its row exists → conflict.
    const seeded = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "anthropic", name: "Fake Anthropic", baseUrl: "https://x.test/v1" },
    });
    expect(seeded.statusCode).toBe(409);
    expect(seeded.json().error.code).toBe("CONFLICT");

    // A reserved id whose row was deleted (tombstoned) can be re-claimed.
    const del = await authInject({ method: "DELETE", url: "/api/v1/providers/anthropic" });
    expect(del.statusCode).toBe(204);
    const resurrected = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic-messages" },
    });
    expect(resurrected.statusCode).toBe(201);
    expect(resurrected.json()).toMatchObject({ id: "anthropic", apiFormat: "anthropic-messages" });

    const first = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "edge", name: "Edge", baseUrl: "https://edge.test/v1" },
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { id: "edge", name: "Edge Again", baseUrl: "https://edge.test/v1" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
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
