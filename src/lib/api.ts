import type {
  AgentRecord,
  MessageAttachment,
  PermissionMode,
  RunMode,
  SessionStatus,
  ThinkingLevel,
  UsageRecord,
} from "shared";
import { getFixtureAgents } from "./agent-fixtures";
import { getFixtureProjects } from "./project-fixtures";
import { getFixtureSessions } from "./session-fixtures";
import { useConfigStore } from "./config-store";
import { isTauri } from "./sidecar";

/**
 * ROUND-50 (R50-c1): the composer's permission-mode + thinking-level unions
 * re-exported from the shared canonical contract (single source of truth).
 */
export type { PermissionMode, ThinkingLevel };

/**
 * Typed client for the agent-core sidecar REST API (docs/architecture/api/API.md).
 * Coded against the contract; the backend lands in a parallel workstream.
 *
 * - Base URL + bearer token come from the config store (shell handoff or dev env).
 * - Every non-2xx response carries the error envelope
 *   `{ error: { code, message, details } }` (API.md §1.3) → surfaced as ApiError.
 * - The fixture adapter (./agent-fixtures.ts) implements the same backend
 *   interface so the UI and tests run before the sidecar exists.
 */

/** Agent as served by the sidecar (API.md §4): AgentRecord + server bookkeeping. */
export interface Agent extends AgentRecord {
  isTemplate: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /agents payload — every editable field, no server-assigned id. */
export type AgentDraft = Omit<AgentRecord, "id">;

/** PATCH /agents/{id} payload — any editable subset. */
export type AgentPatch = Partial<AgentDraft>;

/** Tool names the sidecar validates against (API.md §4.2 "unknown tool names"). */
/** Mirrors the backend TOOL_NAMES (agent-core storage/agents.ts, ADR-0019). */
export const TOOL_CATALOG = [
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "create_dir",
  "delete_file",
  "search_files",
  "search_code",
  "git_status",
  "git_diff",
  "git_log",
  "run_command",
  "todo_write",
  "web_fetch",
  "web_search",
  "index_project",
  // ROUND-44: kept in lockstep with agent-core storage/agents.ts TOOL_NAMES
  // (the agent-form checkboxes render from THIS list — it lagged 15 vs 21
  // after R43/R44 added delegation, browser control and memory).
  "delegate_task",
  "browser_control",
  "memory_save",
  "memory_recall",
  "memory_list",
] as const;

export const PROVIDER_IDS = ["openrouter", "openai", "anthropic", "google"] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/** Extract the error envelope from a response body, if present. */
function parseEnvelope(body: unknown) {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === "object") {
      const { code, message, details } = err as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
      };
      return {
        code: typeof code === "string" ? code : undefined,
        message: typeof message === "string" ? message : undefined,
        details:
          details && typeof details === "object" && !Array.isArray(details)
            ? (details as Record<string, unknown>)
            : undefined,
      };
    }
  }
  return undefined;
}

async function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const { baseUrl, token } = useConfigStore.getState();
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK",
      `Could not reach agent-core at ${baseUrl} (${String(cause)})`,
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const envelope = parseEnvelope(body);
    throw new ApiError(
      res.status,
      envelope?.code ?? "UNKNOWN",
      envelope?.message ?? `Request failed with HTTP ${res.status}`,
      envelope?.details,
    );
  }
  return body as T;
}

/** The agent registry operations the UI needs (API.md §4.1–4.6). */
export interface AgentsBackend {
  list(includeTemplates: boolean): Promise<Agent[]>;
  create(draft: AgentDraft): Promise<Agent>;
  get(id: string): Promise<Agent>;
  update(id: string, patch: AgentPatch): Promise<Agent>;
  remove(id: string): Promise<void>;
  duplicate(id: string, name?: string): Promise<Agent>;
}

/** HTTP implementation talking to the sidecar. */
export function httpAgents(): AgentsBackend {
  return {
    list: (includeTemplates) =>
      request<{ agents: Agent[] }>(`/agents?includeTemplates=${includeTemplates}`).then(
        (b) => b.agents,
      ),
    create: (draft) => request<Agent>("/agents", { method: "POST", json: draft }),
    get: (id) => request<Agent>(`/agents/${id}`),
    update: (id, patch) => request<Agent>(`/agents/${id}`, { method: "PATCH", json: patch }),
    remove: (id) => request<void>(`/agents/${id}`, { method: "DELETE" }),
    duplicate: (id, name) =>
      request<Agent>(`/agents/${id}/duplicate`, { method: "POST", json: name ? { name } : {} }),
  };
}

/**
 * Backend selector: the fixture adapter while demoData is on (sidecar not yet
 * running), HTTP otherwise. Read via getState() so query hooks can call it
 * inside queryFn without prop-drilling.
 */
export function getAgentsBackend(): AgentsBackend {
  if (useConfigStore.getState().demoData) {
    return getFixtureAgents();
  }
  return httpAgents();
}

// ---------------------------------------------------------------------------
// Sessions + single-agent chat (API.md §5, Wave 2 single-agent scope)
// ---------------------------------------------------------------------------

/** Session row as served by the sidecar (agent-core storage/sessions.ts). */
export interface Session {
  id: string;
  projectId: string | null;
  agentId: string | null;
  mode: RunMode;
  status: SessionStatus;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** ROUND-36: set on sub-agent children. */
  parentSessionId?: string | null;
  subRole?: string | null;
  /** ROUND-50 (R50-c1): the composer's permission mode (full/ask/plan/
   * editor — migration 0020; "ask" is the default). Optional here so
   * fixture sessions keep compiling; the live sidecar always sends it. */
  permissionMode?: PermissionMode;
}

/**
 * Append-only event-log row (ADR-0010). `payload` is typed per `type`; the
 * chat events ("message.user" | "message.assistant") carry
 * { role, content, agentId, ts } — narrowed via toChatEntries().
 */
export interface SessionEvent {
  seq: number;
  type: string;
  agentId: string | null;
  payload: unknown;
  ts: string;
}

/** GET /sessions/{id} body: the session plus its event log and backfill anchor. */
export interface SessionDetail extends Session {
  events: SessionEvent[];
  lastSeq: number;
}

/** Final assistant message of a synchronous turn (POST /sessions/{id}/messages). */
export interface AssistantMessage {
  seq: number;
  role: "assistant";
  agentId: string;
  content: string;
  ts: string;
}

export interface SendMessageResult {
  assistantMessage: AssistantMessage;
  usage: UsageRecord;
}

/**
 * ROUND-50 (R50-c1): DISPLAY-ONLY attachment descriptor on a user chat item
 * (name/path/size — the file's TEXT never ships back to the UI; it lives in
 * the event payload for the model-facing history only).
 */
export interface AttachmentRef {
  name: string;
  path?: string;
  size?: number;
}

/**
 * ROUND-50 (R50-c1): one file as read by POST /attachments/read (the head of
 * the file, binary-flagged, or a per-file error — the route never 500s).
 */
export interface AttachmentReadResult {
  path: string;
  name: string;
  size: number;
  /** First 128KB (UTF-8) of the file; null = binary or error. */
  text: string | null;
  /** True when the file is larger than the 128KB head. */
  truncated: boolean;
  /** Per-file failure (missing file, >512KB, path escape, …). */
  error?: string;
}

/**
 * ROUND-50 (R50-c1): the context donut's data source —
 * GET /sessions/:id/context. `breakdown` are token ESTIMATES (the donut
 * slices); usedTokens is their sum; `cache.hitRate` is null before the
 * first provider call reports input tokens; `sessionTotals` are the
 * session's lifetime sums from usage_events.
 */
export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface SessionContextReport {
  model: string;
  providerId: string;
  contextWindow: number;
  usedTokens: number;
  breakdown: {
    systemPrompt: number;
    systemTools: number;
    memory: number;
    messages: number;
    meta: number;
    mcpTools: number;
  };
  cache: {
    inputTokens: number;
    cachedInputTokens: number;
    hitRate: number | null;
  };
  sessionTotals: SessionUsageTotals;
  /**
   * ROUND-51 (R51-c): the Main agent / Sub-agents / Combined usage split for
   * the popover's Session section (owner: main-session stats and sub-agent
   * stats kept separate BUT also shown combined). `main` equals the flat
   * sessionTotals; `subagents` sums the DIRECT child sessions' usage_events
   * (the set GET /sessions/:id/subagents lists); `combined` is their sum.
   * OPTIONAL: a pre-R51 sidecar returns only the flat sessionTotals —
   * consumers fall back (main = sessionTotals, subagents = zeros).
   */
  usage?: {
    main: SessionUsageTotals;
    subagents: SessionUsageTotals;
    combined: SessionUsageTotals;
  };
}

/** Phase 2 scope is single-agent sessions only (ADR-0001); team modes come later. */
export interface CreateSessionInput {
  agentId: string;
  mode: "single";
  title?: string;
  /** Optional project binding (M3 project-chat screen; server-side list
   * filtering does not exist yet — callers filter client-side). */
  projectId?: string;
}

/** POST /sessions/:id/revert response — how many events were removed. */
export interface RevertSessionResult {
  ok: boolean;
  removedCount: number;
}

/** ROUND-50 (R50-c1): the composer's per-send extras threaded through
 * BOTH send paths (the sync SessionsBackend.sendMessage here and
 * streamSessionMessage below). Attachments persist on the message.user
 * payload; thinkingLevel is per-send only (never persisted). */
export interface SendMessageOptions {
  attachments?: MessageAttachment[];
  thinkingLevel?: ThinkingLevel;
}

/** The session/chat operations the UI needs. */
export interface SessionsBackend {
  /** Newest-first (API.md §5.2). */
  list(): Promise<Session[]>;
  /** ROUND-44 (R44-c): GET /sessions?q= — title + event-text search,
   * case-insensitive; newest-updated first. */
  search(q: string): Promise<Session[]>;
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<SessionDetail>;
  /** DELETE /sessions/:id — removes the session + its events/usage/snapshots. */
  remove(id: string): Promise<void>;
  /** PATCH /sessions/:id — rename a session (owner round-33). */
  rename(id: string, title: string): Promise<Session>;
  /** ROUND-44 (R44-c): POST /sessions/:id/fork — full event-log copy under a
   * new top-level session ("Fork · <title>", zeroed usage). */
  fork(id: string): Promise<Session>;
  /** ROUND-44 (R44-c): POST /sessions/:id/revert — delete events with
   * seq > keepThroughSeq (the message AT that seq survives) + append a
   * `session.reverted` marker. 409 when the session is running. */
  revert(id: string, keepThroughSeq: number): Promise<RevertSessionResult>;
  /**
   * One synchronous turn; may take several seconds. 409 CONFLICT when the
   * bound agent is unconfigured, 502 PROVIDER_ERROR on upstream failure.
   * ROUND-50 (R50-c1): optional composer extras (attachments + thinking
   * level) ride the same POST body.
   */
  sendMessage(
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
}

/** HTTP implementation talking to the sidecar. */
export function httpSessions(): SessionsBackend {
  return {
    list: () =>
      request<{ sessions: Session[]; total: number }>("/sessions?limit=50").then(
        (b) => b.sessions,
      ),
    search: (q) =>
      request<{ sessions: Session[]; total: number }>(
        `/sessions?limit=50&q=${encodeURIComponent(q)}`,
      ).then((b) => b.sessions),
    create: (input) => request<Session>("/sessions", { method: "POST", json: input }),
    get: (id) => request<SessionDetail>(`/sessions/${id}`),
    remove: (id) => request<void>(`/sessions/${id}`, { method: "DELETE" }),
    rename: (id, title) =>
      request<Session>(`/sessions/${id}`, { method: "PATCH", json: { title } }),
    fork: (id) =>
      request<{ session: Session }>(`/sessions/${id}/fork`, { method: "POST" }).then(
        (b) => b.session,
      ),
    revert: (id, keepThroughSeq) =>
      request<RevertSessionResult>(`/sessions/${id}/revert`, {
        method: "POST",
        json: { keepThroughSeq },
      }),
    sendMessage: (id, content, options) =>
      request<SendMessageResult>(`/sessions/${id}/messages`, {
        method: "POST",
        json: {
          content,
          ...(options?.attachments !== undefined && options.attachments.length > 0
            ? { attachments: options.attachments }
            : {}),
          ...(options?.thinkingLevel !== undefined && options.thinkingLevel !== "default"
            ? { thinkingLevel: options.thinkingLevel }
            : {}),
        },
      }),
  };
}

/** Session-chat backend selector, same demoData rule as getAgentsBackend(). */
export function getSessionsBackend(): SessionsBackend {
  if (useConfigStore.getState().demoData) {
    return getFixtureSessions();
  }
  return httpSessions();
}

// ── ROUND-44 (R44-c, owner directive: "complete the whole agentic coding
//    environment"): session search / fork / revert client functions. They
//    route through the backend selector so demo (fixture) mode keeps working —
//    the same pattern every other session operation uses. ──────────────────

/** GET /sessions?q= — sessions whose title or event text matches `q`. */
export function searchSessions(q: string): Promise<Session[]> {
  return getSessionsBackend().search(q);
}

/** POST /sessions/:id/fork — full event-log copy under a new session row. */
export function forkSession(id: string): Promise<Session> {
  return getSessionsBackend().fork(id);
}

/** POST /sessions/:id/revert — rewind to the event at `keepThroughSeq`
 * (inclusive); everything after it is removed + a `session.reverted` marker
 * event is appended. Throws ApiError 409 when the session is running. */
export function revertSession(
  id: string,
  keepThroughSeq: number,
): Promise<RevertSessionResult> {
  return getSessionsBackend().revert(id, keepThroughSeq);
}

// ---------------------------------------------------------------------------
// Projects + file explorer (API.md §4a, M3 project-chat screen)
// ---------------------------------------------------------------------------

/** Project row as served by the sidecar (agent-core storage/projects.ts). */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  createdAt: string;
}

/**
 * One node of GET /projects/{id}/tree (agent-core tools/index.ts). `path` is
 * root-relative with "/" separators; folders carry `children`, files an
 * optional byte-ish `size` hint.
 */
export interface TreeNode {
  name: string;
  type: "file" | "folder";
  path: string;
  size?: number;
  children?: TreeNode[];
}

/** The project/workspace operations the project-chat screen needs. */
export interface ProjectsBackend {
  list(): Promise<Project[]>;
  create(name: string, rootPath: string, color?: string): Promise<Project>;
  get(id: string): Promise<Project>;
  remove(id: string): Promise<void>;
  tree(id: string): Promise<{ tree: TreeNode[]; rootPath: string }>;
  file(id: string, path: string): Promise<{ path: string; content: string }>;
}

/** HTTP implementation talking to the sidecar. */
export function httpProjects(): ProjectsBackend {
  return {
    list: () => request<{ projects: Project[] }>("/projects").then((b) => b.projects),
    create: (name, rootPath, color) =>
      request<Project>("/projects", { method: "POST", json: { name, rootPath, color } }),
    get: (id) => request<Project>(`/projects/${id}`),
    remove: (id) => request<void>(`/projects/${id}`, { method: "DELETE" }),
    tree: (id) => request<{ tree: TreeNode[]; rootPath: string }>(`/projects/${id}/tree`),
    file: (id, path) =>
      request<{ path: string; content: string }>(
        `/projects/${id}/file?path=${encodeURIComponent(path)}`,
      ),
  };
}

/** Project backend selector, same demoData rule as getAgentsBackend(). */
export function getProjectsBackend(): ProjectsBackend {
  if (useConfigStore.getState().demoData) {
    return getFixtureProjects();
  }
  return httpProjects();
}

// ---------------------------------------------------------------------------
// Usage summary (API.md §F7 dashboard chart; agent-core storage/usage.ts)
// ---------------------------------------------------------------------------

/** One UTC day bucket as served by GET /usage/summary (zero-filled by server). */
export interface UsageDayBucket {
  /** UTC calendar date, "YYYY-MM-DD". */
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: UsageTotals;
  generatedAt: string;
}

/** Per-day token/request/cost totals over the trailing `days` UTC days (1–90). */
export function fetchUsageSummary(days = 14): Promise<UsageSummary> {
  return request<UsageSummary>(`/usage/summary?days=${days}`);
}

/**
 * Round-28 WS-D3: a single file snapshot (before/after content) for the
 * DiffCard's real unified-diff rendering. Returns null if the snapshot
 * doesn't exist (older sessions pre-R25 have none; non-mutating events have
 * none). Throws ApiError on non-404 failures.
 */
export interface FileSnapshotContent {
  id: string;
  sessionId: string;
  seq: number;
  path: string;
  toolName: string;
  ts: string;
  beforeContent: string | null;
  afterContent: string | null;
}

export async function fetchSnapshot(sessionId: string, seq: number): Promise<FileSnapshotContent | null> {
  try {
    return await request<FileSnapshotContent>(`/sessions/${sessionId}/snapshots/${seq}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Metadata row from GET /sessions/:id/checkpoints (no content BLOBs). */
export interface CheckpointMeta {
  id: string;
  seq: number;
  path: string;
  toolName: string;
  ts: string;
  hadBefore: boolean;
}

/**
 * Round-32: list a session's file-mutation checkpoints. The ActivityBlock's
 * file-change cards use this to resolve which snapshot belongs to a given
 * tool.use event — the runtime stamps snapshots with the TURN's starting seq
 * (computed before the user event lands), not the tool event's own seq, so a
 * direct (sessionId, toolSeq) lookup misses. Resolution rule: same path,
 * greatest snapshot seq ≤ the tool event's seq.
 */
export async function fetchSessionCheckpoints(sessionId: string): Promise<CheckpointMeta[]> {
  try {
    const body = await request<{ checkpoints: CheckpointMeta[] }>(`/sessions/${sessionId}/checkpoints`);
    return body.checkpoints;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return [];
    throw err;
  }
}

/** Pick the snapshot row for a tool.use event (see fetchSessionCheckpoints). */
export function resolveSnapshotForTool(
  checkpoints: CheckpointMeta[],
  path: string | null,
  toolSeq: number,
): CheckpointMeta | null {
  if (path === null) return null;
  let best: CheckpointMeta | null = null;
  for (const cp of checkpoints) {
    if (cp.path !== path) continue;
    if (cp.seq <= toolSeq && (best === null || cp.seq > best.seq)) best = cp;
  }
  // Fallback for same-path writes whose turn seq landed AFTER the tool seq
  // (ordering quirk): accept the closest seq overall.
  if (best === null) {
    let closest: CheckpointMeta | null = null;
    for (const cp of checkpoints) {
      if (cp.path !== path) continue;
      if (closest === null || Math.abs(cp.seq - toolSeq) < Math.abs(closest.seq - toolSeq)) closest = cp;
    }
    best = closest;
  }
  return best;
}

/** ROUND-46 (R46-c): POST /checkpoints/:id/restore response body. */
export interface RestoreCheckpointResult {
  restored: true;
  message: string;
}

/**
 * ROUND-46 (R46-c): restore a file snapshot's BEFORE content to disk
 * (POST /checkpoints/:id/restore). The backend route has existed since
 * round-25 but had no UI caller (the "unrouted feature" lesson) — the
 * DiffDetail restore action is that caller. Overwrites the file at the
 * snapshot's path. NOTE: restoring a create (before content null) DELETES
 * the file via the backend's unlink branch — the UI deliberately hides the
 * action for creates. Throws ApiError (404 unknown checkpoint, 409 session
 * without a project, 500 restore failed) carrying the server's message.
 */
export function restoreCheckpoint(checkpointId: string): Promise<RestoreCheckpointResult> {
  return request<RestoreCheckpointResult>(`/checkpoints/${checkpointId}/restore`, {
    method: "POST",
  });
}

/**
 * Round-28 WS-D3: compute a minimal unified diff (line-level LCS) between
 * before/after content. Returns lines tagged +/- / context for the DiffCard
 * to render with green/red/muted coloring. Not a full git-quality diff —
 * good enough for visual review of agent file mutations.
 */
export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}
export function computeUnifiedDiff(before: string | null, after: string | null): DiffLine[] {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  const truncate = (lines: DiffLine[]): DiffLine[] =>
    lines.length > 200 ? lines.slice(0, 200) : lines;
  // File created (before null) → all-add. File deleted (after null) → all-del.
  if (before === null && after !== null) return truncate(afterLines.map((t) => ({ type: "add" as const, text: t })));
  if (after === null && before !== null) return truncate(beforeLines.map((t) => ({ type: "del" as const, text: t })));
  // LCS table (cap at 500 lines each to bound memory).
  const m = Math.min(beforeLines.length, 500);
  const n = Math.min(afterLines.length, 500);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = beforeLines[i] === afterLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      out.push({ type: "ctx", text: beforeLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: beforeLines[i] });
      i++;
    } else {
      out.push({ type: "add", text: afterLines[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: beforeLines[i++] });
  while (j < n) out.push({ type: "add", text: afterLines[j++] });
  // Truncate huge diffs so the chat stays readable (cap 200 lines).
  return truncate(out);
}

/** A chat bubble narrowed from the event log; non-message events arrive in later waves. */
export interface ChatEntry {
  seq: number;
  role: "user" | "assistant";
  content: string;
  agentId: string | null;
  ts: string;
}

export interface TodoSnapshot {
  seq: number;
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  ts: string;
}

/** Extract the LATEST todo snapshot from the session event log. */
export function toLatestTodo(events: SessionEvent[]): TodoSnapshot | null {
  let latest: TodoSnapshot | null = null;
  for (const event of events) {
    if (event.type !== "todo.update") continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload || !Array.isArray(payload.todos)) continue;
    latest = {
      seq: event.seq,
      ts: event.ts,
      todos: payload.todos as TodoSnapshot["todos"],
    };
  }
  return latest;
}

export function toChatEntries(events: SessionEvent[]): ChatEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "message.user" && event.type !== "message.assistant") return [];
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload || typeof payload.content !== "string") return [];
    return [
      {
        seq: event.seq,
        role: event.type === "message.user" ? "user" : "assistant",
        content: payload.content,
        agentId: event.agentId,
        ts: event.ts,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// project-chat timeline (M3): fold the event log into chat items
// ---------------------------------------------------------------------------

/** One executed tool call as rendered by the grouped action-pills row. */
export interface ToolUseEntry {
  seq: number;
  toolName: string;
  argsSummary: string;
  /** null while the call is in flight (live streaming rows); the persisted
   * event log always carries a concrete boolean. */
  ok: boolean | null;
  ts: string;
  /** ROUND-34: compact tool-output summary (what the tool DID) — shown in
   * the activity rows/terminal cards and used for live command output. */
  outputSummary?: string;
}

/** A write_file/edit_file call surfaced as a diff card (path/chars parsed
 * tolerantly from argsSummary — null when the summary lacks them). */
export interface DiffEntry {
  seq: number;
  toolName: "write_file" | "edit_file";
  path: string | null;
  chars: number | null;
  ok: boolean;
  ts: string;
}

/** Renderable timeline item for the project-chat screen (see toProjectChatItems). */
export type ProjectChatItem =
  | {
      kind: "user";
      seq: number;
      content: string;
      ts: string;
      /** ROUND-50 (R50-c1): display-only attachment chips on the user bubble
       * (name/path/size — the file TEXT never ships back to the UI; the
       * model-facing rendering happens server-side in assembleHistory). */
      attachments?: AttachmentRef[];
    }
  | AssistantTurnItem
  | ErrorTurnItem;

/**
 * ROUND-43 (owner: failed turns "silently die — I only see the message which
 * I sent"): the backend now persists a `turn.error` event when a streamed
 * turn fails. It folds into this item and renders as an error card directly
 * below the failed user message — with Retry + Copy details — instead of a
 * conversation that ends at the user bubble forever.
 */
export interface ErrorTurnItem {
  kind: "error";
  seq: number;
  /** Machine code, e.g. PROVIDER_ERROR / INTERNAL_ERROR. */
  code: string;
  /** Short human summary ("provider 'openrouter' call failed for session …"). */
  message: string;
  /** The model the failed turn used (may differ from the agent default). */
  model?: string;
  /** Provider id, when the backend recorded one. */
  providerId?: string;
  /** Longer upstream reason (status text / SDK error), already secret-scrubbed. */
  providerError?: string;
  /** seq of the user message this failed turn answered (Retry target). */
  userSeq?: number;
  ts: string;
}

/**
 * ROUND-37 (owner "two states" directive): ONE assistant TURN per user
 * message. Everything the agent did between the user's message and its
 * final answer — thoughts, interim narration, tool calls, approval
 * exchanges — folds into `working` and renders inside the collapsible
 * Working section. The text AFTER the last tool call is `finalText`,
 * rendered BELOW the section, so collapsing the section never hides the
 * answer (owner: "the very last line… is the actual response… when I
 * collapse the work for then it will not collapse everything above it").
 */
export interface AssistantTurnItem {
  kind: "turn";
  /** seq of the turn's first event (assistant/tool/approval). */
  seq: number;
  agentId: string | null;
  /** Turn start (first event ts). */
  ts: string;
  /** Last event ts — elapsed = endTs − ts. */
  endTs: string;
  working: WorkingEntry[];
  finalText: string;
  /** Turn-level stats (from the LAST assistant event carrying them — the
   * R35 stats-carrier merges here too). */
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
}

/** One entry inside a turn's Working section. */
export type WorkingEntry =
  | {
      type: "thinking";
      text: string;
      ts: string;
      /** Round-37: measured thinking duration ("Thought for Ns"); absent on
       * sessions persisted before R37 — renderers fall back to "Thought". */
      thinkingMs?: number;
    }
  | { type: "text"; content: string; ts: string }
  | { type: "tool"; tool: ToolUseEntry }
  | {
      type: "approval";
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
      status: "pending" | "approved" | "denied" | "expired";
      remember?: "once" | "always";
      /** ROUND-48 (R48-e2): set when the ask comes from a delegated CHILD
       * agent (its approvals ride the parent's SSE as subagent-event
       * envelopes — stream-store routes them here). Rendered as a
       * "Sub-agent {code} · {role}" attribution prefix on the approval
       * card; absent on main-agent approvals (behavior unchanged). */
      subAgentId?: string;
      ts: string;
    };

/** tool.use payload fields as agent-core's runtime writes them. */
interface ToolUsePayload {
  toolName?: unknown;
  argsSummary?: unknown;
  ok?: unknown;
  outputSummary?: unknown;
}

function toToolUseEntry(event: SessionEvent): ToolUseEntry {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as ToolUsePayload)
      : {};
  return {
    seq: event.seq,
    toolName: typeof payload.toolName === "string" ? payload.toolName : "",
    argsSummary: typeof payload.argsSummary === "string" ? payload.argsSummary : "",
    ok: typeof payload.ok === "boolean" ? payload.ok : true,
    ts: event.ts,
    ...(typeof payload.outputSummary === "string" && payload.outputSummary.length > 0
      ? { outputSummary: payload.outputSummary }
      : {}),
  };
}

/** write/edit tool names that warrant a diff card (round-32: consumed by the
 * ActivityBlock to upgrade those tool rows into file-change cards). */
export const DIFF_TOOLS = new Set(["write_file", "edit_file"]);

/** Tool names rendered as command terminal cards. */
export const TERMINAL_TOOLS = new Set(["run_command"]);

/** Tool names rendered as compact web-action rows. */
export const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

/**
 * Tolerant argsSummary parsing. The canonical format is
 * `path: <relpath>, content: <N> chars`, but summaries may carry extra or
 * missing segments — parse whatever is there, null otherwise.
 */
export function parseDiffArgs(argsSummary: string): { path: string | null; chars: number | null } {
  const pathMatch = /path:\s*([^,]+)/.exec(argsSummary);
  const charsMatch = /(\d+)\s*chars?/i.exec(argsSummary);
  return {
    path: pathMatch ? pathMatch[1].trim() : null,
    chars: charsMatch ? Number(charsMatch[1]) : null,
  };
}

/**
 * Fold the append-only event log (ADR-0010) into the project-chat timeline
 * (ROUND-37 turn model): user bubbles + ONE assistant turn per user message.
 *
 * Turn semantics (plan §1.1 + review amendments #3a–3e):
 * - A turn = every event between two `message.user` events (plus a synthetic
 *   leading turn for logs that start with assistant events).
 * - `finalText` = the content of the last non-empty assistant event, but ONLY
 *   when no tool.use follows it ("text after the last tool call"). A turn that
 *   ends on a tool call has `finalText: ""` and renders working-only.
 * - All other assistant texts (before a later tool) fold into `working` as
 *   narration entries; ALL thinking folds into `working`.
 * - Stats (usage/ms/model) come from the LAST assistant event carrying them
 *   (the R35 stats-carrier merges here — no empty bubbles, ever).
 * - User items ALWAYS render, even when their turn produced nothing (failed
 *   provider call). A turn with no working AND no finalText is dropped.
 * - approval.requested/resolved events fold into working entries; a resolved
 *   event updates its matching pending entry in place.
 */
interface TurnAccumulator {
  seq: number;
  agentId: string | null;
  ts: string;
  endTs: string;
  /** Raw turn events (assistant/tool/approval) in seq order. */
  events: SessionEvent[];
}

interface AssistantPayload {
  content?: unknown;
  thinking?: unknown;
  thinkingMs?: unknown;
  usage?: unknown;
  ms?: unknown;
  model?: unknown;
}

interface ApprovalPayload {
  approvalId?: unknown;
  toolName?: unknown;
  argsSummary?: unknown;
  category?: unknown;
  decision?: unknown;
  remember?: unknown;
}

export function toProjectChatItems(events: SessionEvent[]): ProjectChatItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items: ProjectChatItem[] = [];
  let turn: TurnAccumulator | null = null;

  const openTurn = (event: SessionEvent): TurnAccumulator => {
    turn = {
      seq: event.seq,
      agentId: event.agentId ?? null,
      ts: event.ts,
      endTs: event.ts,
      events: [event],
    };
    return turn;
  };

  const extendTurn = (event: SessionEvent): TurnAccumulator => {
    if (turn === null) return openTurn(event); // openTurn seeds events with [event]
    turn.endTs = event.ts;
    if (turn.agentId === null && event.agentId !== null) turn.agentId = event.agentId;
    turn.events.push(event);
    return turn;
  };

  /** Build the AssistantTurnItem from the accumulated raw events. */
  const flushTurn = (): void => {
    if (turn === null) return;
    const acc = turn;
    turn = null;

    // Classification needs full-turn knowledge: the last tool seq and the
    // last non-empty assistant text seq decide final-vs-narration.
    let lastToolSeq = -1;
    let lastTextSeq = -1;
    let lastTextContent = "";
    for (const event of acc.events) {
      if (event.type === "tool.use") {
        if (event.seq > lastToolSeq) lastToolSeq = event.seq;
        continue;
      }
      if (event.type === "message.assistant") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as AssistantPayload)
            : {};
        if (typeof payload.content === "string" && payload.content.trim() !== "") {
          if (event.seq > lastTextSeq) {
            lastTextSeq = event.seq;
            lastTextContent = payload.content;
          }
        }
      }
    }

    const working: WorkingEntry[] = [];
    const approvalIndex = new Map<string, number>();
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let ms: number | undefined;
    let model: string | undefined;

    for (const event of acc.events) {
      if (event.type === "tool.use") {
        working.push({ type: "tool", tool: toToolUseEntry(event) });
        continue;
      }

      if (event.type === "message.assistant") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as AssistantPayload)
            : {};
        const usageRaw = payload.usage;
        if (typeof usageRaw === "object" && usageRaw !== null) {
          const u = usageRaw as { inputTokens?: unknown; outputTokens?: unknown };
          if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
            usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
          }
        }
        if (typeof payload.ms === "number") ms = payload.ms;
        if (typeof payload.model === "string") model = payload.model;

        if (typeof payload.thinking === "string" && payload.thinking.length > 0) {
          working.push({
            type: "thinking",
            text: payload.thinking,
            ts: event.ts,
            ...(typeof payload.thinkingMs === "number"
              ? { thinkingMs: payload.thinkingMs }
              : {}),
          });
        }

        if (typeof payload.content === "string" && payload.content.trim() !== "") {
          // Final answer iff this is the last text AND no tool follows it;
          // everything else is Working-section narration.
          const isFinal = event.seq === lastTextSeq && lastTextSeq > lastToolSeq;
          if (!isFinal) {
            working.push({ type: "text", content: payload.content, ts: event.ts });
          }
        }
        continue;
      }

      if (event.type === "approval.requested" || event.type === "approval.resolved") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as ApprovalPayload)
            : {};
        const approvalId =
          typeof payload.approvalId === "string" ? payload.approvalId : "";
        const toolName = typeof payload.toolName === "string" ? payload.toolName : "run_command";
        const argsSummary =
          typeof payload.argsSummary === "string" ? payload.argsSummary : "";
        const category = typeof payload.category === "string" ? payload.category : "confirm";
        if (event.type === "approval.requested") {
          approvalIndex.set(approvalId, working.length);
          working.push({
            type: "approval",
            approvalId,
            toolName,
            argsSummary,
            category,
            status: "pending",
            ts: event.ts,
          });
        } else {
          const status =
            payload.decision === "approved" || payload.decision === "denied"
              ? payload.decision
              : "expired";
          const remember =
            payload.remember === "once" || payload.remember === "always"
              ? payload.remember
              : undefined;
          const idx = approvalIndex.get(approvalId);
          if (idx !== undefined && working[idx]?.type === "approval") {
            working[idx] = {
              ...(working[idx] as Extract<WorkingEntry, { type: "approval" }>),
              status,
              ...(remember !== undefined ? { remember } : {}),
            };
          } else {
            working.push({
              type: "approval",
              approvalId,
              toolName,
              argsSummary,
              category,
              status,
              ...(remember !== undefined ? { remember } : {}),
              ts: event.ts,
            });
          }
        }
        continue;
      }

      // Unknown event types are tolerated inside a turn (they keep the turn
      // alive for ts/endTs purposes but add no renderable entries).
    }

    if (working.length === 0 && lastTextSeq === -1) return; // amendment 3e
    items.push({
      kind: "turn",
      seq: acc.seq,
      agentId: acc.agentId,
      ts: acc.ts,
      endTs: acc.endTs,
      working,
      finalText: lastTextSeq > lastToolSeq ? lastTextContent : "",
      ...(usage !== undefined ? { usage } : {}),
      ...(ms !== undefined ? { ms } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  };

  for (const event of ordered) {
    if (event.type === "message.user") {
      flushTurn();
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { content?: unknown; attachments?: unknown })
          : null;
      if (payload !== null && typeof payload.content === "string") {
        // ROUND-50 (R50-c1): narrow the persisted attachments into DISPLAY-ONLY
        // AttachmentRefs (name/path/size — `text` is deliberately dropped).
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachments: AttachmentRef[] = [];
        for (const entry of rawAttachments) {
          if (typeof entry !== "object" || entry === null) continue;
          const item = entry as { name?: unknown; path?: unknown; size?: unknown };
          if (typeof item.name !== "string" || item.name === "") continue;
          attachments.push({
            name: item.name,
            ...(typeof item.path === "string" ? { path: item.path } : {}),
            ...(typeof item.size === "number" ? { size: item.size } : {}),
          });
        }
        items.push({
          kind: "user",
          seq: event.seq,
          content: payload.content,
          ts: event.ts,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      }
      continue;
    }

    if (
      event.type === "tool.use" ||
      event.type === "message.assistant" ||
      event.type === "approval.requested" ||
      event.type === "approval.resolved"
    ) {
      extendTurn(event);
      continue;
    }

    // ROUND-43: a persisted turn failure terminates whatever partial turn
    // accumulated since the user message (the flush renders thoughts/tools
    // done before the crash), then becomes its own error item right below
    // the user bubble.
    if (event.type === "turn.error") {
      flushTurn();
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const asString = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      const model = asString(payload.model);
      const providerId = asString(payload.providerId);
      const providerError = asString(payload.providerError);
      const userSeq =
        typeof payload.userSeq === "number" && Number.isFinite(payload.userSeq)
          ? payload.userSeq
          : undefined;
      items.push({
        kind: "error",
        seq: event.seq,
        code: asString(payload.code) ?? "PROVIDER_ERROR",
        message: asString(payload.message) ?? "The generation failed.",
        ...(model !== undefined ? { model } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
        ...(providerError !== undefined ? { providerError } : {}),
        ...(userSeq !== undefined ? { userSeq } : {}),
        ts: event.ts,
      });
      continue;
    }

    // Other event types (todo.update etc.) don't render in the timeline.
  }

  flushTurn(); // amendment 3c — flush the trailing turn at end-of-log
  return items;
}

// ---------------------------------------------------------------------------
// Native folder picker (round-14): Tauri shell first (UI-side), else the
// sidecar opens the OS dialog (PowerShell / zenity / kdialog).
// ---------------------------------------------------------------------------

/**
 * Ask the sidecar to open the REAL OS folder-picker dialog.
 * Returns the chosen path, null when the user cancelled, or undefined when
 * this machine has no dialog backend (caller falls back to manual entry).
 */
export async function pickFolderViaBackend(): Promise<{
  path: string | null;
  error?: string;
  unavailable?: boolean;
}> {
  const { baseUrl, token } = useConfigStore.getState();
  try {
    const res = await fetch(`${baseUrl}/internal/dialog/folder`, {
      method: "POST",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (res.status === 501) return { path: null, unavailable: true };
    if (!res.ok) {
      // Surface HTTP failures too — never silently pretend "cancelled".
      return { path: null, error: `sidecar answered HTTP ${res.status}` };
    }
    return (await res.json()) as { path: string | null; error?: string };
  } catch (cause) {
    return { path: null, error: `could not reach the sidecar (${String(cause)})` };
  }
}

// ---------------------------------------------------------------------------
// ROUND-50 (R50-c1): composer backend — file picker, attachment reads,
// permission modes, context report.
// ---------------------------------------------------------------------------

/** The Tauri global shape used by pickFilesViaBackend (mirrors Sidebar.tsx). */
type TauriInvokeGlobal = {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

/**
 * ROUND-50 (R50-c1): open the REAL multi-file picker — the composer's
 * "Add Context" button. Inside the Tauri shell the Rust `pick_files` command
 * (rfd FileDialog parented to the main window) runs; in plain browser dev
 * the sidecar route POST /api/v1/internal/dialog/files opens the OS dialog
 * (PowerShell OpenFileDialog with Multiselect / zenity --multiple).
 *
 * Resolves to the chosen absolute paths — EMPTY when the user cancelled (or
 * this machine has no dialog backend). THROWS when the Tauri command fails
 * or the sidecar is unreachable/errors (callers surface the failure; a
 * cancel is never an error).
 */
export async function pickFilesViaBackend(): Promise<string[]> {
  if (isTauri()) {
    const tauri = (window as { __TAURI__?: TauriInvokeGlobal }).__TAURI__;
    if (tauri === undefined) return [];
    const picked = (await tauri.core.invoke("pick_files")) as unknown;
    return Array.isArray(picked) ? (picked as string[]) : [];
  }
  const { baseUrl, token } = useConfigStore.getState();
  try {
    const res = await fetch(`${baseUrl}/api/v1/internal/dialog/files`, {
      method: "POST",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (res.status === 501) return []; // no dialog backend on this machine
    if (!res.ok) {
      throw new Error(`sidecar answered HTTP ${res.status}`);
    }
    const body = (await res.json()) as { files?: string[]; error?: string };
    if (body.error) throw new Error(body.error);
    return Array.isArray(body.files) ? body.files : [];
  } catch (cause) {
    throw new Error(`could not open the file picker (${String(cause)})`);
  }
}

/**
 * ROUND-50 (R50-c1): read the text heads of the files the user attached —
 * POST /attachments/read. Relative paths resolve inside the project root
 * (pass its id); absolute paths (user-picked) read as-is. Per-file failures
 * come back as error entries (the route never 500s), so the composer can
 * show exactly which attachment failed.
 */
export async function readAttachmentFiles(
  paths: string[],
  projectId?: string,
): Promise<AttachmentReadResult[]> {
  const body = await request<{ files: AttachmentReadResult[] }>("/attachments/read", {
    method: "POST",
    json: { paths, ...(projectId !== undefined ? { projectId } : {}) },
  });
  return body.files;
}

/**
 * ROUND-50 (R50-c1): set the session's permission mode (the composer's
 * Full Access / Ask / Plan / Editor switcher) — PATCH /sessions/:id/permissions
 * with { mode }. Returns the updated session in the GET /sessions/:id shape
 * (session row + events + lastSeq). Throws ApiError 400 for an unknown mode,
 * 404 for an unknown session.
 */
export async function patchSessionPermissions(
  sessionId: string,
  mode: PermissionMode,
): Promise<SessionDetail> {
  return request<SessionDetail>(`/sessions/${sessionId}/permissions`, {
    method: "PATCH",
    json: { mode },
  });
}

/**
 * ROUND-50 (R50-c1): the context donut's data source —
 * GET /sessions/:id/context. `model` is optional (defaults to the session
 * agent's model; the composer's per-send model picker passes its selection).
 */
export async function fetchSessionContext(
  sessionId: string,
  model?: string,
): Promise<SessionContextReport> {
  const query =
    model !== undefined && model.trim() !== "" ? `?model=${encodeURIComponent(model)}` : "";
  return request<SessionContextReport>(`/sessions/${sessionId}/context${query}`);
}

// ---------------------------------------------------------------------------
// ROUND-36 (ADR-0022): sub-agent monitoring + orchestration settings
// ---------------------------------------------------------------------------

/** GET /sessions/:id/subagents row — computed status per child. */
export interface SubAgentStatus {
  id: string;
  /** ROUND-48 (R48-e1): deterministic 4-char [A-Z0-9] short code of the
   * child (same value as on every subagent-status SSE envelope) — the
   * quick-identify badge in the picker, Delegated rows and panel header. */
  code: string;
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
   * which was being used"): the model of the child's latest usage row — null
   * before its first provider call completes. */
  model: string | null;
  report: string | null;
  error: string | null;
}

/** GET /sessions/:id — full detail incl. the event log (child logs). */
export async function fetchSessionDetail(sessionId: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/sessions/${sessionId}`);
}

export async function fetchSubAgents(sessionId: string): Promise<SubAgentStatus[]> {
  const body = await request<{ subagents: SubAgentStatus[] }>(`/sessions/${sessionId}/subagents`);
  return body.subagents;
}

export async function retrySubAgent(sessionId: string, childId: string): Promise<void> {
  await request<{ ok: boolean }>(`/sessions/${sessionId}/subagents/${childId}/retry`, {
    method: "POST",
  });
}

/** ROUND-38: a sub-agent's full event log (for the right-sidebar Sub-agents
 * tab — the prompt at the top + the actions below). Reuses the session
 * detail endpoint (a child session is a session). */
export async function fetchSubAgentDetail(childSessionId: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/sessions/${childSessionId}`);
}

/** ROUND-38: POST /projects/:id/terminal — user-driven command runner for the
 * right-sidebar Terminal tab. Returns combined stdout/stderr + exit code. */
export interface TerminalRunResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
}
export async function runProjectTerminal(
  projectId: string,
  command: string,
): Promise<TerminalRunResult> {
  return request<TerminalRunResult>(`/projects/${projectId}/terminal`, {
    method: "POST",
    json: { command },
  });
}

/** ROUND-44 (R44-e): one frame from POST /projects/:id/terminal/stream (SSE).
 * stdout/stderr chunks arrive as the child emits them; `exit` carries the
 * real exit code (null = killed by a signal) + elapsed ms; `error` is a
 * spawn failure / timeout / output-cap kill and always ends the stream. */
export type TerminalStreamFrame =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number | null; ms: number }
  | { type: "error"; message: string };

/**
 * ROUND-44 (R44-e): parse ONE SSE frame block (the text between two `\n\n`
 * separators) and return its data payload, or null when the block carries no
 * data (a `: ping` heartbeat comment — ignored per the SSE spec). Exported
 * for unit tests; the terminal stream read loop below is the only caller.
 *
 * There is no shared SSE parser module in src/lib — each stream client
 * (streamSessionMessage here, streamNotifications in notifications-api.ts)
 * embeds the same verbatim-mirror loop. The terminal stream additionally has
 * to skip comment frames, so this small parser keeps that logic in one
 * testable place instead of a third copy of the loop.
 */
export function parseSseDataBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    // Comment frame (": ping" heartbeat) — ignore, per the SSE spec.
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}

/**
 * ROUND-44 (R44-e): run a terminal command on the STREAMING endpoint —
 * POST /projects/:id/terminal/stream with Accept: text/event-stream, reading
 * response.body as a ReadableStream and parsing SSE frames incrementally
 * (same getReader + TextDecoder + `\n\n` split pattern as
 * streamSessionMessage above; comment/heartbeat frames are ignored). Each
 * stdout/stderr/exit/error frame fires `onFrame` as it lands; the promise
 * resolves when the stream ends.
 *
 * Throws (ApiError / network TypeError / AbortError) when the endpoint is
 * unreachable or answers non-200 BEFORE any frame — the TerminalPanel falls
 * back to the sync runProjectTerminal in that case so the panel never
 * regresses. If the HTTP body dies mid-command without a terminal frame
 * (exit/error), a synthetic error frame is emitted instead — the ROUND-43
 * silent-death lesson applied to the terminal.
 */
export async function runProjectTerminalStream(
  projectId: string,
  command: string,
  onFrame: (frame: TerminalStreamFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/terminal/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ command }),
    signal,
  });
  if (!res.ok || !res.body) {
    // Non-2xx: the error envelope is JSON, not SSE — throw so the caller can
    // fall back to the sync terminal route.
    let message = `sidecar answered HTTP ${res.status}`;
    let code = "UNKNOWN";
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(res.status, code, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalFrame = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = parseSseDataBlock(block);
      if (data !== null) {
        try {
          const parsed = JSON.parse(data) as TerminalStreamFrame;
          if (parsed.type === "exit" || parsed.type === "error") {
            sawTerminalFrame = true;
          }
          onFrame(parsed);
        } catch {
          /* skip malformed frame */
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  if (!sawTerminalFrame) {
    onFrame({
      type: "error",
      message:
        "The terminal stream ended unexpectedly (connection interrupted before the command finished).",
    });
  }
}

/** ROUND-45 (R45-b): a PERSISTENT interactive terminal session — one
 * long-lived shell in the project root. `engine` reports how it runs:
 * "pty" (node-pty loaded — real echo/TUI support) or "pipe" (persistent
 * bash pipe pair — state persists, no TUI echo; the UI echoes commands
 * itself). */
export interface TerminalSessionDescriptor {
  id: string;
  projectId: string;
  engine: "pty" | "pipe";
  createdAt: number;
}

/** ROUND-45 (R45-b): POST /projects/:id/terminal-sessions — spawn a shell
 * in the project root. cols/rows default server-side (120x30). */
export async function createTerminalSession(
  projectId: string,
  opts?: { cols?: number; rows?: number },
): Promise<TerminalSessionDescriptor> {
  return request<TerminalSessionDescriptor>(`/projects/${projectId}/terminal-sessions`, {
    method: "POST",
    json: {
      ...(opts?.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts?.rows !== undefined ? { rows: opts.rows } : {}),
    },
  });
}

/** ROUND-45 (R45-b): GET /projects/:id/terminal-sessions — the project's
 * LIVE sessions, oldest first. */
export async function listTerminalSessions(
  projectId: string,
): Promise<TerminalSessionDescriptor[]> {
  const body = await request<{ sessions: TerminalSessionDescriptor[] }>(
    `/projects/${projectId}/terminal-sessions`,
  );
  return body.sessions;
}

/** ROUND-45 (R45-b): POST …/terminal-sessions/:tsid/input — write raw data
 * to the shell's stdin (append "\n" yourself to submit a command; control
 * sequences like "\u0003" pass through on the pty engine). */
export async function sendTerminalSessionInput(
  projectId: string,
  sessionId: string,
  data: string,
): Promise<void> {
  await request<void>(`/projects/${projectId}/terminal-sessions/${sessionId}/input`, {
    method: "POST",
    json: { data },
  });
}

/** ROUND-45 (R45-b): POST …/terminal-sessions/:tsid/resize — resize the
 * pty (no-op on the pipe engine). */
export async function resizeTerminalSession(
  projectId: string,
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await request<void>(`/projects/${projectId}/terminal-sessions/${sessionId}/resize`, {
    method: "POST",
    json: { cols, rows },
  });
}

/** ROUND-45 (R45-b): DELETE …/terminal-sessions/:tsid — kill the shell. */
export async function killTerminalSession(
  projectId: string,
  sessionId: string,
): Promise<void> {
  await request<void>(`/projects/${projectId}/terminal-sessions/${sessionId}`, {
    method: "DELETE",
  });
}

/** ROUND-45 (R45-b): one frame from GET …/terminal-sessions/:tsid/stream
 * (SSE). `output` chunks are raw shell stdout/stderr (the FIRST one after
 * connecting carries the ring-buffer backlog); `exit` fires when the shell
 * dies (null = killed); `error` is a stream-level failure. */
export type TerminalSessionFrame =
  | { type: "output"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

/** ROUND-45 (R45-b): parse one SSE data payload into a terminal-session
 * frame, or null when it is not a valid frame (malformed JSON / unknown
 * shape). Exported for unit tests; mirrors the R44-e stream client's
 * inline JSON.parse with shape validation on top. */
export function parseTerminalSessionFrame(data: string): TerminalSessionFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const frame = parsed as { type?: unknown; text?: unknown; code?: unknown; message?: unknown };
  if (frame.type === "output" && typeof frame.text === "string") {
    return { type: "output", text: frame.text };
  }
  if (frame.type === "exit") {
    return { type: "exit", code: typeof frame.code === "number" ? frame.code : null };
  }
  if (frame.type === "error" && typeof frame.message === "string") {
    return { type: "error", message: frame.message };
  }
  return null;
}

/**
 * ROUND-45 (R45-b): open the SSE viewer for a persistent terminal session —
 * GET …/terminal-sessions/:tsid/stream with Accept: text/event-stream, same
 * fetch + getReader + `\n\n` split + parseSseDataBlock loop as
 * runProjectTerminalStream above. The FIRST output frame carries the
 * session backlog, so connecting (or reconnecting) always shows the full
 * transcript. Resolves when the server ends the stream (the shell exited);
 * aborting `signal` just detaches the VIEWER — the session survives.
 *
 * Throws (ApiError / network TypeError / AbortError) when the endpoint is
 * unreachable or answers non-200 — the caller surfaces a visible error
 * state (ROUND-43 silent-death lesson). If the body dies WITHOUT a
 * terminal frame (exit/error), a synthetic error frame is emitted instead.
 */
export async function streamTerminalSession(
  projectId: string,
  sessionId: string,
  onFrame: (frame: TerminalSessionFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const res = await fetch(
    `${baseUrl}/api/v1/projects/${projectId}/terminal-sessions/${sessionId}/stream`,
    {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal,
    },
  );
  if (!res.ok || !res.body) {
    // Non-2xx: the error envelope is JSON, not SSE.
    let message = `sidecar answered HTTP ${res.status}`;
    let code = "UNKNOWN";
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(res.status, code, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalFrame = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = parseSseDataBlock(block);
      if (data !== null) {
        const frame = parseTerminalSessionFrame(data);
        if (frame !== null) {
          if (frame.type === "exit" || frame.type === "error") {
            sawTerminalFrame = true;
          }
          onFrame(frame);
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  if (!sawTerminalFrame) {
    onFrame({
      type: "error",
      message:
        "The shell stream ended unexpectedly (connection interrupted while the session was live).",
    });
  }
}

/** ROUND-44 (R44-a): one saved project memory — durable knowledge the agent
 * persisted via its memory_save tool (kinded so the UI groups + colors). */
export interface ProjectMemory {
  id: string;
  projectId: string;
  kind: "fact" | "decision" | "preference" | "note";
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** ROUND-44 (R44-a): GET /projects/:id/memory — the right-sidebar Memory
 * tab's listing (newest first). */
export async function listProjectMemory(projectId: string): Promise<ProjectMemory[]> {
  const body = await request<{ memories: ProjectMemory[] }>(`/projects/${projectId}/memory`);
  return body.memories;
}

/** ROUND-44 (R44-a): DELETE /projects/:id/memory/:memoryId — the owner
 * pruning a stale memory from the Memory tab. */
export async function deleteProjectMemory(
  projectId: string,
  memoryId: string,
): Promise<void> {
  await request<{ ok: boolean }>(`/projects/${projectId}/memory/${memoryId}`, {
    method: "DELETE",
  });
}

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
  /** ROUND-43 (R43-5): the temporary sub-agent model override — model id ALL
   * sub-agent children run on, null = inherit the parent's model. The
   * backend has sent it since R43; typed here (ROUND-47 R47-c1) so callers
   * no longer need to widen locally. */
  subagentModel: string | null;
}

export async function fetchOrchestrationSettings(): Promise<OrchestrationSettings> {
  return request<OrchestrationSettings>("/settings/orchestration");
}

export async function updateOrchestrationSettings(
  patch: Partial<OrchestrationSettings>,
): Promise<OrchestrationSettings> {
  return request<OrchestrationSettings>("/settings/orchestration", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-49 (owner directive: "a setting in the settings to turn off this
 * memory functionality"): the memory master switch. When disabled, no
 * memory digest is injected into any system prompt, the memory_save/recall/
 * list tools are not registered, and the Memory panel shows an off notice.
 * Saved memories are never deleted — a re-enable restores them. */
export interface MemorySettings {
  enabled: boolean;
}

export async function fetchMemorySettings(): Promise<MemorySettings> {
  return request<MemorySettings>("/settings/memory");
}

export async function updateMemorySettings(
  patch: Partial<MemorySettings>,
): Promise<MemorySettings> {
  return request<MemorySettings>("/settings/memory", {
    method: "PUT",
    json: patch,
  });
}

/** Key-pool slot info (masked — values never leave the sidecar). */
export interface KeyPoolSlot {
  slot: number;
  hasKey: boolean;
  masked: string | null;
}

export async function fetchKeyPool(providerId: string): Promise<KeyPoolSlot[]> {
  const body = await request<{ keys: KeyPoolSlot[] }>(`/providers/${providerId}/keys`);
  return body.keys;
}

export async function setKeyPoolSlot(providerId: string, slot: number, value: string): Promise<KeyPoolSlot[]> {
  const body = await request<{ keys: KeyPoolSlot[] }>(`/providers/${providerId}/keys/${slot}`, {
    method: "PUT",
    json: { value },
  });
  return body.keys;
}

export async function removeKeyPoolSlot(providerId: string, slot: number): Promise<KeyPoolSlot[]> {
  const body = await request<{ keys: KeyPoolSlot[] }>(`/providers/${providerId}/keys/${slot}`, {
    method: "DELETE",
  });
  return body.keys;
}

// ── ROUND-47 (R47-c1): provider management — the canonical layer ────────────
// ModelsProvidersTab's local useApi() wrapper is RETIRED; every provider
// CRUD / key / connection-test / models-config call goes through request()
// + ApiError now (one plumbing layer, same typed envelopes as the rest).

/** Provider row as served by GET /providers — agent-core's ProviderView
 * (providers/registry.ts) mirrored field-for-field; never invented. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  /** Wire format (chat-completions | anthropic-messages | responses). */
  apiFormat?: string;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
}

export async function fetchProviders(): Promise<ProviderView[]> {
  const body = await request<{ providers: ProviderView[] }>("/providers");
  return body.providers;
}

/** POST /providers payload — the Add Provider dialog's exact shape. The API
 * key is deliberately NOT part of it: keys only ever travel to the dedicated
 * key route (or the Tauri shell) so no create/list envelope can leak one. */
export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  apiFormat?: string;
  /** Presets re-claim their reserved id (resurrects a deleted built-in). */
  id?: string;
}

export async function createProvider(input: CreateProviderInput): Promise<ProviderView> {
  return request<ProviderView>("/providers", { method: "POST", json: input });
}

/** PATCH /providers/:id payload — any editable subset (every provider is
 * fully editable, built-ins included — ROUND-37). */
export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  apiFormat?: string;
  enabled?: boolean;
}

export async function updateProvider(id: string, patch: ProviderPatch): Promise<ProviderView> {
  return request<ProviderView>(`/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: patch,
  });
}

/** DELETE /providers/:id → 204 (409 while agents still reference it). */
export async function deleteProvider(id: string): Promise<void> {
  await request<void>(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** PUT /providers/:id/key — the browser-dev path only; inside Tauri the key
 * routes through the shell into the OS secure store (ADR-0012). */
export async function storeProviderKey(id: string, value: string): Promise<void> {
  await request<void>(`/providers/${encodeURIComponent(id)}/key`, {
    method: "PUT",
    json: { value },
  });
}

/** POST /providers/:id/test response (ROUND-47 R47-b contract): a probe that
 * RAN and got a NO from the provider arrives as HTTP 200 with ok:false —
 * only transport/agent-core failures throw (ApiError). */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  message?: string;
}

/** Test a provider connection. `slot` scopes the probe to that key-pool key
 * (the backend 409s when the slot holds no key); `model` upgrades the cheap
 * reachability ping to a real one-token completion. */
export async function testProviderConnection(
  id: string,
  opts?: { model?: string; slot?: number },
): Promise<ProviderTestResult> {
  return request<ProviderTestResult>(`/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    json: {
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.slot !== undefined ? { slot: opts.slot } : {}),
    },
  });
}

/** DB model-override row from GET /providers/:id/models-config — agent-core's
 * ModelRecord (storage/models.ts) mirrored field-for-field. */
export interface ProviderModelConfig {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number | null;
  supportsThinking: boolean;
  hidden: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export async function fetchProviderModelConfig(providerId: string): Promise<ProviderModelConfig[]> {
  const body = await request<{ models: ProviderModelConfig[] }>(
    `/providers/${encodeURIComponent(providerId)}/models-config`,
  );
  return body.models;
}

/** POST /providers/:id/models payload — upsert-by-modelId per provider (the
 * UNIQUE(provider_id, model_id) constraint makes "add model" an upsert). */
export interface ProviderModelConfigInput {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputPricePerMtok?: number | null;
  inputPriceCachedPerMtok?: number | null;
  outputPricePerMtok?: number | null;
  supportsThinking?: boolean;
  hidden?: boolean;
}

export async function upsertProviderModelConfig(
  providerId: string,
  input: ProviderModelConfigInput,
): Promise<ProviderModelConfig> {
  return request<ProviderModelConfig>(`/providers/${encodeURIComponent(providerId)}/models`, {
    method: "POST",
    json: input,
  });
}

/** PATCH /models/:id payload — any editable subset (null clears a field). */
export interface ProviderModelConfigPatch {
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputPricePerMtok?: number | null;
  inputPriceCachedPerMtok?: number | null;
  outputPricePerMtok?: number | null;
  supportsThinking?: boolean;
  hidden?: boolean;
}

export async function updateProviderModelConfig(
  modelRowId: string,
  patch: ProviderModelConfigPatch,
): Promise<ProviderModelConfig> {
  return request<ProviderModelConfig>(`/models/${encodeURIComponent(modelRowId)}`, {
    method: "PATCH",
    json: patch,
  });
}

/** DELETE /models/:id → 204. */
export async function deleteProviderModelConfig(modelRowId: string): Promise<void> {
  await request<void>(`/models/${encodeURIComponent(modelRowId)}`, { method: "DELETE" });
}

/** GET /models/catalog entry (ROUND-47 R47-b contract) — agent-core's
 * CatalogModel (storage/models.ts) mirrored field-for-field. */
export interface CatalogModel {
  /** OpenRouter model id — the identifier sent to the API. */
  modelId: string;
  displayName: string;
  /** Total context tokens (input+output). */
  contextWindow: number;
  maxOutputTokens: number | null;
  inputPricePerMtok: number;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number;
  free: boolean;
  /** `tools` in supported_parameters — REQUIRED for agentic turns. */
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  supportsVision: boolean;
}

/** GET /models/catalog response (ROUND-47 R47-b contract): MODEL_CATALOG +
 * the app-wide defaults + recommended pins — the single source model
 * pickers consume (kills the hand-copied catalog drift in SubAgentsTab). */
export interface ModelsCatalog {
  models: CatalogModel[];
  defaultModelId: string;
  subagentDefaultModelId: string;
  recommendedModelIds: string[];
}

export async function fetchModelsCatalog(): Promise<ModelsCatalog> {
  return request<ModelsCatalog>("/models/catalog");
}

// ---------------------------------------------------------------------------
// Streaming messages (round-16: live responses in the chat UI)
// ---------------------------------------------------------------------------

/** ROUND-48 (R48-e1, binding wire contract): a delegated child's live event
 * wrapped by the orchestrator's emit — rides the PARENT's SSE stream as the
 * `inner` payload of a `subagent-event` envelope. `approval.*` frames are the
 * child's interactive permission asks (decided via the parent chat's
 * ApprovalCard → POST /approvals/:id/decision); tool/text frames stream per
 * generateText step. `sessionId` fields are the CHILD's id (the envelope
 * carries it too).
 *
 * The union lists the frames the UI ACTS on; the child's runtime can also
 * forward bookkeeping frames through the same envelope (`meta.compaction`,
 * `meta.context_limit`, `meta.request_limit`, `meta.continuation_complete`,
 * second-shape `meta.continuation {iteration, reason}`) — they arrive
 * verbatim and stream-store ignores them (no branch matches), same as the
 * top-level stream's unlisted meta frames. Extend this union ONLY when a
 * consumer starts rendering one of them. */
export type SubAgentInnerEvent =
  | {
      type: "approval.requested";
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      decision: "approved" | "denied" | "expired";
      remember?: "once" | "always";
    }
  | { type: "tool-call"; sessionId?: string; toolName: string; argsSummary: string }
  | {
      type: "tool-result";
      sessionId?: string;
      toolName: string;
      argsSummary?: string;
      ok: boolean;
      outputSummary?: string;
    }
  /** ROUND-50 (R50-b, owner: "the actual raw data… streamed live just like
   * the main agent"): with children running the STREAMED turn path, inner
   * text frames now arrive as token-level DELTAS (`delta`) instead of the
   * sync path's per-step snapshots (`text` — the full step text; the frames
   * of a call still concatenate to the reply, so both shapes accumulate the
   * same way). stream-store accepts either. */
  | { type: "text-delta"; sessionId?: string; text?: string; delta?: string }
  /** ROUND-50 (R50-b): reasoning tokens stream live from streamed children
   * (the sync path never emits thinking) — the panel renders them in the
   * main chat's muted "Thinking…" language. */
  | { type: "thinking-delta"; sessionId?: string; delta: string }
  /** ROUND-50 (R50-b): the streamed path's finish carries the call's usage —
   * the live stats footer's token counters (the sync path's finish carries
   * only the sessionId). */
  | {
      type: "finish";
      sessionId?: string;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { type: "meta.continuation"; sessionId?: string; iteration: number; maxOuterLoops?: number };

/** Events arriving over POST /sessions/:id/messages/stream (SSE). */
export type StreamTurnEvent =
  | { type: "text-delta"; delta: string }
  /** ROUND-35: thinking/reasoning tokens — rendered separately, muted + collapsible. */
  | { type: "thinking-delta"; delta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean; outputSummary?: string }
  /** Round-32: the outer loop starts a new iteration — the live activity
   * block opens a new ROUND group on this event. */
  | { type: "meta.continuation"; iteration: number; reason?: string }
  /** ROUND-36 (ADR-0022): a delegated sub-agent changed state — the live
   * SubAgentCards update from these. */
  | {
      type: "subagent-status";
      sessionId: string;
      parentSessionId: string;
      status: "queued" | "running" | "completed" | "failed";
      task: string;
      role: string;
      /** ROUND-48 (R48-e1): deterministic 4-char [A-Z0-9] code of the child
       * session — identical to the `code` field on GET /sessions/:id/subagents
       * rows, so the live stream and the polled list join on either id or
       * code. (Tokens arrive live via the child's inner finish events —
       * R50-b — and authoritatively on the polled row.) */
      code: string;
      todosDone?: number;
      todosTotal?: number;
      /** ROUND-50 (R50-b): the model the child actually runs on
       * (orchestration.subagentModel ?? agent.model, resolved at delegation
       * time) — the live stats footer's model line before the polled row's
       * usage-derived `model` lands. */
      model?: string;
    }
  | {
      /** ROUND-48 (R48-e1): a delegated child's live event, wrapped — rides
       * the parent's SSE so the main chat can attribute approvals and show
       * live progress without polling. See SubAgentInnerEvent for shapes. */
      type: "subagent-event";
      sessionId: string;
      parentSessionId: string;
      inner: SubAgentInnerEvent;
    }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { type: "done"; assistantMessage: AssistantMessage; usage: UsageRecord }
  /** ROUND-37 approvals: a tool call needs the owner's permission — the
   * stream stays open while the ApprovalCard waits for a decision. */
  | {
      type: "approval.requested";
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      decision: "approved" | "denied" | "expired";
      remember?: "once" | "always";
    }
  | {
      type: "error";
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    }
  /** ROUND-42: the user explicitly stopped the turn (POST /sessions/:id/stop)
   * — the server resolved it as a deliberate stop, not an error. */
  | { type: "stopped" };

/**
 * Run one streamed turn; `onEvent` fires for every SSE event as it lands
 * (text deltas, tool calls/results, finish, done/error). Resolves when the
 * stream ends. Fixture (demo-data) mode has no sidecar — callers fall back
 * to the sync hook instead of calling this.
 *
 * ROUND-50 (R50-c1): `options` also carries the composer's per-send extras —
 * `thinkingLevel` (reasoning.effort, never persisted) and `attachments`
 * (persisted on the message.user payload, rendered into the model-facing
 * history server-side).
 */
export async function streamSessionMessage(
  sessionId: string,
  content: string,
  onEvent: (event: StreamTurnEvent) => void,
  options?: {
    model?: string;
    signal?: AbortSignal;
    thinkingLevel?: ThinkingLevel;
    attachments?: MessageAttachment[];
  },
): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      content,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.thinkingLevel && options.thinkingLevel !== "default"
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      ...(options?.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    }),
    signal: options?.signal,
  });
  if (!res.ok || !res.body) {
    // Non-2xx: the error envelope is JSON, not SSE.
    let message = `sidecar answered HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* keep the status text */
    }
    onEvent({ type: "error", status: res.status, code: "PROVIDER_ERROR", message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // ROUND-43: a well-formed stream always ends with a terminal frame
  // (done | error | stopped) before the socket closes. If the HTTP stream
  // dies mid-flight (sidecar crash, proxy drop) the read loop below just
  // ends — previously that resolved SILENTLY and the chat showed nothing
  // (the owner's bug). Synthesize a terminal error so the store can surface
  // the failure card + refetch the persisted turn state instead.
  let sawTerminalFrame = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const parsed = JSON.parse(line.slice(6)) as StreamTurnEvent;
            if (parsed.type === "done" || parsed.type === "error" || parsed.type === "stopped") {
              sawTerminalFrame = true;
            }
            onEvent(parsed);
          } catch {
            /* skip malformed frame */
          }
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  if (!sawTerminalFrame) {
    onEvent({
      type: "error",
      status: 0,
      code: "STREAM_DISCONNECTED",
      message:
        "The stream from the agent ended unexpectedly (connection interrupted). Reconnecting may recover the turn.",
    });
  }
}

/**
 * ROUND-42: explicitly stop a live streamed turn on the server. Since turns
 * now survive client disconnects (they complete in the background so a
 * closed window still gets its completion notification), the UI's Stop
 * button must tell the SIDECAR to abort — aborting only the local fetch no
 * longer stops the turn. keepalive lets the request complete even if the
 * user closes the tab right after clicking Stop.
 */
export async function stopSessionTurn(sessionId: string): Promise<void> {
  const { baseUrl, token } = useConfigStore.getState();
  try {
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      keepalive: true,
    });
  } catch {
    // Best-effort — if the sidecar is unreachable the turn will settle on
    // its own; the UI already shows "Stopped".
  }
}

/**
 * ROUND-37 approvals: answer a pending permission request from the live
 * ApprovalCard ("Allow once" / "Always allow" / "Deny"). The waiting tool
 * call resumes (or fails cleanly) the moment the decision lands.
 */
export async function decideApproval(
  approvalId: string,
  body: { decision: "approved" | "denied"; remember?: "once" | "always" },
): Promise<void> {
  await request<unknown>(`/approvals/${approvalId}/decision`, {
    method: "POST",
    json: body,
  });
}

/** Provider model catalog for the composer's model picker (round-16). */
export async function fetchProviderModels(providerId: string): Promise<string[]> {
  const body = await request<{ models: Array<{ id: string; name?: string }> }>(
    `/providers/${providerId}/models`,
  );
  return body.models.map((m) => m.id);
}

/** ROUND-50 (R50-d): the LIVE provider catalog WITH display names — the
 * Settings "Add models" picker needs searchable entries (id + name), which
 * the ids-only fetchProviderModels above cannot serve. Mirrors agent-core's
 * ModelSummary {id, name} from GET /providers/:id/models. */
export interface ProviderModelCatalogEntry {
  /** Model id sent to the API. */
  id: string;
  /** Upstream display name (falls back to the id when absent). */
  name: string;
}

export async function fetchProviderModelEntries(
  providerId: string,
): Promise<ProviderModelCatalogEntry[]> {
  const body = await request<{ models: Array<{ id: string; name?: string }> }>(
    `/providers/${encodeURIComponent(providerId)}/models`,
  );
  return body.models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

// ── Round-28 WS-G2/WS-H: codebase index + unified search ────────────────────

/** Codebase index summary (GET /projects/:id/index) — for the CodebasePanel. */
export interface IndexSummarySymbol {
  path: string;
  symbol: string;
  kind: string;
  line: number;
}
export interface ProjectIndexSummary {
  projectId: string;
  totalFiles: number;
  totalSymbols: number;
  topFiles: Array<{ path: string; count: number }>;
  topSymbols: IndexSummarySymbol[];
  indexedAt: string;
}
export async function fetchProjectIndex(projectId: string): Promise<ProjectIndexSummary | null> {
  const body = await request<{ index: ProjectIndexSummary | null }>(`/projects/${projectId}/index`);
  return body.index;
}

/** Unified project search (POST /projects/:id/search) — for the CommandPalette.
 * kind: "files" (filename substring) | "symbols" (index prefix match) |
 * "content" (grep). */
export interface ProjectSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fileGlob?: string;
  maxResults?: number;
}
export interface ProjectSearchResult {
  kind: string;
  results: unknown;
}
export async function searchProject(
  projectId: string,
  query: string,
  kind: "files" | "symbols" | "content",
  options?: ProjectSearchOptions,
): Promise<ProjectSearchResult> {
  return request<ProjectSearchResult>(`/projects/${projectId}/search`, {
    method: "POST",
    json: { query, kind, ...options },
  });
}

// ── Round-28 WS-I: in-app demo viewer ────────────────────────────────────────

export interface ProjectDemo {
  name: string;
  path: string;       // root-relative, e.g. "demos/test/index.html"
  size: number;
  modifiedAt: string;
}
export async function fetchProjectDemos(projectId: string): Promise<ProjectDemo[]> {
  const body = await request<{ demos: ProjectDemo[] }>(`/projects/${projectId}/demos`);
  return body.demos;
}
