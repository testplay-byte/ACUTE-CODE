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
}

export interface SessionInput {
  agentId: string;
  mode: RunMode;
  projectId?: string | null;
  title?: string | null;
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
  };
  db.prepare(
    `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at)
     VALUES (@id, @projectId, @agentId, @mode, @status, @title, @createdAt, @updatedAt)`,
  ).run(session);
  return session;
}

export function getSession(db: SqliteDatabase, id: string): Session | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row === undefined ? undefined : toSession(row);
}

/** Newest-first (API.md §5.2) with the matching total for pagination. */
export function listSessions(
  db: SqliteDatabase,
  options: { limit: number; offset: number },
): { sessions: Session[]; total: number } {
  const rows = db
    .prepare(
      "SELECT * FROM sessions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(options.limit, options.offset) as SessionRow[];
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM sessions").get() as { total: number };
  return { sessions: rows.map(toSession), total };
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
