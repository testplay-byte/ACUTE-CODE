// @vitest-environment node
//
// R107-b (F5 + F4 + F9): the SYNC-PATH guard parity, the sync adapter's
// abort signal, and the 402/credits classification.
//
//   · F5 (P1): the R80 CONTEXT/REQUEST guard stops and the R77 NO_OUTPUT
//     guard existed ONLY in runStreamedAgentTurn. The sync loop
//     (runSingleAgentTurn — EVERY sub-agent child + the sync HTTP route)
//     could burn unbounded provider calls with no 200-request stop, run an
//     over-budget context with no honest exit, and return ok:true on a
//     whitespace-only reply (the free-model flake R77 fixed, still live on
//     every child). Now both guards + the NO_OUTPUT 502 exit are mirrored.
//   · F4 (P1): the sync SDK call got only the timeout signal — a Stop on a
//     sync child waited out the full in-flight call (600 s default). The
//     signal now threads from the turn into ChatTurnInput and combines with
//     the timeout via AbortSignal.any (the streamed twin's pattern).
//   · F9 (P2): a 402 body ("insufficient credits") matched no class-level
//     pattern → `unknown` → attempts:1 dead end — exactly what the R105-C
//     quota floor was built for. A 402 now maps to rate_limit/quota BY
//     STATUS and rides the 10-minute floor.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import { runSingleAgentTurn } from "../src/agents/runtime";
import { aiSdkChat, type ChatFn } from "../src/agents/chat";
import { classifyProviderError, isTransientApiFailure } from "../src/agents/error-classification";
import { effectiveRungWaitMs, RATE_LIMIT_QUOTA_FLOOR_MS } from "../src/lib/retry";
import { createSession, getSession, listSessionEvents } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProject } from "../src/storage/projects";
import { upsertModel } from "../src/storage/models";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-r107-sync";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r107sync-"));
  db?.close();
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  generateTextMock.mockReset();
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
    model: opts?.model ?? "test/r107-1",
    ...(opts?.maxOuterLoops !== undefined ? { maxOuterLoops: opts.maxOuterLoops } : {}),
  });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
}

const usage = { inputTokens: 7, outputTokens: 4, totalTokens: 11 };

/* ── F5: the R80 guard stops, mirrored onto the sync path ─────────────────── */

describe("R107-b (F5): the request guard stop on the SYNC path (never a silent ok:true)", () => {
  it("200+ provider requests in one sync turn → REQUEST_LIMIT 502 + the persisted turn.error + the session back to queued", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/r107-2",
      displayName: "R107 Sync Model",
      contextWindow: 1_048_576,
    });
    // maxOuterLoops 250 so the loop can run past 200 iterations; each
    // iteration answers with a DISTINCT tool call (varied args — no
    // loop-guard repeat streak) and NO text (the mid-work shape that keeps
    // the outer loop running).
    const { sessionId, keyring } = setup("R107-Req", { model: "test/r107-2", maxOuterLoops: 250 });
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      return {
        text: "",
        usage,
        toolCalls: [
          {
            name: "echo",
            argsSummary: `{"n":${calls}}`,
            args: { n: calls },
            ok: true,
            outputSummary: `echoed ${calls}`,
          },
        ],
      };
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "keep going");

    // Pre-R107 the sync loop had NO request guard: the turn ran to the
    // maxOuterLoops cap and returned ok:true over 250 burned calls.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("REQUEST_LIMIT");
      expect(String(outcome.message)).toContain("200 provider requests");
    }
    const events = listSessionEvents(db, sessionId);
    const turnError = events.find((ev) => ev.type === "turn.error");
    expect(turnError).toBeDefined();
    expect((turnError?.payload as { code?: string }).code).toBe("REQUEST_LIMIT");
    expect(getSession(db, sessionId)?.status).toBe("queued");
    // The loop really did run past 200 chat calls (not some other break).
    expect(calls).toBeGreaterThanOrEqual(201);
  });
});

describe("R107-b (F5): the context guard stop on the SYNC path (the model's OWN budget)", () => {
  it("a giant context on a 1M-window model → CONTEXT_LIMIT 502 + the persisted turn.error + the live meta.context_limit frame", async () => {
    upsertModel(db, "openrouter", {
      modelId: "test/r107-3",
      displayName: "R107 Ctx Model",
      contextWindow: 1_048_576,
    });
    const { sessionId, keyring } = setup("R107-Ctx", { model: "test/r107-3" });
    // ~1.1M tokens (the r80 measurement) — past available
    // (1_048_576 − 32_768 − 8_000 = 1_007_808), under nothing else.
    const giant = "a ".repeat(3_400_000);
    const emitted: Array<Record<string, unknown>> = [];
    let chatCalls = 0;
    // The chat stub is never reached (the guard fires at loop-top on
    // iteration 0, before any provider call) — the counter proves it.
    const chat: ChatFn = async () => {
      chatCalls += 1;
      return { text: "never", usage, toolCalls: [] };
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, giant);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("CONTEXT_LIMIT");
      expect(String(outcome.message)).toContain("exceeded the model's budget");
      expect(String(outcome.message)).toContain("1_007_808".replace(/_/g, ""));
    }
    const events = listSessionEvents(db, sessionId);
    const turnError = events.find((ev) => ev.type === "turn.error");
    expect(turnError).toBeDefined();
    expect((turnError?.payload as { code?: string }).code).toBe("CONTEXT_LIMIT");
    expect(getSession(db, sessionId)?.status).toBe("queued");
    // The guard fired BEFORE any provider call — the pre-R107 sync loop
    // would have SENT the giant context to the provider.
    expect(chatCalls).toBe(0);

    // The emit-carrying variant forwards the live meta frame (a sub-agent
    // child's parent stream watches it).
    const second = setup("R107-Ctx2", { model: "test/r107-3" });
    const emittedOutcome = await runSingleAgentTurn(
      { db, keyring: second.keyring, chat },
      second.sessionId,
      giant,
      undefined,
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(emittedOutcome.ok).toBe(false);
    const limitFrame = emitted.find((e) => e.type === "meta.context_limit") as { limit?: number } | undefined;
    expect(limitFrame).toBeDefined();
    expect(limitFrame?.limit).toBe(1_007_808);
  });
});

describe("R107-b (F5): the R77 blank-output guard on the SYNC path", () => {
  it("a WHITESPACE-ONLY reply with zero tool calls → NO_OUTPUT 502 + the persisted turn.error (never a fake empty success)", async () => {
    const { sessionId, keyring } = setup("R107-Blank");
    // The exact R77 flake shape on the sync path: the model "answers" with
    // a run of newlines. Pre-R107 the sync loop returned ok:true.
    const chat: ChatFn = async () => ({ text: "\n\n\n\n\n", usage, toolCalls: [] });

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "append the status section");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("NO_OUTPUT");
      expect(String(outcome.message)).toContain("empty response");
      expect(String(outcome.message)).toContain("resend");
      expect(outcome.details?.providerError).toContain("whitespace");
    }
    const events = listSessionEvents(db, sessionId);
    const errEvent = events.find((e) => e.type === "turn.error");
    expect(errEvent).toBeDefined();
    expect((errEvent?.payload as { code?: string }).code).toBe("NO_OUTPUT");
    expect((errEvent?.payload as { providerError?: string }).providerError).toContain("whitespace");
    // The session stays retryable + the burned call's usage row exists.
    expect(getSession(db, sessionId)?.status).toBe("queued");
    const usageRows = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .all(sessionId) as unknown[];
    expect(usageRows.length).toBe(1);
  });

  it("a TOOL-USING sync turn with no final text stays OK (the tools did the work — no false positive)", async () => {
    const { sessionId, keyring } = setup("R107-Tools-NoText");
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          usage,
          toolCalls: [
            { name: "write_file", argsSummary: "path: a.txt", args: { path: "a.txt" }, ok: true, outputSummary: "wrote 12 bytes" },
          ],
        };
      }
      return { text: "Done — the file is written.", usage, toolCalls: [] };
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "write the file");
    expect(outcome.ok).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });
});

/* ── F4: the sync adapter's abort signal ──────────────────────────────────── */

describe("R107-b (F4): the sync call aborts on the CALLER's signal", () => {
  it("aiSdkChat combines input.signal with the timeout — aborting the caller aborts the SDK call PROMPTLY (not after the 600 s ceiling)", async () => {
    // The SDK-shaped in-flight call: rejects the moment its abortSignal
    // fires. Pre-R107 the abortSignal was the BARE timeout signal — the
    // caller's abort never reached it and this promise never rejected.
    generateTextMock.mockImplementation(
      (call: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          call.abortSignal?.addEventListener("abort", () => reject(new Error("sdk call aborted")), { once: true });
        }),
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = aiSdkChat({
      provider: { id: "openrouter", baseUrl: "https://openrouter.example/v1", apiFormat: "chat-completions" },
      apiKey: KEY,
      model: "test/r107-1",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      maxTurns: 4,
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(promise).rejects.toThrow("sdk call aborted");
    // PROMPT: milliseconds after the abort, not the 600 s ceiling.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("runSingleAgentTurn threads its signal INTO the sync chat input — the in-flight call observes the stop and the turn returns the honest 499 ABORTED", async () => {
    const { sessionId, keyring } = setup("R107-SyncAbort");
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    // A chat that BLOCKS until its signal aborts (the SDK's real behavior),
    // then resolves — the turn stops between/post-iteration with ABORTED.
    const chat: ChatFn = (input) =>
      new Promise((resolve) => {
        seenSignal = input.signal;
        input.signal?.addEventListener(
          "abort",
          () => resolve({ text: "partial work", usage, toolCalls: [] }),
          { once: true },
        );
      });

    const outcomePromise = runSingleAgentTurn(
      { db, keyring, chat },
      sessionId,
      "stop me mid-call",
      undefined,
      undefined,
      controller.signal,
    );
    // The signal object itself must reach the chat input (the threading).
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    expect(seenSignal).toBe(controller.signal);
    controller.abort();
    const outcome = await outcomePromise;

    // The honest stop (the R48-e1 semantics — a stop is not an error):
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(499);
      expect(outcome.code).toBe("ABORTED");
    }
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
  });
});

/* ── F9: the 402/credits classification ───────────────────────────────────── */

describe("R107-b (F9): a 402 is billing — rate_limit/quota BY STATUS, riding the 10-minute floor", () => {
  it("a 402 \"insufficient credits\" body classifies rate_limit/quota (pre-R107: unknown → attempts:1 dead end)", () => {
    const error = Object.assign(new Error("Insufficient credits for this request"), { statusCode: 402 });
    const classified = classifyProviderError(error);
    expect(classified.class).toBe("rate_limit");
    expect(classified.rateLimitReason).toBe("quota");
    // Transient → the ladder engages (never the pre-R107 fail-fast).
    expect(isTransientApiFailure(classified.class)).toBe(true);
    // The R105-C quota floor: even the schedule's short rungs jump to
    // AT LEAST 10 minutes for a quota (retrying in 90 s against spent
    // credits just re-burns the attempt).
    expect(effectiveRungWaitMs(90_000, null, classified.rateLimitReason)).toBe(RATE_LIMIT_QUOTA_FLOOR_MS);
    expect(effectiveRungWaitMs(90_000, null, classified.rateLimitReason)).toBe(600_000);
  });

  it("a BARE 402 (\"Payment Required\") is still quota — the status alone carries the billing semantics", () => {
    const error = Object.assign(new Error("Payment Required"), { statusCode: 402 });
    const classified = classifyProviderError(error);
    expect(classified.class).toBe("rate_limit");
    expect(classified.rateLimitReason).toBe("quota");
  });

  it("the neighboring statuses are unchanged: a 429 keeps its reason (rate), a 400 validation body stays unknown", () => {
    const rate = Object.assign(new Error("Rate limit exceeded — too many requests per second"), { statusCode: 429 });
    const rateClassified = classifyProviderError(rate);
    expect(rateClassified.class).toBe("rate_limit");
    expect(rateClassified.rateLimitReason).toBe("rate");
    // A 400 validation body matched no pattern pre-R107 and still must not
    // (only 402 joined the status→class mapping).
    const validation = Object.assign(new Error("invalid request shape: messages[0].role"), { statusCode: 400 });
    expect(classifyProviderError(validation).class).toBe("unknown");
    // And a quota-worded body WITHOUT a status is still unknown at class
    // level (the credits patterns refine rate_limit; they never CREATE it).
    expect(classifyProviderError(new Error("insufficient credits")).class).toBe("unknown");
  });
});

// Silence vitest's "no tests without assertions" lint on the vi import used
// by the waitFor case above.
vi.useRealTimers();
