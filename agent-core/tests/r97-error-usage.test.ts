/**
 * ROUND-97 (R97-E) — the PARTIAL USAGE a failed stream carries.
 *
 * The owner: "if a model fails, then it does not show me the total number of
 * tokens sent, total number of tokens received, and such info. It should show
 * that info properly."
 *
 * Coverage:
 *  · A mid-stream failure AFTER usage-bearing finish-steps carries the
 *    accumulated so-far on the thrown error (readStreamPartialUsage reads it).
 *  · A failure BEFORE any usage accumulates carries null (the card then
 *    honestly renders no token line).
 *  · The silent-truncation throw (zero finish-steps + content deltas) also
 *    carries whatever per-step usage accumulated (the wrap covers it).
 */
import { describe, afterEach, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));
// The r95-thinking-levels idiom: the provider constructors are mocked so no
// network path can exist (the adapter's buildModel path resolves through them).
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

import { readStreamPartialUsage, streamAiSdkChat } from "../src/agents/chat";

const streamInput = {
  apiKey: "sk-test",
  model: "test/model-1",
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.2,
  maxTurns: 4,
  provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  thinkingLoop: { enabled: false, stallMs: 120_000, reasoningBytes: 24_000 },
};

function mockStream(parts: Array<Record<string, unknown>>): void {
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R97-E: readStreamPartialUsage (the failed call's real spend)", () => {
  it("a mid-stream failure AFTER usage-bearing finish-steps carries the accumulated totals", async () => {
    mockStream([
      { type: "text-delta", text: "working on it" },
      {
        type: "finish-step",
        usage: { inputTokens: 1_500, outputTokens: 120, inputTokenDetails: { cacheReadTokens: 0 } },
      },
      { type: "text-delta", text: "more work" },
      {
        type: "finish-step",
        usage: { inputTokens: 2_300, outputTokens: 340, inputTokenDetails: { cacheReadTokens: 0 } },
      },
      { type: "text-delta", text: "still going" },
      // The failure — the SDK surfaces it as an error part.
      { type: "error", error: new Error("provider 503 mid-stream") },
    ]);
    let caught: unknown = null;
    try {
      for await (const _ of streamAiSdkChat(streamInput)) {
        void _;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // The so-far: 1500+2300 in, 120+340 out — the owner's tokens line.
    expect(readStreamPartialUsage(caught)).toEqual({ inputTokens: 3_800, outputTokens: 460 });
  });

  it("a failure BEFORE any usage accumulates carries null (no fabricated zeros)", async () => {
    mockStream([
      { type: "text-delta", text: "starting" },
      { type: "error", error: new Error("immediate 401") },
    ]);
    let caught: unknown = null;
    try {
      for await (const _ of streamAiSdkChat(streamInput)) {
        void _;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // null — the card renders NO token line rather than a fake 0/0.
    expect(readStreamPartialUsage(caught)).toBeNull();
  });

  it("the silent-truncation throw reads null too — zero finish-steps means zero per-step usage BY DEFINITION", async () => {
    // The R80 truncation guard fires only when NO step ever finished — and
    // per-step usage arrives ON finish-steps, so the truncation error can
    // never carry non-zero usage. The pin: it reads null (no fake 0/0 line).
    mockStream([
      { type: "text-delta", text: "partial answer…" },
      // ...and the stream just ends (no finish-step, no error part).
    ]);
    let caught: unknown = null;
    try {
      for await (const _ of streamAiSdkChat(streamInput)) {
        void _;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("truncated output");
    expect(readStreamPartialUsage(caught)).toBeNull();
  });

  it("a non-adapter error reads null (never fabricates)", () => {
    expect(readStreamPartialUsage(new Error("from elsewhere"))).toBeNull();
    expect(readStreamPartialUsage("a string throw")).toBeNull();
    expect(readStreamPartialUsage(null)).toBeNull();
  });
});
