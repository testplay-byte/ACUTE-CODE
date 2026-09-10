// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the agent registry CRUD domain (API.md §3).
//
// Registers, in the original server.ts registration order: GET /agents
// (?includeTemplates), POST /agents, GET /agents/:id, PATCH /agents/:id,
// DELETE /agents/:id, POST /agents/:id/duplicate.
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The hand-rolled agent-body validator
// (validateAgentInput + its MEMORY_POLICIES/KNOWN_TOOLS vocabulary) moved
// with the domain; it is this domain's private gate.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import type { MemoryPolicy } from "shared";
import { providerExists } from "../storage/providers.js";
import type { SqliteDatabase } from "../storage/db.js";
import {
  TOOL_NAMES,
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgents,
  updateAgent,
  type Agent,
  type AgentInput,
} from "../storage/agents.js";
import { errorBody } from "./helpers.js";

interface FieldIssue {
  field: string;
  message: string;
}

const MEMORY_POLICIES: readonly MemoryPolicy[] = ["none", "on-start", "every-turn"];
const KNOWN_TOOLS: readonly string[] = TOOL_NAMES;

/**
 * Hand-rolled validation (no schema dependency in Wave 1): validates an agent
 * body for create (`partial: false`, name required) or patch (`partial: true`).
 * Unknown keys are ignored; absent keys stay undefined in the returned input.
 */
function validateAgentInput(
  body: unknown,
  options: { partial: boolean; db: SqliteDatabase },
): { issues: FieldIssue[]; input: AgentInput } {
  const issues: FieldIssue[] = [];
  const input: AgentInput = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { issues: [{ field: "body", message: "body must be a JSON object" }], input };
  }
  const raw = body as Record<string, unknown>;
  const present = (key: string): boolean => raw[key] !== undefined;

  if (present("name")) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      issues.push({ field: "body.name", message: "name must be a non-empty string" });
    } else {
      input.name = raw.name;
    }
  } else if (!options.partial) {
    issues.push({ field: "body.name", message: "name is required" });
  }

  for (const key of ["role", "systemPrompt"] as const) {
    if (!present(key)) continue;
    if (typeof raw[key] !== "string") {
      issues.push({ field: `body.${key}`, message: `${key} must be a string` });
    } else {
      input[key] = raw[key];
    }
  }

  for (const key of ["providerId", "model", "visionModel"] as const) {
    if (!present(key)) continue;
    const value = raw[key];
    if (value === null) {
      input[key] = null;
    } else if (typeof value !== "string") {
      issues.push({ field: `body.${key}`, message: `${key} must be a string or null` });
    } else if (key === "providerId" && !providerExists(options.db, value)) {
      issues.push({ field: "body.providerId", message: `unknown providerId: ${value}` });
    } else {
      input[key] = value;
    }
  }

  if (present("allowedTools")) {
    const value = raw.allowedTools;
    if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
      issues.push({
        field: "body.allowedTools",
        message: `allowedTools must be an array of tool names (${KNOWN_TOOLS.join(", ")})`,
      });
    } else {
      const unknown = (value as string[]).filter((tool) => !KNOWN_TOOLS.includes(tool));
      if (unknown.length > 0) {
        issues.push({
          field: "body.allowedTools",
          message: `unknown tool names: ${unknown.join(", ")}`,
        });
      } else {
        input.allowedTools = value as string[];
      }
    }
  }

  if (present("skills")) {
    const value = raw.skills;
    if (!Array.isArray(value) || value.some((skill) => typeof skill !== "string")) {
      issues.push({ field: "body.skills", message: "skills must be an array of strings" });
    } else {
      input.skills = value as string[];
    }
  }

  if (present("memoryPolicy")) {
    const value = raw.memoryPolicy;
    if (typeof value !== "string" || !MEMORY_POLICIES.includes(value as MemoryPolicy)) {
      issues.push({
        field: "body.memoryPolicy",
        message: `body.memoryPolicy must be one of: ${MEMORY_POLICIES.join(", ")}`,
      });
    } else {
      input.memoryPolicy = value as MemoryPolicy;
    }
  }

  if (present("maxTurns")) {
    const value = raw.maxTurns;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push({
        field: "body.maxTurns",
        message: "maxTurns must be a non-negative integer",
      });
    } else {
      input.maxTurns = value;
    }
  }

  if (present("temperature")) {
    const value = raw.temperature;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
      issues.push({
        field: "body.temperature",
        message: "temperature must be a number between 0 and 2",
      });
    } else {
      input.temperature = value;
    }
  }

  return { issues, input };
}

export function registerAgentRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  scope.get("/agents", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const includeTemplates = (query.includeTemplates ?? "true").toLowerCase() !== "false";
    return { agents: listAgents(db, includeTemplates) };
  });

  scope.post("/agents", async (request, reply) => {
    const { issues, input } = validateAgentInput(request.body, {
      partial: false,
      db,
    });
    const firstIssue = issues[0];
    if (firstIssue !== undefined || input.name === undefined) {
      const issue =
        firstIssue ?? { field: "body.name", message: "name is required" };
      return reply
        .code(400)
        .send(errorBody("VALIDATION", issue.message, { field: issue.field }));
    }
    const agent = createAgent(db, { ...input, name: input.name });
    return reply.code(201).send(agent);
  });

  scope.get("/agents/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const agent: Agent | undefined = getAgent(db, id);
    if (agent === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
    }
    return agent;
  });

  scope.patch("/agents/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (getAgent(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
    }
    const { issues, input } = validateAgentInput(request.body, { partial: true, db });
    if (issues.length > 0) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", issues[0].message, { field: issues[0].field }));
    }
    return updateAgent(db, id, input) as Agent;
  });

  scope.delete("/agents/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const result = deleteAgent(db, id);
    if (result === "missing") {
      return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
    }
    if (result === "template") {
      return reply
        .code(409)
        .send(
          errorBody("CONFLICT", "template agents cannot be deleted", { reason: "template" }),
        );
    }
    return reply.code(204).send();
  });

  scope.post("/agents/:id/duplicate", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (getAgent(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
    }
    let name: string | undefined;
    const body: unknown = request.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
      }
      const rawName = (body as Record<string, unknown>).name;
      if (rawName !== undefined) {
        if (typeof rawName !== "string" || rawName.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "name must be a non-empty string", {
              field: "body.name",
            }),
          );
        }
        name = rawName;
      }
    }
    return reply.code(201).send(duplicateAgent(db, id, name));
  });
}
