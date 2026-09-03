/**
 * ROUND-48 (R48-e2) stream-store tests — sub-agent frames on the PARENT's
 * SSE stream (the binding wire contract implemented by R48-e1):
 *
 *  1. `subagent-status` upserts the live sub-agent map (code/role/task/
 *     status/todos) AND invalidates the polled ["subagents", parentSessionId]
 *     query so the Delegated card / picker converge immediately.
 *  2. `subagent-event` inner approval.requested routes into the EXISTING
 *     approvals queue WITH subAgentId (the ApprovalCard attribution source).
 *  3. Inner approval.resolved resolves the matching child approval entry.
 *  4. A main-agent TOP-LEVEL approval.requested frame keeps working
 *     identically — the entry carries NO subAgentId.
 *  5. Inner tool-call/tool-result events refresh the live map's lastActivity
 *     (and never invent entries for unknown children).
 *  6. Inner text-delta frames are ignored (the panel polls its own transcript).
 *
 * Same driving pattern as stream-error.test.ts: stub global fetch with an SSE
 * Response carrying the frames, run startStream, assert on the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useConfigStore } from "./config-store";
import { setQueryClient } from "./query-client";
import {
  clearStreamSessionProjectsForTest,
  getSubAgentLiveEntry,
  selectSubAgentsLive,
  useStreamStore,
} from "./stream-store";
import { useActiveStreams } from "./active-streams";
// ROUND-65 (R65): the agent-browser activity signal the frames below bump.
import { useRightSidebarStore } from "./right-sidebar-store";
import type { StreamTurnEvent } from "./api";

function sseResponse(frames: StreamTurnEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const PARENT = "sess_parent_r48e2";
const CHILD = "sess_child_r48e2";

function statusFrame(
  over: Partial<Extract<StreamTurnEvent, { type: "subagent-status" }>> = {},
): StreamTurnEvent {
  return {
    type: "subagent-status",
    sessionId: CHILD,
    parentSessionId: PARENT,
    status: "running",
    task: "Refactor src/auth into smaller modules",
    role: "coder",
    code: "K7Q2",
    ...over,
  };
}

function eventFrame(
  inner: Extract<StreamTurnEvent, { type: "subagent-event" }>["inner"],
): StreamTurnEvent {
  return { type: "subagent-event", sessionId: CHILD, parentSessionId: PARENT, inner };
}

beforeEach(() => {
  useConfigStore.setState({
    baseUrl: "http://sidecar.test",
    token: "tok_123",
    demoData: false,
  });
  // Isolate the module-level stores between tests.
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useActiveStreams.setState({ active: new Set<string>() });
  // ROUND-65 (R65): the activity counters start at zero, no burst in flight.
  useRightSidebarStore.setState({
    agentBrowserActivityByProject: {},
    agentBrowserActivityAtByProject: {},
    byProject: {},
    activeProjectId: null,
    activeSessionByProject: {},
  });
  // ROUND-65 (R65): the module-level session→project map starts empty.
  clearStreamSessionProjectsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stream store sub-agent frames (ROUND-48 R48-e2)", () => {
  it("subagent-status upserts the live map and invalidates the polled subagents query", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setQueryClient(qc);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "queued" }),
          statusFrame({ status: "running" }),
          statusFrame({ status: "completed", todosDone: 3, todosTotal: 5 }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    expect(entry).toMatchObject({
      childSessionId: CHILD,
      parentSessionId: PARENT,
      code: "K7Q2",
      role: "coder",
      task: "Refactor src/auth into smaller modules",
      status: "completed",
      todosDone: 3,
      todosTotal: 5,
    });

    // The polled list query is invalidated (the picker + Delegated rows refetch
    // immediately instead of waiting out their interval).
    const keys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["subagents", PARENT]);

    // The selector reads the same map (the panels' reactive entry point).
    const state = useStreamStore.getState();
    expect(selectSubAgentsLive(state)[CHILD]).toBe(entry);
  });

  it("a later status frame keeps the freshest values but carries known todos forward", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "running", todosDone: 1, todosTotal: 4 }),
          statusFrame({ status: "running" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    // The second frame omits todos — the last known progress survives.
    expect(getSubAgentLiveEntry(CHILD)).toMatchObject({
      status: "running",
      todosDone: 1,
      todosTotal: 4,
    });
  });

  it("inner approval.requested lands in the approvals queue WITH subAgentId (attribution)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({
            type: "approval.requested",
            approvalId: "appr_child_1",
            toolName: "run_command",
            argsSummary: "pnpm test",
            category: "confirm",
          }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    const approval = working.find(
      (e) => e.type === "approval" && e.approvalId === "appr_child_1",
    );
    expect(approval).toMatchObject({
      type: "approval",
      toolName: "run_command",
      argsSummary: "pnpm test",
      category: "confirm",
      status: "pending",
      subAgentId: CHILD,
    });
    // The attribution lookup resolves to the live-map entry (code + role).
    expect(getSubAgentLiveEntry(CHILD)).toMatchObject({ code: "K7Q2", role: "coder" });
  });

  it("inner approval.resolved resolves the matching child approval entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({
            type: "approval.requested",
            approvalId: "appr_child_2",
            toolName: "run_command",
            argsSummary: "rm -rf dist",
            category: "confirm",
          }),
          eventFrame({
            type: "approval.resolved",
            approvalId: "appr_child_2",
            decision: "approved",
            remember: "once",
          }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    const approval = working.find(
      (e) => e.type === "approval" && e.approvalId === "appr_child_2",
    );
    expect(approval).toMatchObject({ status: "approved", remember: "once", subAgentId: CHILD });
  });

  it("a main-agent TOP-LEVEL approval frame keeps working identically — NO subAgentId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          {
            type: "approval.requested",
            approvalId: "appr_main_1",
            toolName: "run_command",
            argsSummary: "pnpm build",
            category: "confirm",
          },
          {
            type: "approval.resolved",
            approvalId: "appr_main_1",
            decision: "denied",
          },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "just work");

    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    expect(working).toHaveLength(1);
    const approval = working[0];
    expect(approval).toMatchObject({
      type: "approval",
      approvalId: "appr_main_1",
      status: "denied",
    });
    // The main agent's own asks render WITHOUT the sub-agent attribution.
    expect(approval).not.toHaveProperty("subAgentId");
  });

  it("inner tool-call/tool-result refresh the live map's lastActivity; unknown children are not invented", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "tool-call", sessionId: CHILD, toolName: "run_command", argsSummary: "pnpm test" }),
          eventFrame({ type: "tool-result", sessionId: CHILD, toolName: "run_command", ok: true, outputSummary: "exit 0" }),
          // An unknown child's tool event rides its OWN envelope (the
          // orchestrator wraps each child's events with that child's id).
          {
            type: "subagent-event",
            sessionId: "sess_unknown_child",
            parentSessionId: PARENT,
            inner: { type: "tool-call", sessionId: "sess_unknown_child", toolName: "read_file", argsSummary: "a.ts" },
          },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    // The tool-call summary lands first, the result's summary overwrites it.
    expect(entry?.lastActivity).toBe("run_command ✓ exit 0");
    // A tool event for a child with no status frame yet creates NO entry.
    expect(getSubAgentLiveEntry("sess_unknown_child")).toBeUndefined();
  });

  it("inner tool-result WITHOUT output summarizes to the tool name + mark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "tool-result", sessionId: CHILD, toolName: "read_file", ok: false }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");
    expect(getSubAgentLiveEntry(CHILD)?.lastActivity).toBe("read_file ✗");
  });

  it("inner text-delta frames are ignored — they never touch the parent's live turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "text-delta", sessionId: CHILD, text: "child narration" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveTurn?.streamText).toBe("");
    expect(slice?.liveTurn?.working).toHaveLength(0);
    expect(getSubAgentLiveEntry(CHILD)?.lastActivity).toBeUndefined();
  });

  it("a failed child's status lands in the map too (terminal states persist post-turn)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "queued" }),
          statusFrame({ status: "running" }),
          statusFrame({ status: "failed" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");
    expect(getSubAgentLiveEntry(CHILD)?.status).toBe("failed");
  });
});

// ─── ROUND-50 (R50-b): the child's LIVE raw-stream accumulators ──────────────

describe("stream store sub-agent LIVE raw stream (ROUND-50 R50-b)", () => {
  it("inner text/thinking deltas + finish usage accumulate per child (streamed shapes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ model: "deepseek/deepseek-chat-v3.1" }),
          eventFrame({ type: "thinking-delta", sessionId: CHILD, delta: "I should read the file first. " }),
          eventFrame({ type: "thinking-delta", sessionId: CHILD, delta: "Then edit it." }),
          eventFrame({ type: "text-delta", sessionId: CHILD, delta: "Reading " }),
          eventFrame({ type: "text-delta", sessionId: CHILD, delta: "src/auth.ts" }),
          eventFrame({ type: "tool-call", sessionId: CHILD, toolName: "read_file", argsSummary: "path: src/auth.ts" }),
          eventFrame({
            type: "tool-result",
            sessionId: CHILD,
            toolName: "read_file",
            argsSummary: "path: src/auth.ts",
            ok: true,
            outputSummary: "42 chars",
          }),
          eventFrame({
            type: "finish",
            sessionId: CHILD,
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    // Flat accumulators: concatenated raw text/thinking + tool count.
    expect(entry?.liveText).toBe("Reading src/auth.ts");
    expect(entry?.liveThinking).toBe("I should read the file first. Then edit it.");
    expect(entry?.liveToolCalls).toBe(1);
    // Live token counters from the inner finish event (the stats footer).
    expect(entry?.inputTokens).toBe(7);
    expect(entry?.outputTokens).toBe(3);
    // The status frame's model rides the entry (the footer's model line).
    expect(entry?.model).toBe("deepseek/deepseek-chat-v3.1");
    expect(entry?.lastActivityTs).toBeGreaterThan(0);

    // The ordered live log: thinking block → text run → tool row (marked ok
    // by the matching tool-result), interleaved in true arrival order — the
    // panel renders tool rows BETWEEN the text they interrupt.
    expect(entry?.liveSteps).toEqual([
      { type: "thinking", text: "I should read the file first. Then edit it." },
      { type: "text", text: "Reading src/auth.ts" },
      { type: "tool", tool: { toolName: "read_file", argsSummary: "path: src/auth.ts", ok: true, outputSummary: "42 chars" } },
    ]);

    // The parent's own live turn stays untouched (child text ≠ parent text).
    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveTurn?.streamText).toBe("");
  });

  it("the SYNC step-snapshot text-delta shape (`text`) accumulates too — fallback children stream as well", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "text-delta", sessionId: CHILD, text: "reading the file " }),
          eventFrame({ type: "text-delta", sessionId: CHILD, text: "Done. Final report." }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    expect(getSubAgentLiveEntry(CHILD)?.liveText).toBe("reading the file Done. Final report.");
  });

  it("a `running` status frame RESETS the transcript accumulators (a retry re-starts) but KEEPS the token sums", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "text-delta", sessionId: CHILD, delta: "attempt one text" }),
          eventFrame({ type: "thinking-delta", sessionId: CHILD, delta: "attempt one thought" }),
          eventFrame({ type: "tool-call", sessionId: CHILD, toolName: "read_file", argsSummary: "path: a.md" }),
          eventFrame({
            type: "finish",
            sessionId: CHILD,
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          }),
          statusFrame({ status: "failed" }),
          // The owner clicks Retry → the orchestrator re-runs the child.
          statusFrame({ status: "running" }),
          eventFrame({ type: "text-delta", sessionId: CHILD, delta: "attempt two text" }),
          eventFrame({
            type: "finish",
            sessionId: CHILD,
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    // RESET RULE: the retry's running frame cleared the transcript view…
    expect(entry?.liveText).toBe("attempt two text");
    expect(entry?.liveThinking).toBe("");
    expect(entry?.liveToolCalls).toBe(0);
    expect(entry?.liveSteps).toEqual([{ type: "text", text: "attempt two text" }]);
    // …while the token counters follow the usage ledger's SUM semantics
    // (usage_events accumulate across attempts, and so does the polled
    // /subagents row they feed — the live→final handoff stays monotone).
    expect(entry?.inputTokens).toBe(11);
    expect(entry?.outputTokens).toBe(5);
  });

  it("a completed child's frozen live state survives (the panel bridges the poll-lag handoff gap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "text-delta", sessionId: CHILD, delta: "final report text" }),
          eventFrame({
            type: "finish",
            sessionId: CHILD,
            usage: { inputTokens: 2, outputTokens: 9, totalTokens: 11 },
          }),
          statusFrame({ status: "completed", todosDone: 3, todosTotal: 3 }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    // The live accumulators are NOT cleared on completion — the panel keeps
    // rendering the frozen stream until the polled transcript carries the
    // final assistant reply, then hides the live segment (SubAgentPanel's
    // handoff rule).
    const entry = getSubAgentLiveEntry(CHILD);
    expect(entry?.status).toBe("completed");
    expect(entry?.liveText).toBe("final report text");
    expect(entry?.outputTokens).toBe(9);
    expect(entry?.todosDone).toBe(3);
  });

  it("inner text-delta frames for an UNKNOWN child still invent no entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          {
            type: "subagent-event",
            sessionId: "sess_unknown_child",
            parentSessionId: PARENT,
            inner: { type: "text-delta", sessionId: "sess_unknown_child", delta: "ghost text" },
          },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");
    expect(getSubAgentLiveEntry("sess_unknown_child")).toBeUndefined();
  });
});

// ─── ROUND-52 (R52-b/R52-c): supervision watch/detail + live command output ──

describe("stream store ROUND-52 supervision + live output", () => {
  /** The heartbeat sample the watchdog emits on every running frame. */
  function watchSample(over: Record<string, unknown> = {}) {
    return {
      lastEventAgeMs: 1200,
      lastActivity: "run_command pnpm build",
      toolCount: 3,
      todosDone: 1,
      todosTotal: 4,
      elapsedMs: 47_000,
      stalled: false,
      ...over,
    };
  }

  it("subagent-status watch samples land on the live entry; a restart clears the stale one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          statusFrame({ watch: watchSample() }),
          statusFrame({ watch: watchSample({ toolCount: 9, elapsedMs: 61_000, todosDone: 2 }) }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    // The LATEST sample wins (heartbeat frames overwrite each other).
    expect(getSubAgentLiveEntry(CHILD)?.watch).toEqual({
      lastEventAgeMs: 1200,
      lastActivity: "run_command pnpm build",
      toolCount: 9,
      todosDone: 2,
      todosTotal: 4,
      elapsedMs: 61_000,
      stalled: false,
    });

    // A re-start (retry) clears the previous attempt's sample.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "running", watch: watchSample() }),
          statusFrame({ status: "failed" }),
          statusFrame({ status: "running" }),
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "delegate again");
    expect(getSubAgentLiveEntry(CHILD)?.watch).toBeUndefined();
  });

  it("a failed frame's detail lands on the entry; a new attempt clears it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          statusFrame({ status: "failed", detail: "stopped by the owner" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");
    expect(getSubAgentLiveEntry(CHILD)?.detail).toBe("stopped by the owner");

    // Retry → a queued/running frame without detail clears the old reason.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "queued" }),
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "retry it");
    expect(getSubAgentLiveEntry(CHILD)?.detail).toBeUndefined();
  });

  it("MAIN-agent tool-output chunks append to the matching in-flight entry; the tool-result clears the tail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "run_command", argsSummary: "pnpm test" },
          { type: "tool-output", toolName: "run_command", chunk: "PASS src/a.test.ts\n" },
          { type: "tool-output", toolName: "run_command", chunk: "PASS src/b.test.ts\n" },
          { type: "tool-result", toolName: "run_command", argsSummary: "pnpm test", ok: true, outputSummary: "2 passed" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "run the tests");

    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    const tool = working.find((e) => e.type === "tool");
    // Settled: ok + outputSummary, and the live tail is GONE (the completed
    // pill shows the final output — never both).
    expect(tool).toMatchObject({
      type: "tool",
      tool: { toolName: "run_command", ok: true, outputSummary: "2 passed" },
    });
    expect((tool as { type: "tool"; tool: { liveOutput?: string } }).tool.liveOutput).toBeUndefined();

    // A second run WITHOUT the result proves the accumulation itself:
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "run_command", argsSummary: "pnpm build" },
          { type: "tool-output", toolName: "run_command", chunk: "compiling " },
          { type: "tool-output", toolName: "run_command", chunk: "done" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "build it");
    const working2 = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    const tool2 = working2.find((e) => e.type === "tool");
    expect((tool2 as { type: "tool"; tool: { liveOutput?: string } }).tool.liveOutput).toBe(
      "compiling done",
    );
  });

  it("tool-output with NO matching in-flight row is ignored (never invents an entry)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-output", toolName: "run_command", chunk: "orphan chunk" },
          { type: "tool-call", toolName: "run_command", argsSummary: "pnpm test" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "orphan output");
    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    expect(working).toHaveLength(1);
    expect((working[0] as { type: "tool"; tool: { liveOutput?: string } }).tool.liveOutput).toBeUndefined();
  });

  it("INNER tool-output chunks append to the child's in-flight live step; the inner tool-result strips the tail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "tool-call", sessionId: CHILD, toolName: "run_command", argsSummary: "pnpm test" }),
          eventFrame({ type: "tool-output", sessionId: CHILD, toolName: "run_command", chunk: "PASS a\n" }),
          eventFrame({ type: "tool-output", sessionId: CHILD, toolName: "run_command", chunk: "PASS b" }),
          eventFrame({ type: "tool-result", sessionId: CHILD, toolName: "run_command", ok: true, outputSummary: "2 passed" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const steps = getSubAgentLiveEntry(CHILD)?.liveSteps ?? [];
    expect(steps).toEqual([
      { type: "tool", tool: { toolName: "run_command", argsSummary: "pnpm test", ok: true, outputSummary: "2 passed" } },
    ]);
    // The settled step carries NO live tail.

    // Without the result: the tail accumulates on the in-flight step.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame(),
          eventFrame({ type: "tool-call", sessionId: CHILD, toolName: "run_command", argsSummary: "pnpm build" }),
          eventFrame({ type: "tool-output", sessionId: CHILD, toolName: "run_command", chunk: "compiling " }),
          eventFrame({ type: "tool-output", sessionId: CHILD, toolName: "run_command", chunk: "done" }),
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "build it");
    const steps2 = getSubAgentLiveEntry(CHILD)?.liveSteps ?? [];
    expect(steps2).toEqual([
      { type: "tool", tool: { toolName: "run_command", argsSummary: "pnpm build", ok: null, liveOutput: "compiling done" } },
    ]);
  });
});

// ─── ROUND-58 (R58-cf): deliberate user stop + live tool-arg streaming ───────

/** A live SSE body the test drives by hand: frames are EMITTED on demand and
 * the stream stays open until the test ends it — exactly the shape a running
 * turn has while the user clicks Stop. */
function manualSseResponse(): {
  response: Response;
  emit: (frame: StreamTurnEvent) => void;
  error: (reason: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const emit = (frame: StreamTurnEvent): void => {
    controller?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  };
  const error = (reason: unknown): void => {
    controller?.error(reason);
  };
  const close = (): void => {
    controller?.close();
  };
  return { response, emit, error, close };
}

describe("stream store deliberate user stop (ROUND-58 R58-cf)", () => {
  it("abortStream arms the stopped state INSTANTLY; the server's stopped frame ends the stream cleanly — no error state", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    // Stop is clicked while the turn is streaming.
    useStreamStore.getState().abortStream(PARENT);

    // (i) the flag lands IMMEDIATELY — before any frame arrives.
    const early = useStreamStore.getState().bySession[PARENT];
    expect(early?.liveTurn?.stopped).toBe(true);
    expect(early?.liveTurn?.stoppedByUser).toBe(true);
    expect(early?.lastTurnStoppedByUser).toBe(true);
    expect(early?.lastTurnStoppedTs).not.toBeNull();

    // (ii) the server confirms: partial text flushed, stopped frame, close.
    sse.emit({ type: "text-delta", delta: "partial text" });
    sse.emit({ type: "stopped" });
    sse.close();
    await promise;

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError).toBeNull();
    expect(slice?.sendError).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(true);
    expect(slice?.liveTurn?.stoppedByUser).toBe(true);
    // The partial text stays visible under the quiet Stopped card.
    expect(slice?.liveTurn?.streamText).toBe("partial text");
    expect(slice?.streamBusy).toBe(false);
    // The sidebar activity indicator cleared (the finally runs regardless).
    expect(useActiveStreams.getState().active.has(PARENT)).toBe(false);
  });

  it("a stopped frame WITHOUT a prior abortStream still ends as a user stop (server-side stop resolved first)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "text-delta", delta: "partial " },
          { type: "text-delta", delta: "reply" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "work");

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(true);
    expect(slice?.liveTurn?.stoppedByUser).toBe(true);
    expect(slice?.lastTurnStoppedByUser).toBe(true);
    expect(slice?.liveTurn?.streamText).toBe("partial reply");
  });

  it("a DONE frame after a stop-click race RETRACTS the stop (the turn completed — the stop POST lost the race)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    // The user clicks Stop a hair before the server finishes…
    useStreamStore.getState().abortStream(PARENT);
    expect(useStreamStore.getState().bySession[PARENT]?.lastTurnStoppedByUser).toBe(true);
    // …but the turn was already completing: the server sends its own DONE
    // verdict instead of a stopped frame.
    sse.emit({ type: "text-delta", delta: "full answer" });
    sse.emit({
      type: "done",
      assistantMessage: { seq: 2, role: "assistant", agentId: "a", content: "full answer", ts: "t" },
      usage: {
        agentId: "a",
        sessionId: PARENT,
        provider: "openrouter",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        ts: "t",
      },
    } as unknown as StreamTurnEvent);
    sse.close();
    await promise;

    const slice = useStreamStore.getState().bySession[PARENT];
    // No Stopped card, no Continue affordance — the folded turn owns it.
    expect(slice?.lastTurnStoppedByUser).toBe(false);
    expect(slice?.lastTurnStoppedTs).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(false);
    expect(slice?.liveTurn?.stoppedByUser).toBe(false);
    expect(slice?.liveTurn?.streamText).toBe("full answer");
    expect(slice?.liveError).toBeNull();
  });

  it("an ERROR frame after a stop-click race lets the ERROR verdict win (the Stopped card never stacks under it)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    useStreamStore.getState().abortStream(PARENT);
    expect(useStreamStore.getState().bySession[PARENT]?.lastTurnStoppedByUser).toBe(true);
    // The turn actually failed before the stop could be processed.
    sse.emit({ type: "error", status: 502, code: "PROVIDER_ERROR", message: "upstream 502" });
    sse.close();
    await promise;

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError).toMatchObject({ code: "PROVIDER_ERROR", message: "upstream 502" });
    // Retracted: the error card owns the verdict; the live turn keeps its
    // FROZEN shape (the existing error UX) without the user-stop flags.
    expect(slice?.lastTurnStoppedByUser).toBe(false);
    expect(slice?.lastTurnStoppedTs).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(true);
    expect(slice?.liveTurn?.stoppedByUser).toBe(false);
    expect(slice?.sendError).toBeNull();
  });

  it("hardAbortStream tears the LOCAL controller down and the catch classifies it as a stop (the grace net)", async () => {
    const sse = manualSseResponse();
    let streamSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        // Only the STREAM call carries a signal (abortStream's fire-and-forget
        // POST /stop has none — it must not clobber the capture).
        if (init?.signal != null) streamSignal = init.signal;
        return Promise.resolve(sse.response);
      }),
    );

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    // Deliberate stop, then the grace timer fires before any server answer.
    useStreamStore.getState().abortStream(PARENT);
    useStreamStore.getState().hardAbortStream(PARENT);
    expect(streamSignal?.aborted).toBe(true);
    // The abort surfaces as the reader-level rejection (the webview's
    // "body stream buffer was aborted" path) — NOT an error.
    sse.error(new DOMException("body stream buffer was aborted"));

    await promise;
    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError).toBeNull();
    expect(slice?.sendError).toBeNull();
    expect(slice?.liveTurn?.stoppedByUser).toBe(true);
    expect(slice?.lastTurnStoppedByUser).toBe(true);
  });

  it("hardAbortStream NEVER touches a NEW turn's controller (the stoppedByUser guard)", async () => {
    const first = manualSseResponse();
    let firstSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal != null) firstSignal = init.signal;
        return Promise.resolve(first.response);
      }),
    );
    const firstPromise = useStreamStore.getState().startStream(PARENT, "work");
    useStreamStore.getState().abortStream(PARENT);
    useStreamStore.getState().hardAbortStream(PARENT);
    expect(firstSignal?.aborted).toBe(true);
    first.error(new DOMException("aborted"));
    await firstPromise;

    // A NEW turn replaces the stopped live turn — the stale grace timer
    // (still pending in a real UI) must find nothing to abort.
    const second = manualSseResponse();
    let secondSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal != null) secondSignal = init.signal;
        return Promise.resolve(second.response);
      }),
    );
    const secondPromise = useStreamStore.getState().startStream(PARENT, "continue from where you left off.");
    // The new signal is armed, the fresh liveTurn is NOT user-stopped.
    expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.stoppedByUser).toBe(false);
    useStreamStore.getState().hardAbortStream(PARENT);
    expect(secondSignal?.aborted).toBe(false);
    second.emit({ type: "stopped" });
    second.close();
    await secondPromise;
  });

  it("a NEW send resets the user-stop signal (the Stopped card + Continue affordance end)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse([{ type: "stopped" }])),
    );
    await useStreamStore.getState().startStream(PARENT, "work");
    expect(useStreamStore.getState().bySession[PARENT]?.lastTurnStoppedByUser).toBe(true);

    const doneFrame = {
      type: "done",
      assistantMessage: { seq: 2, role: "assistant", agentId: "a", content: "resumed", ts: "t" },
      usage: {
        agentId: "a",
        sessionId: PARENT,
        provider: "openrouter",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        ts: "t",
      },
    } as unknown as StreamTurnEvent;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([{ type: "text-delta", delta: "resumed" }, doneFrame]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "continue");
    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.lastTurnStoppedByUser).toBe(false);
    expect(slice?.lastTurnStoppedTs).toBeNull();
    expect(slice?.liveTurn?.stoppedByUser).toBe(false);
  });
});

// ─── ROUND-58 (R58-cf): live tool-ARG streaming (the write preview source) ──

describe("stream store tool-input streaming (ROUND-58 R58-cf)", () => {
  it("tool-input-start/delta accumulate per toolCallId in streamingToolInputs (the pending write row source)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "write it");
    sse.emit({ type: "tool-input-start", toolCallId: "call_w1", toolName: "write_file" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.streamingToolInputs).toHaveLength(1);
    });
    sse.emit({ type: "tool-input-delta", toolCallId: "call_w1", inputTextDelta: '{"path":"a.txt","conte' });
    sse.emit({ type: "tool-input-delta", toolCallId: "call_w1", inputTextDelta: 'nt":"hello"}' });
    await vi.waitFor(() => {
      expect(
        useStreamStore.getState().bySession[PARENT]?.liveTurn?.streamingToolInputs[0]?.raw,
      ).toBe('{"path":"a.txt","content":"hello"}');
    });
    // A replayed start frame is idempotent (no duplicate buffer).
    sse.emit({ type: "tool-input-start", toolCallId: "call_w1", toolName: "write_file" });
    // An unknown toolCallId's delta is ignored.
    sse.emit({ type: "tool-input-delta", toolCallId: "call_ghost", inputTextDelta: "orphan" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.streamingToolInputs).toHaveLength(1);
    });
    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("the final tool-call frame attaches the accumulated raw as liveInput (matched by toolName) and consumes the entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-input-start", toolCallId: "call_w1", toolName: "write_file" },
          { type: "tool-input-delta", toolCallId: "call_w1", inputTextDelta: '{"path":"src/a.ts","content":"hello"}' },
          { type: "tool-call", toolName: "write_file", argsSummary: "path: src/a.ts, content: 5 chars" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "write it");

    const slice = useStreamStore.getState().bySession[PARENT];
    const working = slice?.liveTurn?.working ?? [];
    expect(working).toHaveLength(1);
    expect(working[0]).toMatchObject({
      type: "tool",
      tool: {
        toolName: "write_file",
        argsSummary: "path: src/a.ts, content: 5 chars",
        ok: null,
        liveInput: '{"path":"src/a.ts","content":"hello"}',
      },
    });
    // The streaming-input buffer was consumed by the tool-call frame.
    expect(slice?.liveTurn?.streamingToolInputs).toHaveLength(0);
  });

  it("the tool-result strips liveInput (the final result/diff takes over) and settles a lingering streaming entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-input-start", toolCallId: "call_e1", toolName: "edit_file" },
          { type: "tool-input-delta", toolCallId: "call_e1", inputTextDelta: '{"path":"a.ts","newString":"x"' },
          { type: "tool-call", toolName: "edit_file", argsSummary: "path: a.ts" },
          { type: "tool-input-start", toolCallId: "call_e2", toolName: "edit_file" },
          { type: "tool-input-delta", toolCallId: "call_e2", inputTextDelta: '{"path":"b.ts"' },
          { type: "tool-result", toolName: "edit_file", argsSummary: "path: a.ts", ok: true, outputSummary: "edited a.ts" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "edit it");

    const slice = useStreamStore.getState().bySession[PARENT];
    const working = slice?.liveTurn?.working ?? [];
    const settled = working.find(
      (e) => e.type === "tool" && (e as { tool: { argsSummary?: string } }).tool.argsSummary === "path: a.ts",
    );
    expect(settled).toMatchObject({
      type: "tool",
      tool: { toolName: "edit_file", ok: true, outputSummary: "edited a.ts" },
    });
    expect(
      (settled as { type: "tool"; tool: { liveInput?: string } }).tool.liveInput,
    ).toBeUndefined();
    // The matching tool's still-unresolved streaming entry was settled too.
    expect(slice?.liveTurn?.streamingToolInputs).toHaveLength(0);
  });

  it("a tool-call frame with NO matching streaming entry renders a plain pending row (pre-R58 stream)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "read_file", argsSummary: "path: a.ts" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "read it");
    const working = useStreamStore.getState().bySession[PARENT]?.liveTurn?.working ?? [];
    expect(working[0]).toMatchObject({
      type: "tool",
      tool: { toolName: "read_file", ok: null },
    });
    expect((working[0] as { type: "tool"; tool: { liveInput?: string } }).tool.liveInput).toBeUndefined();
  });

  it("the accumulated raw is capped at 256KB, HEAD-kept (the path argument stays extractable)", async () => {
    const big = "x".repeat(200_000);
    const bigger = "y".repeat(200_000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-input-start", toolCallId: "call_big", toolName: "write_file" },
          { type: "tool-input-delta", toolCallId: "call_big", inputTextDelta: big },
          { type: "tool-input-delta", toolCallId: "call_big", inputTextDelta: bigger },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "write a huge file");

    const inputs = useStreamStore.getState().bySession[PARENT]?.liveTurn?.streamingToolInputs ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].raw.length).toBe(256 * 1024);
    // HEAD-kept (not tail-kept): the cap kept the BEGINNING — where the
    // `path` argument lives — so the extractor can still read it. A tail cap
    // would have kept only "yyyy…".
    expect(inputs[0].raw.startsWith("xxxx")).toBe(true);
    expect(inputs[0].raw.slice(0, 200_000)).toBe(big);
    // The second delta was truncated mid-way (not dropped entirely).
    expect(inputs[0].raw.endsWith("yyyy")).toBe(true);
  });
});

// ── ROUND-65 (R65): agent browser activity bumps the right-sidebar signal ──
// The owner: after approving the agent's browser action, "the browser never
// even opened". Every browser_command tool-call frame and every
// browser-command bridge frame now bumps the right-sidebar store's
// burst-gated counter — the RightSidebar's controller effect auto-opens the
// Browser tab on the edge. Pinned here at the SOURCE (the bump); the
// auto-open behavior itself is pinned in RightSidebar.test.tsx.

describe("agent browser activity signal (ROUND-65 R65)", () => {
  it("a browser_control tool-call frame bumps the session's PROJECT counter — other tools do not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "browser_control", argsSummary: "navigate example.com" },
          { type: "tool-call", toolName: "read_file", argsSummary: "src/a.ts" },
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "open a page", { projectId: "prj_browse" });
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_browse"]).toBe(1);
    expect(useRightSidebarStore.getState().agentBrowserActivityAtByProject["prj_browse"]).not.toBeUndefined();
    // Review fix #2: OTHER projects are untouched (the signal is scoped).
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_other"]).toBeUndefined();
  });

  it("a browser-command bridge frame bumps the counter (bridge frames are turn-independent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "browser-command", commandId: "cmd_1", tabId: "tab_browser", action: "eval", payload: { script: "return 1" } },
          { type: "stopped" },
        ]),
      ),
    );

    // No liveTurn needed — the browser-command branch runs before the
    // liveTurn guard (background turns bump too).
    await useStreamStore.getState().startStream(PARENT, "eval in the page", { projectId: "prj_browse" });
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_browse"]).toBe(1);
  });

  it("burst-gated: frames within 8s of the last bump refresh the gate WITHOUT a new edge; a later frame is a NEW burst", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "browser_control", argsSummary: "navigate a.com" },
          { type: "tool-call", toolName: "browser_control", argsSummary: "navigate b.com" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "browse a burst", { projectId: "prj_browse" });
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_browse"]).toBe(1); // ONE edge for the burst

    // Same burst window (the gate timestamp moved with each frame): a third
    // frame right now is still the same burst.
    useStreamStore.getState(); // no-op read for clarity
    const s = useRightSidebarStore.getState();
    const bumped = vi.fn();
    useRightSidebarStore.subscribe(bumped);
    // Rewind the gate to simulate 10s passing (a NEW burst).
    useRightSidebarStore.setState({
      agentBrowserActivityAtByProject: { prj_browse: Date.now() - 10_000 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "browser_control", argsSummary: "navigate c.com" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "browse again later", { projectId: "prj_browse" });
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_browse"]).toBe(2); // a NEW burst edge
    void s; void bumped;
  });

  it("non-agent activity never bumps (plain text + tool frames from other tools)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "text-delta", delta: "working…" },
          { type: "tool-call", toolName: "web_fetch", argsSummary: "docs" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "plain work", { projectId: "prj_browse" });
    expect(useRightSidebarStore.getState().agentBrowserActivityByProject["prj_browse"]).toBeUndefined();
  });

  it("review fix #2: UNATTRIBUTED sessions (no projectId at start) never bump — no sidebar gets yanked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "browser_control", argsSummary: "navigate example.com" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "no project known");
    expect(Object.keys(useRightSidebarStore.getState().agentBrowserActivityByProject)).toHaveLength(0);
  });
});
