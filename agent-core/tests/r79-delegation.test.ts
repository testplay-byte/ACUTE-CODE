// @vitest-environment node
//
// ROUND-79 (R79-a, the orchestrator round): the ADDRESSABLE-delegation
// tests — delegate_task task_id/background/resume, end to end.
//
// What this suite pins (the plan's contract, every clause):
//   1. THE TOOL DISPATCH — {task} blocking (verbatim pre-R79), {task,
//      task_id, background} fire-and-forget, {resume} the collect path,
//      neither → the honest addressable list; validation refusals
//      (background requires task_id; task_id grammar; duplicates; the
//      ≥10-outstanding cap) all return {ok:false, output} — never throw.
//   2. delegateBackground — returns IMMEDIATELY (the receipt: task_id,
//      session, code, role, model + the resume instructions) while the
//      child's chat is still sleeping; the DETACHED run completes on its
//      own (status flips queued→running→completed, the frames + rows carry
//      taskId, the owner notification fires, the slot releases); a
//      throwing emit (a stream gone before the child finished) never
//      breaks the run (best-effort emit); a failing chat marks the child
//      failed honestly.
//   3. resumeTask — completed → the final report + the delegation.collected
//      marker on the PARENT log (idempotent); running → WAITS then returns
//      the report; the parent turn's abort → the honest still-running
//      line; failed → the retryChild continuation (the R39 "You were
//      interrupted" content visible to the child) and the report on
//      success; unknown address → the honest list; resolution by task_id,
//      session id, AND 4-char code.
//   4. THE REMINDER — buildBackgroundTasksReminder (no children →
//      undefined; uncollected → rows; collected → gone; failed rows carry
//      the error excerpt; the 10-row cap + "more"), the prompt section
//      composition (present with rows, absent without — the golden
//      fixture stays byte-identical elsewhere), and the RUNTIME WIRING
//      (prepareTurn renders the section into the live system prompt on the
//      streamed path, and it DISAPPEARS after resume collects).
//   5. STORAGE — delegation.collected events are invisible to
//      assembleHistory by construction; sessions.delegate_task_id
//      round-trips through createSession/listSubAgents.
//   6. THE SWEEP — a background child left running by a dead sidecar is
//      swept (INTERRUPTED, retryable) and resumeTask still collects it.
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

import type { ChatFn } from "../src/agents/chat";
import type { StreamChatEvent } from "../src/agents/chat";
import { Orchestrator, getOrchestrator } from "../src/agents/orchestrator";
import { abortTurn } from "../src/lib/turn-registry";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { buildProjectTools } from "../src/tools/index";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import {
  appendDelegationCollected,
  appendSessionEvent,
  buildBackgroundTasksReminder,
  createSession,
  getSession,
  listSessionEvents,
  listSubAgents,
  setSessionStatus,
  subAgentCode,
} from "../src/storage/sessions";

const KEY = "sk-or-vtest-r79a";

let db: SqliteDatabase;
let tempDir: string;
let orchestrator: Orchestrator;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r79a-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // A FRESH instance per test (the orchestrator.test.ts pattern) — no
  // semaphore carry-over between tests.
  orchestrator = new Orchestrator();
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/* ── fixtures ───────────────────────────────────────────────────────────── */

/** An agent + a parent session (project-bound, so the prompt builds with
 * the full project ctx — the runtime wiring tests need that). */
function makeParent(): { agentId: string; parentSessionId: string } {
  const root = mkdtempSync(join(tempDir, "proj-"));
  const project = createProject(db, { name: "R79 Project", rootPath: root });
  const agent = createAgent(db, {
    name: "R79 Parent",
    providerId: "openrouter",
    model: "test/r79-model",
  });
  const parent = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { agentId: agent.id, parentSessionId: parent.id };
}

function keyring(): ProviderKeyring {
  return new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });
}

/** A chat stub that sleeps `ms` then reports a final report — optionally
 * emitting ONE step first (onStepFinish), so the live subagent-event
 * forwarding rides (the ROUND-40 channel a plain chat never fires). */
function slowChat(
  ms: number,
  report = "Final report: the work is done.",
  withStep = false,
): ChatFn {
  return async (input) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (withStep) {
      input.onStepFinish?.({ text: "", toolCalls: [{ name: "list_dir", argsSummary: "path: .", ok: true, outputSummary: "3 files" }] });
    }
    return {
      text: report,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCalls: [],
    };
  };
}

/** A chat stub that throws (a failing child). */
function throwingChat(message = "provider exploded"): ChatFn {
  return async () => {
    throw new Error(message);
  };
}

/** Poll until `predicate` holds (bounded; fails the test on timeout).
 * The predicate MAY be async — its awaited result is the truth (a raw
 * Promise would be truthy forever, the classic footgun). */
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

async function childStatus(sessionId: string): Promise<string> {
  return getSession(db, sessionId)?.status ?? "missing";
}

/** The notifications table rows for a child (the owner-facing surface). */
function notificationsFor(sessionId: string): Array<{ kind: string; title: string }> {
  return db
    .prepare("SELECT kind, title FROM notifications WHERE session_id = ? ORDER BY ts ASC")
    .all(sessionId) as Array<{ kind: string; title: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — the tool dispatch + validation (the REAL toolset, the plugin's execute)
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: the delegate_task tool dispatch + validation", () => {
  interface ToolShape {
    execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  }

  async function buildTool(
    parentSessionId: string,
    agentId: string,
    chat: ChatFn,
    signal?: AbortSignal,
  ): Promise<ToolShape> {
    const tools = (await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: parentSessionId,
      agentId,
      seq: 1,
      keyring: keyring(),
      chat,
      ...(signal !== undefined ? { signal } : {}),
    })) as unknown as Record<string, ToolShape>;
    expect(tools.delegate_task).toBeDefined();
    return tools.delegate_task;
  }

  it("neither task nor resume → the honest addressable list (ok:false, never a throw)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(1));
    const res = await tool.execute({});
    expect(res.ok).toBe(false);
    expect(res.output).toContain("needs a task");
    expect(res.output).toContain("This session has no sub-agent children yet");
  });

  it("background without task_id → the honest refusal teaching both fixes", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(1));
    const res = await tool.execute({ task: "do something", background: true });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("background:true requires task_id");
    expect(res.output).toContain("drop background");
  });

  it("an invalid task_id → the grammar refusal (never a child created)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(1));
    const res = await tool.execute({ task: "do something", task_id: "has spaces!" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("is invalid");
    expect(listSubAgents(db, parentSessionId)).toHaveLength(0);
  });

  it("the BLOCKING default (task only) still runs to completion and returns the report inline (pre-R79 verbatim)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(20, "Blocking report."));
    const res = await tool.execute({ task: "count the files" });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Blocking report.");
    expect(res.output).toContain("[subagent session:");
    // No address → no collected event, no reminder row.
    expect(listSubAgents(db, parentSessionId)[0]!.taskId).toBeNull();
    expect(buildBackgroundTasksReminder(db, parentSessionId)).toBeUndefined();
  });

  it("the BACKGROUND path returns the receipt IMMEDIATELY while the child still sleeps", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(300, "Background report."));
    const startedAt = Date.now();
    const res = await tool.execute({ task: "research the deps", task_id: "dep-scan", background: true });
    const elapsed = Date.now() - startedAt;
    // The receipt is immediate — the child's chat sleeps 300ms.
    expect(elapsed).toBeLessThan(150);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("[background task: dep-scan |");
    expect(res.output).toContain('{"resume":"dep-scan"}');
    expect(res.output).toContain("do NOT poll");
    // The child was created + is on its way.
    const rows = listSubAgents(db, parentSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("dep-scan");
    await waitFor(async () => (await childStatus(rows[0]!.id)) === "completed", 5000, "background completion");
  });

  it("the RESUME path dispatches to resumeTask (unknown address → the honest list)", async () => {
    const { agentId, parentSessionId } = makeParent();
    const tool = await buildTool(parentSessionId, agentId, slowChat(1));
    const res = await tool.execute({ resume: "no-such-task" });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('No sub-agent of this session matches "no-such-task"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — delegateBackground (the detached run)
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: delegateBackground (the detached run)", () => {
  it("returns immediately; the detached child completes; the frames + rows + notification carry taskId; the slot releases", async () => {
    const { parentSessionId } = makeParent();
    const envelopes: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => envelopes.push(event as Record<string, unknown>);

    const startedAt = Date.now();
    const result = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(250, "Detached report.", true) },
      parentSessionId,
      "research the deep deps",
      "researcher",
      "deep-deps",
      emit,
    );
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    // The frames carry the address from the FIRST (queued) frame onward.
    const frame = (i: number) => envelopes.filter((e) => e.type === "subagent-status")[i] as
      | Record<string, unknown>
      | undefined;
    expect(frame(0)).toMatchObject({ status: "queued", taskId: "deep-deps", role: "researcher" });
    expect(frame(1)).toMatchObject({ status: "running", taskId: "deep-deps" });

    // The child completes detached.
    await waitFor(async () => (await childStatus(result.sessionId!)) === "completed", 5000, "detached completion");
    const statuses = envelopes
      .filter((e) => e.type === "subagent-status")
      .map((e) => (e as { status: string }).status);
    expect(statuses).toContain("completed");
    // The live forwarding rode (the step-reporting chat fired onStepFinish
    // DURING the call — the subagent-event envelopes, checked after the
    // completion because the step fires inside the child's chat sleep).
    expect(envelopes.some((e) => e.type === "subagent-event")).toBe(true);

    // The owner notification fired (durable, the notifications table).
    await waitFor(
      () => notificationsFor(result.sessionId!).some((n) => n.kind === "subagent_complete"),
      5000,
      "completion notification",
    );

    // The /subagents row carries the address.
    const row = listSubAgents(db, parentSessionId).find((r) => r.id === result.sessionId);
    expect(row?.taskId).toBe("deep-deps");
    expect(row?.report).toContain("Detached report.");

    // The slot released — a fresh delegation acquires instantly (a fresh
    // orchestrator would not share the semaphore; THIS one must be empty).
    const second = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: slowChat(1, "second") },
      parentSessionId,
      "quick follow-up",
      "coder",
    );
    expect(second.ok).toBe(true);
  });

  it("a THROWING emit (the parent stream closed long ago) never breaks the detached run — best-effort emit", async () => {
    const { parentSessionId } = makeParent();
    const result = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(60, "Survived the dead stream.") },
      parentSessionId,
      "survive",
      "researcher",
      "survivor",
      () => {
        throw new Error("stream is gone");
      },
    );
    expect(result.ok).toBe(true);
    await waitFor(async () => (await childStatus(result.sessionId!)) === "completed", 5000, "run despite dead emit");
    expect(listSubAgents(db, parentSessionId)[0]!.report).toContain("Survived the dead stream.");
  });

  it("a FAILING chat marks the child failed honestly + notifies the owner", async () => {
    const { parentSessionId } = makeParent();
    const result = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: throwingChat("quota burnt") },
      parentSessionId,
      "doomed task",
      "coder",
      "doomed",
    );
    expect(result.ok).toBe(true); // the RECEIPT is ok — the run is detached
    await waitFor(async () => (await childStatus(result.sessionId!)) === "failed", 5000, "detached failure");
    expect(notificationsFor(result.sessionId!).some((n) => n.kind === "subagent_failed")).toBe(true);
    // The reminder row for a failed task carries the honest error excerpt
    // (the persisted turn.error message — the sync path's provider line).
    const reminder = buildBackgroundTasksReminder(db, parentSessionId);
    expect(reminder?.tasks).toHaveLength(1);
    expect(reminder?.tasks[0]?.status).toBe("failed");
    expect(reminder?.tasks[0]?.error ?? "").toContain("provider");
  });

  it("a duplicate task_id is refused (any status — an address is handed out once)", async () => {
    const { parentSessionId } = makeParent();
    // Seed an existing child holding the address (the DB row is the truth
    // the gate reads — no run needed).
    createSession(db, {
      agentId: "agent-any",
      mode: "single",
      parentSessionId,
      subRole: "coder",
      taskId: "taken",
    });
    const refusal = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "second task with the same address",
      "coder",
      "taken",
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain('task_id "taken" is already used');
    expect(refusal.output).toContain('{"resume":"taken"}');
  });

  it("the ≥10-outstanding background cap refuses (listing the outstanding tasks)", async () => {
    const { parentSessionId } = makeParent();
    // Seed 10 outstanding (queued|running) addressed children — the cap
    // reads DB rows, so no real runs are needed.
    for (let i = 0; i < 10; i += 1) {
      const child = createSession(db, {
        agentId: "agent-any",
        mode: "single",
        parentSessionId,
        subRole: "researcher",
        taskId: `cap-${i}`,
      });
      setSessionStatus(db, child.id, "running");
    }
    const refusal = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "the eleventh task",
      "researcher",
      "cap-10",
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain("Too many outstanding background tasks");
    expect(refusal.output).toContain("cap-0");
    expect(refusal.output).toContain("cap-9");
    // A BLOCKING delegation is NOT subject to the background cap (its
    // parallelism is already semaphore-bounded) — it still runs.
    const blocking = await orchestrator.delegateTask(
      { db, keyring: keyring(), chat: slowChat(1, "blocking still fine") },
      parentSessionId,
      "blocking while ten queued",
      "coder",
    );
    expect(blocking.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — resumeTask (the collect path)
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: resumeTask (collect / wait / retry)", () => {
  it("completed → the final report + the delegation.collected marker on the PARENT log (idempotent)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(30, "The collected report.") },
      parentSessionId,
      "collect me",
      "researcher",
      "collectible",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "completed", 5000, "completion");

    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "collectible",
    );
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("The collected report.");
    expect(resume.output).toContain("[subagent session:");

    // The collected marker on the PARENT's log (exactly one).
    const collected = listSessionEvents(db, parentSessionId).filter(
      (e) => e.type === "delegation.collected",
    );
    expect(collected).toHaveLength(1);
    expect((collected[0]!.payload as { taskId: string }).taskId).toBe("collectible");

    // Idempotent: re-resume returns the report again, no second marker.
    const again = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "collectible",
    );
    expect(again.ok).toBe(true);
    expect(again.output).toContain("The collected report.");
    expect(
      listSessionEvents(db, parentSessionId).filter((e) => e.type === "delegation.collected"),
    ).toHaveLength(1);
  });

  it("running → WAITS (the resume IS the wait) then returns the report", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(400, "Worth the wait.") },
      parentSessionId,
      "slow task",
      "coder",
      "slowpoke",
    );
    // The receipt's child is the one the resume below will wait on.
    expect(getSession(db, bg.sessionId!)?.taskId).toBe("slowpoke");
    // Resume while the child is still running (the 400ms chat).
    const resumedAt = Date.now();
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "slowpoke",
    );
    expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(300); // it WAITED
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("Worth the wait.");
  });

  it("the parent turn's ABORT during the wait → the honest still-running line (no report claimed)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(900, "Never seen this turn.") },
      parentSessionId,
      "long task",
      "coder",
      "longrunner",
    );
    const controller = new AbortController();
    // Abort ~100ms into the wait.
    setTimeout(() => controller.abort(), 100);
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "longrunner",
      undefined,
      controller.signal,
    );
    expect(resume.ok).toBe(false);
    expect(resume.output).toContain("STILL RUNNING");
    expect(resume.output).toContain("Resume it in a later turn");
    // The child is untouched — still running toward its completion.
    expect(["queued", "running"]).toContain(await childStatus(bg.sessionId!));
  });

  it("failed WITH progress → the retryChild continuation (the R39 'You were interrupted' content) + the report on success; failed with NO progress → the task honestly re-sent", async () => {
    const { parentSessionId, agentId } = makeParent();
    // First run FAILS (chat throws), the run is detached.
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: throwingChat("first attempt died") },
      parentSessionId,
      "recoverable task",
      "coder",
      "phoenix",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "failed", 5000, "first failure");

    // Seed PARTIAL PROGRESS on the child (what a mid-task interruption —
    // an owner stop, a stall kill, a mid-ladder crash — actually leaves:
    // work done, no final report). The event log IS the resume point
    // (ADR-0022 §3) — retryChild's hasProgress reads exactly this.
    appendSessionEvent(db, bg.sessionId!, {
      type: "message.assistant",
      agentId,
      payload: { role: "assistant", content: "Partial work: listed the files, was mid-analysis." },
    });

    // The retry chat: capture the CONTENT the child receives (the oracle —
    // the continuation framing must be there), then succeed.
    const contents: string[] = [];
    const retryChat: ChatFn = async (input) => {
      contents.push(input.messages[input.messages.length - 1]?.content ?? "");
      return {
        text: "Recovered and finished.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [],
      };
    };
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: retryChat },
      parentSessionId,
      "phoenix",
    );
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("Recovered and finished.");
    // The continuation content carries the R39 resume framing (progress
    // existed → "continue from where you stopped", not a re-send).
    expect(contents[0]).toContain("You were interrupted while working on this task");
    // The child is completed + collected.
    expect(await childStatus(bg.sessionId!)).toBe("completed");
    const markers = listSessionEvents(db, parentSessionId).filter(
      (e) => e.type === "delegation.collected",
    );
    expect(markers).toHaveLength(1);
  });

  it("failed with NO progress → the task is honestly RE-SENT (not the continuation)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: throwingChat("died before any work") },
      parentSessionId,
      "re-send me whole",
      "coder",
      "fresh-start",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "failed", 5000, "failure");
    const contents: string[] = [];
    const retryChat: ChatFn = async (input) => {
      contents.push(input.messages[input.messages.length - 1]?.content ?? "");
      return {
        text: "Re-sent and finished.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [],
      };
    };
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: retryChat },
      parentSessionId,
      "fresh-start",
    );
    expect(resume.ok).toBe(true);
    // No progress → the ORIGINAL task re-sends (the retryChild contract).
    expect(contents[0]).toContain("re-send me whole");
    expect(contents[0]).not.toContain("You were interrupted while working on this task");
  });

  it("unknown address → the honest addressable list with REAL addresses", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(10) },
      parentSessionId,
      "the only task",
      "reviewer",
      "only-one",
    );
    const res = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "does-not-exist",
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('No sub-agent of this session matches "does-not-exist"');
    expect(res.output).toContain("only-one");
    expect(res.output).toContain(subAgentCode(bg.sessionId!));
  });

  it("resolution by session id AND by 4-char code (task_id first, both fallbacks live)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(10, "Addressable by three names.") },
      parentSessionId,
      "tri-named",
      "tester",
      "tri-name",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "completed", 5000, "completion");

    const byId = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      bg.sessionId!,
    );
    expect(byId.ok).toBe(true);
    expect(byId.output).toContain("Addressable by three names.");

    const byCode = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      subAgentCode(bg.sessionId!).toLowerCase(), // lowercase in — codes match case-insensitively
    );
    expect(byCode.ok).toBe(true);
    expect(byCode.output).toContain("Addressable by three names.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — the reminder (builder + prompt section + the runtime wiring)
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: the BACKGROUND TASKS reminder", () => {
  const base = {
    projectName: "R79 Prompt Project",
    rootPath: "/tmp/r79",
    toolNames: ["read_file", "write_file"],
    skills: [],
  };

  it("buildBackgroundTasksReminder: no addressed children → undefined (the cheap guard)", () => {
    const { parentSessionId } = makeParent();
    expect(buildBackgroundTasksReminder(db, parentSessionId)).toBeUndefined();
    // An UNADDRESSED child does not trigger it either (pre-R79 rows).
    createSession(db, { agentId: "a", mode: "single", parentSessionId, subRole: "coder" });
    expect(buildBackgroundTasksReminder(db, parentSessionId)).toBeUndefined();
  });

  it("the prompt section renders every status line + the more-line; absent → no section", () => {
    const withTasks = buildProjectSystemPrompt({
      ...base,
      backgroundTasks: {
        tasks: [
          { taskId: "alpha", sessionId: "s1", code: "AAAA", role: "coder", status: "running", todosDone: 1, todosTotal: 4, elapsedMinutes: 3 },
          { taskId: "beta", sessionId: "s2", code: "BBBB", role: "researcher", status: "completed", todosDone: 4, todosTotal: 4, elapsedMinutes: 9 },
          { taskId: "gamma", sessionId: "s3", code: "CCCC", role: "reviewer", status: "failed", todosDone: 0, todosTotal: 2, elapsedMinutes: 12, error: "quota burnt" },
          { taskId: "delta", sessionId: "s4", code: "DDDD", role: "tester", status: "queued", todosDone: 0, todosTotal: 0, elapsedMinutes: 0 },
        ],
        more: 2,
      },
    });
    expect(withTasks).toContain("## BACKGROUND TASKS");
    expect(withTasks).toContain('{"resume":"<task_id>"}');
    expect(withTasks).toContain("- alpha (role: coder, code: AAAA): running — 3m in, 1/4 todos");
    expect(withTasks).toContain("- beta (role: researcher, code: BBBB): COMPLETED — resume to read its final report");
    expect(withTasks).toContain("- gamma (role: reviewer, code: CCCC): FAILED (quota burnt) — resume to retry it from where it stopped");
    expect(withTasks).toContain("- delta (role: tester, code: DDDD): queued — waiting for a concurrency slot");
    expect(withTasks).toContain("…and 2 more");
    // Absent → no section (byte-identity is the golden fixture's job; this
    // pins the gate itself).
    expect(buildProjectSystemPrompt({ ...base })).not.toContain("BACKGROUND TASKS");
  });

  it("the collected filter: a completed task disappears from the builder once collected", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(10, "done") },
      parentSessionId,
      "remindful",
      "researcher",
      "reminder-task",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "completed", 5000, "completion");
    // Uncollected → listed.
    expect(buildBackgroundTasksReminder(db, parentSessionId)?.tasks.map((t) => t.taskId)).toEqual([
      "reminder-task",
    ]);
    appendDelegationCollected(db, parentSessionId, {
      taskId: "reminder-task",
      childId: bg.sessionId!,
      childCode: subAgentCode(bg.sessionId!),
    });
    // Collected → the task is GONE from the reminder (the payload may be
    // an empty list — the prompt gate composes nothing either way).
    const after = buildBackgroundTasksReminder(db, parentSessionId);
    expect(after === undefined || after.tasks.length === 0).toBe(true);
  });

  it("the builder caps at 10 rows with an honest more-count", () => {
    const { parentSessionId } = makeParent();
    for (let i = 0; i < 12; i += 1) {
      createSession(db, {
        agentId: "a",
        mode: "single",
        parentSessionId,
        subRole: "researcher",
        taskId: `row-${i}`,
      });
    }
    const reminder = buildBackgroundTasksReminder(db, parentSessionId)!;
    expect(reminder.tasks).toHaveLength(10);
    expect(reminder.more).toBe(2);
    // created_at ties at ms precision → the row ORDER within the same ms is
    // id-driven; assert the honest shape instead: 10 unique taskIds, all
    // from the seeded twelve, exactly two cut.
    const ids = reminder.tasks.map((t) => t.taskId);
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) {
      expect(id).toMatch(/^row-(\d+)$/);
    }
    expect(new Set([...ids, ...Array.from({ length: 12 }, (_, i) => `row-${i}`)]).size).toBe(12);
  });

  it("RUNTIME WIRING: the live system prompt carries the section, and it DISAPPEARS after resume collects (the streamed path)", async () => {
    const { parentSessionId } = makeParent();
    // A background task that completes.
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(30, "The report the next turn must not see listed.") },
      parentSessionId,
      "wiring task",
      "researcher",
      "wired",
    );
    await waitFor(async () => (await childStatus(bg.sessionId!)) === "completed", 5000, "completion");

    // The parent's NEXT turn — the system prompt captured from the chat
    // stub (the r72 task-hints pattern).
    const captured: { system: string } = { system: "" };
    const deps = {
      db,
      keyring: keyring(),
      chat: (async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] })) as never,
      chatStream: (input: { system: string }) => {
        captured.system = input.system;
        return (async function* (): AsyncGenerator<StreamChatEvent> {
          yield { type: "text-delta", delta: "Parent turn done." };
          yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })();
      },
    };
    const first = await runStreamedAgentTurn(deps, parentSessionId, "any new message", () => undefined);
    expect(first.ok).toBe(true);
    expect(captured.system).toContain("## BACKGROUND TASKS");
    expect(captured.system).toContain("- wired (role: researcher");
    expect(captured.system).toContain("COMPLETED — resume to read its final report");

    // Collect via resumeTask, then the NEXT turn's prompt no longer lists it.
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(1) },
      parentSessionId,
      "wired",
    );
    expect(resume.ok).toBe(true);
    const second = await runStreamedAgentTurn(deps, parentSessionId, "another message", () => undefined);
    expect(second.ok).toBe(true);
    expect(captured.system).not.toContain("## BACKGROUND TASKS");
    expect(captured.system).not.toContain("wired");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — storage: the collected event is invisible to assembleHistory; taskId round-trips
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: storage semantics", () => {
  it("delegation.collected events never surface as model-facing history (assembleHistory skips by construction)", async () => {
    const { agentId, parentSessionId } = makeParent();
    appendSessionEvent(db, parentSessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "hello" },
    });
    appendDelegationCollected(db, parentSessionId, { taskId: "ghost", childId: "sess_ghost" });
    appendSessionEvent(db, parentSessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "world" },
    });
    // Import the real assembler lazily (avoids the fixture-only import above).
    const { assembleHistory } = await import("../src/agents/runtime");
    const history = assembleHistory(db, parentSessionId);
    expect(history).toHaveLength(2);
    expect(history.map((m) => (m as { content: string }).content)).toEqual(["hello", "world"]);
  });

  it("sessions.delegate_task_id round-trips through createSession + listSubAgents rows", () => {
    const { agentId, parentSessionId } = makeParent();
    const child = createSession(db, {
      agentId,
      mode: "single",
      parentSessionId,
      subRole: "planner",
      taskId: "round-trip",
    });
    expect(getSession(db, child.id)?.taskId).toBe("round-trip");
    const row = listSubAgents(db, parentSessionId).find((r) => r.id === child.id);
    expect(row?.taskId).toBe("round-trip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — the boot sweep interplay (a dead sidecar's background child)
// ─────────────────────────────────────────────────────────────────────────────

describe("R79-a: the boot-sweep interplay", () => {
  it("a background child left running by a dead sidecar is swept honestly (INTERRUPTED, retryable) and still resumable (collected on success)", async () => {
    const { parentSessionId } = makeParent();
    const bg = await orchestrator.delegateBackground(
      { db, keyring: keyring(), chat: slowChat(60_000, "Never finishes this attempt.") },
      parentSessionId,
      "interrupted task",
      "coder",
      "swept-task",
    );
    // Simulate the dead sidecar: the child sits `running` with no live run
    // that will ever settle it (the 60s chat stands in for the dead
    // process). The sweep is the same static the server boot runs.
    const swept = Orchestrator.sweepStaleRunning(db);
    expect(swept).toBeGreaterThanOrEqual(1);
    // The sweep wrote the honest INTERRUPTED card + reset to queued
    // (retryable) — the R75 behavior, unchanged for background children.
    expect(["queued", "failed"]).toContain(await childStatus(bg.sessionId!));
    const childEvents = listSessionEvents(db, bg.sessionId!);
    expect(childEvents.some((e) => e.type === "turn.error")).toBe(true);

    // The reminder lists it honestly (uncollected).
    expect(buildBackgroundTasksReminder(db, parentSessionId)?.tasks.map((t) => t.taskId)).toEqual([
      "swept-task",
    ]);

    // Settle the orphaned run deterministically (the owner-stop semantic —
    // the registry is shared) so the test leaves nothing pending, then
    // bring the child to the failed state a genuinely crashed child is in.
    abortTurn(bg.sessionId!, "owner");
    await waitFor(async () => {
      const s = await childStatus(bg.sessionId!);
      return s === "failed" || s === "completed";
    }, 5000, "orphan run settled");
    setSessionStatus(db, bg.sessionId!, "failed");

    // resumeTask still collects the swept child: the retry continuation
    // runs the task to completion (the event log IS the resume point).
    const resume = await orchestrator.resumeTask(
      { db, keyring: keyring(), chat: slowChat(10, "Resumed after the crash.") },
      parentSessionId,
      "swept-task",
    );
    expect(resume.ok).toBe(true);
    expect(resume.output).toContain("Resumed after the crash.");
    const after = buildBackgroundTasksReminder(db, parentSessionId);
    expect(after === undefined || after.tasks.length === 0).toBe(true);
  });
});

// The singleton still constructs (the app uses getOrchestrator()).
it("getOrchestrator() exposes the new surface (the app's real entry point)", () => {
  const o = getOrchestrator();
  expect(typeof o.delegateBackground).toBe("function");
  expect(typeof o.resumeTask).toBe("function");
  expect(typeof o.addressableChildrenOutput).toBe("function");
});
