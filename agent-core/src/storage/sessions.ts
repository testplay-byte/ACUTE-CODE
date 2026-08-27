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

/**
 * ROUND-38/41/42 (owner: "by default if I create a new chat session and send
 * in my very first message, it should be given a name based on what was
 * happening in it"). Called after a turn completes. If the session still
 * carries a DEFAULT title AND has at least one user message, rename it to a
 * SHORT, readable title derived from the FIRST user message (stripped of
 * markdown, first sentence, max 60 chars on a word boundary, ellipsis if
 * truncated, capitalized). No-op once the user has manually renamed or the
 * first auto-title has landed. Sub-agent children keep their task-derived
 * titles.
 *
 * ROUND-42 FIX (owner: "it was still not renamed like it should be"): the
 * sidebar's + button creates sessions titled `New chat · <ProjectName>` — the
 * R41 check only matched `null` or the bare project name, so those sessions
 * were NEVER auto-renamed. Both seed formats are now recognized as defaults.
 *
 * The project name is read via a direct SQL lookup (not getProject) to keep
 * sessions.ts free of a projects.ts import edge.
 */
export function maybeAutoTitleSession(db: SqliteDatabase, sessionId: string): void {
  const session = getSession(db, sessionId);
  if (session === undefined) return;
  if (session.parentSessionId !== null) return; // sub-agent child
  let defaultTitle: string | null = null;
  if (session.projectId !== null) {
    const row = db
      .prepare("SELECT name FROM projects WHERE id = ?")
      .get(session.projectId) as { name?: string } | undefined;
    defaultTitle = row?.name ?? null;
  }
  // Default titles: null (AgentChatPanel's auto-create path seeds the project
  // name below), the bare project name, or the sidebar's `New chat · <name>`.
  const isDefault =
    session.title === null ||
    session.title === defaultTitle ||
    (defaultTitle !== null && session.title === `New chat · ${defaultTitle}`);
  if (!isDefault) return;
  const events = listSessionEvents(db, sessionId);
  const firstUser = events.find((e) => e.type === "message.user");
  if (firstUser === undefined) return;
  const content = (firstUser.payload as { content?: unknown } | null)?.content;
  if (typeof content !== "string") return;
  const title = deriveSessionTitle(content);
  if (title === "") return;
  updateSessionTitle(db, sessionId, title);
}

/**
 * ROUND-41: derive a short, human-readable session title from the first
 * user message. Steps:
 *  1. Strip fenced code blocks (```...```) — the user pasted code, not prose.
 *  2. Strip inline code + leading markdown symbols (#, -, *, >, list markers).
 *  3. Collapse whitespace.
 *  4. Take the first sentence (up to . ! ? or newline) OR 60 chars,
 *     whichever is shorter.
 *  5. If the original was longer, truncate at the last word boundary ≤ 60
 *     chars and append "…".
 *  6. Capitalize the first letter.
 * Returns "" for messages that produce no usable prose (e.g. pure code).
 */
function deriveSessionTitle(raw: string): string {
  const noFences = raw.replace(/```[\s\S]*?```/g, " ");
  const stripped = noFences
    .replace(/`[^`]*`/g, " ")
    .replace(/^[\s>#*-]+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === "") return "";
  const firstSentenceMatch = stripped.match(/^([^.!?\n]{1,60})/);
  let snippet = firstSentenceMatch ? firstSentenceMatch[1].trim() : "";
  if (snippet === "") return "";
  const MAX = 60;
  if (stripped.length > snippet.length) {
    if (snippet.length > MAX) {
      const cut = snippet.slice(0, MAX);
      const lastSpace = cut.lastIndexOf(" ");
      snippet = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
    }
    snippet = `${snippet}…`;
  }
  return snippet.charAt(0).toUpperCase() + snippet.slice(1);
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

// ── ROUND-44 (R44-c, owner directive: "complete the whole agentic coding
//    environment") — session SEARCH / FORK / REVERT. Audited as missing in the
//    R43 round report; these three operations close the gap. ─────────────────

/**
 * ROUND-44 (R44-c): case-insensitive substring search across sessions — the
 * session TITLE plus the VISIBLE TEXT of the event log.
 *
 * Payload-column decision: `session_events.payload` is a TEXT column holding
 * the event payload as a JSON-encoded STRING (schema 0001; toEvent() parses
 * it). Every text-bearing event embeds its user-visible text as a JSON string
 * VALUE inside that blob — message.user/message.assistant carry `content`,
 * tool.use carries `argsSummary`/`outputSummary`, turn.error carries
 * `message`. A LIKE over the raw payload column therefore matches exactly the
 * text the user saw in the chat, without a JSON-extraction pass per row (and
 * without maintaining a parallel search index). Trade-offs, accepted + noted:
 *  - JSON-escaped text: a query containing a quote/newline will not match its
 *    escaped form (queries are typed in a one-line search box — acceptable).
 *  - LIKE is case-insensitive for ASCII only (SQLite default) — matches the
 *    title column's behavior; fine for a desktop search box.
 *  - Key names are part of the blob, so a query like "content" matches any
 *    session with a chat event — harmless for a >=1-char search box.
 *
 * Sub-agent children (ADR-0022) are excluded — parity with listSessions's
 * default (the sidebar/search surface stays top-level sessions only). Rows
 * come back in the same shape as listSessions, newest-updated first, deduped
 * (a session with N matching events still appears once).
 */
export function searchSessions(db: SqliteDatabase, q: string, limit = 50): Session[] {
  const needle = q.trim();
  if (needle === "") return [];
  // Escape LIKE wildcards so a literal "%"/"_" in the query means itself.
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT DISTINCT s.*
         FROM sessions s
         LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.parent_session_id IS NULL
          AND (s.title LIKE ? ESCAPE '\\' OR e.payload LIKE ? ESCAPE '\\')
        ORDER BY s.updated_at DESC, s.id DESC
        LIMIT ?`,
    )
    .all(pattern, pattern, limit) as SessionRow[];
  return rows.map(toSession);
}

/**
 * ROUND-44 (R44-c): fork a session — a NEW top-level session carrying a full
 * copy of the original's event log. The fork is an ordinary session (no
 * parent-session linkage, per the R44-c contract — a fork is not a sub-agent
 * child): new `sess_…` id, title `Fork · {original title}`, same agent +
 * project binding, fresh `queued` status, created_at/updated_at = now.
 *
 * Events are copied with PRESERVED seq / type / payload / ts (turn structure
 * + original timestamps survive verbatim); only the AUTOINCREMENT row `id`
 * and the owning `session_id` are new. usage_events are deliberately NOT
 * copied — the fork's token counters start at zero (usage is a separate
 * per-session ledger, so leaving it behind is exactly "zeroed").
 *
 * Returns the new session row, or undefined when the source id is unknown.
 */
export function forkSession(db: SqliteDatabase, sessionId: string): Session | undefined {
  const original = getSession(db, sessionId);
  if (original === undefined) return undefined;
  const now = new Date().toISOString();
  const fork: Session = {
    id: `sess_${randomUUID()}`,
    projectId: original.projectId,
    agentId: original.agentId,
    mode: original.mode,
    status: "queued",
    title: `Fork · ${original.title ?? "Untitled session"}`,
    createdAt: now,
    updatedAt: now,
    // Top-level by design — even when forking a sub-agent child, the fork
    // escapes the parent linkage (it is a user-owned copy, not a delegation).
    parentSessionId: null,
    subRole: null,
  };
  const copy = db.transaction((srcId: string) => {
    db.prepare(
      `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at, parent_session_id, sub_role)
       VALUES (@id, @projectId, @agentId, @mode, @status, @title, @createdAt, @updatedAt, @parentSessionId, @subRole)`,
    ).run(fork);
    // INSERT…SELECT keeps seq/type/payload/ts byte-identical; the autoincrement
    // `id` column is omitted so every copied row gets a fresh row id.
    db.prepare(
      `INSERT INTO session_events (session_id, seq, type, payload, ts)
       SELECT ?, seq, type, payload, ts FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
    ).run(fork.id, srcId);
  });
  copy(sessionId);
  return fork;
}

/** ROUND-44 (R44-c): revertSession outcome — success carries the number of
 * removed events; failure carries an HTTP-mappable code (404 / 409). */
export type RevertSessionResult =
  | { ok: true; removedCount: number }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "VALIDATION"; message: string };

/**
 * ROUND-44 (R44-c): rewind a session to an earlier message. Events with
 * seq > keepThroughSeq are deleted (everything up to AND INCLUDING
 * keepThroughSeq survives — the UI passes the USER message's seq, so the user
 * message stays while the assistant reply + later turns are removed), then ONE
 * `session.reverted` marker event is appended with the next seq. Event types
 * are not validated anywhere (appendSessionEvent accepts any string; readers
 * tolerate unknown types — see toProjectChatItems), so no type registration
 * is needed; the marker's payload is
 * { throughSeq, at, revertedEventCount, agentId: null, ts } (appendSessionEvent
 * mirrors agentId + ts into the payload like every other event).
 *
 * The append-only contract (ADR-0010) governs in-flight operation; an
 * owner-driven rewind is the documented exception (same standing as
 * deleteSession, round-30) and runs as ONE transaction.
 *
 * Edge cases:
 *  - unknown session id → { ok: false, code: "NOT_FOUND" }
 *  - session status "running" (a live turn is streaming) → CONFLICT
 *    "cannot revert a running session" — the deletion would race the turn.
 *  - keepThroughSeq >= max seq → nothing is removed but the marker is STILL
 *    appended (an explicit, auditable no-op rewind).
 */
export function revertSession(
  db: SqliteDatabase,
  sessionId: string,
  keepThroughSeq: number,
): RevertSessionResult {
  const session = getSession(db, sessionId);
  if (session === undefined) {
    return { ok: false, code: "NOT_FOUND", message: `no session with id ${sessionId}` };
  }
  if (session.status === "running") {
    return { ok: false, code: "CONFLICT", message: "cannot revert a running session" };
  }
  if (!Number.isInteger(keepThroughSeq) || keepThroughSeq < 0) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "keepThroughSeq must be an integer >= 0",
    };
  }
  const rewind = db.transaction((): number => {
    const removed = db
      .prepare("DELETE FROM session_events WHERE session_id = ? AND seq > ?")
      .run(sessionId, keepThroughSeq);
    appendSessionEvent(db, sessionId, {
      type: "session.reverted",
      payload: {
        throughSeq: keepThroughSeq,
        at: new Date().toISOString(),
        revertedEventCount: removed.changes,
      },
    });
    // Fresh/idle status — the conversation is rewound and ready for a new turn.
    setSessionStatus(db, sessionId, "queued");
    return removed.changes;
  });
  const removedCount = rewind();
  return { ok: true, removedCount };
}
