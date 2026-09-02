/**
 * Agent registry repository (API.md §4). Routes validate input; this module
 * owns row<->JSON mapping, id/timestamp minting, and version bumps.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MemoryPolicy } from "shared";
import { DEFAULT_MODEL_ID } from "./models.js";

export type SqliteDatabase = Database.Database;

/**
 * Canonical tool ids — the REAL project tool set (agent-core/src/tools/index.ts,
 * ADR-0019). Single source of truth for server-side agent validation; the
 * frontend catalog mirrors this list (src/lib/api.ts TOOL_CATALOG).
 */
export const TOOL_NAMES = [
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
  // ROUND-43: delegation was missing from the seed allowlist — templates
  // could never reach the sub-agent orchestration (children strip this tool
  // in tools/index.ts as the one-level recursion guard). Migration 0014
  // repairs existing databases.
  "delegate_task",
  // ROUND-43 (R43-10): drives the user's embedded browser panel (navigate /
  // history / viewport presets) — tools/index.ts, state in browser-proxy.ts.
  "browser_control",
  // ROUND-44 (R44-a): the agent memory system — persistent per-project
  // knowledge (facts/decisions/preferences) via memory_save/recall/list.
  // Migration 0015 repairs existing databases.
  "memory_save",
  "memory_recall",
  "memory_list",
  // ROUND-52 (R52-a): background-job supervision — run_command resolves
  // detached launches (start /B …, `… &`, nohup …) immediately with a job
  // id; job_status polls what the process is doing (alive/output/log tail),
  // job_stop cleans it up. Migration 0021 appends them to existing
  // EXPLICIT allowlists (the owner's hung-server round-52 case must never
  // recur — the agent needs these on day one).
  "job_status",
  "job_stop",
  // ROUND-61 (R61): the skills progressive-disclosure loader (read_skill).
  // The skills SYSTEM is always-on (a global capability like todo_write);
  // explicit-list agents can add it in the agent form. The computer-use
  // tools are deliberately NOT here — they are a SETTINGS-GATED surface
  // (computerUse.enabled, default OFF), not allowlist vocabulary; MCP
  // tools are dynamic (mcp__<server>__<tool>).
  "read_skill",
] as const;

/** Agent JSON as served by the API: AgentRecord plus bookkeeping columns. */
export interface Agent {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  visionModel: string | null;
  allowedTools: string[];
  memoryPolicy: MemoryPolicy;
  skills: string[];
  maxTurns: number;
  /** Round-28 WS-F: outer-loop cap (default 5). After the SDK's internal
   * multi-step loop ends, the runtime auto-continues unless the task is
   * genuinely complete (explicit signal + all todos done). 5 × 80 = 400
   * tool round-trips max per user message. */
  maxOuterLoops: number;
  temperature: number;
  isTemplate: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable agent fields; every key optional (PATCH semantics). */
export interface AgentInput {
  name?: string;
  role?: string;
  systemPrompt?: string;
  providerId?: string | null;
  model?: string | null;
  visionModel?: string | null;
  allowedTools?: string[];
  memoryPolicy?: MemoryPolicy;
  skills?: string[];
  maxTurns?: number;
  maxOuterLoops?: number;
  temperature?: number;
}

export type DeleteAgentResult = "deleted" | "missing" | "template";

interface AgentRow {
  id: string;
  name: string;
  role: string;
  system_prompt: string;
  provider_id: string | null;
  model: string | null;
  vision_model: string | null;
  allowed_tools: string;
  memory_policy: MemoryPolicy;
  skills: string;
  max_turns: number;
  max_outer_loops: number;
  temperature: number;
  version: number;
  is_template: number;
  created_at: string;
  updated_at: string;
}

const SELECT_AGENT = `SELECT * FROM agents WHERE id = ?`;
const INSERT_AGENT = `INSERT INTO agents (
  id, name, role, system_prompt, provider_id, model, vision_model,
  allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
  version, is_template, created_at, updated_at
) VALUES (
  @id, @name, @role, @systemPrompt, @providerId, @model, @visionModel,
  @allowedTools, @memoryPolicy, @skills, @maxTurns, @maxOuterLoops, @temperature,
  @version, @isTemplate, @createdAt, @updatedAt
)`;

function toJson(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    visionModel: row.vision_model,
    allowedTools: JSON.parse(row.allowed_tools) as string[],
    memoryPolicy: row.memory_policy,
    skills: JSON.parse(row.skills) as string[],
    maxTurns: row.max_turns,
    maxOuterLoops: row.max_outer_loops,
    temperature: row.temperature,
    isTemplate: row.is_template === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bind(
  fields: Omit<Agent, "isTemplate" | "version" | "createdAt" | "updatedAt">,
  extra: { version: number; isTemplate: number; createdAt: string; updatedAt: string },
): Record<string, string | number | null> {
  return {
    id: fields.id,
    name: fields.name,
    role: fields.role,
    systemPrompt: fields.systemPrompt,
    providerId: fields.providerId,
    model: fields.model,
    visionModel: fields.visionModel,
    allowedTools: JSON.stringify(fields.allowedTools),
    memoryPolicy: fields.memoryPolicy,
    skills: JSON.stringify(fields.skills),
    maxTurns: fields.maxTurns,
    maxOuterLoops: fields.maxOuterLoops,
    temperature: fields.temperature,
    ...extra,
  };
}

/** Defaults for fields the client may omit on create. */
const CREATE_DEFAULTS = {
  role: "",
  systemPrompt: "",
  providerId: null,
  model: null,
  visionModel: null,
  allowedTools: [] as string[],
  memoryPolicy: "none" as MemoryPolicy,
  skills: [] as string[],
  maxTurns: 80,
  maxOuterLoops: 5,
  temperature: 0.2,
};

export function listAgents(db: SqliteDatabase, includeTemplates: boolean): Agent[] {
  const rows = includeTemplates
    ? (db.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all() as AgentRow[])
    : (db
        .prepare("SELECT * FROM agents WHERE is_template = 0 ORDER BY created_at ASC, id ASC")
        .all() as AgentRow[]);
  return rows.map(toJson);
}

export function getAgent(db: SqliteDatabase, id: string): Agent | undefined {
  const row = db.prepare(SELECT_AGENT).get(id) as AgentRow | undefined;
  return row === undefined ? undefined : toJson(row);
}

/** `input.name` must be present (route-validated); other fields fall back to defaults. */
export function createAgent(
  db: SqliteDatabase,
  input: AgentInput & { name: string },
): Agent {
  const now = new Date().toISOString();
  const agent: Omit<Agent, "isTemplate" | "version" | "createdAt" | "updatedAt"> = {
    id: `agt_${randomUUID()}`,
    name: input.name,
    role: input.role ?? CREATE_DEFAULTS.role,
    systemPrompt: input.systemPrompt ?? CREATE_DEFAULTS.systemPrompt,
    providerId: input.providerId ?? CREATE_DEFAULTS.providerId,
    model: input.model ?? CREATE_DEFAULTS.model,
    visionModel: input.visionModel ?? CREATE_DEFAULTS.visionModel,
    allowedTools: input.allowedTools ?? CREATE_DEFAULTS.allowedTools,
    memoryPolicy: input.memoryPolicy ?? CREATE_DEFAULTS.memoryPolicy,
    skills: input.skills ?? CREATE_DEFAULTS.skills,
    maxTurns: input.maxTurns ?? CREATE_DEFAULTS.maxTurns,
    maxOuterLoops: input.maxOuterLoops ?? CREATE_DEFAULTS.maxOuterLoops,
    temperature: input.temperature ?? CREATE_DEFAULTS.temperature,
  };
  db.prepare(INSERT_AGENT).run(
    bind(agent, { version: 1, isTemplate: 0, createdAt: now, updatedAt: now }),
  );
  return getAgent(db, agent.id) as Agent;
}

/** Merges the patch into the stored agent and bumps version; undefined = unknown id. */
export function updateAgent(db: SqliteDatabase, id: string, patch: AgentInput): Agent | undefined {
  const current = getAgent(db, id);
  if (current === undefined) return undefined;
  const merged: Omit<Agent, "isTemplate" | "version" | "createdAt" | "updatedAt"> = {
    id: current.id,
    name: patch.name ?? current.name,
    role: patch.role ?? current.role,
    systemPrompt: patch.systemPrompt ?? current.systemPrompt,
    providerId: patch.providerId ?? current.providerId,
    model: patch.model ?? current.model,
    visionModel: patch.visionModel ?? current.visionModel,
    allowedTools: patch.allowedTools ?? current.allowedTools,
    memoryPolicy: patch.memoryPolicy ?? current.memoryPolicy,
    skills: patch.skills ?? current.skills,
    maxTurns: patch.maxTurns ?? current.maxTurns,
    maxOuterLoops: patch.maxOuterLoops ?? current.maxOuterLoops,
    temperature: patch.temperature ?? current.temperature,
  };
  db.prepare(
    `UPDATE agents SET
      name = @name, role = @role, system_prompt = @systemPrompt,
      provider_id = @providerId, model = @model, vision_model = @visionModel,
      allowed_tools = @allowedTools, memory_policy = @memoryPolicy, skills = @skills,
      max_turns = @maxTurns, max_outer_loops = @maxOuterLoops, temperature = @temperature,
      version = @version, updated_at = @updatedAt
    WHERE id = @id`,
  ).run(
    bind(merged, {
      version: current.version + 1,
      isTemplate: current.isTemplate ? 1 : 0,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    }),
  );
  return getAgent(db, id) as Agent;
}

export function deleteAgent(db: SqliteDatabase, id: string): DeleteAgentResult {
  const agent = getAgent(db, id);
  if (agent === undefined) return "missing";
  if (agent.isTemplate) return "template";
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  return "deleted";
}

/** Copies editable fields; the copy is always a concrete agent (version 1, not a template). */
export function duplicateAgent(db: SqliteDatabase, id: string, name?: string): Agent | undefined {
  const source = getAgent(db, id);
  if (source === undefined) return undefined;
  const now = new Date().toISOString();
  const agent: Omit<Agent, "isTemplate" | "version" | "createdAt" | "updatedAt"> = {
    id: `agt_${randomUUID()}`,
    name: name ?? `${source.name} (copy)`,
    role: source.role,
    systemPrompt: source.systemPrompt,
    providerId: source.providerId,
    model: source.model,
    visionModel: source.visionModel,
    allowedTools: source.allowedTools,
    memoryPolicy: source.memoryPolicy,
    skills: source.skills,
    maxTurns: source.maxTurns,
    maxOuterLoops: source.maxOuterLoops,
    temperature: source.temperature,
  };
  db.prepare(INSERT_AGENT).run(
    bind(agent, { version: 1, isTemplate: 0, createdAt: now, updatedAt: now }),
  );
  return getAgent(db, agent.id) as Agent;
}

/** Fixed id for the plug-and-play default agent (round-15: a fresh install
 * must be able to chat OUT OF THE BOX — no manual agent setup required). */
const DEFAULT_AGENT_ID = "agt_default_nova";

/**
 * Seed the default working agent once, when NO non-template agent exists and
 * the openrouter provider row is present (it always is — provider seed).
 * ROUND-43: the previous hardcoded model (stealth/ox-alpha) was deleted
 * upstream by OpenRouter and killed every default chat — the seed now uses
 * DEFAULT_MODEL_ID from the built-in catalog (z-ai/glm-5.2:free: $0, 256K
 * ctx, tools + structured outputs). Existing installs are rewritten by
 * migration 0013; owners with other providers simply edit or duplicate the
 * agent in Settings. Idempotent by fixed id + existence check.
 */
export function ensureDefaultAgent(db: SqliteDatabase): void {
  // Round-16 rename (owner): the default agent is "Acute", not "Nova". The
  // fixed id stays (sessions reference it); an unmodified seed row is renamed
  // in place, a user who renamed it themselves keeps their name.
  db.prepare("UPDATE agents SET name = 'Acute', updated_at = ? WHERE id = ? AND name = 'Nova'")
    .run(new Date().toISOString(), DEFAULT_AGENT_ID);
  const exists = db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?")
    .get(DEFAULT_AGENT_ID) as { n: number };
  if (exists.n > 0) return;
  const anyAgent = db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE is_template = 0")
    .get() as { n: number };
  if (anyAgent.n > 0) return; // user already created their own — never crowd them
  const hasOpenRouter = db
    .prepare("SELECT COUNT(*) AS n FROM providers WHERE id = 'openrouter'")
    .get() as { n: number };
  if (hasOpenRouter.n === 0) return;
  const now = new Date().toISOString();
  db.prepare(INSERT_AGENT).run(
    bind(
      {
        id: DEFAULT_AGENT_ID,
        name: "Acute",
        role: "coder",
        systemPrompt: [
          "You are Nova, a careful hands-on coding agent working inside the user's project.",
          "Prefer minimal, precise changes; read before editing; verify paths stay inside the project root.",
          "When asked to build something, actually create the files with your tools, then summarize what you made.",
        ].join("\n"),
        providerId: "openrouter",
        model: DEFAULT_MODEL_ID,
        visionModel: null,
        allowedTools: [],
        memoryPolicy: "every-turn",
        skills: [],
        maxTurns: 80,
        maxOuterLoops: 5,
        temperature: 0.2,
      },
      { version: 1, isTemplate: 0, createdAt: now, updatedAt: now },
    ),
  );
}
