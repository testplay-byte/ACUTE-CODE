/**
 * ROUND-106 (R106-S3): the command context — everything a command group
 * needs, built once in main.ts after flags parse + connection resolve.
 * Commands stay pure-ish: they receive this and return an exit code.
 */
import type { ColorKit } from "./color.js";
import type { Connection } from "./connection.js";
import { apiFetch } from "./api.js";
import type { CliConfig } from "./config.js";
import { flagString } from "./flags.js";

/** The UI half of the context — everything the OFFLINE commands need too
 * (config, status never dial /api/v1; they get a UiContext, not a
 * CliContext, so the type system keeps them honest). */
export interface UiContext {
  /** stdout — content + cards (NDJSON lines in json mode). */
  stdout: (s: string) => void;
  /** stderr — notices, status lines, error envelopes. */
  stderr: (s: string) => void;
  kit: ColorKit;
  /** No-color mode (markdown plain, kit disabled). */
  plain: boolean;
  quiet: boolean;
  json: boolean;
  autoApprove: boolean;
  config: CliConfig;
  /** Raw parsed flags (validated per command). */
  flags: Record<string, string | true>;
  repoRoot: string;
}

export interface CliContext extends UiContext {
  conn: Connection;
}

/** The session row POST /sessions returns (storage/sessions.ts Session). */
export interface SessionRow {
  id: string;
  projectId: string | null;
  agentId: string | null;
  mode: string;
  status: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  providerId: string | null;
  model: string | null;
  isTemplate: boolean;
}

/** Resolve the agent for a new session: --agent flag → config store → the
 * first registry agent (the M1 default — CLI-DESIGN §6). */
export async function resolveAgentId(
  ctx: CliContext,
  explicit?: string,
): Promise<{ agentId: string; agent: AgentRow | null; note: string | null }> {
  const wanted = explicit ?? flagString(ctx.flags, "agent") ?? ctx.config.agent;
  if (wanted !== undefined) return { agentId: wanted, agent: null, note: null };
  const { agents } = await apiFetch<{ agents: AgentRow[] }>(ctx.conn, "GET", "/agents?includeTemplates=false");
  const list = Array.isArray(agents) ? agents : [];
  if (list.length === 0) {
    throw new Error("no agents in the registry — pass --agent <id> (see: acute raw GET /agents)");
  }
  return {
    agentId: list[0].id,
    agent: list[0],
    note: list[0].name,
  };
}

/** POST /sessions (202 → SessionRow). Title defaults to a slice of content. */
export async function createSession(
  ctx: CliContext,
  agentId: string,
  title?: string,
): Promise<SessionRow> {
  return apiFetch<SessionRow>(ctx.conn, "POST", "/sessions", {
    mode: "single",
    agentId,
    ...(title !== undefined && title !== "" ? { title } : {}),
  });
}
