/**
 * Session, session-event, and usage repositories (API.md §5, §9). The event log
 * is append-only (ADR-0010): no exported function updates or deletes a
 * session_events row, and each seq is minted inside the same transaction as the
 * insert so per-session seq is strictly monotonic.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunMode, SessionStatus, UsageRecord } from "shared";

export type SqliteDatabase = Database.Database;

/** Session row as served by the API (API.md §5). */
export interface Session {
  id: string;
  projectId: string | null;
  agentId: string | null;
  mode: RunMode;
  status: SessionStatus;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** ROUND-36 (ADR-0022): set on sub-agent sessions — the delegating parent. */
  parentSessionId: string | null;
  /** ROUND-36: the delegated role (planner/researcher/coder/reviewer/tester). */
  subRole: string | null;
}

export interface SessionInput {
  agentId: string;
  mode: RunMode;
  projectId?: string | null;
  title?: string | null;
  /** ROUND-36: creates a CHILD session when set. */
  parentSessionId?: string | null;
  subRole?: string | null;
}

/** Event JSON as served by the API (API.md §5.6). `agentId` comes from the payload. */
export interface SessionEvent {
  seq: number;
  type: string;
  agentId: string | null;
  payload: unknown;
  ts: string;
}

export interface AppendEventInput {
  type: string;
  /** Mirrored into the payload (task contract: {role, content, agentId, ts}). */
  agentId?: string | null;
  payload: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  project_id: string | null;
  agent_id: string | null;
  mode: RunMode;
  status: SessionStatus;
  title: string | null;
  created_at: string;
  updated_at: string;
  parent_session_id?: string | null;
  sub_role?: string | null;
}

interface EventRow {
  seq: number;
  type: string;
  payload: string | null;
  ts: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    mode: row.mode,
    status: row.status,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parentSessionId: row.parent_session_id ?? null,
    subRole: row.sub_role ?? null,
  };
}

/** Event payloads we write today carry an agentId string; anything else stays null. */
function payloadAgentId(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "agentId" in payload) {
    const value = (payload as Record<string, unknown>).agentId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function toEvent(row: EventRow): SessionEvent {
  const payload = row.payload === null ? null : (JSON.parse(row.payload) as unknown);
  return { seq: row.seq, type: row.type, agentId: payloadAgentId(payload), payload, ts: row.ts };
}

export function createSession(db: SqliteDatabase, input: SessionInput): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: `sess_${randomUUID()}`,
    projectId: input.projectId ?? null,
    agentId: input.agentId,
    mode: input.mode,
    status: "queued",
    title: input.title ?? null,
    createdAt: now,
    updatedAt: now,
    parentSessionId: input.parentSessionId ?? null,
    subRole: input.subRole ?? null,
  };
  db.prepare(
    `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at, parent_session_id, sub_role)
     VALUES (@id, @projectId, @agentId, @mode, @status, @title, @createdAt, @updatedAt, @parentSessionId, @subRole)`,
  ).run({
    ...session,
    parentSessionId: input.parentSessionId ?? null,
    subRole: input.subRole ?? null,
  });
  return session;
}

export function getSession(db: SqliteDatabase, id: string): Session | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row === undefined ? undefined : toSession(row);
}

/** Newest-first (API.md §5.2) with the matching total for pagination.
 * ROUND-36: sub-agent children are EXCLUDED by default (the sidebar stays
 * clean); `includeChildren: true` opts in. */
export function listSessions(
  db: SqliteDatabase,
  options: { limit: number; offset: number; includeChildren?: boolean },
): { sessions: Session[]; total: number } {
  const filter = options.includeChildren ? "" : " WHERE parent_session_id IS NULL";
  const rows = db
    .prepare(
      `SELECT * FROM sessions${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(options.limit, options.offset) as SessionRow[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions${filter}`)
    .get() as { total: number };
  return { sessions: rows.map(toSession), total };
}

/** ROUND-36 (ADR-0022): a child session's computed status for the
 * sub-agents view — progress from todo.update events, tokens from the usage
 * ledger, report from the last non-empty assistant message. */
export interface SubAgentStatus {
  id: string;
  title: string | null;
  subRole: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  todosDone: number;
  todosTotal: number;
  inputTokens: number;
  outputTokens: number;
  report: string | null;
  error: string | null;
}

export function listSubAgents(db: SqliteDatabase, parentSessionId: string): SubAgentStatus[] {
  const children = db
    .prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(parentSessionId) as SessionRow[];
  return children.map((child) => {
    // Latest todo.update → progress.
    let todosDone = 0;
    let todosTotal = 0;
    for (const ev of listSessionEvents(db, child.id)) {
      if (ev.type !== "todo.update") continue;
      const todos = (ev.payload as { todos?: Array<{ status?: string }> }).todos;
      if (Array.isArray(todos) && todos.length > 0) {
        todosTotal = todos.length;
        todosDone = todos.filter((t) => t.status === "completed").length;
      }
    }
    const usage = db
      .prepare(
        "SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM usage_events WHERE session_id = ?",
      )
      .get(child.id) as { i: number; o: number };
    let report: string | null = null;
    let error: string | null = null;
    for (const ev of listSessionEvents(db, child.id)) {
      if (ev.type === "message.assistant") {
        const content = (ev.payload as { content?: unknown }).content;
        if (typeof content === "string" && content.trim() !== "") report = content;
      }
      if (ev.type === "turn.error") {
        const message = (ev.payload as { message?: unknown }).message;
        if (typeof message === "string") error = message;
      }
    }
    return {
      id: child.id,
      title: child.title,
      subRole: child.sub_role ?? null,
      status: child.status,
      createdAt: child.created_at,
      updatedAt: child.updated_at,
      todosDone,
      todosTotal,
      inputTokens: usage.i,
      outputTokens: usage.o,
      report,
      error,
    };
  });
}

export function setSessionStatus(db: SqliteDatabase, id: string, status: SessionStatus): void {
  db.prepare(
    "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, new Date().toISOString(), id);
}

/**
 * Delete a session and every dependent row in ONE transaction (round-30,
 * owner request). session_events / usage_events / approvals carry no FK
 * constraints (schema v1), so each is deleted explicitly; file_snapshots has
 * ON DELETE CASCADE but is also deleted explicitly so the statement order is
 * deterministic and the whole operation is atomic either way.
 */
export function deleteSession(db: SqliteDatabase, id: string): void {
  const run = db.transaction((sid: string) => {
    db.prepare("DELETE FROM session_events WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM usage_events WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM approvals WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
  });
  run(id);
}

/** ROUND-33 (owner: "the user will be given the ability to edit the names of
 * the sessions"). Returns the updated session, or undefined when the id is
 * unknown. An empty/whitespace title stores null (back to "Untitled"). */
export function updateSessionTitle(db: SqliteDatabase, id: string, title: string): Session | undefined {
  const existing = getSession(db, id);
  if (existing === undefined) return undefined;
  const trimmed = title.trim();
  db.prepare(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
  ).run(trimmed === "" ? null : trimmed, new Date().toISOString(), id);
  return getSession(db, id);
}

export function touchSession(db: SqliteDatabase, id: string): void {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

/** Allocates the next seq and inserts atomically; callers never compute seq themselves. */
export function appendSessionEvent(db: SqliteDatabase, sessionId: string, input: AppendEventInput): SessionEvent {
  const ts = new Date().toISOString();
  const payload = { ...input.payload, agentId: input.agentId ?? null, ts };
  const append = db.transaction((sid: string, evt: AppendEventInput, stamp: string, body: string): number => {
    const { next } = db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM session_events WHERE session_id = ?")
      .get(sid) as { next: number };
    db.prepare(
      "INSERT INTO session_events (session_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
    ).run(sid, next, evt.type, body, stamp);
    return next;
  });
  const seq = append(sessionId, input, ts, JSON.stringify(payload));
  return { seq, type: input.type, agentId: input.agentId ?? null, payload, ts };
}

export function listSessionEvents(db: SqliteDatabase, sessionId: string): SessionEvent[] {
  const rows = db
    .prepare("SELECT seq, type, payload, ts FROM session_events WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as EventRow[];
  return rows.map(toEvent);
}

export function lastSessionSeq(db: SqliteDatabase, sessionId: string): number {
  const { last } = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM session_events WHERE session_id = ?")
    .get(sessionId) as { last: number };
  return last;
}

/** One billing line per completed model call; costUsd is 0 until estimation lands. */
export function recordUsage(db: SqliteDatabase, usage: UsageRecord): void {
  db.prepare(
    `INSERT INTO usage_events
      (agent_id, session_id, provider, model, input_tokens, output_tokens, cost_usd, ts)
     VALUES (@agentId, @sessionId, @provider, @model, @inputTokens, @outputTokens, @costUsd, @ts)`,
  ).run(usage);
}
