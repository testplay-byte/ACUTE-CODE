import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { VERSION, buildServer, startServer } from "../src/server";

const TOKEN = "test-token-3f9a";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-server-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
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

/** Authenticated inject; everything but /health tests go through this. */
async function authInject(options: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  payload?: Record<string, unknown> | string;
}): Promise<LightMyRequestResponse> {
  // inject()'s Chain is a thenable whose await-type collapses to an unusable
  // intersection; cast through the documented Response shape.
  const response = (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
  return response;
}

describe("health (unauthenticated)", () => {
  it("answers GET /health without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", app: "acute-code", version: "0.3.0" });
  });

  it("exports VERSION matching the health payload", () => {
    expect(VERSION).toBe("0.3.0");
  });
});

describe("bearer-token auth", () => {
  it("rejects /api/v1/agents without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("keeps the token wall on unknown paths (401), then 404 once authed", async () => {
    const unauthed = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(unauthed.statusCode).toBe(401);
    const authed = await authInject({ method: "GET", url: "/api/v1/nope" });
    expect(authed.statusCode).toBe(404);
    expect(authed.json().error.code).toBe("NOT_FOUND");
  });
});

describe("agents CRUD", () => {
  it("lists the seeded templates + plug-and-play default agent", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/agents" });
    expect(response.statusCode).toBe(200);
    const agents = response.json().agents;
    // Seeds share one timestamp, so ordering falls through to the id tie-break.
    // Order depends on same-millisecond timestamp ties — assert as a set.
    expect([...agents.map((agent: { name: string }) => agent.name)].sort()).toEqual([
      "Acute",
      "Coder",
      "Planner",
      "Researcher",
      "Reviewer",
      "Tester",
    ]);
  });

  it("excludes templates with ?includeTemplates=false — Acute (default seed) remains", async () => {
    const response = await authInject({
      method: "GET",
      url: "/api/v1/agents?includeTemplates=false",
    });
    expect(response.statusCode).toBe(200);
    const agents = response.json().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "agt_default_nova",
      name: "Acute",
      providerId: "openrouter",
      model: "stealth/ox-alpha",
      isTemplate: false,
    });
  });

  it("creates, reads, patches, duplicates, and deletes an agent", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: "Bug Fixer",
        role: "implementer",
        systemPrompt: "You fix bugs.",
        providerId: "openrouter",
        model: "anthropic/claude-sonnet-4",
        visionModel: null,
        allowedTools: ["file_read", "shell_exec"],
        memoryPolicy: "every-turn",
        skills: ["git-rescue"],
        maxTurns: 30,
        temperature: 0.1,
      },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.id).toMatch(/^agt_/);
    expect(agent).toMatchObject({
      name: "Bug Fixer",
      role: "implementer",
      systemPrompt: "You fix bugs.",
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4",
      visionModel: null,
      allowedTools: ["file_read", "shell_exec"],
      memoryPolicy: "every-turn",
      skills: ["git-rescue"],
      maxTurns: 30,
      temperature: 0.1,
      isTemplate: false,
      version: 1,
    });
    expect(agent.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(agent.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = await authInject({ method: "GET", url: `/api/v1/agents/${agent.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(agent);

    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      payload: { name: "Bug Fixer 2", temperature: 0.3 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Bug Fixer 2", temperature: 0.3, version: 2 });

    const copied = await authInject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/duplicate`,
      payload: { name: "Bug Fixer (fast)" },
    });
    expect(copied.statusCode).toBe(201);
    expect(copied.json()).toMatchObject({
      name: "Bug Fixer (fast)",
      isTemplate: false,
      version: 1,
      providerId: "openrouter",
    });

    const defaulted = await authInject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/duplicate`,
      payload: {},
    });
    expect(defaulted.statusCode).toBe(201);
    expect(defaulted.json().name).toBe("Bug Fixer 2 (copy)");

    const templateCopy = await authInject({
      method: "POST",
      url: "/api/v1/agents/agt_tpl_planner/duplicate",
      payload: {},
    });
    expect(templateCopy.statusCode).toBe(201);
    expect(templateCopy.json()).toMatchObject({ name: "Planner (copy)", isTemplate: false, version: 1 });

    const deleted = await authInject({ method: "DELETE", url: `/api/v1/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");

    const missing = await authInject({ method: "GET", url: `/api/v1/agents/${agent.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("creates an agent with defaults for omitted optional fields", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/agents",
      payload: { name: "Bare" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Bare",
      role: "",
      systemPrompt: "",
      providerId: null,
      model: null,
      visionModel: null,
      allowedTools: [],
      memoryPolicy: "none",
      skills: [],
      maxTurns: 40,
      temperature: 0.2,
      isTemplate: false,
      version: 1,
    });
  });

  it("refuses to delete a template with 409 CONFLICT details.reason=template", async () => {
    const response = await authInject({
      method: "DELETE",
      url: "/api/v1/agents/agt_tpl_coder",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.details.reason).toBe("template");
  });

  it("404s on duplicate of an unknown agent", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/agents/agt_missing/duplicate",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("agent validation (400 VALIDATION)", () => {
  const cases: Array<{ name: string; payload: unknown; field: string }> = [
    { name: "missing name", payload: { role: "x" }, field: "body.name" },
    { name: "empty name", payload: { name: "  " }, field: "body.name" },
    {
      name: "unknown providerId",
      payload: { name: "A", providerId: "groq-not-registered" },
      field: "body.providerId",
    },
    {
      name: "unknown tool name",
      payload: { name: "A", allowedTools: ["file_read", "nmap"] },
      field: "body.allowedTools",
    },
    { name: "negative maxTurns", payload: { name: "A", maxTurns: -1 }, field: "body.maxTurns" },
    {
      name: "bad memoryPolicy",
      payload: { name: "A", memoryPolicy: "sometimes" },
      field: "body.memoryPolicy",
    },
    {
      name: "out-of-range temperature",
      payload: { name: "A", temperature: 9 },
      field: "body.temperature",
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name}`, async () => {
      const response = await authInject({
        method: "POST",
        url: "/api/v1/agents",
        payload: testCase.payload as Record<string, unknown>,
      });
      expect(response.statusCode).toBe(400);
      const error = response.json().error;
      expect(error.code).toBe("VALIDATION");
      expect(error.details.field).toBe(testCase.field);
    });
  }

  it("rejects a negative maxTurns on PATCH too", async () => {
    const response = await authInject({
      method: "PATCH",
      url: "/api/v1/agents/agt_tpl_coder",
      payload: { maxTurns: -5 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.field).toBe("body.maxTurns");
  });

  it("wraps malformed JSON bodies in the error envelope", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
  });
});

describe("startServer", () => {
  it("binds an ephemeral loopback port and prints exactly one ready line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let server: FastifyInstance | undefined;
    try {
      const running = await startServer({
        token: TOKEN,
        dbPath: join(tempDir, "ready-line.db"),
      });
      server = running.server;
      expect(running.port).toBeGreaterThan(0);
      const address = running.server.server.address();
      expect(address).toMatchObject({ address: "127.0.0.1", port: running.port });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(`ACUTE_READY ${JSON.stringify({ port: running.port })}`);
    } finally {
      log.mockRestore();
      await server?.close();
    }
  });
});
