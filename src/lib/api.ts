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
export const TOOL_CATALOG = [
  "file_read",
  "file_write",
  "file_edit",
  "shell_exec",
  "web_search",
  "code_exec",
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

/** A chat bubble narrowed from the event log; non-message events arrive in later waves. */
export interface ChatEntry {
  seq: number;
  role: "user" | "assistant";
  content: string;
  agentId: string | null;
  ts: string;
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
  ok: boolean;
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
  | { kind: "tools"; seqStart: number; seqEnd: number; tools: ToolUseEntry[]; ts: string }
  | { kind: "diff"; entry: DiffEntry }
  | { kind: "ai"; seq: number; content: string; agentId: string | null; ts: string };

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

/** write/edit tool names that warrant a diff card. */
const DIFF_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Tolerant argsSummary parsing. The canonical format is
 * `path: <relpath>, content: <N> chars`, but summaries may carry extra or
 * missing segments — parse whatever is there, null otherwise.
 */
function parseDiffArgs(argsSummary: string): { path: string | null; chars: number | null } {
  const pathMatch = /path:\s*([^,]+)/.exec(argsSummary);
  const charsMatch = /(\d+)\s*chars?/i.exec(argsSummary);
  return {
    path: pathMatch ? pathMatch[1].trim() : null,
    chars: charsMatch ? Number(charsMatch[1]) : null,
  };
}

/**
 * Fold the append-only event log (ADR-0010) into the project-chat timeline:
 * user bubbles, ONE grouped tools item per maximal run of consecutive
 * tool.use events (diff cards for the write_file/edit_file calls in the run
 * follow immediately, in order), and assistant bubbles. Unknown event types
 * are ignored; a message event whose payload lacks a string content is too.
 */
export function toProjectChatItems(events: SessionEvent[]): ProjectChatItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items: ProjectChatItem[] = [];

  let index = 0;
  while (index < ordered.length) {
    const event = ordered[index];

    if (event.type === "tool.use") {
      // Maximal run of consecutive tool.use events → one grouped pills item.
      const tools: ToolUseEntry[] = [];
      while (index < ordered.length && ordered[index].type === "tool.use") {
        tools.push(toToolUseEntry(ordered[index]));
        index += 1;
      }
      items.push({
        kind: "tools",
        seqStart: tools[0].seq,
        seqEnd: tools[tools.length - 1].seq,
        tools,
        ts: tools[0].ts,
      });
      for (const tool of tools) {
        if (DIFF_TOOLS.has(tool.toolName)) {
          items.push({
            kind: "diff",
            entry: {
              ...parseDiffArgs(tool.argsSummary),
              seq: tool.seq,
              toolName: tool.toolName as "write_file" | "edit_file",
              ok: tool.ok,
              ts: tool.ts,
            },
          });
        }
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
          items.push({
            kind: "ai",
            seq: event.seq,
            content: payload.content,
            agentId: event.agentId,
            ts: event.ts,
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
