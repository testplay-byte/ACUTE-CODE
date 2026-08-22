import type { AgentRecord } from "shared";
import { getFixtureAgents } from "./agent-fixtures";
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
