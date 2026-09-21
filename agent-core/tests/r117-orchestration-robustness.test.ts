// @vitest-environment node
//
// ROUND-117 (R117-d1) — ROBUST ORCHESTRATION: the three agent-core legs of
// the wave, end to end.
//
//   1. THE AUTO-RETRY POLICY — a child that dies STALLED or with a transient
//      provider class (network/timeout/rate_limit) is re-delegated ONCE
//      through the same retryChild resume path the owner's Retry button
//      uses; owner-stops NEVER auto-retry; a failing retry is TERMINAL with
//      the honest line; orchestration.autoRetry=false disables it. The
//      retried child's tool result + completed subagent-status frame carry
//      "auto-retried once after {class}"; the durable count is the
//      delegation.autoretry event on the CHILD's log.
//   2. THE GUIDANCE CHANNEL — delegate_task {task_id, guidance} injects a
//      user-role message into a RUNNING child's queue (the queue route's
//      internal path); the child receives it at its next step boundary;
//      every non-running state refuses honestly.
//   3. THE STRUCTURED RESULT ENVELOPE — every completed child's report
//      returns to the parent with the fenced delegation-result block
//      (task_id/result/files_touched/usage); files cap at 20; the block
//      rides ONLY the tool result — the child's own log and the
//      /subagents rows (what the panels read) stay clean.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI SDK is mocked at the module boundary (the orchestrator.test.ts
// pattern) — jsonSchema too, so buildProjectTools builds the REAL toolset.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import {
  Orchestrator,
  autoRetryClassOf,
  childAutoRetryCount,
  childFilesTouched,
  delegationResultEnvelope,
  FILES_TOUCHED_CAP,
  getOrchestrator,
} from "../src/agents/orchestrator";
import { abortTurn, liveTurnIds } from "../src/lib/turn-registry";
import { buildProjectTools } from "../src/tools/index";
import {
  appendSessionEvent,
  childTerminalText,
  createSession,
  getSession,
  listSessionEvents,
  listSubAgents,
  listUndeliveredQueuedMessages,
  setSessionStatus,
} from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { setOrchestrationSettings, setRetrySettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-or-vtest-r117d";
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

let tempDir = "";
let db: SqliteDatabase;
let orchestrator: Orchestrator;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r117d-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // A FRESH instance per test (the r79 pattern) — no semaphore carry-over.
  orchestrator = new Orchestrator();
});

afterEach(() => {
  db.close();
  // No supervision state may leak across tests (the finally teardown).
  expect(liveTurnIds()).toEqual([]);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── fixtures ───────────────────────────────────────────────────────────── */

function makeParent(): { agentId: string; parentSessionId: string } {
  const agent = createAgent(db, {
    name: "R117-d Parent",
    providerId: "openrouter",
    model: "test/r117d-1",
  });
  const parent = createSession(db, { agentId: agent.id, mode: "single" });
  return { agentId: agent.id, parentSessionId: parent.id };
}

function keyring(): ProviderKeyring {
  return new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });
}

/** A chat that reports a final report. */
function slowChat(report = "RESULT: done\nFINDINGS: the work is finished."): ChatFn {
  return async () => ({ text: report, usage, toolCalls: [] });
}

/** Poll until `predicate` holds (bounded; fails the test on timeout). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — the AUTO-RETRY POLICY
// ─────────────────────────────────────────────────────────────────────────────

describe("R117-d: autoRetryClassOf — which failure classes earn a re-delegation", () => {
  const providerError = (errorClass?: string) => ({
    ok: false as const,
    status: 502 as const,
    code: "PROVIDER_ERROR" as const,
    message: "provider failed",
    ...(errorClass !== undefined ? { details: { errorClass } } : {}),
  });

  it("stalled (the watchdog kill) is retryable — even though the outcome code is ABORTED", () => {
    expect(autoRetryClassOf("stalled — no activity for 300s", "stall", { code: "ABORTED" })).toBe("stalled");
  });

  it("the transient provider classes are retryable; context_window_exceeded is NOT (a re-run hits the same wall)", () => {
    expect(autoRetryClassOf(null, null, providerError("network"))).toBe("network");
    expect(autoRetryClassOf(null, null, providerError("timeout"))).toBe("timeout");
    expect(autoRetryClassOf(null, null, providerError("rate_limit"))).toBe("rate_limit");
    expect(autoRetryClassOf(null, null, providerError("context_window_exceeded"))).toBeNull();
    expect(autoRetryClassOf(null, null, providerError("auth"))).toBeNull();
    expect(autoRetryClassOf(null, null, providerError("malformed_response"))).toBeNull();
    expect(autoRetryClassOf(null, null, providerError("unknown"))).toBeNull();
    expect(autoRetryClassOf(null, null, providerError())).toBeNull();
  });

  it("deliberate stops are NEVER auto-retried (owner stop + parent-turn abort)", () => {
    expect(autoRetryClassOf(null, "owner", providerError("network"))).toBeNull();
    expect(autoRetryClassOf(null, null, { code: "ABORTED" })).toBeNull();
  });

  it("non-provider outcome codes never retry (NO_OUTPUT / CONTEXT_LIMIT / PROVIDER_DISABLED)", () => {
    expect(autoRetryClassOf(null, null, { code: "NO_OUTPUT" })).toBeNull();
    expect(autoRetryClassOf(null, null, { code: "CONTEXT_LIMIT" })).toBeNull();
    expect(autoRetryClassOf(null, null, { code: "PROVIDER_DISABLED" })).toBeNull();
  });
});

describe("R117-d: the auto-retry policy (end to end)", () => {
  it("a STALLED child is auto-retried ONCE through the resume path — the resumed child completes, the marker rides the tool result + the completed frame", async () => {
    const { parentSessionId } = makeParent();
    // The minimum bounds the settings validation allow (5s watchdog, 60s
    // stall threshold) — driven on FAKE time (the r107 pattern).
    setOrchestrationSettings(db, { childWatchdogMs: 5_000, childStallTimeoutMs: 60_000 });
    const frames: Array<Record<string, unknown>> = [];
    const emit = (event: unknown): void => {
      frames.push(event as Record<string, unknown>);
    };
    let chatCalls = 0;
    // Attempt 1 hangs until its signal aborts (the watchdog's kill); the
    // auto-retry's chat call SUCCEEDS — the same deps.chat serves both.
    const chat: ChatFn = async (input) => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return await new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => resolve({ text: "", usage, toolCalls: [] }),
            { once: true },
          );
        });
      }
      return { text: "Recovered after the stall.", usage, toolCalls: [] };
    };

    vi.useFakeTimers();
    try {
      const delegated = orchestrator.delegateTask(
        { db, keyring: keyring(), chat },
        parentSessionId,
        "a task that stalls once",
        "researcher",
        emit,
        undefined,
        "phoenix-stall",
      );
      // 65 s of genuine silence → the watchdog kills attempt 1; the
      // auto-retry runs on microtasks and completes.
      await vi.advanceTimersByTimeAsync(65_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await delegated;

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Recovered after the stall.");
      // THE HONEST MARKER — the pinned phrase, in the parent's tool result.
      expect(result.output).toContain("auto-retried once after stalled");
      // The envelope rides the completed report too (deliverable 3).
      expect(result.output).toContain("--- delegation-result ---");
      // Exactly ONE auto-retry (attempt + retry — never more).
      expect(chatCalls).toBe(2);
      expect(childAutoRetryCount(db, result.sessionId!)).toBe(1);
      expect(getSession(db, result.sessionId!)?.status).toBe("completed");
      // The completed subagent-status frame carries the marker (the panels
      // see WHY the child ran again).
      const completedFrame = frames.find(
        (f) => f.type === "subagent-status" && f.status === "completed",
      );
      expect(String(completedFrame?.detail)).toContain("auto-retried once after stalled");
      // The durable marker event on the CHILD's log (the bound's truth).
      const marker = listSessionEvents(db, result.sessionId!).find(
        (e) => e.type === "delegation.autoretry",
      );
      expect(marker).toBeDefined();
      expect((marker!.payload as Record<string, unknown>).class).toBe("stalled");
      expect((marker!.payload as Record<string, unknown>).taskId).toBe("phoenix-stall");
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("a failing retry is TERMINAL — the honest line says the auto-retry ran and also failed", async () => {
    const { parentSessionId } = makeParent();
    setOrchestrationSettings(db, { childWatchdogMs: 5_000, childStallTimeoutMs: 60_000 });
    // BOTH attempts hang until aborted — attempt 1 stalls, the auto-retry
    // stalls too.
    const chat: ChatFn = (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => resolve({ text: "", usage, toolCalls: [] }),
          { once: true },
        );
      });

    vi.useFakeTimers();
    try {
      const delegated = orchestrator.delegateTask(
        { db, keyring: keyring(), chat },
        parentSessionId,
        "a task that stalls twice",
        "coder",
      );
      // Attempt 1 stalls at +65 s; the retry starts then and stalls at
      // +65 s more.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(70_000);
      const result = await delegated;

      expect(result.ok).toBe(false);
      // The original honest stall line + the auto-retry honesty.
      expect(result.output).toContain("STALLED");
      expect(result.output).toContain("auto-retried once after stalled");
      expect(result.output).toContain("retry ALSO failed");
      expect(result.output).toContain("terminal");
      // TERMINAL — exactly one auto-retry burned, the child failed.
      expect(childAutoRetryCount(db, result.sessionId!)).toBe(1);
      expect(getSession(db, result.sessionId!)?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("an owner-stop is NEVER auto-retried — a deliberate stop stays stopped", async () => {
    const { parentSessionId } = makeParent();
    const frames: Array<Record<string, unknown>> = [];
    const chat: ChatFn = (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => resolve({ text: "", usage, toolCalls: [] }),
          { once: true },
        );
      });
    const delegated = orchestrator.delegateTask(
      { db, keyring: keyring(), chat },
      parentSessionId,
      "stopped by the owner mid-task",
      "researcher",
      (event) => frames.push(event as Record<string, unknown>),
    );
    // Wait for the running frame → the child id.
    let childId = "";
    await waitFor(
      () => {
        const frame = frames.find((f) => f.type === "subagent-status" && f.status === "running");
        if (frame !== undefined) {
          childId = String(frame.sessionId);
          return true;
        }
        return false;
      },
      5000,
      "the child's running frame",
    );
    // The owner's Stop (the Sub-agents panel's button → POST /stop).
    expect(abortTurn(childId, "owner")).toBe(true);
    const result = await delegated;
    expect(result.ok).toBe(false);
    expect(result.output).toContain("STOPPED BY THE OWNER");
    expect(result.output).not.toContain("auto-retried");
    expect(childAutoRetryCount(db, childId)).toBe(0);
    expect(getSession(db, childId)?.status).toBe("failed");
  }, 15_000);

  it("orchestration.autoRetry=false → a stalled child fails terminally with the plain honest line (no retry)", async () => {
    const { parentSessionId } = makeParent();
    setOrchestrationSettings(db, {
      childWatchdogMs: 5_000,
      childStallTimeoutMs: 60_000,
      autoRetry: false,
    });
    const chat: ChatFn = (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => resolve({ text: "", usage, toolCalls: [] }),
          { once: true },
        );
      });

    vi.useFakeTimers();
    try {
      const delegated = orchestrator.delegateTask(
        { db, keyring: keyring(), chat },
        parentSessionId,
        "stall with the policy off",
        "researcher",
      );
      await vi.advanceTimersByTimeAsync(65_000);
      const result = await delegated;
      expect(result.ok).toBe(false);
      expect(result.output).toContain("STALLED");
      expect(result.output).not.toContain("auto-retried");
      expect(childAutoRetryCount(db, result.sessionId!)).toBe(0);
      expect(getSession(db, result.sessionId!)?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("a transient provider class (network) is auto-retried — the blocking delegation returns the recovered report + marker", async () => {
    const { parentSessionId } = makeParent();
    // The in-turn provider ladder is disabled for the class so the first
    // failure is terminal FAST (the delegation-level policy is what's under
    // test — in production the ladder runs first, then this policy).
    setRetrySettings(db, { autoRetryNetwork: false });
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed: ECONNRESET");
      return { text: "Recovered after the network blip.", usage, toolCalls: [] };
    };
    const result = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat },
      parentSessionId,
      "survive a network blip",
      "coder",
      undefined,
      undefined,
      "blip",
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Recovered after the network blip.");
    expect(result.output).toContain("auto-retried once after network");
    expect(result.output).toContain("--- delegation-result ---");
    expect(calls).toBe(2);
    expect(childAutoRetryCount(db, result.sessionId!)).toBe(1);
    expect(getSession(db, result.sessionId!)?.status).toBe("completed");
  }, 15_000);

  it("a BACKGROUND child is auto-retried detached — the frames carry the marker and the later resume collects it", async () => {
    const { parentSessionId } = makeParent();
    setRetrySettings(db, { autoRetryNetwork: false });
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed: ECONNRESET");
      return { text: "Background recovered.", usage, toolCalls: [] };
    };
    const frames: Array<Record<string, unknown>> = [];
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat },
      parentSessionId,
      "a background task that blips",
      "researcher",
      "bg-blip",
      (event) => frames.push(event as Record<string, unknown>),
    );
    expect(bg.ok).toBe(true);
    // The detached run fails once, auto-retries, completes.
    await waitFor(
      () => getSession(db, bg.sessionId!)?.status === "completed",
      5000,
      "the detached auto-retry completion",
    );
    expect(calls).toBe(2);
    expect(childAutoRetryCount(db, bg.sessionId!)).toBe(1);
    const completedFrame = frames.find(
      (f) => f.type === "subagent-status" && f.status === "completed",
    );
    expect(String(completedFrame?.detail)).toContain("auto-retried once after network");
    // The collected report (what the parent model reads on resume) carries
    // the marker + the envelope.
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat() },
      parentSessionId,
      "bg-blip",
    );
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("Background recovered.");
    expect(resume.output).toContain("auto-retried once after network");
    expect(resume.output).toContain("--- delegation-result ---");
  }, 15_000);

  it("autoRetryMax bounds the count — a configured second retry fires when the first also stalls (the honest plural line)", async () => {
    const { parentSessionId } = makeParent();
    setOrchestrationSettings(db, {
      childWatchdogMs: 5_000,
      childStallTimeoutMs: 60_000,
      autoRetryMax: 2,
    });
    let chatCalls = 0;
    const chat: ChatFn = async (input) => {
      chatCalls += 1;
      if (chatCalls <= 2) {
        return await new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => resolve({ text: "", usage, toolCalls: [] }),
            { once: true },
          );
        });
      }
      return { text: "Third time's the charm.", usage, toolCalls: [] };
    };
    vi.useFakeTimers();
    try {
      const delegated = orchestrator.delegateTask(
        { db, keyring: keyring(), chat },
        parentSessionId,
        "stalls twice, third attempt lives",
        "tester",
      );
      // Attempt 1 stalls (+65s), retry 1 stalls (+65s), retry 2 succeeds.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await delegated;
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Third time's the charm.");
      // The plural honest line (2 auto-retries, the last class).
      expect(result.output).toContain("auto-retried 2 times, last after stalled");
      expect(chatCalls).toBe(3);
      expect(childAutoRetryCount(db, result.sessionId!)).toBe(2);
      expect(getSession(db, result.sessionId!)?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — THE PARENT→CHILD GUIDANCE CHANNEL
// ─────────────────────────────────────────────────────────────────────────────

describe("R117-d: guidance — the wrong-state + validation refusals", () => {
  it("a queued child refuses ('{status} — guidance needs a running task')", async () => {
    const { agentId, parentSessionId } = makeParent();
    const child = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "coder",
      taskId: "waiting-child",
    });
    setSessionStatus(db, child.id, "queued");
    const res = await orchestrator.sendGuidance(
      { db, keyring: keyring(), chat: slowChat() },
      parentSessionId,
      "waiting-child",
      "pivot to the parser",
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("queued — guidance needs a running task");
    // Nothing queued on the child's log.
    expect(listUndeliveredQueuedMessages(db, child.id)).toHaveLength(0);
  });

  it("a completed child refuses with the read-the-report redirect; a failed child refuses with the resume redirect", async () => {
    const { agentId, parentSessionId } = makeParent();
    const done = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "researcher",
      taskId: "done-child",
    });
    setSessionStatus(db, done.id, "completed");
    const failed = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "researcher",
      taskId: "failed-child",
    });
    setSessionStatus(db, failed.id, "failed");
    const deps = { db, keyring: keyring(), chat: slowChat() };
    const doneRes = await orchestrator.sendGuidance(deps, parentSessionId, "done-child", "pivot");
    expect(doneRes.ok).toBe(false);
    expect(doneRes.output).toContain("completed — guidance needs a running task");
    expect(doneRes.output).toContain("read its report");
    const failedRes = await orchestrator.sendGuidance(deps, parentSessionId, "failed-child", "pivot");
    expect(failedRes.ok).toBe(false);
    expect(failedRes.output).toContain("failed — guidance needs a running task");
    expect(failedRes.output).toContain("Resume it first");
  });

  it("a running ROW with no live registered turn refuses honestly (the queue route's NO_LIVE_TURN gate)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const child = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "coder",
      taskId: "ghost-runner",
    });
    setSessionStatus(db, child.id, "running");
    const res = await orchestrator.sendGuidance(
      { db, keyring: keyring(), chat: slowChat() },
      parentSessionId,
      "ghost-runner",
      "pivot",
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("no live turn");
    expect(listUndeliveredQueuedMessages(db, child.id)).toHaveLength(0);
  });

  it("an unknown address → the honest addressable list; empty guidance → the shape refusal", async () => {
    const { parentSessionId } = makeParent();
    const deps = { db, keyring: keyring(), chat: slowChat() };
    const unknown = await orchestrator.sendGuidance(deps, parentSessionId, "no-such-task", "pivot");
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain('No sub-agent of this session matches "no-such-task"');
    // Empty guidance: an honest refusal, never an empty queued message.
    const empty = await orchestrator.sendGuidance(deps, parentSessionId, "no-such-task", "   ");
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("guidance must be a non-empty string");
  });
});

describe("R117-d: guidance — the running child (the queue injection lands)", () => {
  interface ToolShape {
    execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  }

  async function buildTool(
    parentSessionId: string,
    agentId: string,
    chat: ChatFn,
  ): Promise<ToolShape> {
    const tools = (await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: parentSessionId,
      agentId,
      seq: 1,
      keyring: keyring(),
      chat,
    })) as unknown as Record<string, ToolShape>;
    expect(tools.delegate_task).toBeDefined();
    return tools.delegate_task;
  }

  it("delegate_task {task_id, guidance} lands in the RUNNING child's queue — it delivers at the next step boundary and the model SEES it", async () => {
    const { agentId, parentSessionId } = makeParent();
    const frames: Array<Record<string, unknown>> = [];
    const emit = (event: unknown): void => {
      frames.push(event as Record<string, unknown>);
    };
    // A two-iteration streamed child: iteration 1 runs a tool call, then
    // GATES open mid-turn (the parent model's guidance window); iteration 2
    // is where the delivered guidance must appear in the model-facing
    // history (the r78 loop-top pattern, one tier up).
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let calls = 0;
    const received: Array<Array<{ role: string; content: string }>> = [];
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      received.push(input.messages.map((m) => ({ role: m.role, content: String(m.content) })));
      if (calls === 1) {
        yield { type: "tool-call", toolName: "list_dir", argsSummary: "path: ." };
        yield { type: "tool-result", toolName: "list_dir", argsSummary: "path: .", ok: true, outputSummary: "3 files" };
        await gate;
        yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      } else {
        yield { type: "text-delta", delta: "Report with the guidance applied." };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      }
    };
    const delegated = orchestrator.delegateTask(
      { db, keyring: keyring(), chat: slowChat(), chatStream },
      parentSessionId,
      "scan the deps thoroughly",
      "researcher",
      emit,
      undefined,
      "guide-me",
    );

    // The child is RUNNING (its turn is registered — the queue gate passes).
    let childId = "";
    await waitFor(
      () => {
        const frame = frames.find((f) => f.type === "subagent-status" && f.status === "running");
        if (frame !== undefined) {
          childId = String(frame.sessionId);
          return true;
        }
        return false;
      },
      5000,
      "the child's running frame",
    );

    // THE TOOL CALL (the real dispatch surface): the parent model steers.
    const tool = await buildTool(parentSessionId, agentId, slowChat());
    const res = await tool.execute({
      task_id: "guide-me",
      guidance: "Skip the vendor folders — focus on the parser tests only.",
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Guidance queued for the running sub-agent");
    expect(res.output).toContain("next step boundary");
    // The queued message EXISTS on the child's log (the queue route's row).
    const queued = listUndeliveredQueuedMessages(db, childId);
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as Record<string, unknown>).content).toBe(
      "Skip the vendor folders — focus on the parser tests only.",
    );

    // Release the child — the guidance delivers at the next iteration top.
    releaseGate();
    const result = await delegated;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Report with the guidance applied.");
    // Delivered: nothing stays queued; the transcript carries it as an
    // ordinary user event.
    expect(listUndeliveredQueuedMessages(db, childId)).toHaveLength(0);
    expect(
      listSessionEvents(db, childId).some(
        (e) =>
          e.type === "message.user" &&
          (e.payload as Record<string, unknown>).content ===
            "Skip the vendor folders — focus on the parser tests only.",
      ),
    ).toBe(true);
    // The SECOND model call SAW it (the injection — the child receives the
    // guidance, not just the DB).
    expect(
      received[1]!.some(
        (m) => m.role === "user" && m.content === "Skip the vendor folders — focus on the parser tests only.",
      ),
    ).toBe(true);
    expect(
      received[0]!.some((m) => m.content === "Skip the vendor folders — focus on the parser tests only."),
    ).toBe(false);
    // The delivery frame rode the parent's stream inside the
    // subagent-event envelope (the panel's live chip).
    expect(
      frames.some(
        (f) => f.type === "subagent-event" && (f as { inner?: { type?: string } }).inner?.type === "queued.delivered",
      ),
    ).toBe(true);
  }, 15_000);

  it("the TOOL refuses guidance without task_id (the honest shape refusal)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat());
    const res = await tool.execute({ guidance: "pivot" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("guidance requires task_id");
  });

  it("the TOOL refuses guidance on a completed task (wrong state through the dispatch surface)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const child = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "coder",
      taskId: "finished",
    });
    setSessionStatus(db, child.id, "completed");
    const tool = await buildTool(parentSessionId, agentId, slowChat());
    const res = await tool.execute({ task_id: "finished", guidance: "pivot" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("completed — guidance needs a running task");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — THE STRUCTURED RESULT ENVELOPE
// ─────────────────────────────────────────────────────────────────────────────

describe("R117-d: delegationResultEnvelope (the unit surface)", () => {
  function seedChild(parentSessionId: string, taskId: string | null): string {
    const child = createSession(db, {
      agentId: "agent-env",
      mode: "single",
      parentSessionId,
      subRole: "coder",
      ...(taskId !== null ? { taskId } : {}),
    });
    return child.id;
  }

  function seedToolUse(childId: string, toolName: string, argsSummary: string): void {
    appendSessionEvent(db, childId, {
      type: "tool.use",
      agentId: "agent-env",
      payload: { role: "tool", toolName, argsSummary, ok: true },
    });
  }

  it("composes the exact fenced block: task_id, the report's verdict, unique write-family paths, and the session usage roll-up", () => {
    const { parentSessionId } = makeParent();
    const childId = seedChild(parentSessionId, "env-test");
    seedToolUse(childId, "write_file", "path: src/a.ts, content: 120 chars");
    seedToolUse(childId, "edit_file", "path: src/b.ts, oldString: 40 chars, newString: 55 chars");
    seedToolUse(childId, "write_file", "path: src/a.ts, content: 80 chars"); // dup
    seedToolUse(childId, "read_file", "path: src/never-counted.ts"); // read family — NOT touched
    db.prepare(
      "INSERT INTO usage_events (session_id, provider, model, input_tokens, output_tokens, cost_usd, ts) VALUES (?, 'openrouter', 'test/r117d-env', 20, 8, 0.030000000000000002, ?)",
    ).run(childId, new Date().toISOString());

    const envelope = delegationResultEnvelope(db, childId, "env-test", "RESULT: blocked\nFINDINGS: waiting on the owner.");
    expect(envelope).toBe(
      "--- delegation-result ---\n" +
        '{"task_id":"env-test","result":"blocked","files_touched":["src/a.ts","src/b.ts"],"usage":{"inputTokens":20,"outputTokens":8,"costUsd":0.03}}' +
        "\n--- end ---",
    );
    // The block parses (the machine contract).
    const json = JSON.parse(envelope.split("--- delegation-result ---\n")[1]!.split("\n--- end ---")[0]!) as {
      task_id: string;
      result: string;
      files_touched: string[];
      usage: { inputTokens: number; outputTokens: number; costUsd: number };
    };
    expect(json.task_id).toBe("env-test");
    expect(json.files_touched).toEqual(["src/a.ts", "src/b.ts"]);
    expect(json.usage.costUsd).toBe(0.03); // the float-noise round
  });

  it("files_touched caps at 20 with first-touch order; an unaddressed child carries task_id null; a verdict-less report reads done", () => {
    const { parentSessionId } = makeParent();
    const childId = seedChild(parentSessionId, null);
    for (let i = 0; i < 25; i += 1) {
      seedToolUse(childId, "write_file", `path: src/f${i}.ts, content: 10 chars`);
    }
    expect(childFilesTouched(db, childId)).toHaveLength(FILES_TOUCHED_CAP);
    expect(childFilesTouched(db, childId)[0]).toBe("src/f0.ts");
    expect(childFilesTouched(db, childId)[19]).toBe("src/f19.ts");
    const envelope = delegationResultEnvelope(db, childId, null, "All quiet on the western front.");
    expect(envelope).toContain('"task_id":null');
    expect(envelope).toContain('"result":"done"');
    // The panel-cleanliness invariant: the envelope never lands in the
    // child's OWN log (childTerminalText is what the /subagents rows +
    // panels read).
    expect(listSessionEvents(db, childId).some((e) => e.type === "message.assistant")).toBe(false);
    expect(childTerminalText(db, childId).report).toBeNull();
  });
});

describe("R117-d: the envelope on the real returns (blocking + resume)", () => {
  it("the BLOCKING return appends the block after the report — files from the child's persisted tool.use events, usage from its usage_events roll-up", async () => {
    const { parentSessionId } = makeParent();
    const chat: ChatFn = async () => ({
      text: "RESULT: done\nFILES TOUCHED: src/a.ts\nFINDINGS: wrote the file.",
      usage,
      toolCalls: [
        { name: "write_file", argsSummary: "path: src/a.ts, content: 120 chars", ok: true, outputSummary: "wrote 120 bytes" },
      ],
    });
    const result = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat },
      parentSessionId,
      "write one file",
      "coder",
      undefined,
      undefined,
      "env-blocking",
    );
    expect(result.ok).toBe(true);
    // The readable report FIRST, the machine block AFTER it.
    expect(result.output.indexOf("RESULT: done")).toBeLessThan(result.output.indexOf("--- delegation-result ---"));
    const block = result.output.split("--- delegation-result ---\n")[1]!.split("\n--- end ---")[0]!;
    const json = JSON.parse(block) as {
      task_id: string;
      result: string;
      files_touched: string[];
      usage: { inputTokens: number; outputTokens: number; costUsd: number };
    };
    expect(json.task_id).toBe("env-blocking");
    expect(json.result).toBe("done");
    expect(json.files_touched).toEqual(["src/a.ts"]);
    expect(json.usage.inputTokens).toBe(10);
    expect(json.usage.outputTokens).toBe(5);
  });

  it("the RESUME-collected return carries the block; the /subagents row + childTerminalText stay CLEAN (the panels never render the JSON)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat("RESULT: done\nFINDINGS: finished in the background.") },
      parentSessionId,
      "a completed background task",
      "researcher",
      "env-resume",
    );
    await waitFor(
      () => getSession(db, bg.sessionId!)?.status === "completed",
      5000,
      "background completion",
    );
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat() },
      parentSessionId,
      "env-resume",
    );
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("--- delegation-result ---");
    expect(resume.output).toContain('{"task_id":"env-resume"');
    // PANEL CLEANLINESS — the two surfaces the Sub-agents panel reads:
    const { report } = childTerminalText(db, bg.sessionId!);
    expect(report).not.toContain("--- delegation-result ---");
    expect(report).not.toContain("delegation-result");
    const row = listSubAgents(db, parentSessionId).find((r) => r.id === bg.sessionId);
    expect(row?.report).not.toContain("--- delegation-result ---");
    expect(row?.report).toContain("RESULT: done");
  });
});

// The singleton still constructs (the app uses getOrchestrator()).
it("getOrchestrator() exposes the new surface (the app's real entry point)", () => {
  const o = getOrchestrator();
  expect(typeof o.sendGuidance).toBe("function");
  expect(typeof o.retryChild).toBe("function");
});
