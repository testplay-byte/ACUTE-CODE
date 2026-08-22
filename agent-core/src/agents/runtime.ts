/**
 * Single-agent chat turn (ADR-0001 "single" mode; tools arrive in a later
 * wave). One HTTP message = append the user event -> one provider call ->
 * append the assistant event + a usage_events row. The event log is
 * append-only (ADR-0010): a failed provider call leaves the user event and its
 * seq in place so the next turn continues the sequence without gaps in reuse.
 */
import type { SessionStatus, UsageRecord } from "shared";
import { getAgent } from "../storage/agents.js";
import type Database from "better-sqlite3";
import {
  ProviderKeyring,
  resolveProvider,
} from "../providers/registry.js";
import {
  appendSessionEvent,
  getSession,
  listSessionEvents,
  recordUsage,
  setSessionStatus,
  touchSession,
} from "../storage/sessions.js";
import type { ChatFn, ChatTurnMessage, ChatTurnOutput } from "./chat.js";

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

export async function runSingleAgentTurn(
  deps: TurnDeps,
  sessionId: string,
  content: string,
): Promise<TurnOutcome> {
  const { db, keyring, chat } = deps;
  const session = getSession(db, sessionId);
  if (session === undefined) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: `no session with id ${sessionId}` };
  }
  if (TERMINAL_STATUSES.includes(session.status)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `session ${sessionId} is ${session.status} and no longer accepts messages`,
    };
  }
  if (session.agentId === null) {
    return { ok: false, status: 409, code: "CONFLICT", message: `session ${sessionId} has no bound agent` };
  }
  const agent = getAgent(db, session.agentId);
  if (agent === undefined) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `session agent ${session.agentId} no longer exists`,
    };
  }
  if (agent.providerId === null || agent.model === null) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `agent '${agent.name}' has no providerId/model configured`,
      details: { agentId: agent.id, field: "providerId" },
    };
  }
  const provider = resolveProvider(db, agent.providerId);
  if (provider === undefined || provider.baseUrl === null) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `agent '${agent.name}' references provider '${agent.providerId}' without a usable baseUrl`,
      details: { agentId: agent.id, providerId: agent.providerId },
    };
  }
  const apiKey = keyring.get(provider.id);
  if (apiKey === undefined) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message:
        `no API key for provider '${provider.id}' — set ${ProviderKeyring.envVarName(provider.id)} ` +
        "in the sidecar environment",
      details: { providerId: provider.id },
    };
  }

  // First message flips a queued session to running (API.md §5 semantics).
  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content },
  });
  const messages = listSessionEvents(db, session.id)
    .map(asChatMessage)
    .filter((message): message is ChatTurnMessage => message !== undefined);

  let result: ChatTurnOutput;
  try {
    result = await chat({
      provider: { id: provider.id, baseUrl: provider.baseUrl },
      apiKey,
      model: agent.model,
      system: agent.systemPrompt,
      messages,
      temperature: agent.temperature,
      maxTurns: agent.maxTurns,
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

  const assistantEvent = appendSessionEvent(db, session.id, {
    type: "message.assistant",
    agentId: agent.id,
    payload: { role: "assistant", content: result.text },
  });
  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model: agent.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: 0, // cost estimation arrives in a later wave; providers without pricing report 0
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
