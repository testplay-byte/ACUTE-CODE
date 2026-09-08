import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// Same harness as sessions.test.ts: real server + real sqlite, AI SDK mocked at
// the module boundary so nothing here needs a provider or network.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import {
  appendSessionEvent,
  forkSession,
  listSessionEvents,
  recordUsage,
  revertSession,
  searchSessions,
  setSessionStatus,
  type SessionEvent,
} from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r44c";
const KEY = "sk-or-vtest-r44c";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-sessions-manage-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  generateTextMock.mockReset();
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

async function createAgent(): Promise<{ id: string }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Chat Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/model-1",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createSession(
  agentId: string,
  title?: string,
): Promise<{ id: string; title: string | null }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId, mode: "single", ...(title !== undefined ? { title } : {}) },
  });
  expect(response.statusCode).toBe(202);
  return response.json();
}

/** Seed a two-turn conversation: user(1) assistant(2) user(3) assistant(4). */
async function createSeededSession(
  title: string,
  turns: Array<[string, string]>,
): Promise<string> {
  const agent = await createAgent();
  const session = await createSession(agent.id, title);
  for (const [userText, assistantText] of turns) {
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: userText },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: assistantText },
    });
  }
  return session.id;
}

const eventRowIds = (sessionId: string): Array<{ id: number; seq: number; type: string; payload: string | null; ts: string }> =>
  db
    .prepare(
      "SELECT id, seq, type, payload, ts FROM session_events WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionId) as Array<{ id: number; seq: number; type: string; payload: string | null; ts: string }>;

// ── storage: searchSessions ─────────────────────────────────────────────────

describe("searchSessions (storage)", () => {
  it("matches TITLES case-insensitively and orders newest-updated first", async () => {
    const older = await createSeededSession("Kubernetes rollout audit", [["hi", "hello"]]);
    const newer = await createSeededSession("Totally unrelated title", [["bye", "ciao"]]);
    // updatedAt is set on event append? No — events do not touch the row; bump
    // updated_at deterministically so ordering is observable.
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2026-08-27T10:00:00Z", older);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2026-08-27T11:00:00Z", newer);

    const hits = searchSessions(db, "KUBERNETES");
    expect(hits.map((s) => s.id)).toEqual([older]);

    const both = searchSessions(db, "e"); // both titles contain "e"
    expect(both.map((s) => s.id)).toEqual([newer, older]); // updated_at DESC
  });

  it("matches EVENT TEXT (user + assistant content) case-insensitively, not just titles", async () => {
    const hit = await createSeededSession("Boring title", [
      ["please find the ZEBRA crossing", "no zebras here"],
    ]);
    const miss = await createSeededSession("Also boring", [["nothing relevant", "me neither"]]);

    const byUserText = searchSessions(db, "zebra crossing");
    expect(byUserText.map((s) => s.id)).toEqual([hit]);

    const byAssistantText = searchSessions(db, "no zebras");
    expect(byAssistantText.map((s) => s.id)).toEqual([hit]);

    expect(searchSessions(db, "irrelevant").map((s) => s.id)).not.toContain(miss);
  });

  it("dedupes sessions that match MULTIPLE events and caps at limit", async () => {
    const session = await createSeededSession("Dedup probe", [
      ["alpha needle one", "alpha needle two"],
      ["alpha needle three", "alpha needle four"],
    ]);
    // Four matching events — the session must appear exactly once.
    expect(searchSessions(db, "alpha needle")).toEqual([
      expect.objectContaining({ id: session }),
    ]);
    expect(searchSessions(db, "alpha needle", 0)).toEqual([]); // limit is honored
  });

  it("ignores sub-agent children (parent_session_id set) like listSessions", async () => {
    const agent = await createAgent();
    const parent = await createSession(agent.id, "Parent searchprobe title");
    const child = db
      .prepare(
        `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at, parent_session_id, sub_role)
         VALUES (?, NULL, ?, 'single', 'queued', 'Child searchprobe title', ?, ?, ?, 'researcher')`,
      )
      .run(`sess_child_${randomUUID()}`, agent.id, new Date().toISOString(), new Date().toISOString(), parent.id);
    void child;

    const hits = searchSessions(db, "searchprobe");
    expect(hits.map((s) => s.id)).toEqual([parent.id]); // child excluded
  });

  it("treats LIKE wildcards in the query as literals", async () => {
    const session = await createSeededSession("literal 100% sure", [["hi", "hello"]]);
    // "%" must match ONLY the literal percent sign, not everything.
    expect(searchSessions(db, "100%")).toEqual([expect.objectContaining({ id: session })]);
    expect(searchSessions(db, "100% sure").map((s) => s.title)).toEqual(["literal 100% sure"]);
  });

  it("returns [] for a blank query", async () => {
    await createSeededSession("Anything", [["hi", "hello"]]);
    expect(searchSessions(db, "   ")).toEqual([]);
    expect(searchSessions(db, "")).toEqual([]);
  });
});

// ── storage: forkSession ────────────────────────────────────────────────────

describe("forkSession (storage)", () => {
  it("copies the row (renamed, queued, same agent/project) and ALL events with NEW row ids + preserved seq/payload/ts; usage starts at zero", async () => {
    const agent = await createAgent();
    const original = await createSession(agent.id, "Refactor the parser");
    appendSessionEvent(db, original.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "refactor it" },
    });
    appendSessionEvent(db, original.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "done" },
    });
    recordUsage(db, {
      agentId: agent.id,
      sessionId: original.id,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
      ts: new Date().toISOString(),
    });

    const fork = forkSession(db, original.id);
    expect(fork).toBeDefined();
    if (fork === undefined) return;
    expect(fork.id).not.toBe(original.id);
    expect(fork.id).toMatch(/^sess_/);
    expect(fork.title).toBe("Fork · Refactor the parser");
    expect(fork.status).toBe("queued");
    expect(fork.agentId).toBe(agent.id);
    expect(fork.projectId).toBeNull();
    expect(fork.parentSessionId).toBeNull(); // top-level, never a child
    expect(fork.subRole).toBeNull();

    const sourceRows = eventRowIds(original.id);
    const forkRows = eventRowIds(fork.id);
    expect(forkRows).toHaveLength(sourceRows.length);
    for (let i = 0; i < sourceRows.length; i++) {
      expect(forkRows[i].seq).toBe(sourceRows[i].seq); // seq/order/turn structure preserved
      expect(forkRows[i].type).toBe(sourceRows[i].type);
      expect(forkRows[i].payload).toBe(sourceRows[i].payload); // byte-identical payload
      expect(forkRows[i].ts).toBe(sourceRows[i].ts); // original timestamps preserved
      expect(forkRows[i].id).not.toBe(sourceRows[i].id); // NEW event row ids
    }

    // Usage ledger NOT copied — the fork's counters start at zero.
    const usage = db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
      .get(fork.id) as { n: number };
    expect(usage.n).toBe(0);
  });

  it("falls back to an Untitled-derived title when the source has none", async () => {
    const agent = await createAgent();
    const original = await createSession(agent.id);
    const fork = forkSession(db, original.id);
    expect(fork?.title).toBe("Fork · Untitled session");
  });

  it("returns undefined for an unknown session id", () => {
    expect(forkSession(db, "sess_does_not_exist")).toBeUndefined();
  });
});

// ── storage: revertSession ──────────────────────────────────────────────────

describe("revertSession (storage)", () => {
  it("R77: removes events from the TARGET message onward (seq >= keepThroughSeq), appends a session.reverted marker, and resets status to queued", async () => {
    const sessionId = await createSeededSession("Rewind me", [
      ["first question", "first answer"], // seq 1, 2
      ["second question", "second answer"], // seq 3, 4
    ]);
    setSessionStatus(db, sessionId, "completed");

    // R77 (owner: the reverted message is DELETED from the chat and its
    // text returns to the composer): reverting at the FIRST user message
    // now removes seq 1,2,3,4 — the target message included.
    const result = revertSession(db, sessionId, 1);
    expect(result).toEqual({ ok: true, removedCount: 4 }); // seq 1,2,3,4 removed

    const events: SessionEvent[] = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.seq)).toEqual([1]); // ONLY the marker survives
    expect(events[0].type).toBe("session.reverted");
    expect(events[0].payload).toMatchObject({ throughSeq: 1, revertedEventCount: 4 });
    expect((events[0].payload as { at?: unknown }).at).toEqual(expect.any(String));

    const status = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(sessionId) as { status: string };
    expect(status.status).toBe("queued");
  });

  it("R77: reverting a LATER message keeps the earlier turns intact", async () => {
    const sessionId = await createSeededSession("Rewind me", [
      ["first question", "first answer"], // seq 1, 2
      ["second question", "second answer"], // seq 3, 4
    ]);
    const result = revertSession(db, sessionId, 3); // the second user message
    expect(result).toEqual({ ok: true, removedCount: 2 }); // seq 3,4
    const events: SessionEvent[] = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]); // turn 1 + marker
    expect(events[0].type).toBe("message.user");
    expect(events[1].type).toBe("message.assistant");
    expect(events[2].type).toBe("session.reverted");
    expect(events[2].payload).toMatchObject({ throughSeq: 3, revertedEventCount: 2 });
  });

  it("refuses a RUNNING session (a live turn would race the deletion)", async () => {
    const sessionId = await createSeededSession("Live", [["hi", "hello"]]);
    setSessionStatus(db, sessionId, "running");
    const result = revertSession(db, sessionId, 1);
    expect(result).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "cannot revert a running session",
    });
    // Nothing was touched.
    expect(listSessionEvents(db, sessionId).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("unknown session → NOT_FOUND error result", () => {
    expect(revertSession(db, "sess_missing", 0)).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "no session with id sess_missing",
    });
  });

  it("keepThroughSeq beyond the max seq is a no-op removal but STILL appends the marker", async () => {
    const sessionId = await createSeededSession("Edge", [["hi", "hello"]]);
    const result = revertSession(db, sessionId, 99);
    expect(result).toEqual({ ok: true, removedCount: 0 });
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]); // nothing removed, marker at seq 3
    expect(events[2].type).toBe("session.reverted");
    expect(events[2].payload).toMatchObject({ throughSeq: 99, revertedEventCount: 0 });
  });

  it("rejects a non-integer / negative keepThroughSeq", async () => {
    const sessionId = await createSeededSession("Edge", [["hi", "hello"]]);
    expect(revertSession(db, sessionId, -1)).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(revertSession(db, sessionId, 1.5)).toMatchObject({ ok: false, code: "VALIDATION" });
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe("GET /api/v1/sessions?q= (search route)", () => {
  it("returns matching sessions (title + event text) with the same envelope shape as the plain list", async () => {
    await createSeededSession("Alpha Deployment Notes", [["ship it", "shipped"]]);
    await createSeededSession("Unrelated", [["zzz querytarget zzz", "ok"]]);

    const byTitle = await authInject({ method: "GET", url: "/api/v1/sessions?q=deployment" });
    expect(byTitle.statusCode).toBe(200);
    const titleBody = byTitle.json() as { sessions: Array<{ title: string | null }>; total: number };
    expect(titleBody.total).toBe(1);
    expect(titleBody.sessions).toHaveLength(1);
    expect(titleBody.sessions[0].title).toBe("Alpha Deployment Notes");

    const byEventText = await authInject({ method: "GET", url: "/api/v1/sessions?q=QUERYTARGET" });
    const eventBody = byEventText.json() as { sessions: Array<{ title: string | null }>; total: number };
    expect(eventBody.total).toBe(1);
    expect(eventBody.sessions[0].title).toBe("Unrelated");
  });

  it("an empty/whitespace q falls back to the normal list (no search path)", async () => {
    await createSeededSession("One", [["hi", "hello"]]);
    await createSeededSession("Two", [["hi", "hello"]]);
    for (const q of ["", " ", "%20"]) {
      const response = await authInject({ method: "GET", url: `/api/v1/sessions?q=${q}` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { sessions: unknown[]; total: number };
      expect(body.total).toBe(2);
      expect(body.sessions).toHaveLength(2);
    }
  });

  it("a query with no matches returns an empty list, not an error", async () => {
    await createSeededSession("One", [["hi", "hello"]]);
    const response = await authInject({ method: "GET", url: "/api/v1/sessions?q=xyzzynomatch" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sessions: unknown[] }).sessions).toEqual([]);
  });
});

describe("POST /api/v1/sessions/:id/fork (route)", () => {
  it("201 + { session } with a full event copy on the new id", async () => {
    const sessionId = await createSeededSession("Fork route", [["one", "two"]]);
    const response = await authInject({ method: "POST", url: `/api/v1/sessions/${sessionId}/fork` });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { session: { id: string; title: string; status: string } };
    expect(body.session.id).not.toBe(sessionId);
    expect(body.session.title).toBe("Fork · Fork route");
    expect(body.session.status).toBe("queued");

    // The fork's log is served by the normal detail route.
    const detail = await authInject({ method: "GET", url: `/api/v1/sessions/${body.session.id}` });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { events: Array<{ type: string }>; lastSeq: number };
    expect(detailBody.events.map((e) => e.type)).toEqual(["message.user", "message.assistant"]);
    expect(detailBody.lastSeq).toBe(2);

    // The ORIGINAL is untouched (fork copies, never moves).
    const original = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    expect(((original.json() as { lastSeq: number })).lastSeq).toBe(2);
  });

  it("404 NOT_FOUND for an unknown session", async () => {
    const response = await authInject({ method: "POST", url: "/api/v1/sessions/sess_nope/fork" });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/sessions/:id/revert (route)", () => {
  it("200 { ok, removedCount } — R77: truncates the log FROM the target message (inclusive) and appends the marker", async () => {
    const sessionId = await createSeededSession("Revert route", [
      ["first question", "first answer"], // seq 1, 2
      ["second question", "second answer"], // seq 3, 4
    ]);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/revert`,
      payload: { keepThroughSeq: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, removedCount: 4 }); // seq 1,2,3,4

    const detail = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    const body = detail.json() as { events: Array<{ seq: number; type: string }>; lastSeq: number };
    expect(body.events.map((e) => e.type)).toEqual(["session.reverted"]);
    expect(body.lastSeq).toBe(1);
  });

  it("400 VALIDATION for a missing / non-integer / negative keepThroughSeq", async () => {
    const sessionId = await createSeededSession("Revert validation", [["hi", "hello"]]);
    const cases: Array<{ name: string; payload?: Record<string, unknown> }> = [
      { name: "missing body", payload: undefined },
      { name: "missing field", payload: {} },
      { name: "non-integer", payload: { keepThroughSeq: 1.5 } },
      { name: "negative", payload: { keepThroughSeq: -1 } },
      { name: "wrong type", payload: { keepThroughSeq: "3" } },
    ];
    for (const testCase of cases) {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/revert`,
        ...(testCase.payload !== undefined ? { payload: testCase.payload } : {}),
      });
      expect(response.statusCode, testCase.name).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    }
  });

  it("404 NOT_FOUND for an unknown session", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_nope/revert",
      payload: { keepThroughSeq: 0 },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("409 CONFLICT when the session is running", async () => {
    const sessionId = await createSeededSession("Revert conflict", [["hi", "hello"]]);
    setSessionStatus(db, sessionId, "running");
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/revert`,
      payload: { keepThroughSeq: 1 },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("cannot revert a running session");
  });
});
