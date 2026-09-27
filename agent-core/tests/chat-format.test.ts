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
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  // ROUND-50 (R50-b): streamAiSdkChat's maxRetries pin needs the streaming
  // entry point mocked too (previously unused in this suite).
  streamText: streamTextMock,
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

import { aiSdkChat, resolveApiFormat, streamAiSdkChat } from "../src/agents/chat";

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    steps: [],
  });
  streamTextMock.mockReset();
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {})(),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
  }));
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

describe("openrouter free-model fallback chain (ROUND-43)", () => {
  it("rewrites :free model requests to a models fallback array [model, openrouter/free]", async () => {
    const captured: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    try {
      const { buildModelFallbackFetch } = await import("../src/agents/chat");
      const wrapped = buildModelFallbackFetch();
      await wrapped("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "z-ai/glm-5.2:free", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(captured).toHaveLength(1);
      const first = JSON.parse(captured[0]) as Record<string, unknown>;
      expect(first.model).toBeUndefined();
      expect(first.models).toEqual(["z-ai/glm-5.2:free", "openrouter/free"]);
      // non-JSON body passes through untouched
      await wrapped("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "not-json{{" });
      expect(captured[1]).toBe("not-json{{");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("provider call timeout (ROUND-46)", () => {
  it("aiSdkChat wires a bounded abortSignal (default 10 min; timeoutMs override respected)", async () => {
    await aiSdkChat({ ...baseInput, provider: { id: "p", baseUrl: null } });
    const call = generateTextMock.mock.calls[0][0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(call.abortSignal?.aborted).toBe(false);

    // The default signal stays un-aborted far past the test's lifetime; a
    // 1ms override aborts almost immediately (AbortSignal.timeout semantics).
    await aiSdkChat({ ...baseInput, provider: { id: "p", baseUrl: null }, timeoutMs: 1 });
    const timed = generateTextMock.mock.calls[1][0] as { abortSignal?: AbortSignal };
    expect(timed.abortSignal).toBeInstanceOf(AbortSignal);
    await new Promise((r) => setTimeout(r, 15));
    expect(timed.abortSignal?.aborted).toBe(true);
  });
});

describe("retry policy (ROUND-50 — owner's third Windows test: \"at least five attempts\")", () => {
  it("aiSdkChat passes maxRetries: 4 to generateText (1 initial + 4 retries = 5 attempts)", async () => {
    await aiSdkChat({ ...baseInput, provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    // The AI SDK default is maxRetries: 2 (3 total attempts) — the exact
    // "failed after three attempts" the owner hit on OpenRouter 429s.
    expect(generateTextMock.mock.calls[0][0].maxRetries).toBe(4);
  });

  it("streamAiSdkChat passes maxRetries: 4 to streamText (same five-attempt policy on the streamed path)", async () => {
    const events: string[] = [];
    for await (const event of streamAiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    })) {
      events.push(event.type);
    }
    // The empty mock stream still closes cleanly with one finish frame.
    expect(events).toEqual(["finish"]);
    expect(streamTextMock.mock.calls[0][0].maxRetries).toBe(4);
  });
});

// ── ROUND-50 (R50-c1): the composer's thinking level ────────────────────────

describe("buildThinkingFetch (ROUND-50 R50-c1 — reasoning.effort injection)", () => {
  /** Body-capturing mock fetch: records the outgoing JSON bodies verbatim. */
  function capturingFetch(): { fetchMock: ReturnType<typeof vi.fn>; bodies: string[] } {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    return { fetchMock, bodies };
  }

  it.each([
    ["low", "low"],
    ["high", "high"],
    ["max", "max"],
  ])("level %s injects reasoning.effort: %s into the outgoing chat-completions body", async (level, effort) => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { buildThinkingFetch } = await import("../src/agents/chat");
      await buildThinkingFetch(level as "low" | "high" | "max")(
        "https://openrouter.ai/api/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) },
      );
      expect(bodies).toHaveLength(1);
      const body = JSON.parse(bodies[0]) as { reasoning?: { effort?: string }; model: string };
      expect(body.reasoning).toEqual({ effort });
      // The rest of the body is untouched.
      expect(body.model).toBe("m");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges with an existing reasoning object instead of clobbering provider-set fields", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { buildThinkingFetch } = await import("../src/agents/chat");
      await buildThinkingFetch("high")("https://x.test/v1", {
        method: "POST",
        body: JSON.stringify({ reasoning: { max_tokens: 4096 }, model: "m" }),
      });
      const body = JSON.parse(bodies[0]) as { reasoning?: Record<string, unknown> };
      expect(body.reasoning).toEqual({ max_tokens: 4096, effort: "high" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("non-JSON bodies pass through untouched (no throw, no mutation)", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { buildThinkingFetch } = await import("../src/agents/chat");
      await buildThinkingFetch("max")("https://x.test/v1", { method: "POST", body: "not-json{{" });
      expect(bodies[0]).toBe("not-json{{");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("composes OVER an inner fetch (the openrouter free-model fallback wrapper runs under it)", async () => {
    const innerCalls: string[] = [];
    const inner = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      innerCalls.push(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    const { buildThinkingFetch } = await import("../src/agents/chat");
    // ROUND-95 (R95-E): the signature gained the `support` parameter between
    // level and inner — undefined here keeps the UNKNOWN-support behavior the
    // original composition test pinned.
    const wrapped = buildThinkingFetch("low", undefined, inner);
    await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.2:free", messages: [] }),
    });
    expect(inner).toHaveBeenCalledTimes(1);
    // The inner wrapper receives the ALREADY-thinking-injected body: the
    // effort is present AND the fallback rewrite can still happen on top.
    const body = JSON.parse(innerCalls[0]) as { reasoning?: { effort?: string }; model: string };
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.model).toBe("z-ai/glm-5.2:free");
  });
});

describe("buildModel thinking wiring (ROUND-50 R50-c1)", () => {
  it("a non-default thinkingLevel wraps the provider fetch (reasoning.effort); default/absent injects NOTHING", async () => {
    // Non-default level → a fetch wrapper IS handed to createOpenAICompatible.
    await aiSdkChat({
      ...baseInput,
      provider: { id: "prov", baseUrl: "https://api.prov.test/v1" },
      thinkingLevel: "high",
    });
    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    const withLevel = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as { fetch?: unknown };
    expect(typeof withLevel.fetch).toBe("function");

    // "default" → no THINKING wrapper; ROUND-96 (R96-J): the app-attribution
    // wrapper is ALWAYS present (every outbound call identifies the app —
    // see chat.ts withAppAttribution), so fetch is now defined but carries
    // NO body rewriting (the R50 contract holds: nothing injected).
    createOpenAICompatibleMock.mockClear();
    await aiSdkChat({
      ...baseInput,
      provider: { id: "prov", baseUrl: "https://api.prov.test/v1" },
      thinkingLevel: "default",
    });
    const atDefault = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as { fetch?: unknown };
    expect(typeof atDefault.fetch).toBe("function");

    // absent → same as default.
    createOpenAICompatibleMock.mockClear();
    await aiSdkChat({ ...baseInput, provider: { id: "prov", baseUrl: "https://api.prov.test/v1" } });
    const absent = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as { fetch?: unknown };
    expect(typeof absent.fetch).toBe("function");

    // anthropic-messages / responses formats silently skip the level (no
    // reasoning-effort passthrough wired there — honest limitation).
    await aiSdkChat({
      ...baseInput,
      provider: { id: "anth", baseUrl: "https://api.anthropic.test/v1", apiFormat: "anthropic-messages" },
      thinkingLevel: "max",
    });
    expect(createAnthropicMock).toHaveBeenCalledWith({
      baseURL: "https://api.anthropic.test/v1",
      apiKey: "sk-test",
    });
  });

  it("the wrapped fetch really injects reasoning.effort per level into the wire body", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    try {
      for (const level of ["low", "high", "max"] as const) {
        createOpenAICompatibleMock.mockClear();
        await aiSdkChat({
          ...baseInput,
          provider: { id: "prov", baseUrl: "https://api.prov.test/v1" },
          thinkingLevel: level,
        });
        const config = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as {
          fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
        };
        await config.fetch("https://api.prov.test/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "m", messages: [] }),
        });
        const body = JSON.parse(bodies[bodies.length - 1]) as { reasoning?: { effort?: string } };
        expect(body.reasoning?.effort).toBe(level);
      }
      // "default" injects nothing — the body flows through untouched.
      createOpenAICompatibleMock.mockClear();
      await aiSdkChat({
        ...baseInput,
        provider: { id: "prov", baseUrl: "https://api.prov.test/v1" },
        thinkingLevel: "default",
      });
      const config = (createOpenAICompatibleMock.mock.calls[0] as unknown[])[0] as { fetch?: unknown };
      // ROUND-96 (R96-J): the attribution wrapper is always present now.
      expect(typeof config.fetch).toBe("function");
      const plain = JSON.stringify({ model: "m", messages: [] });
      expect(bodies[bodies.length - 1]).not.toBe(plain); // last captured was a "max" call
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── ROUND-50 (R50-c1): cached prompt-token capture (context meter) ──────────

describe("cachedInputTokens capture (ROUND-50 R50-c1)", () => {
  it("aiSdkChat maps usage.inputTokenDetails.cacheReadTokens onto the turn output (absent → omitted)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: {
        inputTokens: 50_000,
        outputTokens: 2,
        totalTokens: 50_002,
        inputTokenDetails: { cacheReadTokens: 41_000 },
      },
      steps: [],
    });
    const result = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(result.usage.cachedInputTokens).toBe(41_000);

    // No cached tier reported → the field is omitted (not 0 — providers
    // without a cache legitimately have no value; storage maps it to NULL).
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      steps: [],
    });
    const plain = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(plain.usage.cachedInputTokens).toBeUndefined();
  });

  it("streamAiSdkChat carries cachedInputTokens on the finish frame (per-step + totals cross-check)", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          usage: {
            inputTokens: 50_000,
            outputTokens: 10,
            inputTokenDetails: { cacheReadTokens: 41_000 },
          },
        };
      })(),
      totalUsage: Promise.resolve({
        inputTokens: 50_000,
        outputTokens: 10,
        totalTokens: 50_010,
        inputTokenDetails: { cacheReadTokens: 41_000 },
      }),
      usage: Promise.resolve({
        inputTokens: 50_000,
        outputTokens: 10,
        totalTokens: 50_010,
        inputTokenDetails: { cacheReadTokens: 41_000 },
      }),
    }));
    const finish = await (async () => {
      for await (const event of streamAiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      })) {
        if (event.type === "finish") return event;
      }
      throw new Error("no finish frame");
    })();
    expect(finish.usage.inputTokens).toBe(50_000);
    expect(finish.cachedInputTokens).toBe(41_000);

    // Larger-of-the-two rule: a step reports MORE cached tokens than the
    // (empty) totals — the max wins.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          usage: { inputTokens: 100, outputTokens: 1, inputTokenDetails: { cacheReadTokens: 90 } },
        };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 1, totalTokens: 101 }),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 1, totalTokens: 101 }),
    }));
    const noTotals = await (async () => {
      for await (const event of streamAiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      })) {
        if (event.type === "finish") return event;
      }
      throw new Error("no finish frame");
    })();
    expect(noTotals.cachedInputTokens).toBe(90);

    // Nothing reported anywhere → 0 on the frame (the runtime records 0).
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 1 } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
    }));
    const zero = await (async () => {
      for await (const event of streamAiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      })) {
        if (event.type === "finish") return event;
      }
      throw new Error("no finish frame");
    })();
    expect(zero.cachedInputTokens).toBe(0);
  });
});

/* ── R131-T (Wave T): the finish frame's two truths — context vs billing ──────
 *
 * The owner's v0.123.0 device pass: "even though the context was, like
 * roughly 200K, or maybe sometimes 30K, 40K… but the actual which it was
 * showing me on the context window itself was like around 900K… as soon as
 * the context message session ended, it properly started showing me the
 * correct, accurate one." ONE chatStream() call is ONE streamText whose
 * internal tool loop RE-SENDS the whole history every step — the finish
 * frame's usage block used to carry the ACCUMULATED input (N_steps ×
 * context), which the runtime persisted as the stats carrier the context
 * meter AND the compaction gate anchor on mid-turn. R131-T splits the two
 * truths at this seam:
 *   · usage       = the LAST step's own input+output (the context truth —
 *                   what a follow-up request would re-send);
 *   · turnUsage   = the call's cumulative spend (the billing truth — the
 *                   runtime's totalInputTokens + the usage_events row).
 */
describe("R131-T: streamAiSdkChat finish frame — the LAST step is the context truth, the SUM is the billing truth", () => {
  /** Drain a streamAiSdkChat call and return its finish frame. */
  const finishOf = async () => {
    for await (const event of streamAiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    })) {
      if (event.type === "finish") return event;
    }
    throw new Error("no finish frame");
  };

  it("a 3-step tool stream: usage carries the 3rd step's input (NOT the sum); turnUsage keeps the call's cumulative spend", async () => {
    // The owner's exact shape, compressed: a ~200K-context session where the
    // SDK's internal tool loop ran 3 provider requests. Each step RE-SENT
    // the whole history, so the inputs climb 200_000 → 200_200 → 200_400.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "working" };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_000, outputTokens: 900, inputTokenDetails: { cacheReadTokens: 120_000 } },
        };
        yield { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.txt" } };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_200, outputTokens: 1_100, inputTokenDetails: { cacheReadTokens: 130_000 } },
        };
        yield { type: "text-delta", text: "done" };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_400, outputTokens: 1_500, inputTokenDetails: { cacheReadTokens: 150_000 } },
        };
      })(),
      // The SDK's accumulated totalUsage (v7: aggregated across all steps).
      totalUsage: Promise.resolve({
        inputTokens: 600_600,
        outputTokens: 3_500,
        totalTokens: 604_100,
        inputTokenDetails: { cacheReadTokens: 400_000 },
      }),
      usage: Promise.resolve({
        inputTokens: 600_600,
        outputTokens: 3_500,
        totalTokens: 604_100,
        inputTokenDetails: { cacheReadTokens: 400_000 },
      }),
    }));
    const finish = await finishOf();
    // THE CONTEXT TRUTH — the meter's 200K story, not the 900K lie: the
    // frame's usage is the LAST (3rd) request's own numbers.
    expect(finish.usage.inputTokens).toBe(200_400);
    expect(finish.usage.outputTokens).toBe(1_500);
    expect(finish.usage.totalTokens).toBe(201_900);
    // The newest request's OWN cached tier (not the call-wide sum).
    expect(finish.cachedInputTokens).toBe(150_000);
    // THE BILLING TRUTH — the call's cumulative spend rides the additive
    // turnUsage: the runtime's totalInputTokens accumulation + the turn's
    // usage_events row keep the SUM (the spend was real; only its old
    // double-duty as "context at last request" was the defect).
    expect(finish.turnUsage).toEqual({
      inputTokens: 600_600,
      outputTokens: 3_500,
      cachedInputTokens: 400_000,
    });
  });

  it("a SINGLE-step stream stays byte-identical: usage === turnUsage === the pre-R131 larger-of-the-two-sources formula", async () => {
    // One step reporting MORE than the (empty) totals — the max wins, and
    // both truths are the SAME number (there is only one request).
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hi" };
        yield {
          type: "finish-step",
          usage: { inputTokens: 50_000, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 41_000 } },
        };
      })(),
      // totalUsage resolves empty (no totalTokens either) — the
      // larger-of-the-two-sources rule: the step's numbers win.
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }));
    const finish = await finishOf();
    expect(finish.usage).toEqual({ inputTokens: 50_000, outputTokens: 10, totalTokens: 50_010 });
    expect(finish.cachedInputTokens).toBe(41_000);
    expect(finish.turnUsage).toEqual({
      inputTokens: 50_000,
      outputTokens: 10,
      cachedInputTokens: 41_000,
    });
  });

  it("multi-step with usage ONLY on totalUsage: the frame carries the honest UNKNOWN (0/0) — the cumulative input never masquerades as context again", async () => {
    // Two steps whose usage objects carry no numbers (a provider that
    // reports nothing per step) + a real totalUsage. The SUM cannot be
    // decomposed into "the newest request's input", so the context truth is
    // UNKNOWN: 0/0 (the runtime's carriers then omit the usage block and
    // the meter keeps the last REAL measurement — the R130-C1 absence
    // encoding), while billing keeps the real spend on turnUsage.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "b.txt" } };
        yield { type: "finish-step", usage: {} };
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 8_100, outputTokens: 90, totalTokens: 8_190 }),
      usage: Promise.resolve({ inputTokens: 8_100, outputTokens: 90, totalTokens: 8_190 }),
    }));
    const finish = await finishOf();
    expect(finish.usage.inputTokens).toBe(0);
    expect(finish.usage.outputTokens).toBe(0);
    expect(finish.turnUsage?.inputTokens).toBe(8_100);
    expect(finish.turnUsage?.outputTokens).toBe(90);
  });

  it("the LAST USAGE-BEARING step wins: a trailing usage-less step leaves the prior step's truth standing", async () => {
    // Steps 1-2 report real numbers; the 3rd step's usage object carries
    // none (providerUsageAnchor's own law — only a finite inputTokens
    // anchors). The newest REQUEST's usage is unknown, but the newest
    // KNOWN measurement is step 2's: that is what the meter should show
    // (never the SUM).
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_000, outputTokens: 900, inputTokenDetails: { cacheReadTokens: 120_000 } },
        };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_200, outputTokens: 1_100, inputTokenDetails: { cacheReadTokens: 130_000 } },
        };
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 400_200, outputTokens: 2_000, totalTokens: 402_200 }),
      usage: Promise.resolve({ inputTokens: 400_200, outputTokens: 2_000, totalTokens: 402_200 }),
    }));
    const finish = await finishOf();
    expect(finish.usage.inputTokens).toBe(200_200);
    expect(finish.usage.outputTokens).toBe(1_100);
    expect(finish.cachedInputTokens).toBe(130_000);
    expect(finish.turnUsage?.inputTokens).toBe(400_200);
    expect(finish.turnUsage?.outputTokens).toBe(2_000);
  });
});

/* ── R131-T (Wave T): the SYNC twin — ChatTurnOutput.contextUsage ──────────── */
describe("R131-T: aiSdkChat contextUsage — the last generateText step is the sync path's context truth", () => {
  it("a multi-step call reports the LAST step's own usage as contextUsage; usage keeps the aggregated total (billing)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "did the work",
      // generateText's aggregated usage across all steps — the SUM.
      usage: { inputTokens: 40_200, outputTokens: 2_000, totalTokens: 42_200 },
      steps: [
        { usage: { inputTokens: 20_000, outputTokens: 1_000 } },
        { usage: { inputTokens: 20_200, outputTokens: 1_000 } },
      ],
    });
    const result = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    // Billing truth unchanged.
    expect(result.usage.inputTokens).toBe(40_200);
    expect(result.usage.outputTokens).toBe(2_000);
    // Context truth: the LAST (2nd) step's own numbers.
    expect(result.contextUsage).toEqual({ inputTokens: 20_200, outputTokens: 1_000 });
  });

  it("SINGLE-step calls omit contextUsage — every consumer falls back to usage byte-identically (the settled path)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 12_000, outputTokens: 300, totalTokens: 12_300 },
      steps: [{ usage: { inputTokens: 12_000, outputTokens: 300 } }],
    });
    const single = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(single.contextUsage).toBeUndefined();
    expect(single.usage.inputTokens).toBe(12_000);

    // Steps-less mocks/stubs (the pre-R131 mock shape) stay omitted too.
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      steps: [],
    });
    const stepsLess = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(stepsLess.contextUsage).toBeUndefined();
  });

  it("a multi-step call whose last step reports no numbers: contextUsage is the honest UNKNOWN 0/0 (never the aggregated sum)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "tools only",
      usage: { inputTokens: 31_000, outputTokens: 500, totalTokens: 31_500 },
      steps: [{ usage: { inputTokens: 30_000, outputTokens: 400 } }, { usage: {} }],
    });
    const result = await aiSdkChat({
      ...baseInput,
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(result.usage.inputTokens).toBe(31_000);
    // 0/0 — the runtime's carrier persists it and the meter's garbage-row
    // guards skip it (the last REAL measurement stands); the cumulative
    // 31_000 must never become "context at last request".
    expect(result.contextUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

/* ── ROUND-75 (R75): the live 429 find — error PARTS re-thrown ──────────────── */

describe("R75: streamAiSdkChat re-throws the SDK's error PARTS (the real rate-limit path)", () => {
  it("an {type:'error'} fullStream part THROWS the original error — not the generic no-output rejection", async () => {
    const realError = new Error("Rate limit exceeded: too many requests (429)");
    (realError as Error & { statusCode?: number }).statusCode = 429;
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial " };
        // The SDK's shape for a mid-stream failure: the error rides a PART
        // (agentic steps with tools deliver provider errors this way), not
        // an iterator throw.
        yield { type: "error", error: realError };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    }));

    // Consume the async generator — the re-throw surfaces mid-iteration.
    const consume = async (): Promise<unknown> => {
      for await (const _ of streamAiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
        messages: [{ role: "user", content: "hi" }],
      })) {
        void _;
      }
      return "completed";
    };
    await expect(consume()).rejects.toBe(realError);
  });

  it("the re-thrown error classifies as rate_limit — the retry ladder engages on REAL provider 429s", async () => {
    const realError = new Error("Failed after 5 attempts. Last error: AI_APICallError: Rate limit exceeded: too many requests");
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "error", error: realError };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    }));

    // The classifier (the runtime catch's first step) reads the message —
    // the RetryError's embedded provider text matches the rate-limit
    // patterns even though the status code lives on the inner error.
    const { classifyProviderError } = await import("../src/agents/error-classification");
    const classification = classifyProviderError(realError);
    expect(classification.class).toBe("rate_limit");

    const consume = async (): Promise<unknown> => {
      for await (const _ of streamAiSdkChat({
        ...baseInput,
        provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
        messages: [{ role: "user", content: "hi" }],
      })) {
        void _;
      }
      return "completed";
    };
    await expect(consume()).rejects.toBe(realError);
  });
});
