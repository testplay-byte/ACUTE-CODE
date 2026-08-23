/**
 * Thin adapter over the Vercel AI SDK. The runtime depends only on the ChatFn
 * shape, so tests drive turns with a stub (or a module mock of "ai") instead
 * of the network, and this module is the single place that knows SDK types.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, type ToolSet } from "ai";

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatTurnInput {
  provider: { id: string; baseUrl: string | null };
  apiKey: string;
  model: string;
  system: string;
  messages: ChatTurnMessage[];
  temperature: number;
  maxTurns: number;
  /** Agentic Coding MVP: project file tools (list/read/write/edit) when the session has a project. */
  tools?: ToolSet;
}

export interface ChatToolCall {
  name: string;
  argsSummary: string;
  ok: boolean;
}

export interface ChatTurnOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Executed tool calls in order (empty when no tools were provided/used). */
  toolCalls: ChatToolCall[];
}

export type ChatFn = (input: ChatTurnInput) => Promise<ChatTurnOutput>;

/** The production ChatFn: OpenAI-compatible endpoint via the AI SDK, agentic tools when given. */
export const aiSdkChat: ChatFn = async (input) => {
  const provider = createOpenAICompatible({
    name: input.provider.id,
    baseURL: input.provider.baseUrl ?? "",
    apiKey: input.apiKey,
    includeUsage: true,
  });
  const result = await generateText({
    model: provider.chatModel(input.model),
    system: input.system === "" ? undefined : input.system,
    messages: input.messages,
    temperature: input.temperature,
    // Multi-step agentic loop: each tool round-trip is one step.
    stopWhen: stepCountIs(Math.max(1, input.maxTurns)),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  });
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  return {
    text: result.text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
    },
    toolCalls: extractToolCalls(result.steps),
  };
};

/** Flatten per-step tool results into an ordered audit list for the event log. */
function extractToolCalls(steps: Array<unknown>): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!Array.isArray(steps)) return calls;
  for (const step of steps) {
    const responses = (step as { toolResults?: Array<{ toolName?: unknown; input?: unknown; output?: unknown }> })
      .toolResults;
    if (!Array.isArray(responses)) continue;
    for (const r of responses) {
      if (typeof r.toolName !== "string") continue;
      calls.push({
        name: r.toolName,
        argsSummary: summarizeArgs(r.input),
        ok:
          typeof r.output === "object" && r.output !== null && "ok" in r.output
            ? Boolean((r.output as { ok: unknown }).ok)
            : true,
      });
    }
  }
  return calls;
}

/** Compact, log-safe argument summary (paths yes; full file contents no). */
function summarizeArgs(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const args = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    if ((key === "content" || key === "newString") && value.length > 0) {
      parts.push(`${key}: ${value.length} chars`);
      continue;
    }
    parts.push(`${key}: ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`);
  }
  return parts.join(", ");
}


// ─────────────────────────────────────────────────────────────────────────────
// Streaming variant (round-16: live responses in the chat UI)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized streaming event — the runtime/SSE layer never sees SDK types. */
export type StreamChatEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | { type: "tool-result"; toolName: string; argsSummary: string; ok: boolean }
  | { type: "finish"; usage: { inputTokens: number; outputTokens: number; totalTokens: number } };

export interface StreamChatInput extends ChatTurnInput {
  signal?: AbortSignal;
}

export type StreamChatFn = (input: StreamChatInput) => AsyncGenerator<StreamChatEvent>;

/**
 * Production streaming adapter: streamText over the same openai-compatible
 * provider, multi-step (tool round-trips) like generateText. fullStream parts
 * are normalized; usage = awaited totals CROSS-CHECKED against per-step
 * finish usage sums (some provider streams report usage only per step, and
 * totalUsage can resolve empty — take the larger of the two sources).
 */
export const streamAiSdkChat: StreamChatFn = async function* (input) {
  const provider = createOpenAICompatible({
    name: input.provider.id,
    baseURL: input.provider.baseUrl ?? "",
    apiKey: input.apiKey,
    includeUsage: true,
  });
  const result = streamText({
    model: provider.chatModel(input.model),
    system: input.system === "" ? undefined : input.system,
    messages: input.messages,
    temperature: input.temperature,
    stopWhen: stepCountIs(Math.max(1, input.maxTurns)),
    abortSignal: input.signal,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  });

  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let stepInput = 0;
  let stepOutput = 0;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      yield { type: "text-delta", delta: part.text };
    } else if (part.type === "tool-call") {
      const argsSummary = summarizeArgs(part.input);
      yield { type: "tool-call", toolName: part.toolName, argsSummary };
    } else if (part.type === "tool-result") {
      const output = part.output as unknown;
      const ok =
        typeof output === "object" && output !== null && "ok" in output
          ? Boolean((output as { ok: unknown }).ok)
          : true;
      yield {
        type: "tool-result",
        toolName: part.toolName,
        argsSummary: summarizeArgs(part.input),
        ok,
      };
    } else if (part.type === "finish-step") {
      const stepUsage = (part as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      if (stepUsage) {
        stepInput += stepUsage.inputTokens ?? 0;
        stepOutput += stepUsage.outputTokens ?? 0;
      }
    }
  }
  const totals = (await result.totalUsage) ?? (await result.usage);
  usage.inputTokens = Math.max(totals.inputTokens ?? 0, stepInput);
  usage.outputTokens = Math.max(totals.outputTokens ?? 0, stepOutput);
  usage.totalTokens = totals.totalTokens ?? usage.inputTokens + usage.outputTokens;
  yield { type: "finish", usage };
};
