/**
 * ROUND-106 (R106-S3): the command context — everything a command group
 * needs, built once in main.ts after flags parse + connection resolve.
 * Commands stay pure-ish: they receive this and return an exit code.
 */
import { resolve as resolvePath } from "node:path";
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

/** One row of GET /projects (the fields the CLI's project binding reads). */
export interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
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

/**
 * ROUND-117 (R117-b): resolve the PROJECT a new CLI session should bind to
 * — the fix for "CLI sessions are projectless → memory tools hard-fail and
 * no digest". Resolution order:
 *   1. `--project <path>` (the explicit override): resolved absolute and
 *      matched against a REGISTERED project root EXACTLY — no match → stay
 *      projectless (the honest note, never a failure).
 *   2. The CLI's own cwd: scan the projects list for a rootPath that
 *      matches it — exactly ONE match binds; zero or several stay
 *      projectless (never a guess).
 * The projects list is advisory — any fetch/shape failure degrades to
 * projectless (session creation must never fail on it).
 */
export async function resolveProjectBinding(
  ctx: CliContext,
  cwd: string = process.cwd(),
): Promise<{ projectId?: string; projectName?: string; explicitMiss?: string }> {
  const explicit = flagString(ctx.flags, "project");
  let projects: ProjectRow[] = [];
  try {
    const body = await apiFetch<{ projects: ProjectRow[] }>(ctx.conn, "GET", "/projects");
    projects = Array.isArray(body.projects) ? body.projects : [];
  } catch {
    return {}; // the list is advisory — projectless, no drama
  }
  if (explicit !== undefined) {
    const wanted = resolvePath(explicit);
    const hit = projects.find((p) => resolvePath(p.rootPath) === wanted);
    if (hit !== undefined) return { projectId: hit.id, projectName: hit.name };
    return { explicitMiss: wanted };
  }
  const here = resolvePath(cwd);
  const hits = projects.filter((p) => resolvePath(p.rootPath) === here);
  if (hits.length === 1) return { projectId: hits[0].id, projectName: hits[0].name };
  return {};
}

/** POST /sessions (202 → SessionRow). Title defaults to a slice of content.
 * ROUND-117 (R117-b): the session creation gains a projectId when one can
 * be resolved (resolveProjectBinding — `--project <path>` override, else the
 * cwd match); an explicit `--project` that matches nothing stays projectless
 * with the honest stderr note. Callers pass nothing and get the binding for
 * free; tests can inject the resolved id directly. */
export async function createSession(
  ctx: CliContext,
  agentId: string,
  title?: string,
  projectId?: string,
): Promise<SessionRow> {
  let binding: { projectId?: string } = {};
  if (projectId !== undefined) {
    binding = { projectId };
  } else {
    const resolved = await resolveProjectBinding(ctx);
    if (resolved.explicitMiss !== undefined) {
      ctx.stderr(
        ctx.kit.dim(`— no registered project at ${resolved.explicitMiss}; the session stays projectless\n`),
      );
    }
    binding = resolved;
  }
  return apiFetch<SessionRow>(ctx.conn, "POST", "/sessions", {
    mode: "single",
    agentId,
    ...(title !== undefined && title !== "" ? { title } : {}),
    ...(binding.projectId !== undefined ? { projectId: binding.projectId } : {}),
  });
}
