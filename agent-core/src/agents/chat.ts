/**
 * Thin adapter over the Vercel AI SDK. The runtime depends only on the ChatFn
 * shape, so tests drive turns with a stub (or a module mock of "ai") instead
 * of the network, and this module is the single place that knows SDK types.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type ToolSet } from "ai";

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

