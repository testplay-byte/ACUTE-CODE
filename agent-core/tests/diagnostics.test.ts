import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

/**
 * ROUND-59 (R59-E): pins for the sidecar's DIAGNOSTICS ERROR RING (owner:
 * "proper console-like error monitoring and error handling… If there are any
 * errors along the way then you can easily detect them by yourself").
 *
 * The ring captures THROWN request errors with status ≥ 500 (DECISION: 4xx is
 * client noise, not engine errors) and serves them to the in-app Console tab
 * via GET /api/v1/diagnostics/errors. The throwing route below is registered
 * directly on the test app — proving the fastify error handler is the ONE
 * funnel that catches route-handler throws.
 */

const TOKEN = "test-token-diag";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-diag-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
  // A route that THROWS (plain Error → fastify maps it to 500) and a route
  // that throws a 4xx statusCode — both hit the app-level error handler; only
  // the 5xx one may land in the ring.
  app.get("/api/v1/test-diagnostics-throw", async () => {
    throw new Error("boom: the engine tripped");
  });
  app.post("/api/v1/test-diagnostics-throw", async () => {
    throw Object.assign(new Error("thrown but client-side"), { statusCode: 400 });
  });
  app.put("/api/v1/test-diagnostics-throw", async () => {
    throw Object.assign(new Error("provider exploded upstream"), { statusCode: 502 });
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
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

/** Authenticated inject (server.test.ts pattern). */
async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown> | string;
}): Promise<LightMyRequestResponse> {
  const response = (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
  return response;
}

describe("diagnostics error ring (R59-E)", () => {
  it("a throwing route lands in the ring; GET returns it newest-first", async () => {
    const failed = await authInject({ method: "GET", url: "/api/v1/test-diagnostics-throw" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe("INTERNAL");

    const response = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    expect(response.statusCode).toBe(200);
    const { errors } = response.json() as { errors: Record<string, unknown>[] };
    expect(errors).toHaveLength(1);
    const row = errors[0];
    expect(row.statusCode).toBe(500);
    expect(row.code).toBe("INTERNAL");
    expect(row.message).toBe("boom: the engine tripped");
    expect(row.method).toBe("GET");
    expect(row.url).toBe("/api/v1/test-diagnostics-throw");
    expect(row.source).toBe("sidecar");
    expect(row.kind).toBe("http");
    expect(row.count).toBe(1);
    expect(typeof row.id).toBe("string");
    expect(typeof row.ts).toBe("string");
    // The ISO ts parses (it is a real timestamp, not a placeholder).
    expect(Number.isNaN(Date.parse(String(row.ts)))).toBe(false);
  });

  it("records thrown 502s with their status + mapped code", async () => {
    await authInject({ method: "PUT", url: "/api/v1/test-diagnostics-throw" });
    const response = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    const { errors } = response.json() as { errors: Record<string, unknown>[] };
    expect(errors).toHaveLength(1);
    expect(errors[0].statusCode).toBe(502);
    expect(errors[0].code).toBe("PROVIDER_ERROR");
    expect(errors[0].message).toBe("provider exploded upstream");
  });

  it("4xx stays OUT of the ring — handled 404/400 replies AND thrown 4xx (client noise, not engine errors)", async () => {
    // Handled 404: unknown path (setNotFoundHandler — never reaches the error
    // handler). Handled 400: a validation reply. Thrown 400: the POST test route.
    const notFound = await authInject({ method: "GET", url: "/api/v1/nope" });
    expect(notFound.statusCode).toBe(404);
    const badLimit = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors?limit=abc" });
    expect(badLimit.statusCode).toBe(400);
    const thrown4xx = await authInject({ method: "POST", url: "/api/v1/test-diagnostics-throw" });
    expect(thrown4xx.statusCode).toBe(400);

    const response = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    const { errors } = response.json() as { errors: unknown[] };
    expect(errors).toHaveLength(0);
  });

  it("NO request body or auth header is captured — the ring row carries exactly the diagnostic fields", async () => {
    // Send a SECRET in the body AND the auth header to a route that throws.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/test-diagnostics-throw?secretQuery=openrouter-key-value",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-api-key": "sk-test-secret-1234567890",
      },
    });
    expect(response.statusCode).toBe(500);

    const listing = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    const { errors } = listing.json() as { errors: Record<string, unknown>[] };
    expect(errors).toHaveLength(1);
    // Field set is EXACTLY the allowlist — nothing else can ride along.
    expect(Object.keys(errors[0]).sort()).toEqual(
      ["code", "count", "id", "kind", "method", "message", "source", "statusCode", "ts", "url"].sort(),
    );
    // None of the request's sensitive material appears anywhere in the row.
    const serialized = JSON.stringify(errors[0]);
    for (const secret of ["secretQuery", "openrouter-key-value", "x-api-key", TOKEN, "sk-test-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    // And the query string was stripped from the captured url.
    expect(errors[0].url).toBe("/api/v1/test-diagnostics-throw");
  });

  it("GET /diagnostics/errors requires the bearer token (401 without)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("DELETE /diagnostics/errors clears the ring and answers { ok: true }", async () => {
    await authInject({ method: "GET", url: "/api/v1/test-diagnostics-throw" });
    await authInject({ method: "PUT", url: "/api/v1/test-diagnostics-throw" });

    const wipe = await authInject({ method: "DELETE", url: "/api/v1/diagnostics/errors" });
    expect(wipe.statusCode).toBe(200);
    expect(wipe.json()).toEqual({ ok: true });

    const after = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    expect((after.json() as { errors: unknown[] }).errors).toHaveLength(0);

    // DELETE also requires auth.
    const unauthed = await app.inject({ method: "DELETE", url: "/api/v1/diagnostics/errors" });
    expect(unauthed.statusCode).toBe(401);
  });

  it("?limit= honors the requested bound, newest-first", async () => {
    for (let i = 0; i < 3; i++) {
      await authInject({ method: "GET", url: "/api/v1/test-diagnostics-throw" });
      // Separate rows: identical consecutive errors land within the same ms —
      // the ring (unlike the frontend bus) keeps one row per occurrence.
    }
    const response = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors?limit=2" });
    const { errors } = response.json() as { errors: { id: string; ts: string }[] };
    expect(errors).toHaveLength(2);
    // Newest first: ts descending.
    expect(Date.parse(errors[0].ts)).toBeGreaterThanOrEqual(Date.parse(errors[1].ts));

    // limit=0 / negative are rejected as 400 (positive integer required).
    const zero = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors?limit=0" });
    expect(zero.statusCode).toBe(400);
  });

  it("the ring caps at 200 entries (oldest dropped)", async () => {
    for (let i = 0; i < 205; i++) {
      await authInject({ method: "GET", url: `/api/v1/test-diagnostics-throw?i=${i}` });
    }
    const response = await authInject({ method: "GET", url: "/api/v1/diagnostics/errors" });
    const { errors } = response.json() as { errors: unknown[] };
    expect(errors).toHaveLength(200);
  });
});
