/**
 * Response-rating repository (ROUND-59, R59-D — owner directive: "add the
 * options to mark the responses as good or bad, and all of these will be
 * tracked and saved. I can send you each one of those, and you can
 * determine what went wrong: did it perform the request which it was given
 * properly or not? The full context will be properly shared.").
 *
 * The owner rates an assistant reply good/bad (optional note); the rating is
 * persisted TOGETHER with a FULL CONTEXT SNAPSHOT of the turn it belongs to,
 * built from the append-only event log (ADR-0010) AT RATE TIME. The snapshot
 * is what makes each rating immutable evidence: a later revert / fork /
 * session delete cannot alter what was rated — the analysis path
 * (GET /ratings, the CLI `ratings --full` dump) reads the frozen context, not
 * the living log.
 *
 * The ONLY SQL for ratings lives here (anti-drift rule, same as every other
 * storage module). Validation is code-side (typed RatingError → the routes
 * map it to 4xx envelopes) so callers get readable errors instead of raw
 * SQLite exceptions. No FK on sessions (the repo's deliberate no-FK
 * convention — see migration 0022's header for the intended consequences).
 */
import type Database from "better-sqlite3";
import { getAgent } from "./agents.js";
import { getSession, listSessionEvents } from "./sessions.js";

export type SqliteDatabase = Database.Database;

/** The two verdicts (mirrors the 0022 CHECK constraint). */
export type Rating = "good" | "bad";

/** Hard cap on the owner's note (mirrors the route validation). */
export const MAX_RATING_NOTE_CHARS = 2_000;

/* ── Context snapshot bounds (the "full context will be properly shared"
 * directive, honestly bounded so one rating row can never blow up the DB) ── */

/** Per-field cap for userMessage/assistantReply content. */
export const MAX_CONTEXT_FIELD_CHARS = 8_000;
/** Per-tool-entry cap for the output summary. */
export const MAX_TOOL_SUMMARY_CHARS = 500;
/** Max captured tool events per rating. */
export const MAX_TOOL_EVENTS = 50;

/**
 * Typed validation/not-found error. `status` + `code` map straight onto the
 * API.md §1.3 error envelope (the routes just forward them).
 */
export class RatingError extends Error {
  readonly status: 400 | 404;
  readonly code: "VALIDATION" | "NOT_FOUND";
  /** Offending request field, when one exists (rides the error envelope's
   * `details.field` — the repo's 400 convention). */
  readonly field?: string;

  constructor(
    status: 400 | 404,
    code: "VALIDATION" | "NOT_FOUND",
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "RatingError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** A capped text field — `truncated` is the honest flag the owner asked for
 * ("full context" means real data, never silently sliced without a mark). */
export interface CappedText {
  content: string;
  truncated: boolean;
}

/** Usage as persisted on message.assistant payloads. */
export interface RatingUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The frozen turn context (version 1). Captured at RATE time; sizes bounded
 * (see the constants above). Field semantics:
 * - `userMessage` — the turn's opening user message (null only for a
 *   synthetic leading turn that starts with assistant events, or a corrupt
 *   payload): what the owner ASKED for.
 * - `assistantReply` — the rated reply itself (content + ts + usage + ms).
 * - `toolEvents` — every tool call between the user message and the reply:
 *   what the agent DID (in order, ok flag + output summary).
 * - `turnError` — any turn.error event in the range: what went WRONG.
 * - `eventCount` — how many log events the turn spanned (honest size signal
 *   when the caps above trimmed the captured fields).
 */
export interface RatingContext {
  version: 1;
  capturedAt: string;
  sessionTitle: string | null;
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  turnStartSeq: number;
  userMessage: ({ ts: string } & CappedText) | null;
  assistantReply: { ts: string; usage?: RatingUsage; ms?: number } & CappedText;
  toolEvents: Array<{
    seq: number;
    tool: string;
    ok: boolean | null;
    outputSummary: CappedText | null;
  }>;
  turnError?: {
    code: string;
    message: string;
    providerError?: string;
  };
  eventCount: number;
}

/** Rating row as served by the API. `context` is present ONLY in the
 * with-context listing (GET /ratings — the analysis/export path); the
 * per-session listing (the chat UI's map) stays light. */
export interface RatingView {
  id: number;
  sessionId: string;
  assistantSeq: number;
  rating: Rating;
  note: string | null;
  model: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  context?: RatingContext;
}

/** Input for rateReply (the route validates the raw body first). */
export interface RateReply {
  sessionId: string;
  assistantSeq: number;
  rating: Rating;
  note?: string;
}

interface RatingRow {
  id: number;
  session_id: string;
  assistant_seq: number;
  rating: Rating;
  note: string | null;
  context_json: string;
  model: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

function toView(row: RatingRow, withContext: boolean): RatingView {
  return {
    id: row.id,
    sessionId: row.session_id,
    assistantSeq: row.assistant_seq,
    rating: row.rating,
    note: row.note,
    model: row.model,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(withContext ? { context: JSON.parse(row.context_json) as RatingContext } : {}),
  };
}

/* ── Context snapshot ─────────────────────────────────────────────────────── */

function capText(text: string, max: number): CappedText {
  if (text.length <= max) return { content: text, truncated: false };
  return { content: text.slice(0, max), truncated: true };
}

/** Tolerant payload reader (the event log is append-only JSON — never trust
 * a shape; a corrupt row degrades honestly instead of throwing). */
function payloadOf(event: { payload: unknown }): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Event types that open/belong to a turn — mirrors toProjectChatItems's fold
 * classification (the turn a synthetic leading log starts with). */
const TURN_EVENT_TYPES = new Set([
  "tool.use",
  "message.assistant",
  "approval.requested",
  "approval.resolved",
]);

/**
 * Build the frozen turn context for the `message.assistant` event at
 * `assistantSeq`:
 * 1. Locate the event (missing → 400 VALIDATION — nothing to rate there).
 * 2. Walk BACK to the nearest preceding `message.user` (the turn start). A
 *    log with no user event before the reply (synthetic leading turn, or a
 *    session reverted up to the reply) snapshots from the turn's FIRST event.
 * 3. Capture the user message, the reply (content/ts/usage/ms), every
 *    tool.use in between, and any turn.error in the range — all capped.
 * Model/usage/ms fall back first to the LAST assistant event in the range
 * carrying them, then FORWARD to the turn's end (the R35 stats-carrier sits
 * AFTER the last text event, so the rated text event itself may lack the
 * stats — the same merge toProjectChatItems applies to the stats chips).
 * Throws RatingError for the unknown-session / missing-assistant cases.
 */
export function buildRatingContext(
  db: SqliteDatabase,
  sessionId: string,
  assistantSeq: number,
): { context: RatingContext; agentId: string | null; model: string | null } {
  const session = getSession(db, sessionId);
  if (session === undefined) {
    throw new RatingError(404, "NOT_FOUND", `no session with id ${sessionId}`);
  }
  const events = listSessionEvents(db, sessionId);
  const assistantIdx = events.findIndex(
    (e) => e.type === "message.assistant" && e.seq === assistantSeq,
  );
  if (assistantIdx === -1) {
    throw new RatingError(
      400,
      "VALIDATION",
      `session ${sessionId} has no message.assistant event at seq ${assistantSeq}`,
      "body.assistantSeq",
    );
  }
  const assistantEvent = events[assistantIdx];

  // 2. Walk back to the turn start (nearest preceding user message).
  let userStartIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (events[i].type === "message.user") {
      userStartIdx = i;
      break;
    }
  }
  let turnStartIdx = userStartIdx;
  if (turnStartIdx === -1) {
    // Synthetic leading turn: the turn's first event (fold semantics — the
    // first tool/assistant/approval event of the log).
    turnStartIdx = events.findIndex((e) => TURN_EVENT_TYPES.has(e.type));
    if (turnStartIdx === -1 || turnStartIdx > assistantIdx) turnStartIdx = assistantIdx;
  }

  const range = events.slice(turnStartIdx + 1, assistantIdx + 1);

  // Reply stats with the stats-carrier fallback (see the doc comment): the
  // R35 stats-carrier (empty content) lands AFTER the last text event, so a
  // missing stat is first searched BACKWARD inside the range, then FORWARD
  // to the turn's end (the next message.user / turn.error boundary) — the
  // same merge toProjectChatItems applies (the stats chips under the reply
  // come from the carrier).
  const ratedPayload = payloadOf(assistantEvent);
  let model: string | null =
    typeof ratedPayload.model === "string" && ratedPayload.model !== "" ? ratedPayload.model : null;
  let usage: RatingUsage | undefined;
  let ms: number | undefined;
  const readUsage = (payload: Record<string, unknown>): RatingUsage | undefined => {
    const raw = payload.usage;
    if (raw !== null && typeof raw === "object") {
      const u = raw as { inputTokens?: unknown; outputTokens?: unknown };
      if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
        return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      }
    }
    return undefined;
  };
  const takeStats = (payload: Record<string, unknown>): void => {
    if (model === null && typeof payload.model === "string" && payload.model !== "") {
      model = payload.model;
    }
    if (usage === undefined) usage = readUsage(payload);
    if (ms === undefined && typeof payload.ms === "number") ms = payload.ms;
  };
  if (typeof ratedPayload.ms === "number") ms = ratedPayload.ms;
  usage = readUsage(ratedPayload);
  if (model === null || usage === undefined || ms === undefined) {
    for (let i = range.length - 1; i >= 0; i--) {
      const candidate = range[i];
      if (candidate.type !== "message.assistant") continue;
      takeStats(payloadOf(candidate));
      if (model !== null && usage !== undefined && ms !== undefined) break;
    }
  }
  if (model === null || usage === undefined || ms === undefined) {
    // Forward: the stats-carrier trail, up to the turn's end.
    for (let i = assistantIdx + 1; i < events.length; i++) {
      const candidate = events[i];
      if (candidate.type === "message.user" || candidate.type === "turn.error") break;
      if (candidate.type !== "message.assistant") continue;
      takeStats(payloadOf(candidate));
      if (model !== null && usage !== undefined && ms !== undefined) break;
    }
  }

  // Tool events (in order, capped) + any turn error in the range.
  const toolEvents: RatingContext["toolEvents"] = [];
  let turnError: RatingContext["turnError"] | undefined;
  for (const event of range) {
    if (event.type === "tool.use" && toolEvents.length < MAX_TOOL_EVENTS) {
      const payload = payloadOf(event);
      const output =
        typeof payload.outputSummary === "string" && payload.outputSummary.length > 0
          ? capText(payload.outputSummary, MAX_TOOL_SUMMARY_CHARS)
          : null;
      toolEvents.push({
        seq: event.seq,
        tool: typeof payload.toolName === "string" ? payload.toolName : "",
        ok: typeof payload.ok === "boolean" ? payload.ok : null,
        outputSummary: output,
      });
      continue;
    }
    if (event.type === "turn.error") {
      const payload = payloadOf(event);
      turnError = {
        code: typeof payload.code === "string" ? payload.code : "UNKNOWN",
        message: typeof payload.message === "string" ? payload.message : "",
        ...(typeof payload.providerError === "string" ? { providerError: payload.providerError } : {}),
      };
    }
  }

  const userEvent = userStartIdx === -1 ? null : events[userStartIdx];
  const userPayload = userEvent === null ? {} : payloadOf(userEvent);
  const agentId = assistantEvent.agentId ?? session.agentId ?? null;
  const agent = agentId === null ? undefined : getAgent(db, agentId);

  const context: RatingContext = {
    version: 1,
    capturedAt: new Date().toISOString(),
    sessionTitle: session.title,
    agentId,
    agentName: agent?.name ?? null,
    model,
    turnStartSeq: events[turnStartIdx].seq,
    userMessage:
      userEvent === null
        ? null
        : {
            ts: userEvent.ts,
            ...capText(
              typeof userPayload.content === "string" ? userPayload.content : "",
              MAX_CONTEXT_FIELD_CHARS,
            ),
          },
    assistantReply: {
      ts: assistantEvent.ts,
      ...capText(
        typeof ratedPayload.content === "string" ? ratedPayload.content : "",
        MAX_CONTEXT_FIELD_CHARS,
      ),
      ...(usage !== undefined ? { usage } : {}),
      ...(ms !== undefined ? { ms } : {}),
    },
    toolEvents,
    ...(turnError !== undefined ? { turnError } : {}),
    eventCount: assistantIdx - turnStartIdx + 1,
  };
  return { context, agentId, model };
}

/* ── Rating CRUD ─────────────────────────────────────────────────────────── */

/**
 * Rate one assistant reply: validates, builds the frozen context snapshot,
 * and UPSERTS on (session_id, assistant_seq) — re-rating the same reply
 * overwrites rating + note + context, KEEPS created_at, and updates
 * updated_at (one verdict per reply, changeable). Returns the row view
 * WITHOUT context (the POST route's response).
 */
export function rateReply(db: SqliteDatabase, reply: RateReply): RatingView {
  const sessionId = reply.sessionId.trim();
  if (sessionId === "") {
    throw new RatingError(400, "VALIDATION", "rating requires a non-empty sessionId");
  }
  if (!Number.isInteger(reply.assistantSeq) || reply.assistantSeq <= 0) {
    throw new RatingError(
      400,
      "VALIDATION",
      "assistantSeq must be a positive integer (the event seq of the assistant reply being rated)",
      "body.assistantSeq",
    );
  }
  if (reply.rating !== "good" && reply.rating !== "bad") {
    throw new RatingError(400, "VALIDATION", "rating must be 'good' or 'bad'", "body.rating");
  }
  // Trim the note; empty → null (one-click ratings carry no note). The route
  // already enforces the length cap — this is the storage-side backstop.
  const trimmedNote = (reply.note ?? "").trim();
  if (trimmedNote.length > MAX_RATING_NOTE_CHARS) {
    throw new RatingError(
      400,
      "VALIDATION",
      `note must be at most ${MAX_RATING_NOTE_CHARS} characters`,
    );
  }
  const note = trimmedNote === "" ? null : trimmedNote;

  // Unknown session → 404 BEFORE any write (also covers the no-events case
  // via the snapshot builder's assistant lookup).
  const { context, agentId, model } = buildRatingContext(db, sessionId, reply.assistantSeq);
  const contextJson = JSON.stringify(context);
  const now = new Date().toISOString();

  const upsert = db.transaction(() => {
    const existing = db
      .prepare("SELECT id, created_at FROM message_ratings WHERE session_id = ? AND assistant_seq = ?")
      .get(sessionId, reply.assistantSeq) as { id: number; created_at: string } | undefined;
    if (existing !== undefined) {
      db.prepare(
        `UPDATE message_ratings
          SET rating = ?, note = ?, context_json = ?, model = ?, agent_id = ?, updated_at = ?
        WHERE id = ?`,
      ).run(reply.rating, note, contextJson, model, agentId, now, existing.id);
      return {
        id: existing.id,
        created_at: existing.created_at,
      };
    }
    const info = db
      .prepare(
        `INSERT INTO message_ratings
          (session_id, assistant_seq, rating, note, context_json, model, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, reply.assistantSeq, reply.rating, note, contextJson, model, agentId, now, now);
    return { id: Number(info.lastInsertRowid), created_at: now };
  });
  const { id, created_at } = upsert();

  return {
    id,
    sessionId,
    assistantSeq: reply.assistantSeq,
    rating: reply.rating,
    note,
    model,
    agentId,
    createdAt: created_at,
    updatedAt: now,
  };
}

/**
 * Per-session listing for the chat UI's rating map — views WITHOUT context
 * (the panel only needs {assistantSeq, rating, note}); ascending assistant
 * seq (conversation order).
 */
export function listSessionRatings(db: SqliteDatabase, sessionId: string): RatingView[] {
  const rows = db
    .prepare(
      `SELECT * FROM message_ratings WHERE session_id = ? ORDER BY assistant_seq ASC`,
    )
    .all(sessionId) as RatingRow[];
  return rows.map((row) => toView(row, false));
}

/**
 * Global listing for the analysis/export path — views WITH the full frozen
 * context, newest-first (updated_at DESC, then rowid DESC for
 * same-millisecond writes). Filters: sessionId (ratings outlive session
 * deletes, so an unknown id just yields an empty list), rating, limit.
 */
export function listRatings(
  db: SqliteDatabase,
  options: { sessionId?: string; rating?: Rating; limit?: number } = {},
): RatingView[] {
  if (options.rating !== undefined && options.rating !== "good" && options.rating !== "bad") {
    throw new RatingError(400, "VALIDATION", "rating filter must be 'good' or 'bad'");
  }
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.sessionId !== undefined && options.sessionId.trim() !== "") {
    clauses.push("session_id = ?");
    params.push(options.sessionId.trim());
  }
  if (options.rating !== undefined) {
    clauses.push("rating = ?");
    params.push(options.rating);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
  const rows = db
    .prepare(
      `SELECT * FROM message_ratings${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as RatingRow[];
  return rows.map((row) => toView(row, true));
}

/** Delete one rating by row id. false when the id is unknown. */
export function deleteRating(db: SqliteDatabase, id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false;
  const info = db.prepare("DELETE FROM message_ratings WHERE id = ?").run(id);
  return info.changes > 0;
}
