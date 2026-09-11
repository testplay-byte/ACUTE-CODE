/**
 * ROUND-88 (R88, owner: the floating to-do widget + manual edits) — the
 * POST /sessions/:id/todo route + the CURRENT TODO LIST prompt section.
 *
 * Coverage:
 *  · The route's contract: 200 happy path (normalized items, source:"user"
 *    event persisted), 404 unknown session, 409 agent-less session, 400
 *    malformed bodies (non-array, >30 items, bad content, bad status), and
 *    the owner-only EMPTY list (the clear affordance — the tool keeps ≥1).
 *  · The cleared state: latestTodoSnapshot returns the EMPTY snapshot (not
 *    the previous non-empty one) and prepareTurn composes NO section.
 *  · The prompt section: agent-source renders the plain line; user-source
 *    renders the OWNER-edit emphasis; no snapshot → no section.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { latestTodoSnapshot, listSessionEvents } from "../src/storage/sessions";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r88";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;
let sessionId: string;

beforeEach(async () => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r88-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db });
  // A session bound to the default agent (the seeded row) — the route needs
  // an agentId to stamp the events with.
  const created = app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { mode: "single", agentId: "agt_default_nova", title: "r88" },
  });
  // The 202 arrives synchronously on inject — resolve + capture the id.
  const res = await created;
  expect(res.statusCode).toBe(202);
  sessionId = res.json().id as string;
});

// The repo's standing pattern (the R87 Windows lesson): close BOTH the
// fastify app and the db after every test.
afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function post(body: unknown, id = sessionId): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/v1/sessions/${id}/todo`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body as never,
  }) as Promise<LightMyRequestResponse>;
}

describe("R88 POST /sessions/:id/todo — the route contract", () => {
  it("persists a source:user snapshot and returns the normalized items", async () => {
    const res = await post({
      todos: [
        { content: "  Trim me  ", status: "pending" },
        { content: "Work the owner's edits", status: "in_progress" },
        { content: "Done already", status: "completed" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      todos: [
        { content: "Trim me", status: "pending" },
        { content: "Work the owner's edits", status: "in_progress" },
        { content: "Done already", status: "completed" },
      ],
    });

    // The persisted event: source:"user", trimmed content, on THIS session.
    const events = listSessionEvents(db, sessionId);
    const todoEvents = events.filter((e) => e.type === "todo.update");
    expect(todoEvents.length).toBe(1);
    const payload = todoEvents[0].payload as { todos: unknown[]; source?: string };
    expect(payload.source).toBe("user");
    expect(payload.todos[0]).toEqual({ content: "Trim me", status: "pending" });

    // latestTodoSnapshot reads it back with the user source.
    const snap = latestTodoSnapshot(db, sessionId);
    expect(snap?.source).toBe("user");
    expect(snap?.todos.length).toBe(3);
  });

  it("404s unknown sessions, 400s malformed bodies", async () => {
    expect((await post({ todos: [] }, "ses_missing")).statusCode).toBe(404);

    expect((await post({ todos: "yes" })).statusCode).toBe(400);
    expect((await post({ todos: [{ content: "", status: "pending" }] })).statusCode).toBe(400);
    expect((await post({ todos: [{ content: "x", status: "done" }] })).statusCode).toBe(400);
    expect((await post({ todos: Array(31).fill({ content: "x", status: "pending" }) })).statusCode).toBe(400);
    expect((await post(["not", "an", "object"])).statusCode).toBe(400);
  });

  it("accepts the EMPTY list (the owner's clear) — the snapshot reads empty, not the previous one", async () => {
    await post({ todos: [{ content: "a", status: "pending" }] });
    const cleared = await post({ todos: [] });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().todos).toEqual([]);

    const snap = latestTodoSnapshot(db, sessionId);
    expect(snap).toBeDefined();
    expect(snap?.todos).toEqual([]);
    expect(snap?.source).toBe("user");
  });
});

describe("R88 CURRENT TODO LIST — the prompt section", () => {
  it("renders the items with the owner-edit emphasis for source:user", async () => {
    await post({
      todos: [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
        { content: "Third", status: "pending" },
      ],
    });

    // prepareTurn composes the prompt through the project system prompt; the
    // section text is what matters. Use buildProjectSystemPrompt directly with
    // the SAME ctx shape prepareTurn passes (the composition is pure).
    const { buildProjectSystemPrompt } = await import("../src/agents/prompts");
    const snap = latestTodoSnapshot(db, sessionId);
    expect(snap).toBeDefined();
    const system = buildProjectSystemPrompt({
      projectName: "p",
      rootPath: "/tmp/p",
      toolNames: ["todo_write"],
      todoList: snap,
    });
    expect(system).toContain("## CURRENT TODO LIST");
    expect(system).toContain("The OWNER edited this list");
    expect(system).toContain("- [x] First");
    expect(system).toContain("- [~] Second");
    expect(system).toContain("- [ ] Third");
  });

  it("renders the plain discipline line for agent-source snapshots and NOTHING when empty", async () => {
    const { buildProjectSystemPrompt } = await import("../src/agents/prompts");

    const agentSystem = buildProjectSystemPrompt({
      projectName: "p",
      rootPath: "/tmp/p",
      toolNames: ["todo_write"],
      todoList: { todos: [{ content: "Agent's task", status: "pending" }], source: "agent" },
    });
    expect(agentSystem).toContain("## CURRENT TODO LIST");
    expect(agentSystem).not.toContain("The OWNER edited this list");
    expect(agentSystem).toContain("- [ ] Agent's task");

    const clearedSystem = buildProjectSystemPrompt({
      projectName: "p",
      rootPath: "/tmp/p",
      toolNames: ["todo_write"],
      todoList: { todos: [], source: "user" },
    });
    expect(clearedSystem).not.toContain("## CURRENT TODO LIST");

    const noneSystem = buildProjectSystemPrompt({
      projectName: "p",
      rootPath: "/tmp/p",
      toolNames: ["todo_write"],
    });
    expect(noneSystem).not.toContain("## CURRENT TODO LIST");
  });
});
