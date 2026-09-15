import type {
  AgentRecord,
  MessageAttachment,
  ModelReasoningSupport,
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
  // ROUND-98 (R98-F3): the symbol-index query leg (search_symbols — the
  // codebase index lookup: name prefix + kind filter + file:line +
  // signature). Kept in lockstep with agent-core storage/agents.ts
  // TOOL_NAMES (the drift guard enforces it).
  "search_symbols",
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
  // ROUND-52 (R52-a): background-job supervision (run_command's detached
  // launches — poll with job_status, clean up with job_stop).
  "job_status",
  "job_stop",
  // ROUND-61 (R61): the skills progressive-disclosure loader (read_skill —
  // the system prompt lists skill names; the body loads on demand). The
  // computer-use tools are SETTINGS-GATED (Settings → Computer Use), not
  // agent-form vocabulary; MCP tools are dynamic (mcp__<server>__<tool>).
  "read_skill",
  // ROUND-96 (R96-D): the skills DISCOVERY tool (search_skills — fuzzy
  // search over the skills index; the SKILLS section is budget-capped, so
  // discovery is its search leg). Same family as read_skill.
  "search_skills",
  // ROUND-66 (R66, B3): the general image-analysis tool (local file or URL
  // → the dedicated vision model — Settings → Image Analysis). Always
  // registered like web_fetch, so it is allowlist vocabulary.
  "analyze_image",
  // ROUND-73 (R73-b/c): the session's TASK MODE switch (activate / clear /
  // list the posture modules — plan/debug/build/review/explore/refactor, or
  // project .acute/agents/*.md customs). Always registered like read_skill
  // (agent-core tools/plugins/modes.ts), so it is allowlist vocabulary.
  "switch_mode",
  // ROUND-87 (R87): the mid-task interactive question tool — the chat
  // renders a question card (option pills + custom answer) and the turn
  // waits for the owner. A global session capability like todo_write.
  "ask_user",
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
  /** ROUND-73 (R73-c): the session's active TASK MODE id (plan/debug/build/
   * review/explore/refactor, or a project .acute/agents/*.md custom id) —
   * migration 0027's active_mode column; null (the default) = no mode, the
   * agent picks its posture per request. Typed like permissionMode: optional
   * so fixture sessions keep compiling; the live sidecar always sends it. */
  activeMode?: string | null;
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
  /** ROUND-83 (R83): the REAL SDK-call count behind the rows ("requests"
   * above counts TURNS — one row per turn since R24; a 5-iteration turn
   * recorded 1 "request"). Optional: a pre-R83 sidecar omits it. */
  providerCalls?: number;
}

/** ROUND-83 (R83): the provider's OWN number for the last request — the
 * ground truth behind the donut's "measured" line. Computed from the newest
 * message.assistant stats carrier; null before the first provider reply
 * (NEVER a fabricated 0). The model + ts ride along so a per-send model
 * switch can never silently mix numbers. */
export interface SessionContextActual {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  at: string;
  model: string;
}

/** ROUND-83 (R83): the newest context.compact detail (the donut's
 * "Context compacted" badge; tokensSaved is an estimate delta, rendered
 * with a "~"). Optional — absent when the session never compacted. */
export interface SessionContextCompaction {
  throughSeq: number;
  droppedMessages: number;
  tokensSaved: number;
}

export interface SessionContextReport {
  model: string;
  providerId: string;
  contextWindow: number;
  /** ROUND-83 (R83): where contextWindow came from — "override" (the
   * models-table row) | "catalog" | "default" (the assumed 200k). The donut
   * renders the honest provenance ("assumed 200k — set it in Settings"). */
  contextWindowSource?: "override" | "catalog" | "default";
  /** ROUND-83 (R83): the output reserve the budget subtracts (the owner's
   * per-model max_output_tokens, honored for the first time). */
  maxOutputTokens?: number;
  /** ROUND-83 (R83): the behavioral line — contextWindow − maxOutputTokens
   * − margin; the same number the compaction trigger and the context guard
   * use (ONE budget, one truth). */
  available?: number;
  usedTokens: number;
  /** ROUND-83 (R83): "estimated" — the wire says which number is a
   * projection and which (actual) is the provider's own. */
  usedTokensBasis?: "estimated";
  breakdown: {
    systemPrompt: number;
    systemTools: number;
    memory: number;
    messages: number;
    meta: number;
    mcpTools: number;
  };
  /** ROUND-83 (R83): the provider-measured ground truth for the LAST
   * request (null before the first reply). */
  actual?: SessionContextActual | null;
  /** ROUND-83 (R83): the newest compaction's effect on the messages
   * estimate + its detail (the badge). */
  compaction?: SessionContextCompaction;
  cache: {
    inputTokens: number;
    cachedInputTokens: number;
    /** ROUND-83 (R83): null ALSO when the provider never reported a cached
     * tier (all-NULL SUM) — "— not reported", never a fabricated 0%. */
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
 * payload; thinkingLevel is per-send only (never persisted).
 * ROUND-82 (R82, the owner's custom-provider routing fix): `model` +
 * `providerId` — the composer's provider-grouped picker captures BOTH; the
 * pair rides the send wire so a custom-provider model reaches ITS provider
 * (historically the providerId was captured in the UI and silently dropped
 * on the wire, so custom ids went verbatim to the agent's provider — the
 * default agent is openrouter → "unknown model"). */
export interface SendMessageOptions {
  attachments?: MessageAttachment[];
  thinkingLevel?: ThinkingLevel;
  model?: string;
  providerId?: string;
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
          ...(options?.model !== undefined && options.model.trim() !== ""
            ? { model: options.model }
            : {}),
          // ROUND-82: the override's provider rides the wire with its model
          // (absent → the agent's provider, the pre-R82 behavior).
          ...(options?.providerId !== undefined && options.providerId.trim() !== ""
            ? { providerId: options.providerId }
            : {}),
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

// ── ROUND-59 (R59-D, owner directive: "add the options to mark the responses
//    as good or bad, and all of these will be tracked and saved. I can send
//    you each one of those, and you can determine what went wrong… The full
//    context will be properly shared."): the response-rating client. Every
//    assistant reply can be rated good/bad; the backend persists the verdict
//    WITH a full context snapshot and keeps one row per (session, reply). ──

/** The two verdicts (mirrors agent-core storage/ratings.ts). */
export type RatingValue = "good" | "bad";

/** Hard cap on the owner's note (the input enforces it client-side; the
 * route rejects anything past it with 400 VALIDATION). */
export const MAX_RATING_NOTE_CHARS = 2000;

/** One persisted response rating as the per-session listing serves it
 * (agent-core RatingView WITHOUT context — the chat UI only needs the
 * verdict + note keyed by assistantSeq). */
export interface MessageRating {
  id: number;
  sessionId: string;
  assistantSeq: number;
  rating: RatingValue;
  note: string | null;
  model: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The FROZEN turn context captured at rate time (agent-core
 * buildRatingContext — the owner's "full context will be properly shared").
 * Served only by GET /ratings (the analysis/export path the CLI dumps);
 * content fields are capped with an honest `truncated` flag.
 */
export interface RatingContext {
  version: 1;
  capturedAt: string;
  sessionTitle: string | null;
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  turnStartSeq: number;
  userMessage: { ts: string; content: string; truncated: boolean } | null;
  assistantReply: {
    ts: string;
    content: string;
    truncated: boolean;
    usage?: { inputTokens: number; outputTokens: number };
    ms?: number;
  };
  toolEvents: Array<{
    seq: number;
    tool: string;
    ok: boolean | null;
    outputSummary: { content: string; truncated: boolean } | null;
  }>;
  turnError?: { code: string; message: string; providerError?: string };
  eventCount: number;
}

/** POST /sessions/:id/ratings — upsert one verdict on the assistant reply at
 * `assistantSeq` (re-rating overwrites; the backend freezes the turn context
 * server-side). Returns the row WITHOUT context. */
export function rateReply(
  sessionId: string,
  input: { assistantSeq: number; rating: RatingValue; note?: string },
): Promise<MessageRating> {
  return request<{ rating: MessageRating }>(`/sessions/${sessionId}/ratings`, {
    method: "POST",
    json: input,
  }).then((b) => b.rating);
}

/** GET /sessions/:id/ratings — the session's verdicts (no context), the
 * chat panel's rating map. 404 (ApiError) when the session is unknown. */
export function listSessionRatings(sessionId: string): Promise<MessageRating[]> {
  return request<{ ratings: MessageRating[] }>(`/sessions/${sessionId}/ratings`).then(
    (b) => b.ratings,
  );
}

/** DELETE /ratings/:id — clear one verdict (the same-thumb click). */
export function deleteRating(id: number): Promise<void> {
  return request<{ ok: boolean }>(`/ratings/${id}`, { method: "DELETE" }).then(
    () => undefined,
  );
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

// ---------------------------------------------------------------------------
// ROUND-52 (R52-b): detailed usage analytics (GET /usage/detailed — the in-app
// /usage screen). Same aggregation the PUBLIC usage.json export runs
// (scripts/export-usage.mjs → the DASHBOARD site's Usage page) minus its
// redaction: this is the private bearer-token loopback, so ids/titles/roles
// are raw. `days` scopes only the zero-filled activity series; the
// totals/tools/models/projects rollups are whole-history.
// ---------------------------------------------------------------------------

/** Token triplet shared by every detailed-usage aggregate. */
export interface DetailedUsageTokens {
  input: number;
  output: number;
  cached: number;
}

/** One tool's call volume + failure count (session_events tool.use rows). */
export interface DetailedUsageToolCall {
  tool: string;
  count: number;
  failures: number;
}

/** Per-model aggregate — calls, token mix and cost for one model id. */
export interface DetailedUsageModel {
  model: string;
  calls: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  /** ROUND-83 (R83): the real SDK-call count behind the aggregate
   * ("calls"/rows count turns). Optional: a pre-R83 sidecar omits it. */
  providerCalls?: number;
  /** ROUND-83 (R83): false when the model has no pricing rows — the UI
   * renders "(unpriced)", never a silent $0 free lunch. */
  costKnown?: boolean;
}

/**
 * ROUND-64 (R64-e, owner: "I want the ability to track each individual API
 * key's stats, like the total usage of that API key, total tokens used on
 * that API key"): one provider key-pool slot's whole-history usage rollup
 * (usage_events grouped by provider × key_slot, migration 0024). keySlot 0
 * = the provider's primary key; N ≥ 2 = the ACUTE_PROVIDER_<ID>_SLOT<N>
 * pool slot the orchestrator assigns sub-agent children. Only slots with
 * recorded spend appear — the /usage screen joins this with
 * fetchKeyPool's masked poolInfo to render configured-but-unused keys and
 * honestly flag removed ones.
 */
export interface DetailedUsageKey {
  providerId: string;
  /** 0 = primary key; N ≥ 2 = pool slot N. */
  keySlot: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** ISO ts of the slot's latest recorded call (MAX(ts)). */
  lastUsedAt: string;
}

/** A chat session (or a sub-agent child) row in the projects drill-down. */
export interface DetailedUsageSession {
  id: string;
  title: string;
  status: string;
  /** Dominant model (highest input+output tokens across its usage rows). */
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  requests: number;
  /** ROUND-83 (R83): the real SDK-call count. Optional (pre-R83 sidecar). */
  providerCalls?: number;
  toolCalls: DetailedUsageToolCall[];
  toolCallCount: number;
  /** How many sub-agent children this session delegated (parent rows). */
  subagentCount: number;
  /** True when the row is a delegate_task child. */
  isSubagent: boolean;
  /** The delegating parent session's id (null for main sessions). */
  parentId: string | null;
  /** The delegated role (planner/researcher/coder/…), null on main sessions. */
  role: string | null;
}

export interface DetailedUsageProject {
  id: string;
  name: string;
  color: string;
  /** True for the synthetic "Unassigned sessions" bucket (no project row). */
  synthetic: boolean;
  /** Main (non-sub-agent) session count — what the section header shows. */
  sessionCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  totals: {
    sessions: number;
    subagents: number;
    toolCalls: number;
    requests: number;
    costUsd: number;
    tokens: DetailedUsageTokens;
  };
  toolCalls: DetailedUsageToolCall[];
  /** Sub-agent-only rollup nested inside the project totals. */
  subagents: {
    count: number;
    toolCalls: number;
    requests: number;
    tokens: DetailedUsageTokens;
    costUsd: number;
  };
  models: DetailedUsageModel[];
  /** Main + sub-agent children, newest-first (nest children by parentId). */
  sessions: DetailedUsageSession[];
}

export interface DetailedUsageTotals {
  projects: number;
  sessions: number;
  subagentSessions: number;
  toolCalls: number;
  /** Turns (one usage row per turn since R24) — the ROUND-83 honest relabel. */
  requests: number;
  /** ROUND-83 (R83): the real SDK-call count. Optional (pre-R83 sidecar). */
  providerCalls?: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
}

export interface DetailedUsage {
  /** Windowed, zero-filled, ascending — feeds the activity chart. */
  days: UsageDayBucket[];
  /** Whole-history rollups (mirrors the public usage.json export). */
  totals: DetailedUsageTotals;
  tools: DetailedUsageToolCall[];
  models: DetailedUsageModel[];
  /** ROUND-64 (R64-e): per-key (provider × pool slot) rollups, cost-desc. */
  keys: DetailedUsageKey[];
  /** Most-recently-active first; sub-agent children nested by parentId. */
  projects: DetailedUsageProject[];
  generatedAt: string;
}

/**
 * Whole-history usage analytics for the /usage screen (activity series over
 * the trailing `days` UTC days, 1–90, default 30).
 */
export function fetchDetailedUsage(days = 30): Promise<DetailedUsage> {
  return request<DetailedUsage>(`/usage/detailed?days=${days}`);
}

// ---------------------------------------------------------------------------
// ROUND-98 (R98-I2, owner: "Data & statistics … total tokens, peak tokens,
// the 12-month token-activity heatmap, time-range graphs color-coded by
// model name — same name across providers IS one model — the model-usage
// donut, total cost, agent-health, and clear-all-data"): the windowed
// stats surface (GET /usage/stats + DELETE /usage/data — agent-core
// storage/usage.ts getUsageStats/clearUsageData). Shown in BOTH the
// settings "Data & Statistics" tab AND the /usage screen (the shared
// DataStatsPanel).
// ---------------------------------------------------------------------------

/** Window totals as served by GET /usage/stats. */
export interface UsageStatsTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Turns — COUNT(*) of usage rows (one row per turn since R24). */
  requests: number;
  /** ROUND-83 semantics: the real SDK-call count. */
  providerCalls: number;
}

/** The highest input+output UTC day in the window (date null = no traffic). */
export interface UsageStatsPeak {
  date: string | null;
  tokens: number;
}

/** One day of the zero-filled series: tokens per MODEL NAME (the owner's
 * same-name-across-providers rule — one key per distinct model column
 * value, never split by provider). */
export interface UsageStatsDayBucket {
  date: string;
  byModel: Record<string, number>;
}

/** One model's window rollup (models sorted tokens-desc server-side). */
export interface UsageStatsModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  /** ROUND-83 semantics: the real SDK-call count. */
  calls: number;
  /** Turns — COUNT(*) of usage rows. */
  requests: number;
  /** The provider ids that served this name in the window (name-asc). */
  providers: string[];
}

/** A health count — the turn-error class (errorClass, code as the honest
 * fallback) or the failing tool's name; never a guessed label. */
export interface UsageStatsHealthIssue {
  name: string;
  count: number;
}

export interface UsageStatsHealth {
  turnErrors: UsageStatsHealthIssue[];
  toolFailures: UsageStatsHealthIssue[];
}

export interface UsageStats {
  /** The window actually used (1–24; the route validates). */
  months: number;
  totals: UsageStatsTotals;
  peak: UsageStatsPeak;
  /** Zero-filled ascending day series over the calendar-month window. */
  series: UsageStatsDayBucket[];
  models: UsageStatsModel[];
  health: UsageStatsHealth;
  generatedAt: string;
}

/** Windowed Data & Statistics over the trailing `months` calendar months
 * (integer 1–24, default 12). */
export function fetchUsageStats(months = 12): Promise<UsageStats> {
  return request<UsageStats>(`/usage/stats?months=${months}`);
}

/** R98-I2 (owner: "clear-all-data"): DELETE /usage/data — wipes the
 * usage_events ledger ONLY (token counts, costs, model/key-slot/provider-
 * call history); sessions, conversations, agents, providers, and settings
 * are NOT touched. Returns the deleted-row count. */
export function clearUsageData(): Promise<{ deleted: number }> {
  return request<{ deleted: number }>("/usage/data", { method: "DELETE" });
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
  /** R88: WHO wrote this snapshot — "user" (the floating widget's manual
   * edit) or "agent" (the todo_write tool; the default for unmarked
   * pre-R88 events). */
  source?: "agent" | "user";
}

/** Extract the LATEST todo snapshot from the session event log. An empty
 * todos array is the R88 "cleared" state — it IS the latest snapshot. */
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
      ...(payload.source === "user" ? { source: "user" as const } : {}),
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
  | {
      /** ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — send while the agent
       * works): a message the user queued mid-turn that has NOT been delivered
       * yet — persisted as a `message.queued` event (same payload shape as
       * message.user) and folded HERE so the refetched log renders the queued
       * chip after the stream ends (the live store's `queued` array owns the
       * chip mid-stream). A DELIVERED queued message is the SAME event row
       * with its type flipped to message.user server-side — it folds as an
       * ordinary user item, so no fold change and no model-history change
       * were needed for delivery. */
      kind: "queued";
      seq: number;
      content: string;
      ts: string;
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
  /** ROUND-75 (R75): the provider-error class (rate_limit / network /
   * timeout / auth / context_window_exceeded / unknown) — the card's
   * one-word cause line. */
  errorClass?: string;
  /** ROUND-75 (R75): total attempts when the transient-API retry ladder ran
   * (1 = no ladder) — the card's "failed after N attempts" line. */
  attempts?: number;
  /** ROUND-97 (R97-E): the tokens the failed turn actually spent (the
   * completed iterations' totals + the failed call's streamed-so-far) — the
   * card's "Tokens sent ↑ / received ↓" line (the owner: "if a model fails,
   * then it does not show me the total number of tokens sent, total number
   * of tokens received… It should show that info properly"). */
  usage?: { inputTokens: number; outputTokens: number };
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
  /** ROUND-59 (R59-D): the seq of the turn's LAST non-empty assistant text
   * event — the RATING KEY (what POST /sessions/:id/ratings rates; the
   * backend freezes the full turn context against this seq). Absent for
   * turns with no assistant text (working-only turns — nothing to rate).
   * The live path carries the same value (the done frame's
   * assistantMessage.seq), so live-completed turns rate identically. */
  lastAssistantSeq?: number;
  /** ROUND-66 (R66, C1): the post-turn DEBUG ANALYST's report, persisted as
   * a `debug.report` session event and folded HERE (rendered at the very
   * bottom of the turn — a dedicated section, never part of the answer).
   * Absent when debug mode was off or the analyst failed. NEVER sent back
   * to the model (assembleHistory skips the event type), so follow-up
   * messages are unaffected — the owner's separation directive. */
  debugReport?: { content: string; ts: string; model?: string };
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
    }
  | {
      /** ROUND-68 (R68-A, owner: "The screenshots were supposed to be shown
       * properly when they were actually taken, not at the bottom in a
       * dedicated section. When the screenshots were taken they should be
       * shown at that specific time."): one INLINE capture marker inside the
       * working stream — the `{type:"screenshot"}` SSE sideband frame is
       * pushed into liveTurn.working AT FRAME ARRIVAL, so the entry lands
       * right after the in-flight tool row (the sideband fires DURING tool
       * execution) = exactly the capture moment, and WorkingSection renders
       * the inline row at its position.
       *
       * LIVE-ONLY by design: the server event log never persists rasters,
       * so the folded log carries no screenshot entries (the bytes expire
       * server-side in ~10 minutes anyway — the inline entry vanishes with
       * the live turn; the folded turn re-renders from the event log
       * alone). The raster itself is fetched lazily by the inline row via
       * fetchComputerFrameRaster(frameId). */
      type: "screenshot";
      /** The captured raster's frame id (fetchable from the sidecar for ~10 min). */
      frameId: string;
      /** The tool that captured it (screenshot / zoom / get_app_state / browser_control). */
      tool: string;
      ts: string;
    }
  /** ROUND-87 (R87): the ask_user tool's interactive question card — the
   * live entry pushed at frame arrival (agent-question SSE) and the folded
   * entry built from the persisted agent-question.requested session event
   * (the answered state patches in from agent-question.resolved). */
  | {
      type: "question";
      questionId: string;
      questions: AgentQuestionPrompt[];
      status: "pending" | "answered" | "timeout" | "cancelled";
      answers?: string[];
      sources?: Array<"option" | "custom">;
      ts: string;
    }
  /** ROUND-87 (R87): the turn's todo-list card — one entry per turn holding
   * the LATEST snapshot (the live `todo-updated` frame and the folded
   * todo.update events both upsert it, keeping its position). R88: `source`
   * badges the owner's manual edits. */
  | {
      type: "todo";
      items: TodoSnapshot["todos"];
      ts: string;
      source?: "agent" | "user";
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
  /** ROUND-66 (R66-2-c): a `debug.report` event absorbed while this turn
   * was still OPEN (the analyst runs strictly after the turn's last
   * assistant event) — attached to the built AssistantTurnItem at flush. */
  debugReport?: { content: string; ts: string; model?: string };
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

/** ROUND-66 (R66-2-c): payload of a persisted `debug.report` session event
 * (the route-side analyst's output — see agent-core's
 * agents/debug-analyst.ts + the stream route's debug phase). */
interface DebugReportPayload {
  content?: unknown;
  model?: unknown;
}

/** ROUND-78 (R78-b): narrow a raw `attachments` payload array into DISPLAY-ONLY
 * AttachmentRefs (name/path/size — `text` is deliberately dropped) — the exact
 * R50-c1 narrowing that lived inline in the message.user branch, extracted so
 * the new message.queued fold (same payload shape as message.user) shares it. */
function narrowAttachmentRefs(raw: unknown): AttachmentRef[] {
  const rawAttachments = Array.isArray(raw) ? raw : [];
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
  return attachments;
}

export function toProjectChatItems(events: SessionEvent[]): ProjectChatItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items: ProjectChatItem[] = [];
  let turn: TurnAccumulator | null = null;
  // ROUND-66 (R66-2-c): reference to the last-BUILT turn item + the user-gap
  // bookkeeping for `debug.report` folding — see the debug.report branch in
  // the loop below for the placement rules.
  let lastClosedTurn: AssistantTurnItem | null = null;
  let lastUserSeq = -1;
  let closedTurnUserSeq = -1;

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
    // ROUND-87 (R87): the ask_user cards' positions (the resolved event
    // patches the entry the requested event created).
    const questionIndex = new Map<string, number>();
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

      // ROUND-87 (R87): the ask_user cards fold from their persisted events
      // (same shape as the approvals above).
      if (event.type === "agent-question.requested" || event.type === "agent-question.resolved") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        const questionId = typeof payload.questionId === "string" ? payload.questionId : "";
        if (event.type === "agent-question.requested") {
          const questions = Array.isArray(payload.questions)
            ? (payload.questions as AgentQuestionPrompt[])
            : [];
          questionIndex.set(questionId, working.length);
          working.push({ type: "question", questionId, questions, status: "pending", ts: event.ts });
        } else {
          const status =
            payload.resolution === "answered"
              ? "answered"
              : payload.resolution === "cancelled"
                ? "cancelled"
                : "timeout";
          const answers = Array.isArray(payload.answers) ? (payload.answers as string[]) : undefined;
          const sources = Array.isArray(payload.sources)
            ? (payload.sources as Array<"option" | "custom">)
            : undefined;
          const idx = questionIndex.get(questionId);
          if (idx !== undefined && working[idx]?.type === "question") {
            working[idx] = {
              ...(working[idx] as Extract<WorkingEntry, { type: "question" }>),
              status,
              ...(answers !== undefined ? { answers } : {}),
              ...(sources !== undefined ? { sources } : {}),
            };
          } else {
            working.push({
              type: "question",
              questionId,
              questions: [],
              status,
              ...(answers !== undefined ? { answers } : {}),
              ...(sources !== undefined ? { sources } : {}),
              ts: event.ts,
            });
          }
        }
        continue;
      }

      // ROUND-87 (R87): the turn's todo card — ONE entry per turn, upserted
      // with the LATEST snapshot (position = the FIRST todo.update event).
      // R88: the payload's source ("user" = the widget's manual edit) rides
      // through so the floating widget can badge folded owner edits.
      if (event.type === "todo.update") {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : null;
        if (payload !== null && Array.isArray(payload.todos)) {
          const items = payload.todos as TodoSnapshot["todos"];
          const source = payload.source === "user" ? ("user" as const) : undefined;
          // (findLastIndex needs es2023 — the tsconfig targets older lib;
          // a manual reverse scan is the compatible form.)
          let idx = -1;
          for (let i = working.length - 1; i >= 0; i -= 1) {
            if (working[i].type === "todo") {
              idx = i;
              break;
            }
          }
          if (idx !== -1) {
            working[idx] = { type: "todo", items, ts: event.ts, ...(source === "user" ? { source } : {}) };
          } else {
            working.push({ type: "todo", items, ts: event.ts, ...(source === "user" ? { source } : {}) });
          }
        }
        continue;
      }

      // Unknown event types are tolerated inside a turn (they keep the turn
      // alive for ts/endTs purposes but add no renderable entries).
    }

    if (working.length === 0 && lastTextSeq === -1 && acc.debugReport === undefined) return; // amendment 3e
    const item: AssistantTurnItem = {
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
      // ROUND-59 (R59-D): the rating key — last NON-EMPTY assistant text seq
      // (identical to the runtime's lastAssistantEvent and the done frame's
      // assistantMessage.seq, so folded and live turns rate the same reply).
      ...(lastTextSeq !== -1 ? { lastAssistantSeq: lastTextSeq } : {}),
      // ROUND-66 (R66-2-c): the post-turn debug analyst's report, folded onto
      // the turn it analyzed (an amendment-3e turn that carries ONLY a
      // report is kept alive by the guard above — the card still renders).
      ...(acc.debugReport !== undefined ? { debugReport: acc.debugReport } : {}),
    };
    items.push(item);
    lastClosedTurn = item;
    closedTurnUserSeq = lastUserSeq;
  };

  for (const event of ordered) {
    if (event.type === "message.user") {
      flushTurn();
      lastUserSeq = event.seq;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { content?: unknown; attachments?: unknown })
          : null;
      if (payload !== null && typeof payload.content === "string") {
        // ROUND-50 (R50-c1): narrow the persisted attachments into DISPLAY-ONLY
        // AttachmentRefs (name/path/size — `text` is deliberately dropped).
        const attachments = narrowAttachmentRefs(payload.attachments);
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

    // ROUND-78 (R78-D): a QUEUED (not-yet-delivered) mid-turn message — its
    // own timeline item (the queued chip the panel renders), NEVER a turn
    // boundary: the turn it interrupted keeps accumulating across it (the
    // event row's type flips to message.user at DELIVERY time server-side,
    // in place — same seq — so the model's history sees the message exactly
    // where it was queued, and the fold then renders an ordinary user item).
    if (event.type === "message.queued") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { content?: unknown; attachments?: unknown })
          : null;
      if (payload !== null && typeof payload.content === "string") {
        const attachments = narrowAttachmentRefs(payload.attachments);
        items.push({
          kind: "queued",
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
      const errorClass = asString(payload.errorClass);
      const attempts =
        typeof payload.attempts === "number" && Number.isFinite(payload.attempts) && payload.attempts > 1
          ? payload.attempts
          : undefined;
      // R97-E: the failed turn's real token spend (the runtime attaches it
      // to the persisted payload when any usage accumulated).
      const usageRaw =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as { inputTokens?: unknown; outputTokens?: unknown })
          : undefined;
      const usage =
        usageRaw !== undefined &&
        typeof usageRaw.inputTokens === "number" &&
        Number.isFinite(usageRaw.inputTokens) &&
        typeof usageRaw.outputTokens === "number" &&
        Number.isFinite(usageRaw.outputTokens)
          ? { inputTokens: usageRaw.inputTokens, outputTokens: usageRaw.outputTokens }
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
        ...(errorClass !== undefined ? { errorClass } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ts: event.ts,
      });
      continue;
    }

    // ROUND-66 (R66-2-c): a persisted `debug.report` event (the post-turn
    // context-free analyst's output) folds onto the turn it analyzed — the
    // dedicated card at the very bottom of THAT turn's response.
    //
    // PLACEMENT (the honest reading of the event log): the report lands
    // right after the analyzed turn's LAST assistant event and before the
    // next user message, so:
    //   1. a turn is still OPEN → the report rides the accumulator and
    //      attaches when that turn flushes (normal case; endTs stretches to
    //      the report's ts — the analysis IS part of the turn's timeline);
    //   2. NO open turn (the turn was closed by a turn.error flush) →
    //      attach to the LAST-CLOSED turn item, but ONLY when it closed in
    //      the SAME user gap (no user message since — the closedTurnUserSeq
    //      guard) so an older turn never claims a newer failure's report;
    //   3. anything else (a stray report with no analyzable turn in its gap)
    //      is dropped — there is no honest place to render it.
    // Never attached to the NEXT turn: the owner's separation directive — a
    // follow-up user message must never include the analysis.
    if (event.type === "debug.report") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as DebugReportPayload)
          : {};
      if (typeof payload.content !== "string" || payload.content.length === 0) continue;
      const model =
        typeof payload.model === "string" && payload.model.length > 0 ? payload.model : undefined;
      const report = {
        content: payload.content,
        ts: event.ts,
        ...(model !== undefined ? { model } : {}),
      };
      // Widen the closure-captured lets back to their declared types — TS's
      // flow analysis cannot see the closure assignments (openTurn /
      // extendTurn / flushTurn), so it wrongly narrows them to null on this
      // fall-through path. The cast is the honest widening, not a lie.
      const openAcc = turn as TurnAccumulator | null;
      const closedAcc = lastClosedTurn as AssistantTurnItem | null;
      if (openAcc !== null) {
        openAcc.debugReport = report;
        openAcc.endTs = event.ts;
      } else if (closedAcc !== null && closedTurnUserSeq === lastUserSeq) {
        closedAcc.debugReport = report;
      }
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
 *
 * R54: the fetch is bounded (2 min) — the sidecar's dialog can block for up
 * to 15 minutes on a human, but a HUNG dialog (PowerShell stuck, script
 * blocked by policy) used to leave the Browse button spinning forever with
 * no feedback. On timeout the caller gets an error and the manual path input
 * is right there — pasting a path always works.
 */
const FOLDER_DIALOG_TIMEOUT_MS = 120_000;

export async function pickFolderViaBackend(): Promise<{
  path: string | null;
  error?: string;
  unavailable?: boolean;
}> {
  const { baseUrl, token } = useConfigStore.getState();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOLDER_DIALOG_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/internal/dialog/folder`, {
      method: "POST",
      signal: controller.signal,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (res.status === 501) return { path: null, unavailable: true };
    if (!res.ok) {
      // Surface HTTP failures too — never silently pretend "cancelled".
      return { path: null, error: `sidecar answered HTTP ${res.status}` };
    }
    return (await res.json()) as { path: string | null; error?: string };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return {
        path: null,
        error: "the folder dialog timed out — paste the folder path instead",
      };
    }
    return { path: null, error: `could not reach the sidecar (${String(cause)})` };
  } finally {
    clearTimeout(timer);
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
 * ROUND-67 (R67-A): the persisted-attachment result of POST
 * /attachments/upload. `path` is PROJECT-RELATIVE (forward slashes) and
 * points at the copy the sidecar wrote into <root>/attachments/ — exactly
 * the path renderAttachments shows the model, so analyze_image / read_file
 * can open it.
 */
export interface AttachmentUploadResult {
  /** Project-relative path of the persisted copy ("attachments/shot.png"). */
  path: string;
  /** The FINAL on-disk name (dedupe suffix applied when the name was taken). */
  name: string;
  /** Persisted size in bytes. */
  size: number;
}

/**
 * ROUND-67 (R67-A): persist DROPPED/PASTED attachment bytes — POST
 * /attachments/upload with { projectId, name, dataBase64 }. The sidecar
 * decodes, validates (≤8MB, strict base64), and writes the file into the
 * project's attachments/ dir (an identical existing file is reused; a
 * different file under the same name gets a -2… suffix — never an
 * overwrite). The composer threads the returned path onto the chip so the
 * agent-facing history can point analyze_image at a REAL file instead of a
 * guessed path (the owner's #1 v0.66.0 complaint). Throws ApiError on 400
 * (oversized/invalid base64/bad name) and 404 (unknown project).
 */
export async function uploadAttachmentBytes(
  projectId: string,
  name: string,
  dataBase64: string,
): Promise<AttachmentUploadResult> {
  return request<AttachmentUploadResult>("/attachments/upload", {
    method: "POST",
    json: { projectId, name, dataBase64 },
  });
}

/**
 * ROUND-67 (R67-A): ingest an OS-PICKER file by its absolute path — the
 * same POST /attachments/upload, with { projectId, name, absolutePath }:
 * the SIDECAR copies the file into the project's attachments/ dir (the
 * picker already returned a trusted absolute path; /attachments/read reads
 * those the same way). Same result contract as uploadAttachmentBytes.
 */
export async function ingestAttachmentPath(
  projectId: string,
  name: string,
  absolutePath: string,
): Promise<AttachmentUploadResult> {
  return request<AttachmentUploadResult>("/attachments/upload", {
    method: "POST",
    json: { projectId, name, absolutePath },
  });
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
 * ROUND-82: `providerId` joins `model` (the picker's provider grouping) so
 * the meter reads the window/pricing rows of the provider that will serve
 * the next send.
 */
export async function fetchSessionContext(
  sessionId: string,
  model?: string,
  providerId?: string,
): Promise<SessionContextReport> {
  // ROUND-82: ?providerId= alongside ?model= — the meter keys the
  // window/pricing lookups on the provider that will actually serve the
  // next send (the composer's per-send picker), not just the agent's.
  const params: string[] = [];
  if (model !== undefined && model.trim() !== "") {
    params.push(`model=${encodeURIComponent(model)}`);
  }
  if (providerId !== undefined && providerId.trim() !== "") {
    params.push(`providerId=${encodeURIComponent(providerId)}`);
  }
  const query = params.length > 0 ? `?${params.join("&")}` : "";
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
  /** ROUND-79 (R79-b, the orchestrator round): the PARENT's own address for
   * this delegation (sessions.delegate_task_id — the task_id the parent
   * model picked; null = an ordinary unaddressed child, the pre-R79
   * behavior). The panel header + card rows render it as a mono chip — the
   * addressable surface (what delegate_task {"resume":"…"} accepts, what
   * the per-turn BACKGROUND TASKS reminder lists). Additive: old consumers
   * of the other fields are unaffected. */
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

// ── ROUND-52 (R52-a): background jobs ─────────────────────────────────────
// run_command background launches (`start /B … > log 2>&1`, `… &`, nohup)
// register in the sidecar's job registry; these client functions drive the
// Terminal panel's Background Jobs view (live status + output tails + Stop).

/** One background job as served by GET /projects/:id/jobs (and /jobs). */
export interface BackgroundJobStatus {
  id: string;
  command: string;
  cwd: string;
  projectId: string | null;
  startedAt: number;
  status: "running" | "exited";
  exitCode: number | null;
  endedAt: number | null;
  pid: number | null;
  logFile: string | null;
  outputTail: string;
  ageMs: number;
  alive: boolean;
  logTail: string | null;
  /** ROUND-52 follow-up: a fully-detached launch (Unix `&` + full redirect) —
   * liveness is the process-group probe, output the log-file tail. */
  detached?: boolean;
}

/** ROUND-52 (R52-a): GET /projects/:id/jobs — the project's background jobs,
 * newest first (running + recently ended). */
export async function fetchProjectJobs(projectId: string): Promise<BackgroundJobStatus[]> {
  const body = await request<{ jobs: BackgroundJobStatus[] }>(`/projects/${projectId}/jobs`);
  return body.jobs;
}

/** ROUND-52 (R52-a): POST /jobs/:id/stop — best-effort stop of a tracked
 * background job (tree-kill / pid-match kill; the result reports honestly). */
export async function stopBackgroundJob(jobId: string): Promise<{ ok: boolean; output: string }> {
  return request<{ ok: boolean; output: string }>(`/jobs/${jobId}/stop`, { method: "POST" });
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

/** ROUND-98 (R98-F1, the owner: "it definitely does not know or remember the
 * things properly… implement our proper memory functionality"): the Memory
 * panel's WRITE side. POST /projects/:id/memory — the add-memory form's
 * save. kind absent → the sidecar's "note" default (the memory_save tool's
 * contract); the row is sourced "owner" (distinguishable from agent saves
 * in every row). An exact duplicate REFRESHES the existing row
 * (deduplicated: true, 200) instead of inserting a twin (201) — the
 * storage's saveMemoryWithDedup path, REST-visible now. */
export interface CreateProjectMemoryInput {
  kind?: ProjectMemory["kind"];
  content: string;
}

export interface CreateProjectMemoryResult {
  memory: ProjectMemory;
  deduplicated: boolean;
}

export async function createProjectMemory(
  projectId: string,
  input: CreateProjectMemoryInput,
): Promise<CreateProjectMemoryResult> {
  return request<CreateProjectMemoryResult>(`/projects/${projectId}/memory`, {
    method: "POST",
    json: input,
  });
}

/** ROUND-98 (R98-F1): PUT /projects/:id/memory/:memoryId — the per-row edit,
 * a PARTIAL patch ({content?, kind?} — at least one; the PUT /settings/*
 * grammar). The updated row comes back with a bumped updatedAt (it ranks
 * like a fresh save). No importance field exists by design: the memory
 * table's importance model IS the kind weight (decision > fact >
 * preference > note), resolved server-side at digest/search time. */
export interface UpdateProjectMemoryPatch {
  content?: string;
  kind?: ProjectMemory["kind"];
}

export async function updateProjectMemory(
  projectId: string,
  memoryId: string,
  patch: UpdateProjectMemoryPatch,
): Promise<ProjectMemory> {
  const body = await request<{ memory: ProjectMemory }>(
    `/projects/${projectId}/memory/${memoryId}`,
    { method: "PUT", json: patch },
  );
  return body.memory;
}

/** ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap): the sub-agent model as
 * a PROVIDER-SCOPED reference. Reads are always normalized to this shape (a
 * legacy bare-string value reads as openrouter-scoped); null = inherit the
 * parent agent's model. */
export interface SubagentModelRef {
  providerId: string;
  modelId: string;
}

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
  /** ROUND-43 (R43-5): the temporary sub-agent model override — model id ALL
   * sub-agent children run on, null = inherit the parent's model. The
   * backend has sent it since R43; typed here (ROUND-47 R47-c1) so callers
   * no longer need to widen locally.
   * ROUND-82: provider-scoped (SubagentModelRef) — children route to the
   * ref's provider via the R82 model-override wire. */
  subagentModel: SubagentModelRef | null;
  /** ROUND-52 (R52-b): how often the supervisor samples a running child and
   * emits a heartbeat frame (seconds → ms server-side; 5s–60s). */
  childWatchdogMs: number;
  /** ROUND-52 (R52-b): no child events for this long = STALLED → the
   * supervisor aborts the child and reports honestly to the parent
   * (60s–60min). */
  childStallTimeoutMs: number;
}

export async function fetchOrchestrationSettings(): Promise<OrchestrationSettings> {
  return request<OrchestrationSettings>("/settings/orchestration");
}

/** ROUND-82: the PATCH input — subagentModel accepts the provider-scoped
 * ref or null (the legacy bare-string form still works server-side). */
export interface OrchestrationSettingsPatch
  extends Partial<Omit<OrchestrationSettings, "subagentModel">> {
  subagentModel?: SubagentModelRef | null;
}

export async function updateOrchestrationSettings(
  patch: OrchestrationSettingsPatch,
): Promise<OrchestrationSettings> {
  return request<OrchestrationSettings>("/settings/orchestration", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-82 (R82, §2.4.5): every CONFIGURED model row across all providers
 * (GET /models/configured) — the Sub-agents picker's per-provider section.
 * A NIM/custom row picked here becomes the provider-scoped subagentModel. */
export async function fetchConfiguredModels(): Promise<ProviderModelConfig[]> {
  const body = await request<{ models: ProviderModelConfig[] }>("/models/configured");
  return body.models;
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

/** ROUND-65 (owner directive: debug mode with a settings switch): when on,
 * every main-agent turn's system prompt gains a "## DEBUG MODE (ON)" section
 * — the final answer self-reports the full execution trace (every tool
 * call, outcome, verification). Default off (byte-identical prompts). */
export interface DebugSettings {
  enabled: boolean;
}

export async function fetchDebugSettings(): Promise<DebugSettings> {
  return request<DebugSettings>("/settings/debug");
}

export async function updateDebugSettings(
  patch: Partial<DebugSettings>,
): Promise<DebugSettings> {
  return request<DebugSettings>("/settings/debug", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-78 (R78-C, owner: "General Settings 重试配置" — per-failure-type
 * auto-retry switches): the runtime's retry-ladder gates. When a switch is
 * off, that failure class NEVER enters the ladder — it fails fast
 * (attempts:1) through the honest terminal path with the provider's REAL
 * error text. All default true (the R75 ladder behavior).
 * ROUND-80 (R80, owner: "in the settings retry customization is needed"):
 * the CUSTOMIZABLE schedule joins the object — maxAttempts (2–10, default
 * 6), waitMinutes (rung waits in minutes, default [0, 1.5, 5, 10, 30]),
 * and providerTimeoutSeconds (60–3600, default 600). The agent-core
 * resolveRetrySchedule() turns these into the per-turn ladder; the Settings
 * card edits them. */
export interface RetrySettings {
  autoRetryRateLimit: boolean;
  autoRetryTimeout: boolean;
  autoRetryNetwork: boolean;
  /** R80: total attempts per turn (initial + rungs), 2–10, default 6. */
  maxAttempts: number;
  /** R80: rung waits in minutes (rung i = wait before attempt i+2). */
  waitMinutes: number[];
  /** R80: provider call ceiling in seconds, 60–3600, default 600. */
  providerTimeoutSeconds: number;
}

export async function fetchRetrySettings(): Promise<RetrySettings> {
  return request<RetrySettings>("/settings/retry");
}

export async function updateRetrySettings(
  patch: Partial<RetrySettings>,
): Promise<RetrySettings> {
  return request<RetrySettings>("/settings/retry", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-97 (R97-D, owner: "give the user the option in the settings to turn
 * it on or off. By default it will be turned off so that the model can think
 * as much as it needs to… also give the user the option and flexibility to
 * edit the thinking loop management"): the thinking-loop guard's settings
 * domain — the master switch (DEFAULT OFF) + the two thresholds the streamed
 * adapter's watchdog consults (the conjunction: a stall of stallSeconds
 * with reasoningBytesKB accumulated and NO text/tool/finish progress). */
export interface ThinkingLoopSettings {
  /** The master switch — false by default (the model thinks freely). */
  enabled: boolean;
  /** The no-progress window that arms the watchdog (30–600s, default 120). */
  stallSeconds: number;
  /** The reasoning volume that arms it (8–256 KB, default 24). */
  reasoningBytesKB: number;
}

export async function fetchThinkingLoopSettings(): Promise<ThinkingLoopSettings> {
  return request<ThinkingLoopSettings>("/settings/thinking-loop");
}

export async function updateThinkingLoopSettings(
  patch: Partial<ThinkingLoopSettings>,
): Promise<ThinkingLoopSettings> {
  return request<ThinkingLoopSettings>("/settings/thinking-loop", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-97 (R97-G, owner: "add a dedicated section in the settings for the
 * browser… which I can use to edit some settings of the browsers, manage the
 * browser"): the browser settings domain — the search engine (the address
 * bar's query fallback), the homepage ("acute://home" = the panel's
 * quick-links page), the default zoom for new browser sessions, and the
 * editable quick links.
 * ROUND-99 (R99-A, owner: "ship the browser with the app"): linkOpeningMode
 * — where in-app links open. "in-app" routes them through the central link
 * router into the embedded browser panel (the default: the app ships its
 * own WebView2 Fixed Version engine, so links stay inside it); "system"
 * hands them to the device's default browser. The ONE sanctioned consumer
 * is src/lib/open-link.ts. */
export interface BrowserQuickLink {
  label: string;
  url: string;
}

export type LinkOpeningMode = "in-app" | "system";

export interface BrowserSettings {
  searchEngine: "duckduckgo" | "google" | "bing" | "brave";
  homepage: string;
  defaultZoom: number;
  quickLinks: BrowserQuickLink[];
  linkOpeningMode: LinkOpeningMode;
}

/** R97-G: the engine → search-URL template (the agent-core mirror — the
 * panel's normalizeUrl builds the query fallback from the same table). */
export const SEARCH_ENGINE_TEMPLATES: Record<BrowserSettings["searchEngine"], string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};

export async function fetchBrowserSettings(): Promise<BrowserSettings> {
  return request<BrowserSettings>("/settings/browser");
}

export async function updateBrowserSettings(
  patch: Partial<BrowserSettings>,
): Promise<BrowserSettings> {
  return request<BrowserSettings>("/settings/browser", {
    method: "PUT",
    json: patch,
  });
}

/** ROUND-98 (R98-J, owner: task complete / failed / permission needed →
 * "it will send me a notification on my PC"): the desktop-notification
 * master switch. The Tauri notification bridge (src/lib/desktop-
 * notifications.ts) caches this value in memory so a flip applies to the
 * very next record — the GET/PUT pair here is the durable truth. Default
 * ON (the pre-R98 behavior shipped notifications enabled). */
export interface DesktopNotificationsSettings {
  enabled: boolean;
}

export async function fetchDesktopNotificationsSettings(): Promise<DesktopNotificationsSettings> {
  return request<DesktopNotificationsSettings>("/settings/desktop-notifications");
}

export async function updateDesktopNotificationsSettings(
  patch: Partial<DesktopNotificationsSettings>,
): Promise<DesktopNotificationsSettings> {
  return request<DesktopNotificationsSettings>("/settings/desktop-notifications", {
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
  /** ROUND-92 (R92-D, Task 2-a): how many keys the provider holds in total —
   * the primary (slot 0) plus every held pool slot (1–31), straight from the
   * keyring's pool scan. Optional because the field rides the same wave as
   * the backend's key-juggling work: consumers must default defensively
   * (`p.keyCount ?? (p.hasKey ? 1 : 0)`) until every sidecar serves it. */
  keyCount?: number;
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

/** DELETE /providers/:id → 204 (409 while agents still reference it).
 * R91-A: `force` sends `?force=1` — the server then RESETS every referencing
 * agent to the no-provider state (providerId/model NULL — the composer asks
 * for a model on the next send) and deletes the provider anyway. The owner's
 * v0.88.0 verdict: the OpenRouter delete "was not getting deleted" — the
 * default agent's reference blocked every attempt with a 409 that read as
 * "nothing happened". The settings confirm flow now tells the owner exactly
 * what will be reset BEFORE the click, and sends force. */
export async function deleteProvider(id: string, force = false): Promise<void> {
  await request<void>(`/providers/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, {
    method: "DELETE",
  });
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

// ── ROUND-82 (R82, owner: "a test button … not only check for a response,
//    but also check if the response is reasonable"): the PER-MODEL test. ────

/** The probe's staged checks (POST /models/:id/test) — surfaced individually
 * so the UI can show exactly which stage failed (auth ok, model id
 * rejected, …). */
export interface ModelTestChecks {
  http: boolean;
  auth: boolean;
  modelAccepted: boolean;
  nonEmptyContent: boolean;
}

/** POST /models/:id/test response: a probe that RAN and got a NO arrives as
 * HTTP 200 with ok:false + reason (the provider's raw error body, e.g. an
 * EOL'd NIM function's 410) — only transport failures throw (ApiError 502,
 * or 409 when the provider/key is missing). ok:true carries the reply
 * preview + provider-reported usage. */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  providerId: string;
  model: string;
  checks: ModelTestChecks;
  /** First ≤200 chars of the reply (scrubbed) — the "is the response
   * reasonable" eyeball check. */
  contentPreview?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Present on ok:false — the failing stage's reason. */
  reason?: string;
}

/** Test a CONFIGURED model row (the row id from models-config, `mdl_…`) —
 * a real one-word completion against the row's own provider. `slot` scopes
 * the probe to that key-pool key (the backend 409s when empty). */
export async function testModelConnection(
  modelRowId: string,
  opts?: { slot?: number },
): Promise<ModelTestResult> {
  return request<ModelTestResult>(`/models/${encodeURIComponent(modelRowId)}/test`, {
    method: "POST",
    json: {
      ...(opts?.slot !== undefined ? { slot: opts.slot } : {}),
    },
  });
}

/** DB model-override row from GET /providers/:id/models-config — agent-core's
 * ModelRecord (storage/models.ts) mirrored field-for-field. Pricing fields
 * are USD PER 1 MILLION TOKENS (ROUND-62 R62-2b doc pin: never per-token or
 * per-1k — the usage math divides tokens by 1e6 before multiplying). */
export interface ProviderModelConfig {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** USD per 1M input tokens (null = unknown). */
  inputPricePerMtok: number | null;
  /** USD per 1M cached input tokens (null = no cached tier / unknown). */
  inputPriceCachedPerMtok: number | null;
  /** USD per 1M output tokens (null = unknown). */
  outputPricePerMtok: number | null;
  supportsThinking: boolean;
  /** ROUND-61 (R61): image-input modality — the gate for "main" vision
   * mode (the vision relay uses the turn's model only when this is true).
   * Editable per row like supportsThinking. */
  supportsVision: boolean;
  /** ROUND-82 (R82, owner: the model edit dialog's proper capability
   * options): TRI-STATE — null = unknown (never set, no catalog source —
   * the honest default for NIM/custom rows), false = explicitly off,
   * true = explicitly on. */
  supportsTools: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  /** ROUND-87 (R87): the INPUT/OUTPUT capability columns — same tri-state
   * contract. supportsPdf is the PDF-document INPUT (text is always on;
   * images ride supportsVision, videos ride supportsVideo). The four
   * *_output flags describe what the model PRODUCES. sizeLabel is a
   * human-facing parameter-size string ("70B") — null = unspecified. */
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  sizeLabel: string | null;
  /** ROUND-95 (R95-F, the api-mirror catch-up R95-E flagged): the model's
   * DETECTED reasoning capability (R95-B's ModelReasoningSupport — the
   * sidecar's ModelRecord has carried `reasoningSupport` additively since
   * R95-B, but this frontend mirror lacked the field, forcing Composer to
   * read it through composer-utils' ReasoningAwareModelRow widening).
   * Additive + optional: null/absent = UNKNOWN (never block on it — the
   * thinking-level menu falls back to the global selector). With this
   * field in place, that local widening type can be simplified/removed in
   * a round that owns composer-utils.ts. */
  reasoningSupport?: ModelReasoningSupport | null;
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
 * UNIQUE(provider_id, model_id) constraint makes "add model" an upsert).
 * Pricing fields are USD PER 1M TOKENS (decimals like 0.075 are valid; null
 * clears back to unknown — see ProviderModelConfig). */
export interface ProviderModelConfigInput {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** USD per 1M input tokens. */
  inputPricePerMtok?: number | null;
  /** USD per 1M cached input tokens. */
  inputPriceCachedPerMtok?: number | null;
  /** USD per 1M output tokens. */
  outputPricePerMtok?: number | null;
  supportsThinking?: boolean;
  /** ROUND-61 (R61): mark image-input support on add (prefilled from the
   * catalog's supportsVision when the row comes from GET /models/catalog). */
  supportsVision?: boolean;
  /** ROUND-82 (R82): tri-state on add — boolean sets, null = unknown, absent
   * lets the backend prefill (catalog tools bit for openrouter ids, NULL
   * otherwise). */
  supportsTools?: boolean | null;
  supportsAudio?: boolean | null;
  supportsVideo?: boolean | null;
  /** ROUND-87 (R87): the input/output capability columns on add — same
   * tri-state contract (absent lets the backend default: text output ON,
   * the rest unknown). sizeLabel is a display string (null = unspecified). */
  supportsPdf?: boolean | null;
  supportsTextOutput?: boolean | null;
  supportsImageOutput?: boolean | null;
  supportsVideoOutput?: boolean | null;
  supportsAudioOutput?: boolean | null;
  sizeLabel?: string | null;
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

/** PATCH /models/:id payload — any editable subset (null clears a field).
 * Pricing fields are USD PER 1M TOKENS, same contract as the POST above. */
export interface ProviderModelConfigPatch {
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** USD per 1M input tokens (null = unknown). */
  inputPricePerMtok?: number | null;
  /** USD per 1M cached input tokens (null = unknown). */
  inputPriceCachedPerMtok?: number | null;
  /** USD per 1M output tokens (null = unknown). */
  outputPricePerMtok?: number | null;
  supportsThinking?: boolean;
  /** ROUND-61 (R61): flip the vision flag on a stored row. */
  supportsVision?: boolean;
  /** ROUND-82 (R82): tri-state PATCH — boolean sets, null clears to
   * unknown, absent keeps. */
  supportsTools?: boolean | null;
  supportsAudio?: boolean | null;
  supportsVideo?: boolean | null;
  /** ROUND-87 (R87): the input/output capability columns on PATCH — same
   * tri-state contract; sizeLabel null clears the label. */
  supportsPdf?: boolean | null;
  supportsTextOutput?: boolean | null;
  supportsImageOutput?: boolean | null;
  supportsVideoOutput?: boolean | null;
  supportsAudioOutput?: boolean | null;
  sizeLabel?: string | null;
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
  /** ROUND-52 (R52-a, owner: "After running the commands, it should actually
   * show the terminal interface of those commands too"): live terminal
   * output of a RUNNING tool call (run_command) — batched stdout+stderr
   * chunks streaming while the command executes. Renders as a live tail in
   * the working section / sub-agent panel. */
  | {
      type: "tool-output";
      sessionId?: string;
      toolName: string;
      argsSummary?: string;
      chunk: string;
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
  /** ROUND-58 (R58-cf): the model started generating a tool call's JSON
   * arguments — the client accumulates the following tool-input-delta
   * fragments per toolCallId to render a LIVE write preview (path +
   * content-so-far) while write_file/edit_file args stream. */
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  /** ROUND-58 (R58-cf): one text chunk of a tool call's JSON args —
   * concatenated per toolCallId (e.g. for write_file the raw grows like
   * `{"path":"a.txt","content":"<!DOCTYPE…`). The final tool-call frame (with
   * the completed argsSummary, NO toolCallId) ends the accumulation. */
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean; outputSummary?: string }
  /** ROUND-52 (R52-a): live terminal output of a running tool call — the
   * child's run_command streaming its output live inside the envelope. */
  | { type: "tool-output"; toolName: string; argsSummary?: string; chunk: string }
  /** Round-32: the outer loop starts a new iteration — the live activity
   * block opens a new ROUND group on this event. */
  | { type: "meta.continuation"; iteration: number; reason?: string }
  /** ROUND-75 (R75): the transient-API retry ladder — the backend caught a
   * rate_limit / network / timeout failure and will retry attempt N of 6
   * after waiting `remainingMs` (the immediate rung is 0). Re-emitted as a
   * heartbeat every RETRY_TICK_MS with the refreshed remaining time; any
   * content frame (text-delta / tool-call / finish…) means the retry
   * SUCCEEDED and the status clears. A terminal error frame after the
   * ladder exhausted carries attempts=6.
   * ROUND-78 (R78-A, owner: only a REAL rate limit may show as one — every
   * other failure shows the API's ACTUAL error text): `providerError` rides
   * the frame additively — the scrubbed REAL provider text (the R78-A
   * classifier's unwrap), so the LIVE RetryStatusCard can render what the
   * API actually said instead of the generic class one-liner. Optional:
   * pre-R78 sidecars never send it (the card keeps the class message). */
  | {
      type: "meta.retry";
      attempt: number;
      totalAttempts: number;
      waitMs: number;
      remainingMs: number;
      retryAt: number;
      errorClass: string;
      classMessage: string;
      message: string;
      providerError?: string;
    }
  /** ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — send while the agent
   * works): the user queued a message on a LIVE turn (POST
   * /sessions/:id/queue) — the chip appears IMMEDIATELY (before the
   * persisted message.queued event could ride a refetch). Attachments ride
   * the frame the same MessageAttachment shape the send routes accept. */
  | { type: "user.queued"; seq: number; content: string; ts: string; attachments?: MessageAttachment[] }
  /** ROUND-78 (R78-D): a queued message was DELIVERED into the model-facing
   * history (the event row flipped to message.user in place) — the chip
   * becomes an ordinary user bubble. The frame carries the content + ts so
   * the store can render the bubble without waiting for the refetch. */
  | { type: "queued.delivered"; seq: number; content: string; ts: string }
  /** ROUND-78 (R78-D): the turn ended with queued messages remaining and the
   * SAME SSE stream continues on the first one (the rest ride iteration 0).
   * Informational today — the store types it but takes no action (the
   * delivered/flipped events own the render); reserved for a future
   * "continuing with your queued message" status line. */
  | {
      type: "meta.queue_continue";
      count: number;
      /** R93-B2: this continuation is the automatic RECOVERY after a
       * transient (network/timeout) failure — the UI can say "resuming
       * with your queued message" instead of the plain "continuing". */
      recovery?: boolean;
    }
  /** ROUND-92 (R92-D): the key-pool JUGGLING frame — a key-attributable
   * failure (auth: the key was rejected; rate_limit: that key's quota is
   * spent) swapped the turn onto the next untried key of the provider's
   * pool and the SAME call retries immediately (no ladder wait — a fresh
   * key has fresh quota). Rendered as a transient status note (the
   * overflow-recovery pattern); any content frame clears it. Carries pool
   * INDEXES and the reason only — never a key value. */
  | {
      type: "meta.key";
      key: { attempt: number; totalKeys: number; reason: string };
      message: string;
    }
  /** ROUND-75 (R75): the R71 overflow-recovery line, finally typed — a
   * context overflow was auto-compacted and the turn is retrying (rendered
   * as a transient status note, not an error). */
  | { type: "meta.overflow_recovery"; message: string }
  /** ROUND-83 (R83): a compaction landed THIS turn — the older context was
   * summarized into a dense briefing (the model now receives summary + tail;
   * the meter's messages estimate drops with it). The store renders the
   * honest status line + invalidates the context meter. */
  | { type: "meta.compaction"; tokensSaved: number; droppedMessages: number; throughSeq: number }
  /** ROUND-80 (R80): the context/request guard frames — typed for
   * completeness; they ride the stream right before the terminal error
   * frame. ROUND-83 (R83): the context_limit frame now ALSO renders as the
   * live turn's terminal note (the store's honest line); the persisted
   * turn.error + the error card still own the durable render. Pre-R80
   * these frames arrived untyped and unrendered while the turn ended
   * ok:true — the silent stop the round fixes at the runtime layer. */
  | { type: "meta.context_limit"; tokens: number; limit: number }
  | { type: "meta.request_limit"; requests: number; limit: number }
  /** ROUND-80 (R80): the loop-cap frame (maxOuterLoops reached) — same
   * treatment: informational, no store action, the turn's own terminal
   * frame follows. */
  | { type: "meta.continuation_complete"; iterations: number }
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
      /** ROUND-79 (R79-b): the delegation address (sessions.delegate_task_id)
       * when the child is addressable — the same value as SubAgentStatus
       * .taskId, joined from the FIRST (queued) frame onward so the panel's
       * task chip renders before the first poll. Absent on unaddressed
       * children (pre-R79 frames unchanged). */
      taskId?: string;
      todosDone?: number;
      todosTotal?: number;
      /** ROUND-50 (R50-b): the model the child actually runs on
       * (orchestration.subagentModel ?? agent.model, resolved at delegation
       * time) — the live stats footer's model line before the polled row's
       * usage-derived `model` lands. */
      model?: string;
      /** ROUND-52 (R52-b): the supervisor's heartbeat sample (running frames
       * only) — live "what is this sub-agent doing" stats. */
      watch?: {
        lastEventAgeMs: number;
        lastActivity: string;
        toolCount: number;
        todosDone: number;
        todosTotal: number;
        elapsedMs: number;
        stalled: boolean;
      };
      /** ROUND-52 (R52-b): WHY a terminal frame fired — "stopped by the
       * owner", "stalled — no activity for Ns", … — shown on the card. */
      detail?: string;
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
  | {
      type: "done";
      assistantMessage: AssistantMessage;
      usage: UsageRecord;
      /** R93-B1: the honest cap-break — N messages are STILL queued after
       * the continuation cap was reached (they stay queued server-side and
       * pre-flip on the next send). The UI renders the kept notice. */
      queuedKept?: number;
    }
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
  | { type: "stopped" }
  /** ROUND-61 (R61): the computer-use monitor feed. Every computer-use tool
   * execution emits one frame at dispatch time (kind: observation | action |
   * refusal | vision | session_start | session_stop; tool names the call;
   * code carries the refusal's error code). The right-sidebar Computer panel
   * + the floating mini window render from these live frames. */
  | {
      type: "computer-use";
      kind: string;
      tool?: string;
      code?: string;
      [extra: string]: unknown;
    }
  /** ROUND-62 (R62/D8): the live browser-command bridge — the browser_control
   * tool's eval / screenshot actions send a command to THIS app (the only
   * place the native webview lives); the agent-browser-bridge executes it and
   * POSTs the result to /browser-commands/:commandId/result, which resolves
   * the pending tool promise in agent-core. */
  | {
      type: "browser-command";
      commandId: string;
      tabId: string;
      action: string;
      payload?: Record<string, unknown>;
      [extra: string]: unknown;
    }
  /** ROUND-66 (R66, A5): the browser_control set_viewport action applied a
   * display-size change server-side — emitted IMMEDIATELY (before the 4s
   * poll) so the mounted BrowserPanel applies it live instead of waiting
   * for the poll (the owner's "had to nudge a number" bug: the panel's
   * natural-mode gate swallowed agent presets). Turn-independent (rides
   * before the liveTurn guard in stream-store, like computer-use frames). */
  | {
      type: "browser-viewport";
      sessionId: string;
      tabId: string;
      viewport: BrowserViewportFrame;
    }
  /** ROUND-67 (R67, E1): the browser_control navigate/back/forward/reload
   * action recorded a navigation server-side — emitted IMMEDIATELY so the
   * panel loads the URL (creating the native webview when needed) instead
   * of waiting for the 4s poll. The owner's blank-panel bug: the poll's
   * adopt-without-create left a fresh tab empty until a manual address-bar
   * Enter. Turn-independent (rides before the liveTurn guard). */
  | {
      type: "browser-navigate";
      sessionId: string;
      tabId: string;
      url: string;
    }
  /** ROUND-67 (R67, E3): the browser_control tool minted THIS chat session's
   * agent browser tab (ag-<chatSession>) — the sidebar opens a real tab
   * whose id IS the sidecar session id, so the panel, the command bridge
   * and the history all align on one id. `url` may be null (tab opens
   * empty; the navigate action follows). Turn-independent. */
  | {
      type: "browser-open";
      sessionId: string;
      tabId: string;
      chatSessionId: string;
      url: string | null;
    }
  /** ROUND-67 (R67/D), ROUND-68 (R68-A): the agent captured a screenshot
   * (computer-use screenshot / zoom / get_app_state includeScreenshot, or
   * the browser_control screenshot action) and the bytes are now fetchable
   * at GET /computer-use/frames/:frameId/raster (an EPHEMERAL in-memory
   * raster — LRU 12, 10-minute TTL; never persisted, never model-facing).
   * The sideband fires DURING tool execution, and the chat now renders the
   * shot INLINE at its capture moment (the owner: "When the screenshots
   * were taken they should be shown at that specific time") — the frame
   * becomes a `screenshot` WorkingEntry pushed onto the OPEN liveTurn's
   * working array, landing right after the in-flight tool row. Turn-scoped
   * on the frontend (rasters belong to the turn that captured them). */
  | {
      type: "screenshot";
      sessionId: string;
      frameId: string;
      tool: string;
      note?: string;
    }
  /** ROUND-66 (R66, A4): the browser_control wait_for_verification action
   * opened a human-verification checkpoint — the page hit a bot wall
   * (captcha / Cloudflare challenge / age gate). The chat renders the
   * checkpoint card (live countdown + Mark as done + Stop waiting); the
   * owner's answer POSTs to /browser-checkpoints/:id/resolve, which
   * resolves the tool's pending promise. */
  | {
      type: "browser-checkpoint";
      sessionId: string;
      checkpointId: string;
      tabId: string;
      kind: BrowserCheckpointKind;
      url: string;
      waitMs: number;
    }
  /** ROUND-66 (R66, A4): the checkpoint settled — "done" (owner marked it
   * solved), "stop" (owner stopped waiting), "timeout" (the wait ran
   * out). The card collapses to its one-line resolution. */
  | {
      type: "browser-checkpoint.resolved";
      sessionId: string;
      checkpointId: string;
      resolution: "done" | "stop" | "timeout";
    }
  /** ROUND-87 (R87): the ask_user tool opened an interactive question —
   * the chat renders the question card(s) (option pills + custom input per
   * question); the owner's answers POST to /agent-questions/:id/resolve,
   * which resolves the tool's pending promise and settles the turn. */
  | {
      type: "agent-question";
      sessionId: string;
      questionId: string;
      questions: AgentQuestionPrompt[];
    }
  /** ROUND-87 (R87): the ask settled — "answered" (the owner answered;
   * answers/sources aligned per question), "timeout" (10 minutes),
   * "cancelled" (the turn was stopped). The card collapses to its
   * answered state. */
  | {
      type: "agent-question.resolved";
      sessionId: string;
      questionId: string;
      resolution: "answered" | "timeout" | "cancelled";
      answers?: string[];
      sources?: Array<"option" | "custom">;
    }
  /** ROUND-87 (R87): the todo_write tool's live snapshot — one frame per
   * write; the chat's todo card upserts in place (latest state).
   * R88: the frame carries `source` — "user" when the write came from the
   * floating widget's manual-edit route (the live stream + the widget both
   * badge owner edits); agent writes stay unmarked (pre-R88 compat). */
  | { type: "todo-updated"; sessionId: string; todos: TodoSnapshot["todos"]; source?: "agent" | "user" }
  /** ROUND-66 (R66, C1): debug mode — the turn COMPLETED; the separate
   * context-free debug analyst is now starting. The chat swaps the
   * loading shimmer in under the turn's final answer. */
  | { type: "debug-start"; sessionId: string }
  /** ROUND-66 (R66, C1): one streamed fragment of the analyst's report. */
  | { type: "debug-delta"; sessionId: string; delta: string }
  /** ROUND-66 (R66, C1): the analyst finished — content is the full report
   * (already persisted as a debug.report session event; the folded turn
   * renders it from the refetch, so follow-up turns never include it). */
  | { type: "debug-done"; sessionId: string; content: string; model?: string }
  /** ROUND-66 (R66, C1): the analyst itself failed (provider error) — the
   * turn's own answer is untouched; the debug card shows the honest error. */
  | { type: "debug-error"; sessionId: string; message: string };

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
    /** ROUND-82 (R82, the owner's custom-provider routing fix): the provider
     * the model was picked under (the composer's provider-grouped picker).
     * Absent → the agent's provider, exactly the pre-R82 behavior. */
    providerId?: string;
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
      ...(options?.providerId ? { providerId: options.providerId } : {}),
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
    // ROUND-77 (R77, owner: "show the actual error messages too, which were
    // returned from the API"): preserve the envelope's REAL code + details
    // (providerError / errorClass / classMessage / attempts when present).
    // The old shape hardcoded code: "PROVIDER_ERROR" and dropped details,
    // so a 409 PROVIDER_DISABLED / 400 VALIDATION / 401 UNAUTHORIZED
    // surfaced with the wrong class and no context.
    let message = `sidecar answered HTTP ${res.status}`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      if (body.error?.message) message = body.error.message;
      if (typeof body.error?.code === "string") code = body.error.code;
      if (body.error?.details !== null && typeof body.error?.details === "object") {
        details = body.error.details;
      }
    } catch {
      /* keep the status text */
    }
    onEvent({
      type: "error",
      status: res.status,
      code: code ?? (res.status === 401 ? "UNAUTHORIZED" : "PROVIDER_ERROR"),
      message,
      ...(details !== undefined ? { details } : {}),
    });
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
  // ROUND-58 (R58-cf): an exception out of the read loop (AbortError-like or
  // otherwise) PROPAGATES — it never reaches the synthesis below. When the
  // LOCAL controller was aborted (the deliberate user stop), some fetch
  // implementations end the body "cleanly" (done === true, no throw) instead
  // of rejecting; in that case the signal's aborted flag is the only witness
  // — synthesizing STREAM_DISCONNECTED there is a LIE (the server's
  // {type:"stopped"} frame simply can no longer arrive after the local
  // teardown), and the store's catch must classify the stop as a stop.
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
    if (options?.signal?.aborted === true) {
      // The local AbortController fired (deliberate user stop grace-abort):
      // the connection teardown is the CAUSE, not a sidecar crash. No
      // synthesized error frame — the caller's catch classifies it.
      return;
    }
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

/** ROUND-78 (R78-D) queue result: the persisted message.queued event's seq —
 * the chip's identity (the user.queued frame + the fold + this optimistic
 * return all join on it). */
export interface QueueMessageResult {
  ok: boolean;
  seq: number;
}

/**
 * ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — while the agent is
 * responding/running tools the user can still send): queue a message on the
 * session's LIVE turn. The sidecar validates like the send routes, requires
 * a registered live turn, appends a `message.queued` event, and notifies the
 * running stream (the user.queued frame renders the chip immediately).
 *
 * The 409 NO_LIVE_TURN rejection surfaces as a catchable ApiError with
 * `.code === "NO_LIVE_TURN"` — the caller (runTurn) falls through to a
 * NORMAL send in that case (the turn just ended between the Enter and this
 * POST; the queue POST and the turn-end race are benign).
 */
export async function queueSessionMessage(
  sessionId: string,
  input: {
    content: string;
    attachments?: MessageAttachment[];
    /** ROUND-82 (R82): the picker state at queue time — the queued
     * follow-up's own model/provider (the continuation turn routes to
     * this provider instead of falling back to the agent default). */
    model?: string;
    providerId?: string;
  },
): Promise<QueueMessageResult> {
  return request<QueueMessageResult>(`/sessions/${sessionId}/queue`, {
    method: "POST",
    json: input,
  });
}

/**
 * ROUND-78 (R78-D): remove a NOT-YET-DELIVERED queued message (the chip's X
 * button / the "Send now" path's dequeue half — the message never reaches
 * the model's history). 404s when the event is absent or already delivered
 * (flipped to message.user) — callers treat that as "already gone", never
 * fatal.
 */
export async function dequeueSessionMessage(sessionId: string, seq: number): Promise<void> {
  await request<void>(`/sessions/${sessionId}/queue/${seq}`, {
    method: "DELETE",
  });
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

// ---------------------------------------------------------------------------
// ROUND-59 (R59-E): diagnostics — the engine's error ring
// ---------------------------------------------------------------------------

/**
 * One row of the sidecar's diagnostics error ring (GET /diagnostics/errors).
 * The ConsolePanel merges these with the frontend error-bus snapshot into a
 * single newest-first list. Field-for-field the server's SidecarDiagnosticError
 * (agent-core/src/server.ts) — scrubbed at capture time (no bodies, no auth
 * headers, no query strings ever leave the engine through this route).
 */
export interface DiagnosticError {
  id: string;
  /** ISO timestamp of the failure. */
  ts: string;
  source: "sidecar";
  /** Capture point — "http" (fastify error handler) today. */
  kind: string;
  /** Always ≥ 500 (the 4xx-exclusion decision — client noise stays out). */
  statusCode: number;
  /** Envelope/error code (INTERNAL, PROVIDER_ERROR, …). */
  code: string;
  /** Scrubbed error message. */
  message: string;
  /** HTTP method of the failing request. */
  method: string;
  /** Request path (query string stripped server-side). */
  url: string;
  /** Frontend-parity count field — the server ring keeps 1 per row. */
  count: number;
}

/**
 * ROUND-59 (R59-E): the engine's captured errors, newest-first. Polled by the
 * right-sidebar Console tab every 5s and merged with the frontend bus.
 * `limit` bounds the page (server caps at 200).
 */
export async function listDiagnosticErrors(limit?: number): Promise<DiagnosticError[]> {
  const path = limit === undefined ? "/diagnostics/errors" : `/diagnostics/errors?limit=${limit}`;
  const body = await request<{ errors: DiagnosticError[] }>(path);
  return body.errors;
}

/** ROUND-59 (R59-E): clear the engine's error ring (the Console's Clear all —
 * paired with the frontend bus's clearAll()). */
export async function clearDiagnosticErrors(): Promise<void> {
  await request<{ ok: boolean }>("/diagnostics/errors", { method: "DELETE" });
}

/* ══════════════════════════════════════════════════════════════════════════
 * ROUND-61 (R61): COMPUTER USE + SKILLS + MCP SERVERS + PLUGINS — the
 * owner's extensibility directive. Types mirror the sidecar's storage
 * shapes (storage/computer-use.ts, storage/skills.ts, storage/mcp.ts).
 * ══════════════════════════════════════════════════════════════════════════ */

/** The host policy posture (storage/computer-use.ts). */
export type ComputerUsePosture = "observe" | "act" | "auto";
/** The vision-model separation mode (ROUND-66: the settings moved to their
 * own GET/PUT /vision/settings — see VisionSettings below; this alias stays
 * for the vision-key helpers' shared typing). */
export type ComputerVisionMode = "off" | "separate" | "main";

export interface ComputerUseSettings {
  enabled: boolean;
  permission: ComputerUsePosture;
}

export interface ComputerUseConfigResponse {
  settings: ComputerUseSettings;
  platform: string;
  capabilities: Record<string, boolean>;
}

/** GET /computer-use/config — settings + the detected backend + capabilities. */
export async function fetchComputerUseConfig(): Promise<ComputerUseConfigResponse> {
  return request<ComputerUseConfigResponse>("/computer-use/config");
}

/** PUT /computer-use/config — partial patch (enabled/permission; vision
 * settings moved to PUT /vision/settings in ROUND-66), returns the full
 * settings. */
export async function updateComputerUseConfig(
  patch: Partial<Pick<ComputerUseSettings, "enabled" | "permission">>,
): Promise<ComputerUseSettings> {
  const body = await request<{ settings: ComputerUseSettings }>("/computer-use/config", {
    method: "PUT",
    json: patch,
  });
  return body.settings;
}

/** One monitor-ring event from the control session (computer/session.ts). */
export interface ComputerUseEventRow {
  seq: number;
  ts: number;
  kind: string;
  label: string;
  tool?: string;
  detail?: Record<string, unknown>;
}

export interface ComputerUseSessionState {
  active: boolean;
  killSwitch: boolean;
  backendKind: string;
  startedAt: number | null;
  stopReason: string | null;
  stats: {
    startedAt: number;
    actionsSent: number;
    actionsRefused: number;
    observations: number;
    visionCalls: number;
  };
  events: ComputerUseEventRow[];
}

/** GET /computer-use/session — the monitor ring (newest-first) + stats. */
export async function fetchComputerUseSession(): Promise<ComputerUseSessionState> {
  return request<ComputerUseSessionState>("/computer-use/session");
}

/**
 * ROUND-67 (R67/D), ROUND-68 (R68-A): GET /computer-use/frames/:frameId/raster
 * — the PNG bytes of a frame captured this sidecar lifetime, as a Blob (the
 * INLINE screenshot row's lazy fetch, one per `screenshot` WorkingEntry).
 * BINARY (the shared request() helper is JSON-only), so this carries its own
 * Authorization header like the SSE fetch + browserRequest do. Throws
 * ApiError on a non-OK reply — a 404 (TTL/LRU eviction) is the caller's
 * "expired tile" signal, not a crash; a 0-status network miss surfaces the
 * same honest way.
 */
export async function fetchComputerFrameRaster(frameId: string): Promise<Blob> {
  const { baseUrl, token } = useConfigStore.getState();
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl}/api/v1/computer-use/frames/${encodeURIComponent(frameId)}/raster`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK",
      `Could not reach agent-core at ${baseUrl} (${String(cause)})`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const envelope = parseEnvelope(body);
    throw new ApiError(
      res.status,
      envelope?.code ?? "UNKNOWN",
      envelope?.message ?? `Frame raster fetch failed with HTTP ${res.status}`,
    );
  }
  return res.blob();
}

/**
 * ROUND-62 (D8): POST /browser-commands/:commandId/result — the agent-browser
 * bridge's answer channel. The browser_control tool (agent-core) sends a
 * live command through the turn's SSE stream; this app executes it (eval in
 * the native webview / the panel's screenshot geometry) and posts the result
 * here, resolving the tool's pending promise. Fire-and-forget from the UI's
 * perspective — a 404 (expired command) is fine.
 */
export async function postBrowserCommandResult(
  commandId: string,
  result: { ok: boolean; data?: unknown; error?: string },
): Promise<void> {
  await request(`/browser-commands/${encodeURIComponent(commandId)}/result`, {
    method: "POST",
    json: result,
  });
}

/** POST /computer-use/stop — the UI kill switch (STOP button). */
export async function stopComputerUse(reason?: string): Promise<{ ok: boolean; reason: string }> {
  return request<{ ok: boolean; reason: string }>("/computer-use/stop", {
    method: "POST",
    json: reason ? { reason } : {},
  });
}

/** POST /computer-use/test — readiness probe (permissions + capabilities;
 * never pops dialogs). */
export async function testComputerUse(): Promise<{
  report: { ok: boolean; issues?: string[]; [extra: string]: unknown };
  capabilities: Record<string, boolean>;
  platform: string;
}> {
  return request("/computer-use/test", { method: "POST", json: {} });
}

/** GET /computer-use/vision-key?providerId=… — hasKey + masked (never the value). */
export async function fetchVisionKey(providerId: string): Promise<{
  providerId: string;
  hasKey: boolean;
  masked: string | null;
}> {
  return request<{ providerId: string; hasKey: boolean; masked: string | null }>(
    `/computer-use/vision-key?providerId=${encodeURIComponent(providerId)}`,
  );
}

/** PUT /computer-use/vision-key — paste the dedicated vision key (web-mode;
 * the packaged app writes the durable credential via Tauri store_provider_key). */
export async function setVisionKey(providerId: string, value: string): Promise<void> {
  await request("/computer-use/vision-key", {
    method: "PUT",
    json: { providerId, value },
  });
}

/** DELETE /computer-use/vision-key — clear the slot. */
export async function clearVisionKey(providerId: string): Promise<void> {
  await request(`/computer-use/vision-key?providerId=${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

/** ROUND-66 (R66, A4): the bot-wall classes the browser backend detects
 * (browser-checkpoint.ts detectVerificationWall) and surfaces in chat. */
export type BrowserCheckpointKind = "captcha" | "cloudflare" | "age" | "verification";

/** ROUND-66 (R66, A5): the display-size state as the instant-apply frame
 * carries it (the browser-proxy BrowserViewportState shape). */
export interface BrowserViewportFrame {
  width: number;
  height: number;
  preset: string;
  zoom: number;
  rotate: boolean;
}

/**
 * ROUND-66 (R66, A4): POST /browser-checkpoints/:checkpointId/resolve — the
 * checkpoint card's answer channel. "done" = the owner solved the wall
 * (the tool re-probes the page and continues); "stop" = stop waiting (the
 * tool returns immediately with the honest stopped result). Unknown/expired
 * ids answer {ok:false} — the card then falls back to its timeout path.
 */
export async function resolveBrowserCheckpoint(
  checkpointId: string,
  action: "done" | "stop",
): Promise<{ ok: boolean; resolution: "done" | "stop" | "timeout" }> {
  return request(`/browser-checkpoints/${encodeURIComponent(checkpointId)}/resolve`, {
    method: "POST",
    json: { action },
  });
}

/* ── ROUND-87 (R87): the mid-task interactive agent question (ask_user) ── */

/** One question the agent asks: option pills + an optional custom-text
 * answer (allowCustom defaults true). Mirrors agent-question.ts's
 * AgentQuestion. */
export interface AgentQuestionPrompt {
  question: string;
  options?: string[];
  allowCustom?: boolean;
  placeholder?: string;
}

/** Answer a pending ask — one answer per question, in order. sources
 * records option-pick vs custom-typed per answer ("option" | "custom"). */
export async function resolveAgentQuestion(
  questionId: string,
  answers: string[],
  sources?: Array<"option" | "custom">,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/agent-questions/${encodeURIComponent(questionId)}/resolve`, {
    method: "POST",
    json: { answers, ...(sources !== undefined ? { sources } : {}) },
  });
}

/* ── ROUND-88 (R88): the floating to-do widget's manual edit (POST
 * /sessions/:id/todo) ── */

/** The widget's edit payload — the FULL list snapshot (idempotent, the
 * todo_write contract). An empty array is the owner's CLEAR affordance. */
export async function saveSessionTodo(
  sessionId: string,
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>,
): Promise<{ ok: boolean; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }> {
  return request<{
    ok: boolean;
    todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  }>(`/sessions/${encodeURIComponent(sessionId)}/todo`, {
    method: "POST",
    json: { todos },
  });
}

/* ── ROUND-87 (R87): the application-wide reset (POST /system/reset) ── */

export interface SystemResetResult {
  ok: boolean;
  abortedTurns: number;
  wipedTables: number;
  purgedFiles: number;
}

/** Wipe EVERYTHING server-side: projects, sessions, agents, providers,
 * models, memory, settings — then reseed the factory state. The webview
 * clears its own localStorage + query cache after this resolves and
 * reloads (the About tab's reset flow). */
export async function resetApplication(): Promise<SystemResetResult> {
  return request<SystemResetResult>("/system/reset", { method: "POST" });
}

/* ── ROUND-89 (R89-A2): the server-side update check (GET /system/updates) ──
 * The repo is PRIVATE — the webview's anonymous api.github.com fetch answered
 * 404 (the owner's verdict). The sidecar runs the check with the launcher's
 * saved token; the PAT never crosses this boundary. */
export interface SystemUpdateCheck {
  current: string;
  releasesUrl: string;
  ok: boolean;
  /** Only meaningful when ok === true: */
  latest?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  /** R99-C: the release's NOTES body (markdown, capped at 8,000 chars +
   * an honest truncation marker by the route; "" for a tag-only release) —
   * feeds the About tab's "What's new" block. */
  body?: string;
  /** R91-E: the release's x64 setup.exe asset (present when the release has
   * one) — feeds the in-app "Update now" download. */
  asset?: { url: string; size: number; digest: string | null };
  /** Only meaningful when ok === false: */
  reason?: string;
  error?: string;
}

export async function fetchSystemUpdates(): Promise<SystemUpdateCheck> {
  return request<SystemUpdateCheck>("/system/updates");
}

/** R91-E: the in-app update download's LIVE state (single-flight, polled). */
export interface SystemUpdateDownload {
  status: "idle" | "downloading" | "verifying" | "ready" | "error";
  received: number;
  total: number;
  path: string | null;
  version: string | null;
  error: string | null;
}

/** R91-E: start streaming the update installer to the sidecar's temp dir
 * (sha256-verified against the release digest when present). Poll
 * fetchUpdateDownloadProgress for the live state. */
export async function startUpdateDownload(body: {
  url: string;
  digest?: string | null;
  version?: string;
}): Promise<{ ok: boolean; status: string; alreadyRunning?: boolean }> {
  return request("/system/updates/download", { method: "POST", json: body });
}

/** R91-E: the live update-download state (the About tab's progress bar). */
export async function fetchUpdateDownloadProgress(): Promise<SystemUpdateDownload> {
  return request<SystemUpdateDownload>("/system/updates/download/progress");
}

/* ── ROUND-66 (R66, B3/B5): the DEDICATED image-analysis (vision) settings ── */

/** The global vision configuration (moved OUT of computer use per the
 * owner's directive — Settings → Image Analysis). Same mode semantics as
 * the R61 computer-use vision block, now app-wide: every image analysis
 * (computer-use screenshots, browser screenshots, the analyze_image tool)
 * reads THIS. */
export interface VisionSettings {
  mode: "off" | "separate" | "main";
  provider: string | null;
  modelId: string | null;
}

/** GET /vision/settings — the dedicated image-analysis configuration. */
export async function fetchVisionSettings(): Promise<VisionSettings> {
  return request<VisionSettings>("/vision/settings");
}

/** PUT /vision/settings — partial patch (mode / provider / modelId). */
export async function updateVisionSettings(
  patch: Partial<Pick<VisionSettings, "mode" | "provider" | "modelId">>,
): Promise<VisionSettings> {
  return request<VisionSettings>("/vision/settings", { method: "PUT", json: patch });
}

/* ── Skills (the owner's "multiple skills") ───────────────────────────────── */

/**
 * One skill row as served by GET /skills — the MERGED listing (agent-core
 * storage/skills-files.ts MergedSkillRecord): DB rows (builtin/user, the
 * editable source of truth) + file skills (`project-file`/`global-file`,
 * provenance-marked and read-only in the app — PATCH /skills/:id refuses
 * their synthetic ids with a 409).
 */
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "builtin" | "user" | "project-file" | "global-file";
  enabled: boolean;
  /**
   * ROUND-98 (R98-E2): the ALWAYS-LOAD tier — `true` means the skill's FULL
   * body rides every turn's system prompt (the ALWAYS-ON SKILLS section,
   * 24K total budget) instead of loading on demand via read_skill. DB rows
   * PATCH it (updateSkill {alwaysLoad}); file rows read it from the SKILL.md
   * frontmatter and are read-only. Optional so pre-R98 fixtures/tests keep
   * compiling — the live sidecar sends it on every row.
   */
  alwaysLoad?: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** File skills only — the SKILL.md path (the app refuses edits; edit it). */
  filePath?: string;
  /** Project-file skills only — disambiguates same names across projects. */
  projectName?: string;
}

export async function listSkills(): Promise<SkillRecord[]> {
  const body = await request<{ skills: SkillRecord[] }>("/skills");
  return body.skills;
}

export async function createSkill(input: {
  name: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  /** R98-E2: create straight into the always-load tier (default false). */
  alwaysLoad?: boolean;
}): Promise<SkillRecord> {
  return request<SkillRecord>("/skills", { method: "POST", json: input });
}

export async function updateSkill(
  id: string,
  patch: {
    name?: string;
    description?: string;
    body?: string;
    enabled?: boolean;
    /** R98-E2: the Settings tab's Always load switch PATCHes this. */
    alwaysLoad?: boolean;
    sortOrder?: number;
  },
): Promise<SkillRecord> {
  return request<SkillRecord>(`/skills/${id}`, { method: "PATCH", json: patch });
}

export async function deleteSkill(id: string): Promise<void> {
  await request(`/skills/${id}`, { method: "DELETE" });
}

/* ── Prompt section overrides (ROUND-98 R98-E1) ───────────────────────────── */

/** Which context-meter bucket a prompt section belongs to (the §2 identity
 * chip grammar carries it in the Settings list). */
export type PromptSectionBucket = "identity" | "tools" | "memory" | "meta";

/**
 * One registry entry as served by GET /prompts/sections (routes/prompts.ts):
 * describePromptSections' PromptSectionInfo PLUS the editor's two payloads —
 * `overrideContent` (the raw `.acute/prompts/<id>.md` file text, null when
 * none exists) and `defaultText` (the built-in composition for THIS ctx,
 * null when the section is absent here — conditional sections report
 * honestly). `present` is post-override: an empty override file makes a
 * present section absent (the DROP semantics).
 */
export interface PromptSectionView {
  id: string;
  description: string;
  dynamic: boolean;
  bucket: PromptSectionBucket;
  present: boolean;
  overridden: boolean;
  overrideContent: string | null;
  defaultText: string | null;
}

/** GET /prompts/sections?projectRoot= — the registry picture for one project. */
export interface PromptSectionsReport {
  rootPath: string;
  sections: PromptSectionView[];
  /** Ids carrying override files. */
  overridden: string[];
  /** Section order of the EFFECTIVE composition (post-override + reorder). */
  effectiveOrder: string[];
  /** Human-readable override diagnostics (reorder files, empty drops…). */
  diagnostics: string[];
}

/** GET /prompts/sections — the list + each section's override/default text. */
export async function fetchPromptSections(projectRoot: string): Promise<PromptSectionsReport> {
  return request<PromptSectionsReport>(
    `/prompts/sections?projectRoot=${encodeURIComponent(projectRoot)}`,
  );
}

/** PUT /prompts/sections/:id — what the server replies after a write. */
export interface PromptOverrideWriteResult {
  ok: boolean;
  id: string;
  /** The `.acute/prompts/<id>.md` file that was written. */
  file: string;
  /** True when the content trimmed to empty — the DROP semantics fired. */
  dropped: boolean;
  content: string;
}

/**
 * PUT /prompts/sections/:id {projectRoot, content} — write (or drop) the
 * override. Non-empty content replaces the section WHOLESALE (dynamic parts
 * included); content that TRIMS to empty writes the empty file = DROP the
 * section from the prompt entirely — the caller must warn before that.
 */
export async function savePromptOverride(
  projectRoot: string,
  id: string,
  content: string,
): Promise<PromptOverrideWriteResult> {
  return request<PromptOverrideWriteResult>(`/prompts/sections/${encodeURIComponent(id)}`, {
    method: "PUT",
    json: { projectRoot, content },
  });
}

/** DELETE /prompts/sections/:id?projectRoot= — revert to the built-in text. */
export interface PromptOverrideRevertResult {
  ok: boolean;
  id: string;
  reverted: boolean;
  /** False when no override file existed (an idempotent revert). */
  existed: boolean;
}

/**
 * DELETE /prompts/sections/:id?projectRoot= — remove the override file so
 * the section returns to its built-in composition (byte-identical to a
 * project that never overrode it). Idempotent server-side.
 */
export async function deletePromptOverride(
  projectRoot: string,
  id: string,
): Promise<PromptOverrideRevertResult> {
  return request<PromptOverrideRevertResult>(
    `/prompts/sections/${encodeURIComponent(id)}?projectRoot=${encodeURIComponent(projectRoot)}`,
    { method: "DELETE" },
  );
}

/** One PRESENT section's effective text as the model receives it. */
export interface PromptPreviewSection {
  id: string;
  overridden: boolean;
  text: string;
}

/** GET /prompts/preview?projectRoot= — the composed effective composition. */
export interface PromptPreviewReport {
  rootPath: string;
  /** The registry ids in DEFAULT order — the UI's list anchor. */
  registryOrder: string[];
  effectiveOrder: string[];
  /** Sum of every section's text length — the honest size readout. */
  totalChars: number;
  sections: PromptPreviewSection[];
  diagnostics: string[];
}

/** GET /prompts/preview — the composed effective section texts, in order. */
export async function fetchPromptPreview(projectRoot: string): Promise<PromptPreviewReport> {
  return request<PromptPreviewReport>(
    `/prompts/preview?projectRoot=${encodeURIComponent(projectRoot)}`,
  );
}

/* ── MCP servers (the owner's "MCP servers too") ─────────────────────────── */

export interface McpServerRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const body = await request<{ servers: McpServerRecord[] }>("/mcp");
  return body.servers;
}

export async function createMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}): Promise<McpServerRecord> {
  return request<McpServerRecord>("/mcp", { method: "POST", json: input });
}

export async function updateMcpServer(
  id: string,
  patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/mcp/${id}`, { method: "PATCH", json: patch });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await request(`/mcp/${id}`, { method: "DELETE" });
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function listMcpTools(id: string): Promise<{ tools: McpToolInfo[]; error?: string }> {
  return request<{ tools: McpToolInfo[]; error?: string }>(`/mcp/${id}/tools`);
}

export interface McpProbeResult {
  ok: boolean;
  toolCount?: number;
  ms?: number;
  error?: string;
}

export async function probeMcpServer(id: string): Promise<McpProbeResult> {
  return request<McpProbeResult>(`/mcp/${id}/probe`, { method: "POST", json: {} });
}

/* ── Plugins (the Extensions surface: built-ins + external .mjs) ──────────── */

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  builtIn: boolean;
}

export interface PluginCatalogTool {
  name: string;
  description: string;
  category: string;
}

export interface ExternalPluginFile {
  file: string;
  scope: "user" | "project";
  loaded: boolean;
}

/** GET /plugins?projectId=… — built-in plugin metadata + the tool catalog +
 * the external .mjs file report (one surface for the Extensions view). */
export async function listPlugins(projectId?: string): Promise<{
  plugins: PluginInfo[];
  tools: PluginCatalogTool[];
  external: { files: ExternalPluginFile[]; loadedCount: number; note: string };
}> {
  const path = projectId ? `/plugins?projectId=${encodeURIComponent(projectId)}` : "/plugins";
  return request(path);
}
