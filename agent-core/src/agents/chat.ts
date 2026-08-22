/**
 * Thin adapter over the Vercel AI SDK. The runtime depends only on the ChatFn
 * shape, so tests drive turns with a stub (or a module mock of "ai") instead
 * of the network, and this module is the single place that knows SDK types.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";

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
}

export interface ChatTurnOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export type ChatFn = (input: ChatTurnInput) => Promise<ChatTurnOutput>;

/** The production ChatFn: OpenAI-compatible endpoint via the AI SDK, no tools yet. */
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
    // AI SDK v7 replaced maxSteps with stopWhen(stepCountIs(n)); tools arrive
    // in a later wave, so this only bounds future multi-step loops.
    stopWhen: stepCountIs(Math.max(1, input.maxTurns)),
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
  };
};
