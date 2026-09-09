/**
 * ROUND-80 (R80, owner: "the issue I have been having the chat ends without
 * any error message or anything some times — this needs to be fixed"):
 * the SILENT-STOP regression tests. Three root causes, three guards:
 *
 *  · A1 — the stream-truncation guard (chat.ts streamAiSdkChat): a provider
 *    that closes the SSE stream CLEANLY mid-generation (no error part, no
 *    finish-step) previously made the adapter synthesize a finish, the turn
 *    "completed" with truncated text, and the chat stopped with NO error.
 *    Now: zero finish-step parts + content deltas → the honest truncation
 *    throw (network-class message → the retry ladder engages).
 *  · A2 — the context/request guard stops (runtime.ts): the 800k-token and
 *    200-request guards previously broke the loop with ok:true (SSE-only
 *    meta frames nobody rendered — a silent stop). Now: guardStop → the
 *    LOOP_GUARD pattern — persisted turn.error + usage + the 502 outcome
 *    (codes CONTEXT_LIMIT / REQUEST_LIMIT) + the session reset to queued.
 *  · A3 — the route-crash persistence (server.ts stream route) lives in
 *    r80-route-crash.test.ts (its vi.mock of the runtime module needs a
 *    dedicated file).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { runStreamedAgentTurn } from "../src/agents/runtime";
import { streamAiSdkChat, type StreamChatEvent } from "../src/agents/chat";
import { listSessionEvents, createSession, getSession } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { upsertModel } from "../src/storage/models";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r80-silent";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r80-silent-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function setup(name: string, opts?: { model?: string; maxOuterLoops?: number }): {
  sessionId: string;
  keyring: ProviderKeyring;
} {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, {
    name: `${name} Agent`,
    providerId: "openrouter",
    model: opts?.model ?? "test/r80-1",
    ...(opts?.maxOuterLoops !== undefined ? { maxOuterLoops: opts.maxOuterLoops } : {}),
  });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

/* ── A1: the stream-truncation guard (chat.ts) ───────────────────────────── */

/** A fake fullStream: the parts the provider would send, in order. */
function fakeFullStream(parts: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined }),
      };
    },
  };
}

const CHAT_INPUT = {
  provider: { id: "openrouter", baseUrl: "https://openrouter.example", apiFormat: "chat-completions" },
  apiKey: KEY,
  model: "test/r80-1",
  system: "",
  messages: [{ role: "user", content: "hello" }],
} as Parameters<typeof streamAiSdkChat>[0];

describe("R80-A1: the stream-truncation guard (the clean-close silent stop)", () => {
  it("text deltas streamed but ZERO finish-step parts → the honest truncation throw (never a fake finish)", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fakeFullStream([
        { type: "text-delta", text: "The answer is " },
        { type: "text-delta", text: "42 and the…" },
        // ...stream just ENDS. No error part, no finish-step — the clean close.
      ]),
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    });
    // Drain the stream — the throw lands when the loop ends (the terminal
    // position is the point: the old code resolved a fake finish there).
    const events: Array<Record<string, unknown>> = [];
    await expect(async () => {
      for await (const event of streamAiSdkChat(CHAT_INPUT)) {
        events.push(event as Record<string, unknown>);
      }
    }).rejects.toThrow(/ended without a finish signal.*connection closed mid-response/);
    // The partial text WAS yielded before the throw (the runtime's R75 flush
    // persists it — nothing is lost).
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta"]);
  });

  it("a HEALTHY stream (finish-step present) passes untouched — no false positives", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fakeFullStream([
        { type: "text-delta", text: "Hi" },
        { type: "finish-step", usage: { inputTokens: 5, outputTokens: 1 } },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamAiSdkChat(CHAT_INPUT)) {
      events.push(event as Record<string, unknown>);
    }
    // text-delta + the synthesized finish — exactly the pre-R80 healthy shape.
    expect(events.map((e) => e.type)).toEqual(["text-delta", "finish"]);
  });

  it("an EMPTY stream with no finish stays on the existing paths (no false positive — the guard needs content)", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fakeFullStream([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamAiSdkChat(CHAT_INPUT)) {
      events.push(event as Record<string, unknown>);
    }
    expect(events.map((e) => e.type)).toEqual(["finish"]);
  });
});

/* ── A2: the context/request guard stops (runtime.ts) ────────────────────── */

const summarizerChat = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

describe("R80-A2: the context guard stop (800k tokens — never a silent ok:true)", () => {
  it("a giant context on a 1M-window model → CONTEXT_LIMIT 502 + the persisted turn.error + session back to queued", async () => {
    // The 1M window is what keeps the giant history un-compacted (the guard
    // protects the 1M-window models — "the 1M window is a LIMIT, not
    // headroom").
    upsertModel(db, "openrouter", {
      modelId: "test/r80-1",
      displayName: "R80 Test Model",
      contextWindow: 1_048_576,
    });
    const { sessionId, keyring } = setup("R80-Ctx");
    // ~902k tokens (the SEGMENT_RE estimator's measured ratio: "a " x 2.8M
    // ≈ 0.32 tokens/repeat — verified against the real estimateTokens).
    const giant = "a ".repeat(2_800_000);
    const emitted: Array<Record<string, unknown>> = [];

    // The chatStream fake is never reached (the guard fires at loop-top on
    // iteration 0, before any provider call) — but the deps contract still
    // requires one.
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as StreamChatEvent;
    };
    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      giant,
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("CONTEXT_LIMIT");
      expect(String(outcome.message)).toContain("800k-token guard");
    }
    // The pre-R80 behavior was the meta frame + a silent ok:true done — now
    // the honest event is on the log and the session is retryable.
    const events = listSessionEvents(db, sessionId);
    const turnError = events.find((ev) => ev.type === "turn.error");
    expect(turnError).toBeDefined();
    expect((turnError?.payload as { code?: string }).code).toBe("CONTEXT_LIMIT");
    expect(getSession(db, sessionId)?.status).toBe("queued");
    // The SSE-only meta frame still rides the stream (typed since R80).
    expect(emitted.some((e) => e.type === "meta.context_limit")).toBe(true);
  });
});

describe("R80-A2: the request guard stop (200 requests — never a silent ok:true)", () => {
  it("200+ provider requests in one turn → REQUEST_LIMIT 502 + the persisted turn.error", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/r80-2",
      displayName: "R80 Test Model 2",
      contextWindow: 1_048_576,
    });
    // maxOuterLoops 250 so the loop can run past 200 iterations; each
    // iteration yields a DISTINCT tool call (varied args — no loop-guard
    // repeat streak) and no completion signal text.
    const { sessionId, keyring } = setup("R80-Req", { model: "test/r80-2", maxOuterLoops: 250 });
    let calls = 0;
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      yield { type: "text-delta", delta: `step ${calls}\n` } as StreamChatEvent;
      yield { type: "tool-call", toolName: "echo", argsSummary: `{"n":${calls}}` } as StreamChatEvent;
      yield {
        type: "tool-result",
        toolName: "echo",
        argsSummary: `{"n":${calls}}`,
        ok: true,
      } as StreamChatEvent;
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as StreamChatEvent;
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "keep going",
      () => {},
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("REQUEST_LIMIT");
      expect(String(outcome.message)).toContain("200 provider requests");
    }
    const events = listSessionEvents(db, sessionId);
    const turnError = events.find((ev) => ev.type === "turn.error");
    expect((turnError?.payload as { code?: string }).code).toBe("REQUEST_LIMIT");
    expect(getSession(db, sessionId)?.status).toBe("queued");
    // The loop really did run past 200 chat calls (not some other break).
    expect(calls).toBeGreaterThanOrEqual(201);
  });
});
