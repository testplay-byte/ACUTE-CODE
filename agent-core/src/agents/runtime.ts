/**
 * Single-agent chat turn (ADR-0001 "single" mode). Round-16: the turn prep
 * is shared between the SYNC path (runSingleAgentTurn) and the STREAMED path
 * (runStreamedAgentTurn — live text deltas + tool events over SSE); both
 * persist the identical append-only event sequence (ADR-0010):
 * message.user → tool.use (one per executed call, as each completes) →
 * message.assistant (with per-reply usage+ms stats) → usage_events row.
 */
import type { SessionStatus, UsageRecord } from "shared";
import { getAgent } from "../storage/agents.js";
import { getProject } from "../storage/projects.js";
import type Database from "better-sqlite3";
import {
  ProviderKeyring,
  resolveProvider,
} from "../providers/registry.js";
import { buildProjectTools } from "../tools/index.js";
import {
  appendSessionEvent,
  getSession,
  lastSessionSeq,
  listSessionEvents,
  recordUsage,
  setSessionStatus,
  touchSession,
} from "../storage/sessions.js";
import type { ChatFn, ChatTurnMessage, ChatTurnOutput, StreamChatFn } from "./chat.js";
import { buildProjectSystemPrompt, readCustomRules } from "./prompts.js";
import { lookupPricing } from "../storage/models.js";
import { assembleWithinBudget, type ContextBudget } from "../context.js";

export type SqliteDatabase = Database.Database;

/** API.md §5.4: these session statuses refuse follow-up turns. */
const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled"];

export interface AssistantMessage {
  seq: number;
  role: "assistant";
  agentId: string;
  content: string;
  ts: string;
}

export type TurnOutcome =
  | { ok: true; assistantMessage: AssistantMessage; usage: UsageRecord }
  | {
      ok: false;
      status: 404 | 409 | 502;
      code: "NOT_FOUND" | "CONFLICT" | "PROVIDER_ERROR";
      message: string;
      details?: Record<string, unknown>;
    };

export interface TurnDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  chat: ChatFn;
  /** Streaming adapter (round-16); the streamed turn refuses without one. */
  chatStream?: StreamChatFn;
}

/** Narrows an event payload back to the {role, content} chat shape we write. */
function asChatMessage(event: { type: string; payload: unknown }): ChatTurnMessage | undefined {
  if (event.type !== "message.user" && event.type !== "message.assistant") return undefined;
  if (typeof event.payload !== "object" || event.payload === null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.content !== "string") return undefined;
  return { role: event.type === "message.user" ? "user" : "assistant", content: payload.content };
}

/** Error text for a 502 envelope — scrubbed of the API key, then length-capped. */
function providerErrorDetail(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw.split(apiKey).join("***");
  return scrubbed.length > 500 ? `${scrubbed.slice(0, 500)}…` : scrubbed;
}

/** Everything a turn needs after validation (shared by sync + streamed). */
interface PreparedTurn {
  session: NonNullable<ReturnType<typeof getSession>>;
  agent: NonNullable<ReturnType<typeof getAgent>>;
  provider: { id: string; baseUrl: string };
  apiKey: string;
  model: string;
  tools: ReturnType<typeof buildProjectTools> | undefined;
  system: string;
}

/** Shared pre-flight: validation, provider/key resolution, tools, system,
 * history. modelOverride lets one call use a different model than the
 * agent's default (the chat UI's per-send model picker). */
function prepareTurn(
  db: SqliteDatabase,
  keyring: ProviderKeyring,
  sessionId: string,
  modelOverride?: string,
): PreparedTurn | { error: Extract<TurnOutcome, { ok: false }> } {
  const session = getSession(db, sessionId);
  if (session === undefined) {
    return { error: { ok: false, status: 404, code: "NOT_FOUND", message: `no session with id ${sessionId}` } };
  }
  if (TERMINAL_STATUSES.includes(session.status)) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session ${sessionId} is ${session.status} and no longer accepts messages`,
      },
    };
  }
  if (session.agentId === null) {
    return { error: { ok: false, status: 409, code: "CONFLICT", message: `session ${sessionId} has no bound agent` } };
  }
  const agent = getAgent(db, session.agentId);
  if (agent === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session agent ${session.agentId} no longer exists`,
      },
    };
  }
  if (agent.providerId === null || agent.model === null) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `agent '${agent.name}' has no providerId/model configured`,
        details: { agentId: agent.id, field: "providerId" },
      },
    };
  }
  const provider = resolveProvider(db, agent.providerId);
  if (provider === undefined || provider.baseUrl === null) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `agent '${agent.name}' references provider '${agent.providerId}' without a usable baseUrl`,
        details: { agentId: agent.id, providerId: agent.providerId },
      },
    };
  }
  const apiKey = keyring.get(provider.id);
  if (apiKey === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message:
          `no API key for provider '${provider.id}' — set ${ProviderKeyring.envVarName(provider.id)} ` +
          "in the sidecar environment",
        details: { providerId: provider.id },
      },
    };
  }
  const project = session.projectId !== null ? getProject(db, session.projectId) : undefined;
  if (session.projectId !== null && project === undefined) {
    return {
      error: {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `session ${sessionId} references missing project ${session.projectId}`,
      },
    };
  }
  // Tools: the project set, intersected with the agent's allowlist when one
  // is set (ADR-0019). Empty/omitted allowlist = ALL tools (the default
  // agents rely on this; an explicit non-empty list is a real restriction).
  //
  // round-27 fix: the `deps` arg (db/sessionId/agentId/seq) was NEVER passed
  // before — so todo_write returned "todo tracking unavailable" and the
  // write_file/edit_file/delete_file snapshot recording (checkpoints) were
  // silently dead in real turns while the tools existed on paper. Now wired
  // so todos persist + every mutating tool records a revertible snapshot.
  const turnSeq = lastSessionSeq(db, session.id) + 1;
  const toolDeps = { db, sessionId: session.id, agentId: agent.id, seq: turnSeq };
  const tools =
    project !== undefined
      ? buildProjectTools(project.rootPath, agent.allowedTools, toolDeps)
      : undefined;
  const system = project
    ? buildProjectSystemPrompt({
        projectName: project.name,
        rootPath: project.rootPath,
        toolNames: Object.keys(buildProjectTools(project.rootPath, agent.allowedTools, toolDeps)),
        customRules: readCustomRules(project.rootPath),
      })
    : agent.systemPrompt;
  return {
    session,
    agent,
    provider: { id: provider.id, baseUrl: provider.baseUrl },
    apiKey,
    model: modelOverride && modelOverride.trim() !== "" ? modelOverride.trim() : agent.model,
    tools,
    system,
  };
}

export async function runSingleAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
  modelOverride?: string,
): Promise<TurnOutcome> {
  const { db, keyring, chat } = deps;
  const prepared = prepareTurn(db, keyring, sessionId, modelOverride);
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;

  // First message flips a queued session to running (API.md §5 semantics).
  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content },
  });
  const rawMessages = listSessionEvents(db, session.id)
    .map(asChatMessage)
    .filter((message): message is ChatTurnMessage => message !== undefined);

  // Context-window management: trim oldest messages if over budget (round-25)
  const budget: ContextBudget = {
    contextWindow: getModelContextWindow(db, provider.id, model),
    maxOutputTokens: 32_768,
    margin: 8_000,
  };
  const { messages } = assembleWithinBudget(rawMessages, budget);

  const startedAt = Date.now();
  let result: ChatTurnOutput;
  try {
    result = await chat({
      provider: { id: provider.id, baseUrl: provider.baseUrl },
      apiKey,
      model,
      system,
      messages,
      temperature: agent.temperature,
      maxTurns: agent.maxTurns,
      ...(tools !== undefined ? { tools } : {}),
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      status: 502,
      code: "PROVIDER_ERROR",
      message: `provider '${provider.id}' call failed for session ${session.id}`,
      details: { providerError: providerErrorDetail(normalized, apiKey) },
    };
  }
  const ms = Date.now() - startedAt;

  // Audit trail: one event per executed tool call, in order (ADR-0010 log).
  for (const call of result.toolCalls) {
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: call.name, argsSummary: call.argsSummary, ok: call.ok },
    });
  }

  const assistantEvent = appendSessionEvent(db, session.id, {
    type: "message.assistant",
    agentId: agent.id,
    payload: {
      role: "assistant",
      content: result.text,
      // Round-16 per-reply stats (owner request) ride on the event payload.
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      ms,
      model,
    },
  });
  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: computeCost(db, provider.id, model, result.usage.inputTokens, result.usage.outputTokens),
    ts: assistantEvent.ts,
  };
  recordUsage(db, usage);
  touchSession(db, session.id);

  return {
    ok: true,
    assistantMessage: {
      seq: assistantEvent.seq,
      role: "assistant",
      agentId: agent.id,
      content: result.text,
      ts: assistantEvent.ts,
    },
    usage,
  };
}

/** Streaming turn outcome: same shape as the sync turn. */
export type StreamedTurnOutcome = TurnOutcome;

/**
 * STREAMED turn (round-16): identical persistence/ordering to the sync turn
 * (user event → tool.use events as each call completes → assistant event
 * with usage+ms → usage row), but every stream event is emitted LIVE via
 * `emit` so the UI can render text deltas and tool calls as they happen.
 */
export async function runStreamedAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
  emit: (event: unknown) => void,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<StreamedTurnOutcome> {
  const { db, keyring, chatStream } = deps;
  if (chatStream === undefined) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "streaming is not available in this build",
    };
  }
  const prepared = prepareTurn(db, keyring, sessionId, modelOverride);
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;

  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content },
  });
  const rawMessages = listSessionEvents(db, session.id)
    .map(asChatMessage)
    .filter((message): message is ChatTurnMessage => message !== undefined);

  const budget: ContextBudget = {
    contextWindow: getModelContextWindow(db, provider.id, model),
    maxOutputTokens: 32_768,
    margin: 8_000,
  };
  const { messages } = assembleWithinBudget(rawMessages, budget);

  const startedAt = Date.now();
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const event of chatStream({
      provider: { id: provider.id, baseUrl: provider.baseUrl },
      apiKey,
      model,
      system,
      messages,
      temperature: agent.temperature,
      maxTurns: agent.maxTurns,
      ...(tools !== undefined ? { tools } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      emit(event);
      if (event.type === "text-delta") {
        text += event.delta;
      } else if (event.type === "tool-result") {
        // Persist each tool call the moment it completes (live ordering).
        appendSessionEvent(db, session.id, {
          type: "tool.use",
          agentId: agent.id,
          payload: { role: "tool", toolName: event.toolName, argsSummary: event.argsSummary, ok: event.ok },
        });
      } else if (event.type === "finish") {
        inputTokens = event.usage.inputTokens;
        outputTokens = event.usage.outputTokens;
      }
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      status: 502,
      code: "PROVIDER_ERROR",
      message: `provider '${provider.id}' call failed for session ${session.id}`,
      details: { providerError: providerErrorDetail(normalized, apiKey) },
    };
  }
  const ms = Date.now() - startedAt;

  const assistantEvent = appendSessionEvent(db, session.id, {
    type: "message.assistant",
    agentId: agent.id,
    payload: {
      role: "assistant",
      content: text,
      usage: { inputTokens, outputTokens },
      ms,
      model,
    },
  });
  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens,
    outputTokens,
    costUsd: computeCost(db, provider.id, model, inputTokens, outputTokens),
    ts: assistantEvent.ts,
  };
  recordUsage(db, usage);
  touchSession(db, session.id);

  return {
    ok: true,
    assistantMessage: {
      seq: assistantEvent.seq,
      role: "assistant",
      agentId: agent.id,
      content: text,
      ts: assistantEvent.ts,
    },
    usage,
  };
}

/** Compute cost from the models table pricing (round-24). */
function computeCost(
  db: SqliteDatabase,
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = lookupPricing(db, providerId, modelId);
  if (pricing.inputPricePerMtok === null || pricing.outputPricePerMtok === null) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.inputPricePerMtok +
    (outputTokens / 1_000_000) * pricing.outputPricePerMtok
  );
}

/** Look up the model's context window (fallback 200k if not configured). */
function getModelContextWindow(db: SqliteDatabase, providerId: string, modelId: string): number {
  const row = db
    .prepare("SELECT context_window FROM models WHERE provider_id = ? AND model_id = ?")
    .get(providerId, modelId) as { context_window: number | null } | undefined;
  return row?.context_window ?? 200_000;
}
