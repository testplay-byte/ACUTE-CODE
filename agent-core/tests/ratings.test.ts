/**
 * ROUND-59 (R59-D) — the RESPONSE RATING system.
 *
 * Owner directive: "add the options to mark the responses as good or bad,
 * and all of these will be tracked and saved. I can send you each one of
 * those, and you can determine what went wrong: did it perform the request
 * which it was given properly or not? The full context will be properly
 * shared." These tests pin:
 *
 *   - storage/ratings.ts: the upsert semantics (re-rating overwrites
 *     rating+note+context and KEEPS created_at; one row per
 *     (session_id, assistant_seq)), the code-side validation (typed
 *     RatingError → 400/404), the FROZEN context snapshot (user message,
 *     reply with usage/ms, tool events, turn-error capture, honest
 *     truncation flags, the synthetic no-user-event edge, the stats-carrier
 *     fallback), the with/without-context listings + filters, and delete,
 *   - the REST surface: POST/GET /sessions/:id/ratings, GET /ratings
 *     (full-context analysis path), DELETE /ratings/:id — happy paths,
 *     401 (bearer wall), 404 (unknown session / rating id), 400s (bad body,
 *     unknown assistantSeq, bad filters),
 *   - migration 0022 on the standard bootstrap + on a simulated pre-R59
 *     install (audit row, idempotent reopen, SQL-level constraints).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createAgent } from "../src/storage/agents";
import { appendSessionEvent, createSession } from "../src/storage/sessions";
import {
  MAX_CONTEXT_FIELD_CHARS,
  MAX_RATING_NOTE_CHARS,
  MAX_TOOL_EVENTS,
  MAX_TOOL_SUMMARY_CHARS,
  RatingError,
  type Rating,
  deleteRating,
  listRatings,
  listSessionRatings,
  rateReply,
} from "../src/storage/ratings";

const dir = mkdtempSync(join(tmpdir(), "acute-ratings-"));
const TOKEN = "test-token-r59d";

let db: SqliteDatabase;
let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (db !== undefined) {
    db.close();
    db = undefined as unknown as SqliteDatabase;
  }
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

beforeEach(() => {
  db = openDatabase(join(dir, `${randomUUID()}.db`));
});

/* ── Event-log seeding helpers (payload shapes as runtime.ts writes them) ── */

/** The session's bound agent (set by seedSession; the events carry it, like
 * the runtime mirrors agentId into every payload). */
let seededAgentId = "";

function seedSession(title = "Ratings probe"): string {
  const agent = createAgent(db, { name: "Rater" });
  seededAgentId = agent.id;
  const session = createSession(db, {
    agentId: agent.id,
    mode: "single",
    title,
  });
  return session.id;
}

function userEvent(sessionId: string, content: string): number {
  return appendSessionEvent(db, sessionId, {
    type: "message.user",
    agentId: seededAgentId,
    payload: { role: "user", content },
  }).seq;
}

function toolEvent(
  sessionId: string,
  toolName: string,
  ok: boolean,
  outputSummary?: string,
): number {
  return appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: seededAgentId,
    payload: {
      role: "tool",
      toolName,
      argsSummary: `path: ${toolName}.txt`,
      ok,
      ...(outputSummary !== undefined ? { outputSummary } : {}),
    },
  }).seq;
}

function assistantEvent(
  sessionId: string,
  content: string,
  extras: { usage?: { inputTokens: number; outputTokens: number }; ms?: number; model?: string } = {},
): number {
  return appendSessionEvent(db, sessionId, {
    type: "message.assistant",
    agentId: seededAgentId,
    payload: {
      role: "assistant",
      content,
      ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
      ...(extras.ms !== undefined ? { ms: extras.ms } : {}),
      ...(extras.model !== undefined ? { model: extras.model } : {}),
    },
  }).seq;
}

function turnErrorEvent(sessionId: string): number {
  return appendSessionEvent(db, sessionId, {
    type: "turn.error",
    agentId: seededAgentId,
    payload: {
      code: "PROVIDER_ERROR",
      message: "provider 'openrouter' call failed",
      model: "test/model",
      providerId: "openrouter",
      providerError: "HTTP 502 upstream",
      userSeq: 1,
    },
  }).seq;
}

/** The canonical one-turn conversation the fidelity tests rate. */
function seedTurn(sessionId: string): { replySeq: number } {
  userEvent(sessionId, "please fix the parser");
  toolEvent(sessionId, "read_file", true, "read 120 lines");
  toolEvent(sessionId, "edit_file", false, "edit rejected: no match");
  const replySeq = assistantEvent(sessionId, "the parser is fixed", {
    usage: { inputTokens: 1200, outputTokens: 80 },
    ms: 2400,
    model: "test/model",
  });
  return { replySeq };
}

/* ── Storage: upsert semantics + views ───────────────────────────────────── */

describe("rating storage (upsert + views)", () => {
  it("inserts one row and returns the LIGHT view (no context key)", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);

    const view = rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });

    expect(view).toMatchObject({
      sessionId,
      assistantSeq: replySeq,
      rating: "good",
      note: null,
      model: "test/model",
      agentId: seededAgentId,
    });
    expect(view.id).toBeGreaterThan(0);
    expect(view.createdAt).toBe(view.updatedAt);
    // Light view: the context never rides the POST response or the
    // per-session listing — only the analysis path reads it back.
    expect("context" in view).toBe(false);

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM message_ratings")
      .get() as { c: number };
    expect(rows.c).toBe(1);
    // The snapshot IS persisted (context_json).
    const raw = db
      .prepare("SELECT context_json FROM message_ratings")
      .get() as { context_json: string };
    expect(JSON.parse(raw.context_json).version).toBe(1);
  });

  it("re-rating overwrites rating + note + context and KEEPS created_at (upsert on (session_id, assistant_seq))", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);

    // Fake clock: the two writes must land at DISTINCT timestamps so the
    // createdAt-kept / updatedAt-bumped contract is deterministic.
    vi.useFakeTimers({ now: new Date("2026-09-01T00:00:00Z") });
    try {
      const first = rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });
      // Turn grows AFTER the first rating — the re-rate must refresh the
      // frozen context (immutability is per-verdict, not per-first-write).
      vi.advanceTimersByTime(1500);
      // The log changes between the two writes (a revert-style truncation
      // removed one tool event) — the re-rate must refresh the frozen
      // context from the CURRENT log.
      db.prepare("DELETE FROM session_events WHERE seq = 3").run();
      const second = rateReply(db, {
        sessionId,
        assistantSeq: replySeq,
        rating: "bad",
        note: "  it never ran the tests  ",
      });

      expect(second.id).toBe(first.id); // one row, overwritten in place
      expect(second.createdAt).toBe(first.createdAt); // kept
      expect(second.updatedAt).not.toBe(first.updatedAt); // bumped
      expect(second.rating).toBe("bad");
      expect(second.note).toBe("it never ran the tests"); // trimmed
    } finally {
      vi.useRealTimers();
    }

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM message_ratings")
      .get() as { c: number };
    expect(rows.c).toBe(1); // no duplicate rows — the UNIQUE is handled

    // The refreshed context reflects the truncated log: ONE tool event left
    // (the deleted edit_file at seq 3 no longer rides the snapshot).
    const [full] = listRatings(db, { sessionId });
    expect(full.context?.toolEvents).toHaveLength(1);
    expect(full.context?.toolEvents[0]).toMatchObject({ tool: "read_file", ok: true });
  });

  it("the raw UNIQUE (session_id, assistant_seq) is enforced at the SQL level (the upsert never hits it)", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });
    const insert = db.prepare(
      `INSERT INTO message_ratings (session_id, assistant_seq, rating, context_json, created_at, updated_at)
       VALUES (?, ?, 'good', '{}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    expect(() => insert.run(sessionId, replySeq)).toThrow(/UNIQUE/);
  });

  it("the CHECK constraint only admits good|bad", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    const insert = db.prepare(
      `INSERT INTO message_ratings (session_id, assistant_seq, rating, context_json, created_at, updated_at)
       VALUES (?, ?, 'meh', '{}', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    );
    expect(() => insert.run(sessionId, replySeq)).toThrow(/CHECK/);
  });
});

/* ── Storage: typed validation errors ────────────────────────────────────── */

describe("rating validation (typed RatingError)", () => {
  it("unknown session → 404 NOT_FOUND", () => {
    expect(() =>
      rateReply(db, { sessionId: "sess_ghost", assistantSeq: 1, rating: "good" }),
    ).toThrow(RatingError);
    try {
      rateReply(db, { sessionId: "sess_ghost", assistantSeq: 1, rating: "good" });
    } catch (err) {
      expect((err as RatingError).status).toBe(404);
      expect((err as RatingError).code).toBe("NOT_FOUND");
    }
  });

  it("session exists but no message.assistant at the seq → 400 VALIDATION", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "hello");
    const replySeq = assistantEvent(sessionId, "hi");

    let thrown: unknown;
    try {
      rateReply(db, { sessionId, assistantSeq: replySeq + 5, rating: "good" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RatingError);
    expect((thrown as RatingError).status).toBe(400);
    expect((thrown as RatingError).code).toBe("VALIDATION");
    expect((thrown as RatingError).message).toContain("message.assistant");
  });

  it("rejects non-positive / non-integer assistantSeq and any rating besides good|bad", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    // The rating union is deliberately bypassed with `as` for the runtime
    // validation case ("meh" must be REJECTED by storage, not by the type
    // system — the HTTP route delivers untyped JSON).
    const cases: Array<{ assistantSeq: number; rating: string }> = [
      { assistantSeq: 0, rating: "good" },
      { assistantSeq: -3, rating: "good" },
      { assistantSeq: 1.5, rating: "good" },
      { assistantSeq: replySeq, rating: "meh" },
    ];
    for (const input of cases) {
      expect(() =>
        rateReply(db, {
          sessionId,
          assistantSeq: input.assistantSeq,
          rating: input.rating as Rating,
        }),
      ).toThrow(RatingError);
    }
  });

  it("rejects a note over the cap and trims an empty note to null", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    expect(() =>
      rateReply(db, {
        sessionId,
        assistantSeq: replySeq,
        rating: "good",
        note: "x".repeat(MAX_RATING_NOTE_CHARS + 1),
      }),
    ).toThrow(/note must be at most/);
    const view = rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good", note: "   " });
    expect(view.note).toBeNull();
  });
});

/* ── Storage: the frozen context snapshot ───────────────────────────────── */

describe("context snapshot fidelity", () => {
  it("captures the user message, the reply, the tool events, and the turn identity", () => {
    const sessionId = seedSession("Snapshot fidelity");
    const { replySeq } = seedTurn(sessionId);
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });

    const [row] = listRatings(db, { sessionId });
    const ctx = row.context;
    expect(ctx).toBeDefined();
    expect(ctx?.version).toBe(1);
    expect(ctx?.sessionTitle).toBe("Snapshot fidelity");
    expect(ctx?.agentId).toBe(seededAgentId);
    expect(ctx?.agentName).toBe("Rater"); // resolved from the agents table
    expect(ctx?.model).toBe("test/model");
    expect(ctx?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The turn's first event IS the user message → turnStartSeq is its seq.
    expect(ctx?.turnStartSeq).toBe(1);
    expect(ctx?.userMessage).toMatchObject({ content: "please fix the parser" });
    expect(ctx?.userMessage?.truncated).toBe(false);
    expect(ctx?.assistantReply).toMatchObject({
      content: "the parser is fixed",
      truncated: false,
      usage: { inputTokens: 1200, outputTokens: 80 },
      ms: 2400,
    });
    expect(ctx?.toolEvents).toEqual([
      expect.objectContaining({ tool: "read_file", ok: true, seq: 2 }),
      expect.objectContaining({ tool: "edit_file", ok: false, seq: 3 }),
    ]);
    expect(ctx?.toolEvents?.[0]?.outputSummary).toMatchObject({
      content: "read 120 lines",
      truncated: false,
    });
    // user + 2 tools + reply = 4 events in the range (inclusive).
    expect(ctx?.eventCount).toBe(4);
    expect(ctx?.turnError).toBeUndefined();
  });

  it("captures any turn.error in the range", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "do the thing");
    turnErrorEvent(sessionId);
    const replySeq = assistantEvent(sessionId, "recovered reply", { model: "test/model" });
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "bad" });

    const [row] = listRatings(db, { sessionId });
    expect(row.context?.turnError).toMatchObject({
      code: "PROVIDER_ERROR",
      message: "provider 'openrouter' call failed",
      providerError: "HTTP 502 upstream",
    });
    expect(row.assistantSeq).toBe(replySeq);
  });

  it("marks honestly what it truncates (8000-char fields, 500-char tool summaries, 50 tool events)", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "x".repeat(MAX_CONTEXT_FIELD_CHARS + 500));
    for (let i = 0; i < MAX_TOOL_EVENTS + 7; i++) {
      toolEvent(sessionId, "run_command", true, "y".repeat(MAX_TOOL_SUMMARY_CHARS + 100));
    }
    const replySeq = assistantEvent(sessionId, "z".repeat(MAX_CONTEXT_FIELD_CHARS + 900));
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "bad" });

    const [row] = listRatings(db, { sessionId });
    const ctx = row.context;
    expect(ctx?.userMessage?.truncated).toBe(true);
    expect(ctx?.userMessage?.content).toHaveLength(MAX_CONTEXT_FIELD_CHARS);
    expect(ctx?.assistantReply?.truncated).toBe(true);
    expect(ctx?.assistantReply?.content).toHaveLength(MAX_CONTEXT_FIELD_CHARS);
    expect(ctx?.toolEvents).toHaveLength(MAX_TOOL_EVENTS); // entry cap
    for (const tool of ctx?.toolEvents ?? []) {
      expect(tool.outputSummary?.truncated).toBe(true);
      expect(tool.outputSummary?.content).toHaveLength(MAX_TOOL_SUMMARY_CHARS);
    }
    // The event count stays HONEST: all 60+ events span the turn.
    expect(ctx?.eventCount).toBe(MAX_TOOL_EVENTS + 7 + 2);
  });

  it("synthetic leading turn (no user event): snapshots from the turn's first event, userMessage null", () => {
    const sessionId = seedSession();
    // A log that STARTS with assistant events (no message.user anywhere).
    const firstSeq = assistantEvent(sessionId, "leading narration");
    toolEvent(sessionId, "read_file", true, "read");
    const replySeq = assistantEvent(sessionId, "the answer", { model: "test/model" });
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });

    const [row] = listRatings(db, { sessionId });
    const ctx = row.context;
    expect(row.assistantSeq).toBe(replySeq);
    expect(ctx?.userMessage).toBeNull();
    // The turn's first event = the FIRST turn-relevant event (seq of the
    // leading narration), not the reply itself.
    expect(ctx?.turnStartSeq).toBe(firstSeq);
    expect(ctx?.assistantReply?.content).toBe("the answer");
    expect(ctx?.toolEvents).toHaveLength(1);
  });

  it("only the LATEST user message bounds the turn (a previous turn's events stay out)", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "first request");
    assistantEvent(sessionId, "first reply");
    const secondUserSeq = userEvent(sessionId, "second request");
    toolEvent(sessionId, "read_file", true, "read");
    const replySeq = assistantEvent(sessionId, "second reply");
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });

    const [row] = listRatings(db, { sessionId });
    const ctx = row.context;
    expect(ctx?.turnStartSeq).toBe(secondUserSeq);
    expect(ctx?.userMessage?.content).toBe("second request");
    expect(ctx?.toolEvents).toHaveLength(1);
    expect(ctx?.eventCount).toBe(replySeq - secondUserSeq + 1);
  });

  it("stats-carrier fallback: usage/ms/model read from the last assistant event carrying them", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "ping");
    // The rated event (last NON-empty text) carries NO stats; the R35
    // stats-carrier (empty content) follows it with them.
    const replySeq = assistantEvent(sessionId, "pong");
    assistantEvent(sessionId, "", {
      usage: { inputTokens: 42, outputTokens: 7 },
      ms: 1234,
      model: "test/model",
    });
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });

    const [row] = listRatings(db, { sessionId });
    expect(row.model).toBe("test/model");
    const ctx = row.context;
    expect(ctx?.model).toBe("test/model");
    expect(ctx?.assistantReply).toMatchObject({
      content: "pong",
      usage: { inputTokens: 42, outputTokens: 7 },
      ms: 1234,
    });
    expect(row.assistantSeq).toBe(replySeq);
  });

  it("the snapshot is IMMUTABLE EVIDENCE: deleting the turn's events after rating leaves the context intact", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    rateReply(db, { sessionId, assistantSeq: replySeq, rating: "bad", note: "wrong file" });

    // A revert-style truncation wipes the session's events…
    db.prepare("DELETE FROM session_events WHERE session_id = ?").run(sessionId);
    // …the rating survives with its frozen context (and re-listing works).
    const [row] = listRatings(db, { sessionId });
    expect(row.context?.userMessage?.content).toBe("please fix the parser");
    expect(row.context?.assistantReply?.content).toBe("the parser is fixed");
    expect(row.note).toBe("wrong file");
  });
});

/* ── Storage: listings + delete ─────────────────────────────────────────── */

describe("listings + delete", () => {
  it("listSessionRatings serves light views in conversation order", () => {
    const sessionId = seedSession();
    userEvent(sessionId, "q1");
    const r1 = assistantEvent(sessionId, "a1");
    userEvent(sessionId, "q2");
    const r2 = assistantEvent(sessionId, "a2");
    rateReply(db, { sessionId, assistantSeq: r2, rating: "good" });
    rateReply(db, { sessionId, assistantSeq: r1, rating: "bad" });

    const list = listSessionRatings(db, sessionId);
    expect(list.map((r) => r.assistantSeq)).toEqual([r1, r2]); // seq ASC
    for (const row of list) expect("context" in row).toBe(false);
  });

  it("listRatings serves FULL context, newest-first, with sessionId/rating/limit filters", () => {
    const a = seedSession("A");
    const b = seedSession("B");
    userEvent(a, "qa");
    const ra = assistantEvent(a, "aa");
    userEvent(b, "qb");
    const rb1 = assistantEvent(b, "ab1");
    const rb2 = assistantEvent(b, "ab2");
    rateReply(db, { sessionId: a, assistantSeq: ra, rating: "good" });
    rateReply(db, { sessionId: b, assistantSeq: rb1, rating: "bad" });
    rateReply(db, { sessionId: b, assistantSeq: rb2, rating: "good" });

    const all = listRatings(db);
    expect(all).toHaveLength(3);
    for (const row of all) expect(row.context).toBeDefined();

    // newest-first: same-millisecond writes tie-break on rowid DESC.
    expect(all[0].assistantSeq).toBe(rb2);
    expect(all[1].assistantSeq).toBe(rb1);
    expect(all[2].assistantSeq).toBe(ra);

    expect(listRatings(db, { sessionId: a }).map((r) => r.assistantSeq)).toEqual([ra]);
    expect(listRatings(db, { rating: "bad" }).map((r) => r.assistantSeq)).toEqual([rb1]);
    expect(listRatings(db, { limit: 2 })).toHaveLength(2);
    // Unknown session filter → empty (ratings outlive session deletes).
    expect(listRatings(db, { sessionId: "sess_ghost" })).toEqual([]);
    // Invalid rating filter is a typed validation error.
    expect(() =>
      listRatings(db, { rating: "meh" as unknown as "good" }),
    ).toThrow(RatingError);
  });

  it("deleteRating removes by row id and reports misses", () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    const view = rateReply(db, { sessionId, assistantSeq: replySeq, rating: "good" });
    expect(deleteRating(db, view.id)).toBe(true);
    expect(deleteRating(db, view.id)).toBe(false);
    expect(listSessionRatings(db, sessionId)).toHaveLength(0);
    expect(deleteRating(db, -1)).toBe(false);
  });
});

/* ── REST surface ────────────────────────────────────────────────────────── */

describe("REST: POST/GET /sessions/:id/ratings + GET /ratings + DELETE /ratings/:id", () => {
  beforeEach(() => {
    app = buildServer({ token: TOKEN, db });
  });

  function authInject(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }) {
    return app!.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } });
  }

  it("POST rates a reply (200, light view) and upserts on re-rate", async () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);

    const first = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/ratings`,
      payload: { assistantSeq: replySeq, rating: "good" },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.rating).toMatchObject({ assistantSeq: replySeq, rating: "good", note: null });
    expect(firstBody.rating.context).toBeUndefined();

    const second = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/ratings`,
      payload: { assistantSeq: replySeq, rating: "bad", note: "wrong file" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().rating.id).toBe(firstBody.rating.id);
    expect(second.json().rating.rating).toBe("bad");

    // The per-session listing the chat UI's map reads.
    const listed = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/ratings` });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json().ratings;
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("wrong file");
    expect(rows[0].context).toBeUndefined();
  });

  it("GET /ratings serves the FULL-context analysis path with filters", async () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/ratings`,
      payload: { assistantSeq: replySeq, rating: "bad", note: "ignored the tests" },
    });

    const res = await authInject({ method: "GET", url: "/api/v1/ratings?rating=bad&limit=5" });
    expect(res.statusCode).toBe(200);
    const rows = res.json().ratings;
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toMatchObject({ version: 1 });
    expect(rows[0].context.assistantReply.content).toBe("the parser is fixed");

    const scoped = await authInject({
      method: "GET",
      url: `/api/v1/ratings?sessionId=${sessionId}`,
    });
    expect(scoped.json().ratings).toHaveLength(1);

    const none = await authInject({ method: "GET", url: "/api/v1/ratings?sessionId=sess_ghost" });
    expect(none.statusCode).toBe(200);
    expect(none.json().ratings).toEqual([]);
  });

  it("DELETE /ratings/:id clears a verdict (200 {ok}) and 404s on misses", async () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);
    const created = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/ratings`,
      payload: { assistantSeq: replySeq, rating: "good" },
    });
    const id = created.json().rating.id;

    const removed = await authInject({ method: "DELETE", url: `/api/v1/ratings/${id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });

    const missing = await authInject({ method: "DELETE", url: `/api/v1/ratings/${id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");

    const badId = await authInject({ method: "DELETE", url: "/api/v1/ratings/not-a-number" });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe("VALIDATION");
  });

  it("requires the bearer token on every ratings route (401 without)", async () => {
    for (const route of [
      { method: "POST" as const, url: "/api/v1/sessions/s/ratings" },
      { method: "GET" as const, url: "/api/v1/sessions/s/ratings" },
      { method: "GET" as const, url: "/api/v1/ratings" },
      { method: "DELETE" as const, url: "/api/v1/ratings/1" },
    ]) {
      const res = await app!.inject({ method: route.method, url: route.url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    }
  });

  it("404 unknown session on POST and GET (session-scoped)", async () => {
    const post = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_ghost/ratings",
      payload: { assistantSeq: 1, rating: "good" },
    });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe("NOT_FOUND");

    const get = await authInject({ method: "GET", url: "/api/v1/sessions/sess_ghost/ratings" });
    expect(get.statusCode).toBe(404);
  });

  it("400 VALIDATION: malformed body, bad assistantSeq, bad rating, long note, unknown assistantSeq, bad filter", async () => {
    const sessionId = seedSession();
    const { replySeq } = seedTurn(sessionId);

    const cases: Array<{ payload: Record<string, unknown>; field: string }> = [
      { payload: { rating: "good" }, field: "body.assistantSeq" },
      { payload: { assistantSeq: 0, rating: "good" }, field: "body.assistantSeq" },
      { payload: { assistantSeq: 1.5, rating: "good" }, field: "body.assistantSeq" },
      { payload: { assistantSeq: replySeq, rating: "meh" }, field: "body.rating" },
      {
        payload: { assistantSeq: replySeq, rating: "good", note: "x".repeat(MAX_RATING_NOTE_CHARS + 1) },
        field: "body.note",
      },
      {
        // Session exists, no assistant event at this seq → nothing to rate.
        payload: { assistantSeq: replySeq + 99, rating: "good" },
        field: "body.assistantSeq",
      },
    ];
    for (const { payload, field } of cases) {
      const res = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/ratings`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
      expect(res.json().error.details.field).toBe(field);
    }

    const nonObject = await app!.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/ratings`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: '"just a string"',
    });
    expect(nonObject.statusCode).toBe(400);
    expect(nonObject.json().error.code).toBe("VALIDATION");

    const badFilter = await authInject({ method: "GET", url: "/api/v1/ratings?rating=meh" });
    expect(badFilter.statusCode).toBe(400);
    expect(badFilter.json().error.details.field).toBe("query.rating");
  });
});

/* ── Migration 0022 ──────────────────────────────────────────────────────── */

/** Applies migrations 0001..0021 by hand — simulates a pre-R59 install. */
function openPreR59Database(path: string): SqliteDatabase {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 21)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(21);
  const insert = raw.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    raw.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return raw;
}

describe("migration 0022 (message_ratings)", () => {
  it("applies on the standard test bootstrap with the audit row", () => {
    // beforeEach already ran openDatabase — the fresh DB carries 0022.
    const applied = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 22")
      .get() as { version: number; name: string };
    expect(applied).toEqual({ version: 22, name: "0022_message_ratings.sql" });
    const audit = db
      .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0022'")
      .get() as { actor: string; action: string } | undefined;
    expect(audit).toEqual({ actor: "migration-0022", action: "ratings.system.create" });
  });

  it("upgrades a pre-R59 install (existing events become rateable) and is idempotent on reopen", () => {
    const path = join(dir, `m0022-${randomUUID()}.db`);
    const old = openPreR59Database(path);
    // A living pre-R59 session whose events must become rateable post-migration.
    const agent = createAgent(old, { name: "Pre" });
    const session = createSession(old, { agentId: agent.id, mode: "single", title: "Pre-R59" });
    appendSessionEvent(old, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "legacy question" },
    });
    const reply = appendSessionEvent(old, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "legacy reply", model: "legacy/model" },
    });
    old.close();

    // Reopen with the current code: 0022 applies inside openDatabase.
    const db2 = openDatabase(path);
    try {
      const view = rateReply(db2, { sessionId: session.id, assistantSeq: reply.seq, rating: "bad" });
      expect(view.model).toBe("legacy/model");
      const [row] = listRatings(db2, { sessionId: session.id });
      expect(row.context?.userMessage?.content).toBe("legacy question");
      expect(row.context?.assistantReply?.content).toBe("legacy reply");
    } finally {
      db2.close();
    }

    // Idempotent: reopening does not re-apply or fail.
    const again = openDatabase(path);
    const count = again
      .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 22")
      .get() as { c: number };
    expect(count.c).toBe(1);
    again.close();
  });
});
