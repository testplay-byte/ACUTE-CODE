import type { AgentRecord, RunMode, SessionStatus, UsageRecord } from "shared";
import { getFixtureAgents } from "./agent-fixtures";
import { getFixtureProjects } from "./project-fixtures";
import { getFixtureSessions } from "./session-fixtures";
import { useConfigStore } from "./config-store";

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

/** Phase 2 scope is single-agent sessions only (ADR-0001); team modes come later. */
export interface CreateSessionInput {
  agentId: string;
  mode: "single";
  title?: string;
  /** Optional project binding (M3 project-chat screen; server-side list
   * filtering does not exist yet — callers filter client-side). */
  projectId?: string;
}

/** The session/chat operations the UI needs. */
export interface SessionsBackend {
  /** Newest-first (API.md §5.2). */
  list(): Promise<Session[]>;
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<SessionDetail>;
  /** DELETE /sessions/:id — removes the session + its events/usage/snapshots. */
  remove(id: string): Promise<void>;
  /**
   * One synchronous turn; may take several seconds. 409 CONFLICT when the
   * bound agent is unconfigured, 502 PROVIDER_ERROR on upstream failure.
   */
  sendMessage(sessionId: string, content: string): Promise<SendMessageResult>;
}

/** HTTP implementation talking to the sidecar. */
export function httpSessions(): SessionsBackend {
  return {
    list: () =>
      request<{ sessions: Session[]; total: number }>("/sessions?limit=50").then(
        (b) => b.sessions,
      ),
    create: (input) => request<Session>("/sessions", { method: "POST", json: input }),
    get: (id) => request<SessionDetail>(`/sessions/${id}`),
    remove: (id) => request<void>(`/sessions/${id}`, { method: "DELETE" }),
    sendMessage: (id, content) =>
      request<SendMessageResult>(`/sessions/${id}/messages`, {
        method: "POST",
        json: { content },
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
  | { kind: "user"; seq: number; content: string; ts: string }
  | {
      /** Round-32: one ACTIVITY BLOCK per turn — every tool.use event of the
       * turn, grouped into rounds (outer-loop iterations), rendered as the
       * collapsible activity timeline card. Diff/terminal/web visuals render
       * INSIDE the block from the tool entries. */
      kind: "activity";
      seqStart: number;
      seqEnd: number;
      rounds: ToolUseEntry[][];
      ts: string;
      /** Last event ts of the block — elapsed = endTs − ts. */
      endTs: string;
    }
  | {
      kind: "ai";
      seq: number;
      content: string;
      agentId: string | null;
      ts: string;
      /** Round-16 per-reply stats (from the assistant event payload). */
      usage?: { inputTokens: number; outputTokens: number };
      ms?: number;
      model?: string;
    };

/** tool.use payload fields as agent-core's runtime writes them. */
interface ToolUsePayload {
  toolName?: unknown;
  argsSummary?: unknown;
  ok?: unknown;
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
 * (round-32): user bubbles, ONE ACTIVITY BLOCK per turn (all tool.use events
 * of the turn, grouped into rounds — a new round starts after each interim
 * message.assistant the outer loop records), and assistant bubbles in their
 * chronological positions. Unknown event types are ignored; a message event
 * whose payload lacks a string content is too.
 *
 * Turn = one message.user … until the next message.user. The activity item
 * is emitted at the position of the turn's FIRST tool.use so the card reads
 * “here is the work that happened”, followed by the assistant notes.
 */
export function toProjectChatItems(events: SessionEvent[]): ProjectChatItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items: ProjectChatItem[] = [];

  // ── Pass 1: collect each turn's tool events (rounds split at assistant
  //    messages) + remember the seq where the turn's tools START. ──────────
  interface TurnActivity {
    seqStart: number;
    seqEnd: number;
    rounds: ToolUseEntry[][];
    ts: string;
    endTs: string;
    emitted: boolean;
  }
  const turnActivities: TurnActivity[] = [];
  let current: TurnActivity | null = null;

  for (const event of ordered) {
    if (event.type === "message.user") {
      // A new turn starts; the previous turn's activity (if any) is complete.
      current = null;
    } else if (event.type === "tool.use") {
      const entry = toToolUseEntry(event);
      if (current === null) {
        current = {
          seqStart: entry.seq,
          seqEnd: entry.seq,
          rounds: [[entry]],
          ts: entry.ts,
          endTs: entry.ts,
          emitted: false,
        };
        turnActivities.push(current);
      } else {
        current.seqEnd = entry.seq;
        current.endTs = entry.ts;
        const lastRound = current.rounds[current.rounds.length - 1];
        if (lastRound.length === 0) {
          lastRound.push(entry);
        } else {
          current.rounds[current.rounds.length - 1].push(entry);
        }
      }
    } else if (event.type === "message.assistant") {
      // An assistant message closes the current round; subsequent tools in
      // the same turn open a NEW round (outer-loop iteration).
      if (current !== null) {
        current.rounds.push([]);
      }
    }
  }

  // Drop the trailing empty round (the final assistant message closes a
  // round that never gets more tools).
  for (const activity of turnActivities) {
    if (activity.rounds.length > 0 && activity.rounds[activity.rounds.length - 1].length === 0) {
      activity.rounds.pop();
    }
  }

  // ── Pass 2: emit. Activity items go at their FIRST tool.use position. ────
  const activityByFirstSeq = new Map<number, TurnActivity>();
  for (const activity of turnActivities) {
    activityByFirstSeq.set(activity.seqStart, activity);
  }

  let index = 0;
  while (index < ordered.length) {
    const event = ordered[index];

    if (event.type === "tool.use") {
      const activity = activityByFirstSeq.get(event.seq);
      if (activity !== undefined && !activity.emitted) {
        activity.emitted = true;
        items.push({
          kind: "activity",
          seqStart: activity.seqStart,
          seqEnd: activity.seqEnd,
          rounds: activity.rounds,
          ts: activity.ts,
          endTs: activity.endTs,
        });
      }
      // Skip the whole run of tool events (they're all inside the block).
      while (index < ordered.length && ordered[index].type === "tool.use") {
        index += 1;
      }
      continue;
    }

    if (event.type === "message.user" || event.type === "message.assistant") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      if (payload && typeof payload.content === "string") {
        if (event.type === "message.user") {
          items.push({ kind: "user", seq: event.seq, content: payload.content, ts: event.ts });
        } else {
          const usageRaw = payload.usage;
          const usage =
            typeof usageRaw === "object" && usageRaw !== null
              ? (usageRaw as { inputTokens: number; outputTokens: number })
              : undefined;
          const msRaw = payload.ms;
          const modelRaw = payload.model;
          items.push({
            kind: "ai",
            seq: event.seq,
            content: payload.content,
            agentId: event.agentId,
            ts: event.ts,
            ...(usage ? { usage } : {}),
            ...(typeof msRaw === "number" ? { ms: msRaw } : {}),
            ...(typeof modelRaw === "string" ? { model: modelRaw } : {}),
          });
        }
      }
    }

    index += 1;
  }

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
// Streaming messages (round-16: live responses in the chat UI)
// ---------------------------------------------------------------------------

/** Events arriving over POST /sessions/:id/messages/stream (SSE). */
export type StreamTurnEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean }
  /** Round-32: the outer loop starts a new iteration — the live activity
   * block opens a new ROUND group on this event. */
  | { type: "meta.continuation"; iteration: number; reason?: string }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { type: "done"; assistantMessage: AssistantMessage; usage: UsageRecord }
  | {
      type: "error";
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Run one streamed turn; `onEvent` fires for every SSE event as it lands
 * (text deltas, tool calls/results, finish, done/error). Resolves when the
 * stream ends. Fixture (demo-data) mode has no sidecar — callers fall back
 * to the sync hook instead of calling this.
 */
export async function streamSessionMessage(
  sessionId: string,
  content: string,
  onEvent: (event: StreamTurnEvent) => void,
  options?: { model?: string; signal?: AbortSignal },
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
            onEvent(JSON.parse(line.slice(6)) as StreamTurnEvent);
          } catch {
            /* skip malformed frame */
          }
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}

/** Provider model catalog for the composer's model picker (round-16). */
export async function fetchProviderModels(providerId: string): Promise<string[]> {
  const body = await request<{ models: Array<{ id: string; name?: string }> }>(
    `/providers/${providerId}/models`,
  );
  return body.models.map((m) => m.id);
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
