import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUND-37 (owner: "he can select the API format… Anthropic messages /
 * Chat completion / Responses"): the model-client branch in chat.ts must
 * construct the right SDK provider per the provider row's apiFormat. The
 * three adapter factories are mocked at the module boundary — no network.
 */
const createOpenAICompatibleMock = vi.hoisted(() => vi.fn(() => ({
  chatModel: (model: string) => ({ kind: "openai-compatible", model }),
})));
const createAnthropicMock = vi.hoisted(() => vi.fn(() => (model: string) => ({ kind: "anthropic", model })));
const createOpenAIMock = vi.hoisted(() =>
  vi.fn(() => ({
    responses: (model: string) => ({ kind: "responses", model }),
  })),
);
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

import { aiSdkChat, resolveApiFormat } from "../src/agents/chat";

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    steps: [],
  });
  createOpenAICompatibleMock.mockClear();
  createAnthropicMock.mockClear();
  createOpenAIMock.mockClear();
});

const baseInput = {
  apiKey: "sk-test",
  model: "test/model-1",
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.2,
  maxTurns: 4,
};

describe("resolveApiFormat (ROUND-37)", () => {
  it("maps known formats and falls back to chat-completions", () => {
    expect(resolveApiFormat("chat-completions")).toBe("chat-completions");
    expect(resolveApiFormat("anthropic-messages")).toBe("anthropic-messages");
    expect(resolveApiFormat("responses")).toBe("responses");
    expect(resolveApiFormat(undefined)).toBe("chat-completions");
    expect(resolveApiFormat("gibberish")).toBe("chat-completions");
  });
});

describe("aiSdkChat apiFormat branch (ROUND-37)", () => {
  it("chat-completions (default) builds an openai-compatible client", async () => {
    await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    expect(createAnthropicMock).not.toHaveBeenCalled();
    expect(createOpenAIMock).not.toHaveBeenCalled();
    expect(generateTextMock.mock.calls[0][0].model).toEqual({ kind: "openai-compatible", model: "test/model-1" });
  });

  it("anthropic-messages builds the Anthropic client", async () => {
    await aiSdkChat({
      ...baseInput,
      provider: { id: "custom-anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic-messages" },
    });
    expect(createAnthropicMock).toHaveBeenCalledTimes(1);
    expect(createAnthropicMock).toHaveBeenCalledWith({
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-test",
    });
    expect(generateTextMock.mock.calls[0][0].model).toEqual({ kind: "anthropic", model: "test/model-1" });
  });

  it("responses builds the OpenAI Responses client", async () => {
    await aiSdkChat({
      ...baseInput,
      provider: { id: "openai-proxy", baseUrl: "https://api.openai.com/v1", apiFormat: "responses" },
    });
    expect(createOpenAIMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].model).toEqual({ kind: "responses", model: "test/model-1" });
  });
});
