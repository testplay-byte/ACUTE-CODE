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
import { getIndexSummary } from "../storage/index.js";
import { lookupPricing } from "../storage/models.js";
import { assembleWithinBudget, type ContextBudget } from "../context.js";

export type SqliteDatabase = Database.Database;

/**
 * Round-28 WS-F: read the latest todo.update snapshot from the session event
 * log. Returns true if ALL todo items are marked "completed" (vacuously true
 * if the model never called todo_write — no plan = not a completion blocker).
 * Used by the inverted continueIfUnfinished heuristic: the outer loop
 * continues UNLESS (a) explicit completion signal AND (b) all todos done.
 */
function latestTodosAllDone(db: SqliteDatabase, sessionId: string): boolean {
  const events = listSessionEvents(db, sessionId);
  // Walk backwards to find the latest todo.update.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "todo.update") {
      const todos = (ev.payload as { todos?: Array<{ status?: string }> }).todos;
      if (!Array.isArray(todos) || todos.length === 0) return true; // no plan → not a blocker
      return todos.every((t) => t.status === "completed");
    }
  }
  return true; // no todo.update event → no plan → not a blocker
}

/** Completion-signal regex (6-e inverted heuristic — phrase matching was
 * brittle; now we require BOTH the signal AND all todos done to STOP). No
 * trailing \b: the signal often ends the message, and \b after a period
 * requires a following word char (absent at end-of-string). */
const COMPLETION_SIGNAL = /\b(Done\.|Task complete\.|Finished\.|All set\.|All done\.)/i;

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
  // ROUND-35 (review fix #3): thinking-only / stats-carrier segments have
  // empty content — sending {role:"assistant", content:""} makes
  // Anthropic-protocol endpoints 400. Skip them for history.
  if (event.type === "message.assistant" && payload.content === "") return undefined;
  return { role: event.type === "message.user" ? "user" : "assistant", content: payload.content };
}

/**
 * ROUND-34 (review fix #2/#3): scrub keyring-held secrets from tool output
 * BEFORE persisting AND before emitting over SSE — one helper, both paths.
 */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * ROUND-34 (Cline-pattern tool feedback): fold the append-only event log into
 * a model-facing conversation that INCLUDES tool results — the fix for
 * multi-step tasks. Event order is user → tool.use×N → assistant, so the
 * model previously saw its own replies but never what its tools returned;
 * outer-loop iteration 2+ would re-plan blind (or repeat work). Now the
 * history carries a <tool_results> block after each assistant turn. The
 * markers keep tool output as DATA, never instructions (injection guard);
 * old events without an outputSummary still fold (ok flag only).
 */
function assembleHistory(db: SqliteDatabase, sessionId: string): ChatTurnMessage[] {
  const events = listSessionEvents(db, sessionId);
  const messages: ChatTurnMessage[] = [];
  let pendingToolLines: string[] = [];

  const flushTools = () => {
    if (pendingToolLines.length === 0) return;
    messages.push({
      role: "user",
      content: `<tool_results>\n${pendingToolLines.join("\n")}\n</tool_results>`,
    });
    pendingToolLines = [];
  };

  for (const event of events) {
    if (event.type === "message.user" || event.type === "message.assistant") {
      flushTools();
      const msg = asChatMessage(event);
      if (msg) messages.push(msg);
    } else if (event.type === "tool.use") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "";
      const ok = payload.ok === false ? false : true;
      const outputSummary =
        typeof payload.outputSummary === "string" && payload.outputSummary.length > 0
          ? payload.outputSummary
          : null;
      // Review fix #7: neutralize the closing marker inside tool output so
      // injected content can't escape the <tool_results> data block.
      const safeOutput = outputSummary?.replace(/<\/tool_results>/g, "<\/tool_results>");
      pendingToolLines.push(
        `${toolName}(${argsSummary}) → ${ok ? "ok" : "FAILED"}${safeOutput ? `: ${safeOutput}` : ""}`,
      );
    }
  }
  flushTools();
  return messages;
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
  tools: Awaited<ReturnType<typeof buildProjectTools>> | undefined;
  system: string;
}

/** Shared pre-flight: validation, provider/key resolution, tools, system,
 * history. modelOverride lets one call use a different model than the
 * agent's default (the chat UI's per-send model picker). */
async function prepareTurn(
  db: SqliteDatabase,
  keyring: ProviderKeyring,
  sessionId: string,
  modelOverride?: string,
  /** ROUND-36: the chat fn (delegate_task spawns child turns through it). */
  chatForTools?: ChatFn,
  /** ROUND-36 (streamed turns): forward live subagent-status events to SSE. */
  emitForTools?: (event: unknown) => void,
): Promise<PreparedTurn | { error: Extract<TurnOutcome, { ok: false }> }> {
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
  // ROUND-36 (ADR-0022): keyring + chat let the delegate_task tool spawn
  // child turns; `emit` is added per-path (the streamed turn forwards live
  // subagent-status events onto its SSE).
  const toolDeps = {
    db,
    sessionId: session.id,
    agentId: agent.id,
    seq: turnSeq,
    projectId: session.projectId ?? undefined,
    keyring,
    ...(chatForTools !== undefined ? { chat: chatForTools } : {}),
    ...(emitForTools !== undefined ? { emit: emitForTools } : {}),
  };
  // ROUND-36 (ADR-0022): children never get delegate_task — one-level
  // fan-out is the recursion guard.
  const childAllowList =
    session.parentSessionId !== null && agent.allowedTools !== undefined
      ? agent.allowedTools.filter((t) => t !== "delegate_task")
      : agent.allowedTools;
  const tools =
    project !== undefined
      ? await buildProjectTools(
          project.rootPath,
          session.parentSessionId !== null
            ? childAllowList !== undefined && childAllowList.length === 0
              ? ["__none__"]
              : childAllowList
            : agent.allowedTools,
          toolDeps,
        )
      : undefined;
  const system = project
    ? buildProjectSystemPrompt({
        projectName: project.name,
        rootPath: project.rootPath,
        toolNames: Object.keys(await buildProjectTools(project.rootPath, agent.allowedTools, toolDeps)),
        customRules: readCustomRules(project.rootPath),
        // Round-28 WS-F: inject the agent's maxTurns budget into the AGENTIC
        // LOOP section so the model knows how many tool round-trips it has.
        maxTurns: agent.maxTurns,
        // Round-28 WS-G: inject the codebase index summary (if the project
        // has been indexed) so the agent has codebase awareness without
        // needing list_dir + read_file every turn.
        indexSummary: session.projectId !== null ? getIndexSummary(db, session.projectId) ?? undefined : undefined,
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
  const prepared = await prepareTurn(db, keyring, sessionId, modelOverride, chat);
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;

  // First message flips a queued session to running (API.md §5 semantics).
  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content },
  });
  // ROUND-34: history INCLUDES tool results (multi-step fix — Cline parity).
  const rawMessages = assembleHistory(db, session.id);

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
    // Review fix #2: the sync path scrubbed NOTHING before — a custom
    // provider key echoed by run_command env would land in SQLite verbatim.
    const keySecrets = keyring.list();
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: {
        role: "tool",
        toolName: call.name,
        argsSummary: call.argsSummary,
        ok: call.ok,
        ...(call.outputSummary !== undefined
          ? { outputSummary: scrubSecrets(call.outputSummary, keySecrets) }
          : {}),
      },
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
  const { db, keyring, chat, chatStream } = deps;
  // ROUND-34: values the keyring holds — scrubbed from persisted tool output
  // summaries (run_command inherits process.env which carries ACUTE_* keys).
  const keySecrets = keyring.list().filter((v) => v.length >= 8);
  if (chatStream === undefined) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "streaming is not available in this build",
    };
  }
  const prepared = await prepareTurn(db, keyring, sessionId, modelOverride, chat, emit);
  if ("error" in prepared) return prepared.error;
  const { session, agent, provider, apiKey, model, tools, system } = prepared;

  if (session.status === "queued") setSessionStatus(db, session.id, "running");

  appendSessionEvent(db, session.id, {
    type: "message.user",
    agentId: agent.id,
    payload: { role: "user", content },
  });

  const budget: ContextBudget = {
    contextWindow: getModelContextWindow(db, provider.id, model),
    maxOutputTokens: 32_768,
    margin: 8_000,
  };

  // Round-28 WS-F: multi-turn agentic continuation (owner R28 directive:
  // "It should automatically continue… 4, 5, 6, or 7 iterations… research →
  // save files → restart → next research"). The AI SDK's internal multi-step
  // loop (maxTurns tool round-trips) is ONE "SDK call". The OUTER loop here
  // starts a NEW SDK call when the task isn't genuinely complete — the
  // conversation context (with the previous assistant message + tool results)
  // is re-assembled from the event log each iteration.
  const maxOuterLoops = agent.maxOuterLoops ?? 5;
  const startedAt = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalRequests = 0;
  let lastAssistantEvent: { seq: number; ts: string; content: string } | null = null;
  let lastText = "";

  for (let outerIter = 0; outerIter < maxOuterLoops; outerIter++) {
    // Re-assemble messages from the event log — ROUND-34: now WITH tool
    // results, so iteration 2+ sees exactly what its tools did instead of
    // re-planning blind (the multi-step fix).
    const rawMessages = assembleHistory(db, session.id);
    const { messages, usedTokens } = assembleWithinBudget(rawMessages, budget);

    // Context guard (6-f R-F5): abort if assembled context > 800K tokens
    // (the 1M window is a LIMIT, not headroom; 200+ tool round-trips approach
    // 500KB of tool I/O alone).
    if (usedTokens > 800_000) {
      emit({ type: "meta.context_limit", tokens: usedTokens, limit: 800_000 });
      break;
    }
    // Request guard (6-f R-F6): abort if > 200 total requests (OpenRouter
    // rate limits apply even on 0-cost models).
    if (totalRequests > 200) {
      emit({ type: "meta.request_limit", requests: totalRequests, limit: 200 });
      break;
    }

    // Emit a continuation event so the frontend can show "Continuing…" (the
    // streaming bubble from WS-D2 handles this event type).
    if (outerIter > 0) {
      emit({ type: "meta.continuation", iteration: outerIter, reason: "incomplete_todos" });
    }

    let iterText = "";
    let iterThinking = "";
    // ROUND-37: measured thinking duration per segment ("Thought for Ns").
    // Starts at the first reasoning delta; freezes when the segment's text
    // begins (the thought is done the moment the model starts writing).
    let iterThinkingStart: number | null = null;
    let iterThinkingMs: number | null = null;
    let iterAllText = ""; // never reset — completion-signal detection across segments
    let iterInputTokens = 0;
    let iterOutputTokens = 0;
    let iterToolCalls = 0;
    totalRequests++;

    /** ROUND-35 (review fix #5): reasoning can run 10s of KB — cap the
     * persisted thinking at 4000 chars, head+tail like tool outputs. */
    const capThinking = (text: string): string => {
      if (text.length <= 4000) return text;
      const omitted = text.length - 4000;
      return `${text.slice(0, 2000)}\n…[thinking truncated ${omitted} chars]…\n${text.slice(-2000)}`;
    };

    let statsCarrierNeeded = false;

    /** ROUND-35 (owner: tool calls "should show within the chat at the point
     * of the tools being called… afterwards it should continue with the
     * message"): when a tool call arrives mid-message, flush the text-so-far
     * as an interim assistant SEGMENT so the event log (and the UI) renders
     * text → tool work → more text. */
    const flushSegment = (withStats: boolean): boolean => {
      if (iterText.trim() === "" && iterThinking.trim() === "") return false;
      const iterMs = Date.now() - startedAt;
      const thinkingMs =
        iterThinkingMs !== null
          ? iterThinkingMs
          : iterThinkingStart !== null
            ? Date.now() - iterThinkingStart
            : null;
      const ev = appendSessionEvent(db, session.id, {
        type: "message.assistant",
        agentId: agent.id,
        payload: {
          role: "assistant",
          content: iterText,
          ...(iterThinking.trim() !== ""
            ? {
                thinking: capThinking(iterThinking),
                ...(thinkingMs !== null && thinkingMs > 0 ? { thinkingMs } : {}),
              }
            : {}),
          ...(withStats
            ? {
                usage: { inputTokens: iterInputTokens, outputTokens: iterOutputTokens },
                ms: iterMs,
                model,
              }
            : {}),
        },
      });
      if (iterText.trim() !== "") {
        lastAssistantEvent = { seq: ev.seq, ts: ev.ts, content: iterText };
      }
      iterText = "";
      iterThinking = "";
      iterThinkingStart = null;
      iterThinkingMs = null;
      return true;
    };

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
        if (event.type === "tool-result") {
          // handled below with a scrubbed outputSummary — do NOT emit raw.
        } else {
          emit(event);
        }
        if (event.type === "text-delta") {
          // ROUND-37: the first text token completes the in-flight thought —
          // freeze its measured duration ("Thought for Ns").
          if (iterThinkingStart !== null && iterThinkingMs === null) {
            iterThinkingMs = Date.now() - iterThinkingStart;
          }
          iterText += event.delta;
          iterAllText += event.delta;
        } else if (event.type === "thinking-delta") {
          if (iterThinkingStart === null) iterThinkingStart = Date.now();
          iterThinking += event.delta;
        } else if (event.type === "tool-call") {
          iterToolCalls += 1;
          // ROUND-35: flush the message-so-far BEFORE the tool runs, so the
          // tool work lands between message segments (owner directive).
          if (iterText.trim() !== "" || iterThinking.trim() !== "") {
            flushSegment(false);
            statsCarrierNeeded = true; // stats attach at iteration end instead
          }
        } else if (event.type === "tool-result") {
          // Persist each tool call the moment it completes (live ordering).
          // ROUND-34 (review fix #3): scrub the output summary BEFORE it is
          // emitted over SSE AND persisted — the UI must never see secrets.
          const outputSummary =
            event.outputSummary !== undefined
              ? scrubSecrets(event.outputSummary, keySecrets)
              : null;
          // Always emit the tool-result (scrubbed when it carries output) —
          // the UI's live rows key off these events.
          emit({ ...event, ...(outputSummary !== null ? { outputSummary } : {}) });
          appendSessionEvent(db, session.id, {
            type: "tool.use",
            agentId: agent.id,
            payload: {
              role: "tool",
              toolName: event.toolName,
              argsSummary: event.argsSummary,
              ok: event.ok,
              ...(outputSummary !== null ? { outputSummary } : {}),
            },
          });
        } else if (event.type === "finish") {
          iterInputTokens = event.usage.inputTokens;
          iterOutputTokens = event.usage.outputTokens;
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

    totalInputTokens += iterInputTokens;
    totalOutputTokens += iterOutputTokens;
    lastText = iterAllText;

    // ROUND-35: flush the iteration's FINAL segment (with stats). Interim
    // segments were already flushed at each tool call. REVIEW FIX #1: when
    // the iteration's text all preceded the tool calls (no trailing text),
    // the final flush is a NO-OP — append a stats-carrier event (empty
    // content + usage) so the reply badges + ctx meter survive. History
    // skips it (asChatMessage) and the UI merges its stats into the last
    // message (toProjectChatItems).
    const finalFlushed = flushSegment(true);
    if (statsCarrierNeeded && !finalFlushed) {
      const iterMs = Date.now() - startedAt;
      appendSessionEvent(db, session.id, {
        type: "message.assistant",
        agentId: agent.id,
        payload: {
          role: "assistant",
          content: "",
          usage: { inputTokens: iterInputTokens, outputTokens: iterOutputTokens },
          ms: iterMs,
          model,
        },
      });
    }
    statsCarrierNeeded = false;

    // ROUND-33 FIX (owner report: "hello, how are you" kept planning +
    // running tools in an infinite loop): an iteration that produced a text
    // reply with ZERO tool calls is a CONVERSATIONAL response — the model
    // considered the request answered. Continuing would force the model to
    // invent work nobody asked for. Break immediately.
    if (iterToolCalls === 0) {
      break;
    }

    // Inverted continueIfUnfinished (6-e fix — phrase matching was brittle):
    // for tool-using iterations, continue UNLESS BOTH (a) explicit completion
    // signal AND (b) all todos completed.
    const hasCompletionSignal = COMPLETION_SIGNAL.test(iterAllText);
    const todosDone = latestTodosAllDone(db, session.id);
    if (hasCompletionSignal && todosDone) {
      break;
    }
    // Last iteration — emit a cap-reached event so the UI knows.
    if (outerIter === maxOuterLoops - 1) {
      emit({ type: "meta.continuation_complete", iterations: maxOuterLoops });
    }
  }

  const ms = Date.now() - startedAt;

  // If no iteration produced text (edge case: model only called tools with no
  // final message), append an empty assistant marker so the event log closes
  // cleanly + the UI can resolve.
  if (lastAssistantEvent === null) {
    const fallback = appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: {
        role: "assistant",
        content: lastText,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        ms,
        model,
      },
    });
    lastAssistantEvent = { seq: fallback.seq, ts: fallback.ts, content: lastText };
  }

  const usage: UsageRecord = {
    agentId: agent.id,
    sessionId: session.id,
    provider: provider.id,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: computeCost(db, provider.id, model, totalInputTokens, totalOutputTokens),
    ts: lastAssistantEvent.ts,
  };
  recordUsage(db, usage);
  touchSession(db, session.id);

  return {
    ok: true,
    assistantMessage: {
      seq: lastAssistantEvent.seq,
      role: "assistant",
      agentId: agent.id,
      content: lastText,
      ts: lastAssistantEvent.ts,
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
