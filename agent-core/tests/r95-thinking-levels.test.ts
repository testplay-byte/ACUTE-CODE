/**
 * ROUND-95 (R95-E) tests — model-aware thinking levels + the thinking-loop
 * guard.
 *
 * The owner's two reports, verbatim:
 *  (1) "The reasoning level… was supposed to be model-specific. Multiple
 *      models have different thinking levels… Our program should be able to
 *      properly detect the models' thinking options, like which options it
 *      supports and such."
 *  (2) "The models would apparently get stuck in the thinking loop. The
 *      models will be stuck in thinking. They will think for way too long,
 *      more than they even need to, and they won't even get out of the
 *      thinking."
 *
 * Coverage:
 *  · buildThinkingFetch capability awareness: UNKNOWN support → the R50
 *    verbatim injection (no budget); supported:false → NO reasoning key at
 *    all; a detected ladder → the effort MAPPED onto it + the per-level
 *    reasoning.max_tokens budget (never clobbering a provider-set value).
 *  · mapThinkingLevelToEffort: max rides the highest rung; an unsupported
 *    level falls to the nearest lower one; no lower rung → the lowest.
 *  · The streamed thinking-loop watchdog (streamAiSdkChat): endless
 *    reasoning-deltas past BOTH thresholds (120s + 24KB) throw
 *    ThinkingLoopError; text progress resets the window; neither threshold
 *    alone fires it.
 *  · The classifier: ThinkingLoopError → the new `thinking_loop` class,
 *    which is NOT transient for the R75 wait ladder.
 *  · The runtime's streamed DE-ESCALATING retry: one ThinkingLoopError
 *    retries immediately with the thinking level forced down (high → low;
 *    an already-low level → default = reasoning excluded), visible as a
 *    meta.retry card whose reason names the loop and the downgrade; a
 *    SECOND ThinkingLoopError fails honestly (terminal 502, attempts 2,
 *    persisted turn.error).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAICompatibleMock = vi.hoisted(() => vi.fn(() => ({
  chatModel: (model: string) => ({ kind: "openai-compatible", model }),
})));
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  // jsonSchema passes through as-is (the orchestrator-test idiom): the
  // RUNTIME integration tests below run prepareTurn → buildProjectTools,
  // whose filesystem tools wrap their input schemas with it — the mock
  // must provide it or createTools dies on a non-function.
  jsonSchema: <T>(schema: T) => schema,
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

import {
  buildThinkingFetch,
  mapThinkingLevelToEffort,
  REASONING_BUDGET_BY_LEVEL,
  streamAiSdkChat,
  ThinkingLoopError,
  THINKING_STALL_MS,
  THINKING_STALL_REASONING_BYTES,
} from "../src/agents/chat";
import { classifyProviderError, isTransientApiFailure } from "../src/agents/error-classification";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import type { ModelReasoningSupport, ThinkingLevel } from "shared";

const KEY = "sk-r95e-thinking";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r95e-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  streamTextMock.mockReset();
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {})(),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
  }));
  createOpenAICompatibleMock.mockClear();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Body-capturing mock fetch: records the outgoing JSON bodies verbatim. */
function capturingFetch(): { fetchMock: ReturnType<typeof vi.fn>; bodies: string[] } {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { fetchMock, bodies };
}

const baseBody = (): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
});

function reasoning(efforts: string[]): ModelReasoningSupport {
  return { supported: true, efforts: efforts as ModelReasoningSupport["efforts"] };
}

/* ── buildThinkingFetch: the capability-aware injection ────────────────────── */

describe("R95-E: buildThinkingFetch (support-aware reasoning injection)", () => {
  it("UNKNOWN support → the R50 behavior byte-for-byte: effort verbatim, NO budget", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const level of ["low", "medium", "high", "max"] as const) {
        await buildThinkingFetch(level)("https://x.test/v1", baseBody());
      }
      expect(bodies).toHaveLength(4);
      const efforts = bodies.map((b) => (JSON.parse(b) as { reasoning?: { effort?: string } }).reasoning?.effort);
      expect(efforts).toEqual(["low", "medium", "high", "max"]);
      // No invented budgets for an unknown model — the R50 wire shape.
      const budgets = bodies.map((b) => (JSON.parse(b) as { reasoning?: { max_tokens?: number } }).reasoning?.max_tokens);
      expect(budgets).toEqual([undefined, undefined, undefined, undefined]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supported: false → NO reasoning key at all (the model takes no reasoning parameter)", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await buildThinkingFetch("high", { supported: false, efforts: [] })("https://x.test/v1", baseBody());
      expect(bodies).toHaveLength(1);
      const body = JSON.parse(bodies[0]) as { reasoning?: unknown; model: string };
      expect(body.reasoning).toBeUndefined();
      expect(body.model).toBe("m");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a detected ladder maps the level — effort ONLY (OpenRouter refuses effort + max_tokens together)", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      // A [low, medium] model: high falls to medium, max rides the highest
      // rung (medium), low/medium hit their own rungs. NO max_tokens budget
      // rides (the R95-G live-fire correction: OpenRouter rejects the pair).
      const support = reasoning(["low", "medium"]);
      const cases: Array<[ThinkingLevel, string]> = [
        ["low", "low"],
        ["medium", "medium"],
        ["high", "medium"],
        ["max", "medium"],
      ];
      for (const [level] of cases) {
        await buildThinkingFetch(level, support)("https://x.test/v1", baseBody());
      }
      const parsed = bodies.map((b) => JSON.parse(b) as { reasoning?: { effort?: string; max_tokens?: number } });
      expect(parsed.map((p) => p.reasoning?.effort)).toEqual(cases.map((c) => c[1]));
      expect(parsed.map((p) => p.reasoning?.max_tokens)).toEqual([undefined, undefined, undefined, undefined]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a high-capable ladder keeps high/max on high (effort only, no budget)", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const support = reasoning(["minimal", "low", "medium", "high"]);
      await buildThinkingFetch("high", support)("https://x.test/v1", baseBody());
      await buildThinkingFetch("max", support)("https://x.test/v1", baseBody());
      const parsed = bodies.map((b) => JSON.parse(b) as { reasoning?: { effort?: string; max_tokens?: number } });
      expect(parsed[0]?.reasoning).toEqual({ effort: "high" });
      expect(parsed[1]?.reasoning).toEqual({ effort: "high" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("supported with NO discrete efforts → the max_tokens budget ONLY (no effort key)", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      // The ladder-less shape (e.g. nemotron-3.5-lightning: reasoning, no
      // reasoning_effort) — the budget is the ONLY knob (OpenRouter refuses
      // the pair, so no effort rides along).
      await buildThinkingFetch("high", { supported: true, efforts: [] })("https://x.test/v1", baseBody());
      const body = JSON.parse(bodies[0]) as { reasoning?: { effort?: string; max_tokens?: number } };
      expect(body.reasoning).toEqual({ max_tokens: 8192 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a provider-set max_tokens is never clobbered; other reasoning fields survive", async () => {
    const { fetchMock, bodies } = capturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await buildThinkingFetch("high", reasoning(["high"]))(
        "https://x.test/v1",
        {
          method: "POST",
          body: JSON.stringify({ reasoning: { max_tokens: 512, enabled: true }, model: "m" }),
        },
      );
      const body = JSON.parse(bodies[0]) as { reasoning?: Record<string, unknown> };
      expect(body.reasoning).toEqual({ max_tokens: 512, enabled: true, effort: "high" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the budget table is exactly the specced ladder (medium at the midpoint)", () => {
    expect(REASONING_BUDGET_BY_LEVEL).toEqual({ low: 2048, medium: 4096, high: 8192, max: 16384 });
  });
});

/* ── mapThinkingLevelToEffort: the pure ladder mapping ────────────────────── */

describe("R95-E: mapThinkingLevelToEffort (level → the model's own ladder)", () => {
  it("max rides the HIGHEST supported effort on every ladder", () => {
    expect(mapThinkingLevelToEffort("max", ["low"])).toBe("low");
    expect(mapThinkingLevelToEffort("max", ["low", "medium"])).toBe("medium");
    expect(mapThinkingLevelToEffort("max", ["medium", "high"])).toBe("high");
    expect(mapThinkingLevelToEffort("max", ["minimal", "low", "medium", "high"])).toBe("high");
  });

  it("an exact rung maps to itself", () => {
    expect(mapThinkingLevelToEffort("low", ["minimal", "low", "high"])).toBe("low");
    expect(mapThinkingLevelToEffort("medium", ["low", "medium", "high"])).toBe("medium");
    expect(mapThinkingLevelToEffort("high", ["low", "medium", "high"])).toBe("high");
  });

  it("an unsupported level falls to the NEAREST LOWER rung", () => {
    expect(mapThinkingLevelToEffort("high", ["low", "medium"])).toBe("medium");
    expect(mapThinkingLevelToEffort("high", ["minimal", "low"])).toBe("low");
    expect(mapThinkingLevelToEffort("medium", ["minimal", "low", "high"])).toBe("low");
  });

  it("no lower rung exists → the LOWEST supported effort stands in (never a 400)", () => {
    expect(mapThinkingLevelToEffort("low", ["medium", "high"])).toBe("medium");
    expect(mapThinkingLevelToEffort("medium", ["high"])).toBe("high");
  });
});

/* ── The streamed thinking-loop watchdog ───────────────────────────────────── */

const streamInput = {
  apiKey: "sk-test",
  model: "test/model-1",
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.2,
  maxTurns: 4,
  provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
};

describe("R95-E: streamAiSdkChat's thinking-loop watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the thresholds are the specced pair (120s window, 24KB volume)", () => {
    expect(THINKING_STALL_MS).toBe(120_000);
    expect(THINKING_STALL_REASONING_BYTES).toBe(24_000);
  });

  it("endless reasoning past BOTH thresholds throws ThinkingLoopError", async () => {
    const now = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now.t);
    // 60 chunks of 500B (30KB total), the clock advancing 5s per chunk —
    // past the 120s window well before the volume threshold trips.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        for (let i = 0; i < 60; i++) {
          now.t += 5_000;
          yield { type: "reasoning-delta", text: "x".repeat(500) };
        }
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    }));

    await expect(
      (async () => {
        for await (const _ of streamAiSdkChat(streamInput)) {
          /* drain */
        }
      })(),
    ).rejects.toBeInstanceOf(ThinkingLoopError);
  });

  it("TEXT progress resets the window — the same volume split across resets never trips", async () => {
    const now = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now.t);
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < 30; i++) {
            now.t += 5_000;
            yield { type: "reasoning-delta", text: "x".repeat(500) };
          }
          // A text-delta is PROGRESS: the window resets here, so each burst
          // accumulates only 15KB of reasoning since the last mark.
          yield { type: "text-delta", text: "working" };
        }
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    }));

    const events: string[] = [];
    for await (const event of streamAiSdkChat(streamInput)) {
      events.push(event.type);
    }
    expect(events.filter((t) => t === "thinking-delta").length).toBe(90);
    expect(events).toContain("text-delta");
    expect(events[events.length - 1]).toBe("finish");
  });

  it("NEITHER threshold alone fires: volume without the stall stays quiet", async () => {
    const now = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now.t);
    // 30KB of reasoning but the clock never moves — no 120s window.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        for (let i = 0; i < 60; i++) {
          yield { type: "reasoning-delta", text: "x".repeat(500) };
        }
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    }));
    const events: string[] = [];
    for await (const event of streamAiSdkChat(streamInput)) {
      events.push(event.type);
    }
    expect(events[events.length - 1]).toBe("finish");
  });

  it("a long stall with only a SMALL reasoning volume stays quiet too", async () => {
    const now = { t: 1_700_000_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => now.t);
    // 10 minutes on the clock but only 6KB of reasoning — the model may
    // legitimately be chewing one long thought.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        for (let i = 0; i < 60; i++) {
          now.t += 10_000;
          yield { type: "reasoning-delta", text: "x".repeat(100) };
        }
        yield { type: "finish-step", usage: {} };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
    }));
    const events: string[] = [];
    for await (const event of streamAiSdkChat(streamInput)) {
      events.push(event.type);
    }
    expect(events[events.length - 1]).toBe("finish");
  });
});

/* ── The classifier: the thinking_loop class ──────────────────────────────── */

describe("R95-E: ThinkingLoopError classification", () => {
  it("classifies as thinking_loop and carries its own honest message", () => {
    const classified = classifyProviderError(new ThinkingLoopError());
    expect(classified.class).toBe("thinking_loop");
    expect(classified.userMessage).toContain("stuck in a reasoning loop");
    expect(classified.userMessage).toContain("120s");
  });

  it("thinking_loop is NOT transient — the R75 WAIT ladder never engages on it", () => {
    expect(isTransientApiFailure("thinking_loop")).toBe(false);
  });
});

/* ── The runtime: the de-escalating streamed retry ────────────────────────── */

describe("R95-E: the streamed thinking-loop de-escalating retry", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r95e-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  const summarizerChat: ChatFn = async () => ({
    text: "SUMMARY: prior work.",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
  });

  it("ONE ThinkingLoopError retries immediately with the level DOWNGRADED (high → low), visible as a meta.retry card", async () => {
    const { sessionId, keyring } = setup("R95E-Loop-Retry");
    const emitted: Array<Record<string, unknown>> = [];
    const inputs: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      inputs.push(input as unknown as Record<string, unknown>);
      if (streamCalls === 1) throw new ThinkingLoopError();
      yield { type: "text-delta", delta: "Recovered — the work is done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
      undefined,
      undefined,
      "high",
    );

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    // The initial call ran with the owner's pick; the retry ran DOWNGRADED.
    expect(inputs[0]?.thinkingLevel).toBe("high");
    expect(inputs[1]?.thinkingLevel).toBe("low");
    // The retry card: the same meta.retry shape the ladder emits, with the
    // honest loop reason + the downgrade named.
    const retryFrames = emitted.filter((e) => e.type === "meta.retry");
    expect(retryFrames).toHaveLength(1);
    expect(retryFrames[0]?.errorClass).toBe("thinking_loop");
    expect(retryFrames[0]?.attempt).toBe(2);
    expect(retryFrames[0]?.totalAttempts).toBe(2);
    expect(String(retryFrames[0]?.message)).toContain("stuck in a reasoning loop");
    expect(String(retryFrames[0]?.message)).toContain("downgraded to low");
    expect(String(retryFrames[0]?.message)).toContain("immediately");
    // No error ever persisted — the turn recovered.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });

  it("an already-LOW level de-escalates to default (reasoning excluded for the retry)", async () => {
    const { sessionId, keyring } = setup("R95E-Loop-Low");
    const inputs: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      inputs.push(input as unknown as Record<string, unknown>);
      if (streamCalls === 1) throw new ThinkingLoopError();
      yield { type: "text-delta", delta: "done" };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      () => {},
      undefined,
      undefined,
      "low",
    );

    expect(outcome.ok).toBe(true);
    expect(inputs[1]?.thinkingLevel).toBe("default");
  });

  it("a SECOND ThinkingLoopError on the de-escalated retry fails honestly (terminal 502, attempts 2)", async () => {
    const { sessionId, keyring } = setup("R95E-Loop-Twice");
    const emitted: Array<Record<string, unknown>> = [];
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      throw new ThinkingLoopError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "do the work",
      (event) => emitted.push(event as Record<string, unknown>),
      undefined,
      undefined,
      "high",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.details?.errorClass).toBe("thinking_loop");
      expect(outcome.details?.attempts).toBe(2);
      expect(String(outcome.details?.classMessage)).toContain("stuck in a reasoning loop");
    }
    // The persisted failure carries the class + attempts for the folded card.
    const events = listSessionEvents(db, sessionId);
    const error = events.find((e) => e.type === "turn.error");
    expect(error).toBeDefined();
    const payload = error!.payload as Record<string, unknown>;
    expect(payload.errorClass).toBe("thinking_loop");
    expect(payload.attempts).toBe(2);
    // The retry card was still shown for the ONE de-escalating attempt.
    expect(emitted.filter((e) => e.type === "meta.retry")).toHaveLength(1);
    // The session stays retryable.
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
  });
});
