/**
 * ROUND-106 (R106-S3, CLI-DESIGN §6): the ApiError ENVELOPE units — the
 * sidecar's `{error:{code,message,details?}}` shape becomes a typed ApiError
 * (never a raw status string), plain-text/empty bodies fall back honestly,
 * and apiFetch's 200/2xx/non-2xx/network-death ladder (fetch stubbed — no
 * server, no I/O).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, healthFetch, parseErrorEnvelope, UnreachableError } from "../src/api.js";
import type { Connection } from "../src/connection.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal attach-mode connection (the fetch target is stubbed anyway). */
const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4599",
  token: "test-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4599,
  spawned: null,
};

describe("parseErrorEnvelope (the {error:{code,message}} envelope)", () => {
  it("a well-formed envelope maps to the typed ApiError (code + message + details)", () => {
    const err = parseErrorEnvelope(
      409,
      JSON.stringify({ error: { code: "CONFLICT", message: "no API key stored for provider 'openrouter'" } }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("no API key stored for provider 'openrouter'");
    expect(err.details).toBeUndefined();
    expect(err.describe()).toBe("409 CONFLICT: no API key stored for provider 'openrouter'");
  });

  it("details ride the envelope as a record", () => {
    const err = parseErrorEnvelope(
      400,
      JSON.stringify({ error: { code: "VALIDATION", message: "bad body", details: { field: "mode" } } }),
    );
    expect(err.details).toEqual({ field: "mode" });
  });

  it("a non-string code degrades to HTTP_<status>, keeping the message", () => {
    const err = parseErrorEnvelope(418, JSON.stringify({ error: { code: 42, message: "teapot" } }));
    expect(err.code).toBe("HTTP_418");
    expect(err.message).toBe("teapot");
  });

  it("a non-envelope JSON body (or plain text) falls back to HTTP_<status> + the body", () => {
    const plain = parseErrorEnvelope(502, "Bad Gateway: upstream melted");
    expect(plain.code).toBe("HTTP_502");
    expect(plain.message).toBe("Bad Gateway: upstream melted");
    const notEnvelope = parseErrorEnvelope(500, JSON.stringify({ oops: true }));
    expect(notEnvelope.code).toBe("HTTP_500");
    expect(notEnvelope.message).toBe(JSON.stringify({ oops: true }));
  });

  it("an EMPTY body is the honest '(empty body, HTTP N)' marker", () => {
    const err = parseErrorEnvelope(503, "");
    expect(err.code).toBe("HTTP_503");
    expect(err.message).toBe("(empty body, HTTP 503)");
  });
});

describe("apiFetch (the authenticated call ladder)", () => {
  it("a 2xx JSON body parses; the Bearer + content-type headers ride the call", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }),
    );
    const json = await apiFetch<{ agents: unknown[] }>(CONN, "GET", "/agents");
    expect(json).toEqual({ agents: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:4599/api/v1/agents");
    expect(calls[0].init.method).toBe("GET");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["content-type"]).toBeUndefined(); // no body → no content-type
  });

  it("a body serializes as JSON with the content-type header", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
        calls.push({ init });
        return new Response("", { status: 202 });
      }),
    );
    const result = await apiFetch(CONN, "POST", "/sessions", { mode: "single", agentId: "a1" });
    expect(result).toBeUndefined(); // 202 with an empty body → undefined
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ mode: "single", agentId: "a1" });
  });

  it("a non-2xx response THROWS the envelope as an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such session" } }), {
            status: 404,
          }),
      ),
    );
    const err = await apiFetch(CONN, "GET", "/sessions/nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).describe()).toBe("404 NOT_FOUND: no such session");
  });

  it("network death wraps as UnreachableError with the cause text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }),
    );
    const err = await apiFetch(CONN, "GET", "/agents").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect((err as UnreachableError).baseUrl).toBe("http://127.0.0.1:4599");
    expect((err as UnreachableError).message).toContain("ECONNREFUSED");
    expect((err as UnreachableError).message).toContain("unreachable http://127.0.0.1:4599");
  });
});

describe("healthFetch (the one open route — GET /health, no auth)", () => {
  it("the loopback shape {status:'ok', app:'acute-code', version} resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string): Promise<Response> => {
          expect(url).toBe("http://127.0.0.1:4599/health");
          return new Response(JSON.stringify({ status: "ok", app: "acute-code", version: "0.101.0" }), {
            status: 200,
          });
        },
      ),
    );
    expect(await healthFetch("http://127.0.0.1:4599")).toEqual({
      status: "ok",
      app: "acute-code",
      version: "0.101.0",
    });
  });

  it("a non-ok status, a foreign app id, or a fetch throw all → null (stale portal)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => new Response("nope", { status: 503 })));
    expect(await healthFetch("http://127.0.0.1:4599")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ status: "ok", app: "other" }), { status: 200 })),
    );
    expect(await healthFetch("http://127.0.0.1:4599")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }));
    expect(await healthFetch("http://127.0.0.1:4599")).toBeNull();
  });

  it("a hung /health aborts at the timeout → null", async () => {
    vi.stubGlobal(
      "fetch",
      async (_url: string, init?: RequestInit): Promise<Response> => {
        // A server that never answers — the AbortController is the only exit.
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        });
      },
    );
    expect(await healthFetch("http://127.0.0.1:4599", 50)).toBeNull();
  });
});
