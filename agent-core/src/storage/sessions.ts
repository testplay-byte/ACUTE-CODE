/**
 * Session, session-event, and usage repositories (API.md §5, §9). The event log
 * is append-only (ADR-0010): no exported function updates or deletes a
 * session_events row, and each seq is minted inside the same transaction as the
 * insert so per-session seq is strictly monotonic.
 *
 * ROUND-113 (R113-a): the THREE session mutation choke points below —
 * createSession, setSessionStatus, appendSessionEvent — double as the
 * events-bus publish points (lib/events-bus.ts). One hook each beats
 * sprinkling publishes at the ~40 call sites: EVERY writer (the runtime's
 * message/tool/meta events, the orchestrator's children, the queue's
 * type flips, approvals, todo tool, compaction, forks, reverts) already
 * funnels through these functions, so a watcher subscribed to
 * GET /events/stream learns about every session change exactly once, at
 * the moment the durable row lands. The publishes are fire-and-forget
 * (the bus never throws into a caller) and need NO extra state: the row
 * being written IS the news.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MessageAttachment, PermissionMode, RunMode, SessionStatus, UsageRecord } from "shared";
import { getEventsBus } from "../lib/events-bus.js";

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
  /** ROUND-81 (the unified mode picker): the session's OPERATING MODE
   * (full = Full Access / ask = Ask / plan = Plan). Enforced at turn time
   * (runtime.ts prepareTurn + approvals.ts); children copy their parent's
   * mode at delegation. The old "editor" value reads as "ask"
   * (migration 0029 makes it durable). */
  permissionMode: PermissionMode;
  /** ROUND-73 (R73-b): the session's ACTIVE TASK MODE id (the posture tier —
   * plan/debug/build/review/explore/refactor builtin, or a custom
   * .acute/agents/*.md id), or null when the session runs in the default
   * posture. Set/cleared via PATCH /sessions/:id { activeMode } and the
   * switch_mode tool; resolved against resolveEffectiveModes(session's
   * project root) at turn time so a VANISHED custom mode is cleared honestly
   * (runtime.ts prepareTurn threads the note). While set, the mode's deep
   * body rides the system prompt's ACTIVE TASK MODE section. NULL = the
   * column default; pre-0027 databases read as null (fail-open to the
   * default posture — exactly the pre-R73 behavior). */
  activeMode: string | null;
  /** ROUND-79 (R79-a, the orchestrator round): the PARENT's own address for
   * this session when it was created as an ADDRESSABLE delegation (the
   * task_id the parent model picked for delegate_task with task_id set, or
   * a background delegation). NULL = an ordinary unaddressed child (every
   * pre-R79 child and every task_id-less delegation — exactly the pre-R79
   * behavior). Immutable for the child's lifetime: resume resolves by it,
   * the per-turn BACKGROUND TASKS reminder lists by it, and the
   * duplicate/cap gates refuse against it. Written ONCE through
   * createSession's SessionInput.taskId (migration 0028). */
  taskId: string | null;
}

export interface SessionInput {
  agentId: string;
  mode: RunMode;
  projectId?: string | null;
  title?: string | null;
  /** ROUND-36: creates a CHILD session when set. */
  parentSessionId?: string | null;
  subRole?: string | null;
  /** ROUND-50 (R50-c1): the session's permission mode (default "ask" —
   * exactly the pre-R50 behavior). */
  permissionMode?: PermissionMode;
  /** ROUND-75 (R75): the session's ACTIVE TASK MODE at creation — used ONLY
   * by the orchestrator's delegation path so a child COPIES its parent's
   * posture (the R50-c1 rule, one tier down: delegated work can never
   * outrun the mode the owner picked; a plan-mode parent spawns read-only
   * children). Default null (modeless — the pre-R75 creation behavior). */
  activeMode?: string | null;
  /** ROUND-79 (R79-a): the parent model's own address for this delegation
   * (delegate_task {task, task_id}) — persisted as sessions.delegate_task_id
   * (migration 0028). The ORCHESTRATOR validates it
   * (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, duplicate among the parent's
   * children, the ≥10 outstanding cap) BEFORE calling createSession, so
   * this function trusts its argument (same contract as every other
   * SessionInput field). Default null = unaddressed (pre-R79 behavior). */
  taskId?: string | null;
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
  /** ROUND-50 (R50-c1): NOT NULL DEFAULT 'ask' since migration 0020; the
   * fallback keeps hand-opened pre-0020 databases readable. */
  permission_mode?: string | null;
  /** ROUND-73 (R73-b): nullable since migration 0027; the fallback keeps
   * hand-opened pre-0027 databases readable (null = default posture). */
  active_mode?: string | null;
  /** ROUND-79 (R79-a): nullable since migration 0028; the fallback keeps
   * hand-opened pre-0028 databases readable (null = unaddressed child). */
  delegate_task_id?: string | null;
}

interface EventRow {
  seq: number;
  type: string;
  payload: string | null;
  ts: string;
}

const PERMISSION_MODE_VALUES: readonly string[] = ["full", "ask", "plan"];

/** ROUND-81: legacy rows (pre-0029 databases, or rows written by an older
 * build) may still carry "editor". It maps to "ask" — fail-closed: editor
 * had no terminal at all, and ask is the only operating mode that still
 * gates commands, so nothing the owner had is silently widened. */
const LEGACY_PERMISSION_MODE_REMAP: Readonly<Record<string, PermissionMode>> = {
  editor: "ask",
};

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
    // ROUND-50 (R50-c1): unknown/null values (corrupted rows, pre-0020
    // databases opened without the migration) read as "ask" — the
    // fail-closed default that equals the pre-R50 behavior.
    // ROUND-81: "editor" (retired by the unified picker) remaps to "ask"
    // on read so an un-migrated database stays fail-closed; migration
    // 0029 rewrites the rows durably.
    permissionMode:
      typeof row.permission_mode === "string" && PERMISSION_MODE_VALUES.includes(row.permission_mode)
        ? (row.permission_mode as PermissionMode)
        : typeof row.permission_mode === "string" && row.permission_mode in LEGACY_PERMISSION_MODE_REMAP
          ? LEGACY_PERMISSION_MODE_REMAP[row.permission_mode]
          : "ask",
    // ROUND-73 (R73-b): a non-string/corrupted value reads as null — the
    // default posture (fail-open; a garbage active_mode must never break a
    // turn, prepareTurn simply resolves nothing and stays modeless).
    activeMode: typeof row.active_mode === "string" && row.active_mode !== "" ? row.active_mode : null,
    // ROUND-79 (R79-a): same fail-open read for the delegation address — a
    // garbage/empty delegate_task_id reads as null (an unaddressed child;
    // resume then falls back to session-id/code resolution honestly).
    taskId: typeof row.delegate_task_id === "string" && row.delegate_task_id !== "" ? row.delegate_task_id : null,
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
    permissionMode: input.permissionMode ?? "ask",
    // ROUND-73 (R73-b): sessions START modeless (the column's NULL default);
    // activation happens through PATCH /sessions/:id or switch_mode.
    // ROUND-75 (R75): EXCEPT delegation children, which copy the parent's
    // posture (input.activeMode — the R50-c1 inheritance, one tier down).
    activeMode: input.activeMode ?? null,
    // ROUND-79 (R79-a): the delegation address (migration 0028's
    // delegate_task_id) — set ONLY by the orchestrator's delegation path
    // after its own validation (charset/duplicate/cap); null = unaddressed.
    taskId: input.taskId ?? null,
  };
  // ROUND-75 (R75) + ROUND-79 (R79-a): active_mode and delegate_task_id join
  // the INSERT ONLY when the caller set them (delegation children copying
  // their parent's posture / carrying the parent's task address). The R73
  // rule still holds for every other creation: the columns stay OUT of the
  // statement so a pre-0027/pre-0028 database (migration-test schemas
  // recreate old layouts verbatim) never sees the unknown column — the NULL
  // default applies exactly as before. The column tail order is fixed
  // (…, permission_mode, active_mode, delegate_task_id): every legacy
  // combination binds exactly the columns + values its pre-R79 branch did.
  const hasActiveMode = typeof input.activeMode === "string" && input.activeMode !== "";
  const hasTaskId = typeof input.taskId === "string" && input.taskId !== "";
  // column → named-binding key (the bound object's keys are camelCase —
  // the exact pairs the pre-R79 statements spelled out inline).
  const pairs: Array<[column: string, param: string]> = [
    ["id", "id"],
    ["project_id", "projectId"],
    ["agent_id", "agentId"],
    ["mode", "mode"],
    ["status", "status"],
    ["title", "title"],
    ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
    ["parent_session_id", "parentSessionId"],
    ["sub_role", "subRole"],
    ["permission_mode", "permissionMode"],
  ];
  if (hasActiveMode) pairs.push(["active_mode", "activeMode"]);
  if (hasTaskId) pairs.push(["delegate_task_id", "taskId"]);
  db.prepare(
    `INSERT INTO sessions (${pairs.map(([c]) => c).join(", ")})
     VALUES (${pairs.map(([, p]) => `@${p}`).join(", ")})`,
  ).run({
    ...session,
    parentSessionId: input.parentSessionId ?? null,
    subRole: input.subRole ?? null,
    permissionMode: input.permissionMode ?? "ask",
    // The spread carries activeMode/taskId even when the columns are absent
    // — unbound extra keys are ignored by better-sqlite3's named binding
    // (the documented pre-0027 pattern; the NULL default applies).
    ...(hasActiveMode ? { activeMode: input.activeMode } : {}),
    ...(hasTaskId ? { taskId: input.taskId } : {}),
  });
  // R113-a: announce the new session on the events bus — watchers
  // (desktop sidebar / phone session list) refresh. Covers POST /sessions,
  // delegation children, and every other creator through the one choke
  // point. The row is already durable at this line (the INSERT ran above).
  getEventsBus().publishSessionFrame(session.id, session.projectId, "created", {
    status: session.status,
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
 * ledger, report from the last non-empty assistant message.
 * ROUND-48 (R48-e1): `code` — a deterministic 4-char [A-Z0-9] short code
 * (see subAgentCode) so the owner can identify WHICH sub-agent is asking/
 * working without reading a sess_<uuid>. */
export interface SubAgentStatus {
  id: string;
  /** ROUND-48 (R48-e1): deterministic 4-char [A-Z0-9] identifier of the child
   * (same value on every read + on every subagent-status SSE envelope). */
  code: string;
  /** ROUND-79 (R79-a): the parent's own address for this child
   * (sessions.delegate_task_id, migration 0028) — the task_id the parent
   * model picked at delegation; null = an unaddressed child (pre-R79
   * behavior). The Sub-agents panel rows and the delegate_task resume
   * resolution both use it, so the wire + the tool agree on one address. */
  taskId: string | null;
  title: string | null;
  subRole: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  todosDone: number;
  todosTotal: number;
  inputTokens: number;
  outputTokens: number;
  /** ROUND-50 (R50-b, owner: the sub-agent stats footer must show "the model
   * which was being used"): the model of the child's LATEST usage_events row
   * (the model its last completed provider call actually ran on — it follows
   * the orchestration.subagentModel override), null before the first usage
   * row lands. */
  model: string | null;
  report: string | null;
  error: string | null;
}

/** ROUND-48 (R48-e1, owner directive: sub-agents should be identifiable at a
 * glance): deterministic short code for a session id — FNV-1a 32-bit hash of
 * the id, base36-encoded, last 4 characters uppercased (left-padded with
 * "X" in the astronomically unlikely case the hash encodes shorter than 4
 * chars, i.e. hash < 36^3). Pure: the same id always maps to the same code,
 * so the SSE `subagent-status` envelope, the GET /sessions/:id/subagents
 * rows, approval attribution, and the picker all agree without any stored
 * state. 4 base36 chars = 1.68M codes — collisions across a realistic
 * handful of concurrent children are negligible, and the raw id always
 * travels alongside for exact matching. */
export function subAgentCode(sessionId: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  const base36 = (hash >>> 0).toString(36).toUpperCase();
  const tail = base36.slice(-4);
  return tail.length >= 4 ? tail : tail.padStart(4, "X");
}

/** ROUND-79 (R79-a): a child's todo progress from its latest todo.update
 * event (the exact loop listSubAgents always ran — extracted so the
 * background-task reminder + resume share ONE extraction, never drifting). */
export function childTodoProgress(
  db: SqliteDatabase,
  childId: string,
): { todosDone: number; todosTotal: number } {
  let todosDone = 0;
  let todosTotal = 0;
  for (const ev of listSessionEvents(db, childId)) {
    if (ev.type !== "todo.update") continue;
    const todos = (ev.payload as { todos?: Array<{ status?: string }> }).todos;
    if (Array.isArray(todos) && todos.length > 0) {
      todosTotal = todos.length;
      todosDone = todos.filter((t) => t.status === "completed").length;
    }
  }
  return { todosDone, todosTotal };
}

/**
 * ROUND-88 (R88, owner: the floating to-do widget + manual edits): the
 * session's LATEST todo snapshot, walking the event log backwards (the same
 * direction latestTodosAllDone walks, but returning the payload instead of a
 * verdict). `source` rides along when the write marked it — "user" means the
 * OWNER edited the list through the widget's route (prepareTurn's prompt
 * section emphasizes those), "agent" (or absent — every pre-R88 event) is the
 * todo_write tool's own snapshot.
 */
export function latestTodoSnapshot(
  db: SqliteDatabase,
  sessionId: string,
): { todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; source: "agent" | "user" } | undefined {
  const events = listSessionEvents(db, sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "todo.update") continue;
    const payload = ev.payload as { todos?: unknown; source?: unknown };
    if (!Array.isArray(payload.todos)) continue;
    // An EMPTY array is the R88 "cleared" state (the widget's clear writes
    // an empty snapshot) — it IS the latest snapshot, not a malformed one to
    // skip past. Callers treat length 0 as "no list".
    return {
      todos: payload.todos as Array<{ content: string; status: "pending" | "in_progress" | "completed" }>,
      source: payload.source === "user" ? "user" : "agent",
    };
  }
  return undefined;
}

/** ROUND-79 (R79-a): a child's terminal texts — the FINAL REPORT (the last
 * non-empty message.assistant, the exact extraction listSubAgents always
 * ran) + the ERROR (the last turn.error message). resumeTask returns the
 * report from HERE, so the tool result and the Sub-agents panel can never
 * disagree about what a completed child's final report is. */
export function childTerminalText(
  db: SqliteDatabase,
  childId: string,
): { report: string | null; error: string | null } {
  let report: string | null = null;
  let error: string | null = null;
  for (const ev of listSessionEvents(db, childId)) {
    if (ev.type === "message.assistant") {
      const content = (ev.payload as { content?: unknown }).content;
      if (typeof content === "string" && content.trim() !== "") report = content;
    }
    if (ev.type === "turn.error") {
      const message = (ev.payload as { message?: unknown }).message;
      if (typeof message === "string") error = message;
    }
  }
  return { report, error };
}

export function listSubAgents(db: SqliteDatabase, parentSessionId: string): SubAgentStatus[] {
  const children = db
    .prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(parentSessionId) as SessionRow[];
  return children.map((child) => {
    // Latest todo.update → progress (ROUND-79: the shared extraction).
    const { todosDone, todosTotal } = childTodoProgress(db, child.id);
    const usage = db
      .prepare(
        "SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM usage_events WHERE session_id = ?",
      )
      .get(child.id) as { i: number; o: number };
    // ROUND-50 (R50-b): the model of the LATEST usage row — the stats
    // footer's authoritative "model which was being used" once the child
    // has made at least one provider call (null until then; the SSE
    // subagent-status frames carry the resolved model from the start).
    const modelRow = db
      .prepare("SELECT model FROM usage_events WHERE session_id = ? ORDER BY ts DESC LIMIT 1")
      .get(child.id) as { model?: string } | undefined;
    // ROUND-79 (R79-a): the shared report/error extraction (identical loop).
    const { report, error } = childTerminalText(db, child.id);
    return {
      id: child.id,
      code: subAgentCode(child.id),
      // ROUND-79 (R79-a): the delegation address rides the row (null for
      // unaddressed children — the additive wire shape; old consumers of
      // the other fields keep working untouched).
      taskId: child.delegate_task_id ?? null,
      title: child.title,
      subRole: child.sub_role ?? null,
      status: child.status,
      createdAt: child.created_at,
      updatedAt: child.updated_at,
      todosDone,
      todosTotal,
      inputTokens: usage.i,
      outputTokens: usage.o,
      model: modelRow?.model ?? null,
      report,
      error,
    };
  });
}

export function setSessionStatus(db: SqliteDatabase, id: string, status: SessionStatus): void {
  // R113-a: read the row FIRST so the publish can carry the project scope
  // AND be a real FLIP (a no-op write — same status, e.g. an end-of-turn
  // reset on an already-queued session — is not news; watchers would
  // refetch for nothing). One PK-indexed SELECT per status write.
  const existing = db
    .prepare("SELECT project_id, status FROM sessions WHERE id = ?")
    .get(id) as { project_id: string | null; status: string } | undefined;
  db.prepare(
    "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, new Date().toISOString(), id);
  if (existing !== undefined && existing.status !== status) {
    // The status-flip frame (queued→running at turn start, running→queued
    // at turn end, →failed/completed on terminal outcomes). The UPDATE has
    // already run on the same synchronous connection, so a watcher's
    // refetch (a later HTTP request on this same thread) always sees the
    // committed value.
    getEventsBus().publishSessionFrame(id, existing.project_id, "status", { status });
  }
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

/**
 * ROUND-50 (R50-c1): set the session's permission mode (the composer's
 * Full Access / Ask / Plan / Editor switcher). Callers (the PATCH
 * /sessions/:id/permissions route) validate the value against the 4 known
 * modes BEFORE calling — this function trusts its argument and only handles
 * the unknown-id case (undefined). Returns the updated session row.
 */
export function updateSessionPermissionMode(
  db: SqliteDatabase,
  id: string,
  mode: PermissionMode,
): Session | undefined {
  const existing = getSession(db, id);
  if (existing === undefined) return undefined;
  db.prepare(
    "UPDATE sessions SET permission_mode = ?, updated_at = ? WHERE id = ?",
  ).run(mode, new Date().toISOString(), id);
  return getSession(db, id);
}

/**
 * ROUND-73 (R73-b): set or clear the session's ACTIVE TASK MODE (the posture
 * tier; column active_mode, migration 0027). Callers (the PATCH
 * /sessions/:id route, the switch_mode tool, and prepareTurn's stale-mode
 * sweep) validate the id against resolveEffectiveModes BEFORE calling —
 * this function trusts its argument and only handles the unknown-id case
 * (undefined). A null argument CLEARS the mode (back to the default
 * posture; idempotent — clearing a modeless session is a no-op write).
 * Returns the updated session row. The updated_at bump mirrors the
 * permission-mode setter: a posture change is a session-level event.
 */
export function updateSessionActiveMode(
  db: SqliteDatabase,
  id: string,
  activeMode: string | null,
): Session | undefined {
  const existing = getSession(db, id);
  if (existing === undefined) return undefined;
  db.prepare("UPDATE sessions SET active_mode = ?, updated_at = ? WHERE id = ?").run(
    activeMode,
    new Date().toISOString(),
    id,
  );
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

/** Allocates the next seq and inserts atomically; callers never compute seq themselves.
 * R113-a: also the events-bus publish point for EVERY log append — one
 * {type:"session", kind:"event"} frame per row, carrying the fresh seq so
 * remote watchers know exactly how far the log grew (refetch + fold). */
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
  // R113-a: the announce. The transaction above already committed (same
  // synchronous thread), and projectId/status ride the frame when the
  // session row is cheaply resolvable — a missing row (a foreign/corrupt
  // id) publishes with null scope rather than throwing: the append itself
  // succeeded, and a watcher refetching an unknown id gets an honest 404.
  const session = db
    .prepare("SELECT project_id, status FROM sessions WHERE id = ?")
    .get(sessionId) as { project_id: string | null; status: string } | undefined;
  getEventsBus().publishSessionFrame(
    sessionId,
    session?.project_id ?? null,
    "event",
    { seq, ...(session !== undefined ? { status: session.status } : {}) },
  );
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

// ── ROUND-78 (R78, owner: "工作中发送消息（排队）" — while the agent is
//    responding/running tools the user can still send; the message QUEUES
//    and is auto-delivered right after the current tool call completes)
//    — the message.queued event + its storage lifecycle. ────────────────────
//
// A queued message is a session_events ROW of type `message.queued` with the
// EXACT payload shape of a message.user event ({role:"user", content,
// attachments?} + appendSessionEvent's agentId/ts mirroring). NOTHING
// existing reads the type: assembleHistory's fold only matches
// message.user/message.assistant/tool.use, and toProjectChatItems folds it
// as a queued chip — so a queued event is invisible to the model by
// construction. DELIVERY is a type FLIP (message.queued → message.user) on
// the SAME row: seq, ts, agentId, and payload are untouched, so the message
// lands in the transcript exactly where it was queued (ordering preserved
// by construction). This is the one deliberate UPDATE to session_events
// since ADR-0010 made the log append-only — the flip writes NO new data
// (the row is the message), it only promotes its visibility, and the
// queue's own lifecycle (append → deliver/delete) is owner-visible state,
// not history rewriting (the same standing as revertSession's documented
// exception).

/**
 * ROUND-78 (R78): append a queued user message. Mirrors the message.user
 * append exactly (same payload shape, same agentId mirroring — the event
 * carries the SESSION's agent so the fold and any reader resolve the author
 * the same way a delivered row does). Returns the appended event (seq is
 * the queue identity the wire contract uses).
 * ROUND-82 (R82): the queue entry may carry its OWN per-send override
 * (`model` + `providerId` — the picker state at queue time). The fields
 * live in the payload (invisible to the model: the history fold reads
 * role/content/attachments only) and survive the delivery type-flip
 * harmlessly; the queue-continuation loop reads them when the entry is
 * consumed so the follow-up turn routes to the provider the user picked
 * when queueing — historically a queued follow-up fell back to the agent
 * default, dropping the override entirely.
 */
export function appendQueuedMessage(
  db: SqliteDatabase,
  sessionId: string,
  input: {
    content: string;
    attachments?: MessageAttachment[];
    model?: string;
    providerId?: string;
  },
): SessionEvent {
  const session = getSession(db, sessionId);
  return appendSessionEvent(db, sessionId, {
    type: "message.queued",
    // The session's agent (null on agentless rows — same mirroring the
    // message.user appends use through prepareTurn's agent).
    agentId: session?.agentId ?? null,
    payload: {
      role: "user",
      content: input.content,
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.model !== undefined && input.model.trim() !== "" ? { model: input.model } : {}),
      ...(input.providerId !== undefined && input.providerId.trim() !== ""
        ? { providerId: input.providerId }
        : {}),
    },
  });
}

/**
 * ROUND-78 (R78): every not-yet-delivered queued message for a session, in
 * seq order (the delivery order). Type-filtered — a flipped row is an
 * ordinary message.user and disappears from this list.
 */
export function listUndeliveredQueuedMessages(db: SqliteDatabase, sessionId: string): SessionEvent[] {
  const rows = db
    .prepare(
      "SELECT seq, type, payload, ts FROM session_events WHERE session_id = ? AND type = 'message.queued' ORDER BY seq ASC",
    )
    .all(sessionId) as EventRow[];
  return rows.map(toEvent);
}

/**
 * ROUND-78 (R78): deliver ONE queued message — flip the row's type to
 * `message.user` (seq / ts / agentId / payload untouched, so the message
 * lands in the transcript exactly where it was queued). Returns false when
 * the seq is unknown for the session or its event is not a queued one
 * (already delivered, a user message, any other type) — the flip is
 * strictly queued → user, never the reverse.
 */
export function deliverQueuedMessage(db: SqliteDatabase, sessionId: string, seq: number): boolean {
  if (!Number.isInteger(seq) || seq <= 0) return false;
  const result = db
    .prepare(
      "UPDATE session_events SET type = 'message.user' WHERE session_id = ? AND seq = ? AND type = 'message.queued'",
    )
    .run(sessionId, seq);
  return result.changes > 0;
}

/**
 * ROUND-78 (R78): remove a not-yet-delivered queued message (the queue
 * chip's remove / send-now path — send-now reads the payload first, then
 * deletes, then the caller re-sends it as a fresh turn). Delivered rows are
 * ordinary transcript history: the guard refuses to touch them.
 */
export function deleteQueuedMessage(db: SqliteDatabase, sessionId: string, seq: number): boolean {
  if (!Number.isInteger(seq) || seq <= 0) return false;
  const result = db
    .prepare("DELETE FROM session_events WHERE session_id = ? AND seq = ? AND type = 'message.queued'")
    .run(sessionId, seq);
  return result.changes > 0;
}

/**
 * ROUND-78 (R78): pre-flip — deliver EVERY undelivered queued message for a
 * session (in seq order) and return how many flipped. The runtime calls
 * this at the start of a NEW turn (before the turn's own message.user
 * append): the crash/stop recovery contract — a queue left behind by an
 * aborted stream or a sidecar kill always eventually delivers, in order,
 * BEFORE the new message, and the event log owns the render (no frames are
 * emitted — the folded log the UI refetches shows ordinary user bubbles).
 */
export function deliverAllQueuedMessages(db: SqliteDatabase, sessionId: string): number {
  const queued = listUndeliveredQueuedMessages(db, sessionId);
  let delivered = 0;
  for (const event of queued) {
    if (deliverQueuedMessage(db, sessionId, event.seq)) delivered += 1;
  }
  return delivered;
}

// ── ROUND-79 (R79-a, the orchestrator round: delegate_task
//    task_id/background/resume) — the delegation.collected event + the
//    background-task reminder payload. ─────────────────────────────────────
//
// A delegation.collected event is a session_events ROW of NEW type
// `delegation.collected` on the PARENT's log with the payload
// {taskId, childId, childCode?} (+ appendSessionEvent's agentId/ts
// mirroring). NOTHING existing reads it as a message: assembleHistory's
// fold only matches message.user/message.assistant/tool.use, so the event
// is invisible to the model by construction — the R78 message.queued
// pattern, one tier over (a queued row is a pending MESSAGE; a collected
// row is durable BOOKKEEPING). Unlike message.queued there is NO delivery
// flip: the row is written ONCE (a delegation is collected at most one
// time) and never mutated. The uniform COLLECTED rule:
//   · a BLOCKING delegation with task_id writes it at COMPLETION (the
//     report was delivered inline — the reminder must never nag about a
//     task the parent already has the answer to);
//   · a BACKGROUND task writes it when RESUME returns the report.
// The per-turn BACKGROUND TASKS reminder lists only the parent's children
// whose ids have no collected event yet.

/** The event type string (named once; the orchestrator + tests share it). */
export const DELEGATION_COLLECTED_EVENT = "delegation.collected";

/**
 * ROUND-79 (R79-a): append a delegation.collected event to the PARENT's
 * log — the durable "this task's report was collected" marker the
 * per-turn reminder consults. Idempotence is the CALLER's contract (the
 * orchestrator writes it exactly once per delegation: blocking at
 * completion, background at resume); this function just appends.
 */
export function appendDelegationCollected(
  db: SqliteDatabase,
  parentSessionId: string,
  input: { taskId: string; childId: string; childCode?: string },
): SessionEvent {
  const parent = getSession(db, parentSessionId);
  return appendSessionEvent(db, parentSessionId, {
    type: DELEGATION_COLLECTED_EVENT,
    agentId: parent?.agentId ?? null,
    payload: {
      taskId: input.taskId,
      childId: input.childId,
      ...(input.childCode !== undefined ? { childCode: input.childCode } : {}),
    },
  });
}

/**
 * ROUND-79 (R79-a): the ids of every child whose report the parent has
 * COLLECTED (the delegation.collected events on the parent's log). Type-
 * filtered and payload-guarded — a malformed payload contributes nothing
 * (honest fail-open: an unreadable marker must never hide a task).
 */
export function collectedChildIds(db: SqliteDatabase, parentSessionId: string): Set<string> {
  const collected = new Set<string>();
  for (const ev of listSessionEvents(db, parentSessionId)) {
    if (ev.type !== DELEGATION_COLLECTED_EVENT) continue;
    const childId = (ev.payload as { childId?: unknown }).childId;
    if (typeof childId === "string" && childId !== "") collected.add(childId);
  }
  return collected;
}

/** ROUND-79 (R79-a): one reminder row — an uncollected addressed child. */
export interface BackgroundTaskRow {
  /** The parent's address for the delegation (delegate_task task_id). */
  taskId: string;
  /** The child session id (resume accepts it too). */
  sessionId: string;
  /** The child's deterministic 4-char code (resume accepts it too). */
  code: string;
  /** The delegated role (planner/researcher/coder/reviewer/tester). */
  role: string | null;
  status: SessionStatus;
  todosDone: number;
  todosTotal: number;
  /** Whole minutes since the child was CREATED (the delegation age — the
   * "running — Xm" line's elapsed). Computed at build time; the reminder is
   * rebuilt every turn so it is always fresh. */
  elapsedMinutes: number;
  /** failed rows only: the last turn.error message, excerpted (~120 chars). */
  error?: string;
}

/** ROUND-79 (R79-a): the per-turn BACKGROUND TASKS payload — the uncollected
 * rows (capped at 10, oldest first) + how many more were cut. Strictly
 * optional in the prompt ctx: undefined composes byte-identically. */
export interface BackgroundTasksPayload {
  tasks: BackgroundTaskRow[];
  /** Rows beyond the cap — rendered as one honest "and N more" line. */
  more: number;
}

/** The reminder's row cap (the plan's fan-out discipline: the section stays
 * a glanceable list, never a wall). */
export const BACKGROUND_TASK_REMINDER_CAP = 10;

/**
 * ROUND-79 (R79-a): build the per-turn BACKGROUND TASKS payload for a
 * session — its children WITH a delegate_task_id whose reports have NOT
 * been collected yet (no delegation.collected event naming the child id).
 *
 * CHEAP GUARD FIRST: one indexed existence probe
 * (idx_sessions_parent_task) — a session with no addressed children (every
 * pre-R79 session, every task_id-less delegation, every ordinary turn)
 * returns undefined and the prompt composes byte-identically at the cost of
 * a LIMIT 1 lookup. Pure (db reads only); never throws.
 */
export function buildBackgroundTasksReminder(
  db: SqliteDatabase,
  sessionId: string,
): BackgroundTasksPayload | undefined {
  const guard = db
    .prepare(
      "SELECT 1 FROM sessions WHERE parent_session_id = ? AND delegate_task_id IS NOT NULL LIMIT 1",
    )
    .get(sessionId);
  if (guard === undefined) return undefined;
  const collected = collectedChildIds(db, sessionId);
  const children = db
    .prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? AND delegate_task_id IS NOT NULL ORDER BY created_at ASC, id ASC",
    )
    .all(sessionId) as SessionRow[];
  const tasks: BackgroundTaskRow[] = [];
  let more = 0;
  for (const child of children) {
    const taskId = child.delegate_task_id ?? null;
    if (taskId === null) continue; // toSession's null-guard, restated
    if (collected.has(child.id)) continue; // report already collected
    const { todosDone, todosTotal } = childTodoProgress(db, child.id);
    const row: BackgroundTaskRow = {
      taskId,
      sessionId: child.id,
      code: subAgentCode(child.id),
      role: child.sub_role ?? null,
      status: child.status,
      todosDone,
      todosTotal,
      elapsedMinutes: elapsedMinutesSince(child.created_at),
    };
    // failed rows carry the honest error excerpt (~120 chars).
    if (child.status === "failed") {
      const { error } = childTerminalText(db, child.id);
      if (error !== null && error !== "") row.error = excerpt(error, 120);
    }
    if (tasks.length < BACKGROUND_TASK_REMINDER_CAP) tasks.push(row);
    else more += 1;
  }
  return { tasks, more };
}

/** ROUND-79 (R79-a): whole minutes since an ISO ts (0 on parse failure —
 * honest, never NaN in a prompt line). */
function elapsedMinutesSince(iso: string): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.round((Date.now() - at) / 60_000));
}

/** ROUND-79 (R79-a): a text excerpt at cap chars + ellipsis when longer. */
function excerpt(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** ROUND-83 (R83): which subsystem spent the tokens — every pre-R83 row is
 * a plain "turn"; the compaction summarizer and the debug analyst (the
 * audit's §2.12: real provider spend that appeared NOWHERE) now record
 * their own rows with their origin so the usage screens can label them. */
export type UsageOrigin = "turn" | "compaction" | "debug";

/** ROUND-83 (R83): the storage-side dimensions of a usage row beyond the
 * shared UsageRecord — providerCalls (the real SDK-call count behind the
 * turn; "requests" in the UI meant TURNS before, a 5-iteration turn counted
 * as 1) and origin. Optional: omitted → the SQL defaults (1 / 'turn'). */
export interface UsageMeta {
  providerCalls?: number;
  origin?: UsageOrigin;
}

/** One billing line per completed model call; costUsd is 0 until estimation lands.
 * ROUND-50 (R50-c1): cachedInputTokens (the provider's cached prompt-token
 * count, null when unreported) persists into usage_events.cached_input_tokens.
 * ROUND-64 (R64-e): keySlot (migration 0024) — which key-pool slot served the
 * call. 0 = the provider's primary key (the default: main-session turns and
 * every caller that cannot know a slot); N ≥ 2 = the pool slot the
 * orchestrator assigned a sub-agent child. Kept as a separate parameter (NOT
 * on shared's UsageRecord) — the slot is a storage dimension, and shared
 * stays message-shaped.
 * ROUND-83 (R83): meta.providerCalls → usage_events.provider_calls (the SDK
 * calls behind this row, DEFAULT 1 — one row per turn since R24, so old rows
 * stay exactly true); meta.origin → usage_events.origin (migration 0031). */
export function recordUsage(
  db: SqliteDatabase,
  usage: UsageRecord,
  keySlot = 0,
  meta?: UsageMeta,
): void {
  db.prepare(
    `INSERT INTO usage_events
      (agent_id, session_id, provider, model, input_tokens, output_tokens, cached_input_tokens, cost_usd, key_slot, provider_calls, origin, ts)
     VALUES (@agentId, @sessionId, @provider, @model, @inputTokens, @outputTokens, @cachedInputTokens, @costUsd, @keySlot, @providerCalls, @origin, @ts)`,
  ).run({
    agentId: usage.agentId,
    sessionId: usage.sessionId,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    costUsd: usage.costUsd,
    keySlot,
    providerCalls: meta?.providerCalls ?? 1,
    origin: meta?.origin ?? "turn",
    ts: usage.ts,
  });
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
    // ROUND-79 (R79-a): …and the fork is NOT addressable either — the
    // delegation address belongs to the parent-child relationship the fork
    // just escaped (resume resolves among the PARENT's children only).
    taskId: null,
    // ROUND-50 (R50-c1): the fork keeps the source session's permission
    // mode — a copy of the conversation keeps its posture.
    permissionMode: original.permissionMode,
    // ROUND-73 (R73-b): …and the same argument carries the ACTIVE TASK MODE —
    // the fork inherits the posture the source was running, and its guide
    // rides the fork's system prompt from turn one.
    activeMode: original.activeMode,
  };
  const copy = db.transaction((srcId: string) => {
    db.prepare(
      `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at, parent_session_id, sub_role, permission_mode, active_mode)
       VALUES (@id, @projectId, @agentId, @mode, @status, @title, @createdAt, @updatedAt, @parentSessionId, @subRole, @permissionMode, @activeMode)`,
    ).run(fork);
    // INSERT…SELECT keeps seq/type/payload/ts byte-identical; the autoincrement
    // `id` column is omitted so every copied row gets a fresh row id.
    db.prepare(
      `INSERT INTO session_events (session_id, seq, type, payload, ts)
       SELECT ?, seq, type, payload, ts FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
    ).run(fork.id, srcId);
  });
  copy(sessionId);
  // R113-a: a fork IS a new session (its rows land through INSERT…SELECT,
  // not appendSessionEvent — the bulk copy deliberately publishes no
  // per-row event frames; ONE "created" frame carries the news). Watchers
  // refresh their lists and see the fork.
  getEventsBus().publishSessionFrame(fork.id, fork.projectId, "created", {
    status: fork.status,
  });
  return fork;
}

/** ROUND-44 (R44-c): revertSession outcome — success carries the number of
 * removed events; failure carries an HTTP-mappable code (404 / 409). */
export type RevertSessionResult =
  | { ok: true; removedCount: number }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "VALIDATION"; message: string };

/**
 * ROUND-44 (R44-c): rewind a session to an earlier message. Events with
 * seq >= throughSeq are deleted — ROUND-77 (R77, owner: "when I click on
 * the revert option on any one of the chats, it should revert to that
 * session, and that message which was on that should be pasted in the
 * message area. That message should be deleted from the chat itself with
 * the agent"): the target message itself is now REMOVED TOO (the wire field
 * keeps its historical name `keepThroughSeq` — it is the seq of the user
 * message being reverted; everything from that message onward is deleted,
 * the UI refills the composer with the message's text, so the owner can
 * edit + resend it as a fresh turn) — then ONE `session.reverted` marker
 * event is appended with the next seq. Event types are not validated
 * anywhere (appendSessionEvent accepts any string; readers tolerate unknown
 * types — see toProjectChatItems), so no type registration is needed; the
 * marker's payload is { throughSeq, at, revertedEventCount, agentId: null,
 * ts } (appendSessionEvent mirrors agentId + ts into the payload like every
 * other event).
 *
 * The append-only contract (ADR-0010) governs in-flight operation; an
 * owner-driven rewind is the documented exception (same standing as
 * deleteSession, round-30) and runs as ONE transaction.
 *
 * Edge cases:
 *  - unknown session id → { ok: false, code: "NOT_FOUND" }
 *  - session status "running" (a live turn is streaming) → CONFLICT
 *    "cannot revert a running session" — the deletion would race the turn.
 *  - throughSeq > max seq → nothing is removed but the marker is STILL
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
    // R77: seq >= throughSeq — the target message is deleted with its reply
    // (was seq > throughSeq, which kept the user message dangling at the
    // transcript's end with no answer).
    const removed = db
      .prepare("DELETE FROM session_events WHERE session_id = ? AND seq >= ?")
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
