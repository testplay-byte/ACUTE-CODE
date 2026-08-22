import type { Agent, AgentsBackend, AgentDraft, AgentPatch } from "./api";

/**
 * In-memory AgentsBackend used by tests and the "demo data" toggle — the UI is
 * fully usable before the sidecar lands. Seed data mirrors the workspace's
 * sub-agent protocol (AGENTS.md) and the dev provider constraint (OpenRouter,
 * single allowed model "ox Alpha").
 */

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

const SEED: Agent[] = [
  {
    id: "agt_tpl_researcher",
    name: "Researcher",
    role: "researcher",
    systemPrompt:
      "You investigate the codebase and gather context. You read broadly, never edit files, and return findings with absolute file paths.",
    providerId: "openrouter",
    model: "openrouter/ox-alpha",
    visionModel: null,
    allowedTools: ["file_read", "web_search"],
    memoryPolicy: "on-start",
    skills: [],
    maxTurns: 20,
    temperature: 0.3,
    isTemplate: true,
    version: 1,
    createdAt: "2026-08-20T09:00:00Z",
    updatedAt: "2026-08-20T09:00:00Z",
  },
  {
    id: "agt_tpl_implementer",
    name: "Implementer",
    role: "developer",
    systemPrompt:
      "You write precise, minimal diffs that satisfy the task without gold-plating. You follow the workspace AGENTS.md rules at all times.",
    providerId: "openrouter",
    model: "openrouter/ox-alpha",
    visionModel: null,
    allowedTools: ["file_read", "file_write", "file_edit", "shell_exec"],
    memoryPolicy: "every-turn",
    skills: ["git-rescue"],
    maxTurns: 40,
    temperature: 0.2,
    isTemplate: true,
    version: 1,
    createdAt: "2026-08-20T09:05:00Z",
    updatedAt: "2026-08-20T09:05:00Z",
  },
  {
    id: "agt_tpl_reviewer",
    name: "Reviewer",
    role: "reviewer",
    systemPrompt:
      "You review diffs for correctness, license compliance, and adherence to the spec. Review failures go back to the producer with concrete file/line references.",
    providerId: "openrouter",
    model: "openrouter/ox-alpha",
    visionModel: null,
    allowedTools: ["file_read", "shell_exec"],
    memoryPolicy: "none",
    skills: [],
    maxTurns: 15,
    temperature: 0.1,
    isTemplate: true,
    version: 1,
    createdAt: "2026-08-20T09:10:00Z",
    updatedAt: "2026-08-20T09:10:00Z",
  },
  {
    id: "agt_scribe",
    name: "Scribe",
    role: "scribe",
    systemPrompt:
      "You keep the phase reports and decision log current. Every entry states what was done, the artifacts, and open questions.",
    providerId: "openrouter",
    model: "openrouter/ox-alpha",
    visionModel: null,
    allowedTools: ["file_read", "file_write"],
    memoryPolicy: "every-turn",
    skills: [],
    maxTurns: 25,
    temperature: 0.2,
    isTemplate: false,
    version: 3,
    createdAt: "2026-08-21T10:00:00Z",
    updatedAt: "2026-08-21T16:30:00Z",
  },
  {
    id: "agt_ui_vision",
    name: "UI Auditor",
    role: "tester",
    systemPrompt:
      "You verify screens against the owner's design demos and file precise visual regressions with screenshots.",
    providerId: "openrouter",
    model: "openrouter/ox-alpha",
    visionModel: "openrouter/ox-alpha",
    allowedTools: ["file_read", "code_exec"],
    memoryPolicy: "on-start",
    skills: ["screenshot-diff"],
    maxTurns: 30,
    temperature: 0.2,
    isTemplate: false,
    version: 1,
    createdAt: "2026-08-22T08:00:00Z",
    updatedAt: "2026-08-22T08:00:00Z",
  },
];

/** Build an isolated fixture backend; the UI shares a single memoized one. */
export function createFixtureAgents(seed: Agent[] = SEED): AgentsBackend {
  const agents = new Map(seed.map((a) => [a.id, { ...a }]));

  const ok = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 10));

  return {
    list: (includeTemplates) =>
      ok([...agents.values()].filter((a) => includeTemplates || !a.isTemplate)),
    create: (draft: AgentDraft) => {
      const agent: Agent = {
        ...draft,
        id: uid("agt"),
        isTemplate: false,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      agents.set(agent.id, agent);
      return ok(agent);
    },
    get: (id) => {
      const agent = agents.get(id);
      if (!agent) return Promise.reject(new Error(`agent ${id} not found`));
      return ok({ ...agent });
    },
    update: (id, patch: AgentPatch) => {
      const agent = agents.get(id);
      if (!agent) return Promise.reject(new Error(`agent ${id} not found`));
      const next: Agent = { ...agent, ...patch, version: agent.version + 1, updatedAt: now() };
      agents.set(id, next);
      return ok({ ...next });
    },
    remove: (id) => {
      if (!agents.delete(id)) return Promise.reject(new Error(`agent ${id} not found`));
      return ok(undefined);
    },
    duplicate: (id, name) => {
      const agent = agents.get(id);
      if (!agent) return Promise.reject(new Error(`agent ${id} not found`));
      const copy: Agent = {
        ...agent,
        id: uid("agt"),
        name: name ?? `${agent.name} (copy)`,
        isTemplate: false,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      agents.set(copy.id, copy);
      return ok(copy);
    },
  };
}

let shared: AgentsBackend | null = null;

/** Memoized instance so toggling demoData off/on keeps demo edits. */
export function getFixtureAgents(): AgentsBackend {
  shared ??= createFixtureAgents();
  return shared;
}

/** Re-seed the shared demo backend (test isolation / "reset demo data"). */
export function resetFixtureAgents() {
  shared = null;
}
