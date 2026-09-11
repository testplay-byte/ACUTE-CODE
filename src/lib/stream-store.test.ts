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
import { setQueryClient, getQueryClient } from "./query-client";
import {
  clearStreamSessionProjectsForTest,
  getSubAgentLiveEntry,
  selectSubAgentsLive,
  useStreamStore,
} from "./stream-store";
import { useActiveStreams } from "./active-streams";
// ROUND-65 (R65): the agent-browser activity signal the frames below bump.
import { useRightSidebarStore } from "./right-sidebar-store";
// ROUND-67 (R67): the browser tab store + the computer monitor store (the
// instant browser frames + the monitor turn-hold).
import { useBrowserTabStore } from "./browser-store";
import { useComputerMonitorStore } from "./computer-monitor-store";
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

  it("ROUND-79: the frame's taskId rides the live entry and carries forward on frames that omit it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          // The queued frame of an ADDRESSABLE delegation carries taskId
          // (R79: from the FIRST frame onward — the panel's chip renders
          // before the first poll).
          statusFrame({ status: "queued", taskId: "bg-research" }),
          statusFrame({ status: "running" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    expect(entry?.taskId).toBe("bg-research");
  });

  it("ROUND-79: an unaddressed child's frames (no taskId) leave the entry without one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          statusFrame({ status: "queued" }),
          statusFrame({ status: "running" }),
          { type: "stopped" },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "delegate it");

    const entry = getSubAgentLiveEntry(CHILD);
    expect(entry?.taskId).toBeUndefined();
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

// ── ROUND-67 (R67): the instant browser frames + the monitor turn-hold ──────
describe("R67 browser frames + computer monitor turn-hold", () => {
  beforeEach(() => {
    useBrowserTabStore.getState().resetAll();
    useRightSidebarStore.setState({
      byProject: {},
      activeSessionByProject: {},
      agentBrowserActivityByProject: {},
      agentBrowserActivityAtByProject: {},
    });
    useComputerMonitorStore.setState({ turnHolds: {}, liveActivity: false, events: [], session: null, error: null });
  });

  it("R67/E1: a browser-navigate frame applies the agent navigation INSTANTLY (tab slice + agentNavSeq)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "browser-navigate", sessionId: "", tabId: "ag-sess_r67", url: "https://example.com/inst-nav" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "navigate", { projectId: "prj_browse" });
    const tab = useBrowserTabStore.getState().tabs["ag-sess_r67"];
    // The slice was CREATED by the frame (the panel's mount effect later
    // reads currentUrl to CREATE the webview — the blank-panel fix).
    expect(tab).toBeDefined();
    expect(tab?.currentUrl).toBe("https://example.com/inst-nav");
    expect(tab?.navSeq).toBe(1);
    expect(tab?.agentNavSeq).toBe(1);
    expect(tab?.loading).toBe(true);
  });

  it("R67/E3: a browser-open frame opens the chat session's agent tab in the ACTIVE slice (auto-open)", async () => {
    useRightSidebarStore.getState().setActiveSession("prj_browse", PARENT);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "browser-open", sessionId: "", tabId: "ag-sess_r67b", chatSessionId: PARENT, url: "https://example.com/opened" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "browse", { projectId: "prj_browse" });
    const slice = useRightSidebarStore.getState().byProject[`prj_browse::${PARENT}`];
    expect(slice).toBeDefined();
    const tab = slice?.tabs.find((t) => t.id === "ag-sess_r67b");
    expect(tab).toBeTruthy();
    expect(tab?.type).toBe("browser");
    expect(tab?.browserUrl).toBe("https://example.com/opened");
    expect(slice?.open).toBe(true);
    expect(slice?.activeTabId).toBe("ag-sess_r67b");
  });

  it("R67/E3: a background session's browser-open NEVER yanks the visible slice (isolation)", async () => {
    // The user is viewing session OTHER in prj_browse's sidebar; PARENT
    // streams in the background and its agent opens a browser tab.
    useRightSidebarStore.getState().setActiveSession("prj_browse", "sess_other");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "browser-open", sessionId: "", tabId: "ag-sess_r67c", chatSessionId: PARENT, url: null },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "background browse", { projectId: "prj_browse" });
    const bg = useRightSidebarStore.getState().byProject[`prj_browse::${PARENT}`];
    expect(bg?.tabs.find((t) => t.id === "ag-sess_r67c")).toBeTruthy();
    // The VISIBLE slice (sess_other) has no tab and stays closed.
    const visible = useRightSidebarStore.getState().byProject["prj_browse::sess_other"];
    expect(visible?.tabs ?? []).toHaveLength(0);
    expect(visible?.open).not.toBe(true);
  });

  it("R67/F1: a computer-use frame latches the monitor TURN-HOLD while the turn is open; the stream end releases it", async () => {
    const snapshots: Array<Record<string, boolean>> = [];
    useComputerMonitorStore.subscribe((s) => snapshots.push({ ...s.turnHolds }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "computer-use", kind: "data", tool: "screenshot" },
          { type: "text-delta", delta: "thinking…" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "use the computer", { projectId: "prj_browse" });
    // The hold WAS latched while the turn streamed (the owner: the indicator
    // vanished while the agent was still thinking between tool calls).
    expect(snapshots.some((s) => s[PARENT] === true)).toBe(true);
    // …and the stream's finally released it (the turn is over).
    expect(useComputerMonitorStore.getState().turnHolds[PARENT]).toBeUndefined();
  });

  it("R67/F1: stop_computer_control rests the monitor signal immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "computer-use", kind: "data", tool: "screenshot" },
          { type: "computer-use", kind: "receipt", tool: "stop_computer_control" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "stop it", { projectId: "prj_browse" });
    expect(useComputerMonitorStore.getState().turnHolds[PARENT]).toBeUndefined();
    expect(useComputerMonitorStore.getState().liveActivity).toBe(false);
  });
});

// ── ROUND-68 (R68-A): the INLINE screenshot feed ────────────────────────────
describe("R68/A screenshot frames → inline working entries", () => {
  beforeEach(() => {
    useBrowserTabStore.getState().resetAll();
    useComputerMonitorStore.setState({ turnHolds: {}, liveActivity: false, events: [], session: null, error: null });
  });

  it("a screenshot frame appends a {type:\"screenshot\"} WorkingEntry to the OPEN liveTurn — right after the in-flight tool row (the capture moment)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "tool-call", toolName: "screenshot", argsSummary: "full display" },
          // The sideband fires DURING tool execution — after the tool row
          // landed, before the result settles it.
          { type: "screenshot", sessionId: PARENT, frameId: "f-1", tool: "screenshot" },
          { type: "tool-result", toolName: "screenshot", argsSummary: "full display", ok: true, outputSummary: "captured 1920x1080" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "take screenshots");
    const liveTurn = useStreamStore.getState().bySession[PARENT]?.liveTurn;
    expect(liveTurn).not.toBeNull();
    // The strip's sidecar array is GONE (R68-A: the entry is the record now).
    expect((liveTurn as unknown as Record<string, unknown>).screenshots).toBeUndefined();
    // Order: the tool row (settled IN PLACE by the tool-result — the store
    // updates the matching in-flight row, it does not append) with the
    // screenshot entry right AFTER it: the entry landed at its capture
    // moment, interleaved with the working rows.
    expect(liveTurn!.working.map((e) => e.type)).toEqual(["tool", "screenshot"]);
    const shot = liveTurn!.working[1];
    expect(shot).toMatchObject({ type: "screenshot", frameId: "f-1", tool: "screenshot" });
    // ts is a real ISO clock read (the capture-moment timestamp the inline
    // row captions and the export marker ride).
    expect(typeof (shot as { ts?: unknown }).ts).toBe("string");
    expect(Number.isNaN(Date.parse((shot as { ts: string }).ts))).toBe(false);
    // And the tool row ahead of it settled with the real result (ok: true).
    const toolRow = liveTurn!.working[0];
    expect(toolRow).toMatchObject({ type: "tool", tool: { toolName: "screenshot", ok: true } });
  });

  it("browser_control captures ride the same inline entries (tool name preserved, newest LAST)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "screenshot", sessionId: PARENT, frameId: "f-1", tool: "screenshot" },
          { type: "screenshot", sessionId: PARENT, frameId: "bs_x", tool: "browser_control", note: "browser panel" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "browser shots");
    const liveTurn = useStreamStore.getState().bySession[PARENT]?.liveTurn;
    const shots = liveTurn!.working.filter((e) => e.type === "screenshot");
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ type: "screenshot", frameId: "f-1", tool: "screenshot" });
    expect(shots[1]).toMatchObject({ type: "screenshot", frameId: "bs_x", tool: "browser_control" });
  });

  it("NO cap on entries — 10 captures stay 10 inline rows (the server-side 12-LRU/10-min registry is the real limit; expired tiles show the honest placeholder)", async () => {
    const frames: StreamTurnEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      frames.push({ type: "screenshot", sessionId: PARENT, frameId: `f-${i}`, tool: "screenshot" });
    }
    frames.push({ type: "stopped" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));
    await useStreamStore.getState().startStream(PARENT, "screenshot loop");
    const liveTurn = useStreamStore.getState().bySession[PARENT]?.liveTurn;
    const shots = liveTurn!.working.filter((e) => e.type === "screenshot");
    expect(shots).toHaveLength(10); // nothing dropped — order preserved
    expect((shots[0] as { frameId: string }).frameId).toBe("f-1");
    expect((shots[9] as { frameId: string }).frameId).toBe("f-10");
  });

  it("a screenshot frame with NO open liveTurn is dropped, never a crash (rasters belong to the turn that captured them)", async () => {
    // Drive a mid-stream liveTurn removal: frame 1 lands on the open turn,
    // then the slice's liveTurn is cleared (the panel's post-done clear
    // racing a late frame) BEFORE frame 2 (the screenshot) arrives — the
    // per-event guard must drop it and leave the store consistent.
    const encoder = new TextEncoder();
    let release: ((frame: StreamTurnEvent) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-delta", delta: "start" })}\n\n`));
        release = (frame) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
    );
    const running = useStreamStore.getState().startStream(PARENT, "late frame race");
    // Let the first frame process (the reader runs in microtasks).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    useStreamStore.setState((s) => ({
      bySession: { ...s.bySession, [PARENT]: { ...s.bySession[PARENT], liveTurn: null } },
    }));
    release!({ type: "screenshot", sessionId: PARENT, frameId: "f-late", tool: "screenshot" });
    await running;
    // No crash, and the guard dropped the frame — nothing recreated the
    // cleared liveTurn (a broken guard would have built one for the entry).
    expect(useStreamStore.getState().bySession[PARENT]?.liveTurn).toBeNull();
  });

  it("a fresh turn RESETS the working array (startStream initializes working: [] — the previous turn's captures never leak in)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          { type: "screenshot", sessionId: PARENT, frameId: "f-1", tool: "screenshot" },
          { type: "stopped" },
        ]),
      ),
    );
    await useStreamStore.getState().startStream(PARENT, "first turn");
    expect(
      useStreamStore.getState().bySession[PARENT]?.liveTurn?.working.filter((e) => e.type === "screenshot"),
    ).toHaveLength(1);
    // Second turn: the fetch stub still serves the same frames, but the
    // fresh working array is visible DURING the stream — assert via the
    // fresh startStream patch order (liveTurn replaced before frames land).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        // Read the store MID-STREAM: the fresh liveTurn already exists with
        // an EMPTY working array (the previous turn's capture never leaks in).
        const mid = useStreamStore.getState().bySession[PARENT]?.liveTurn;
        expect(mid?.working).toEqual([]);
        return sseResponse([{ type: "stopped" }]);
      }),
    );
    await useStreamStore.getState().startStream(PARENT, "second turn");
    expect(
      useStreamStore.getState().bySession[PARENT]?.liveTurn?.working.filter((e) => e.type === "screenshot"),
    ).toHaveLength(0);
  });
});

/* ── ROUND-75 (R75): the transient-API retry ladder's live state ───────────── */

describe("stream store ROUND-75 retry ladder frames", () => {
  beforeEach(() => {
    // The house reset (the other suites' pattern): clear the per-session
    // map so each test starts with no live stream state.
    useStreamStore.setState({ bySession: {} });
  });

  it("a meta.retry frame sets LiveTurn.retry (the ladder card's source); a content frame CLEARS it — the retry succeeded", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({ type: "text-delta", delta: "partial work " });
    // A transient failure lands: the backend emits the ladder frame
    // (attempt 2 of 6, waiting the 1.5-minute rung).
    sse.emit({
      type: "meta.retry",
      attempt: 2,
      totalAttempts: 6,
      waitMs: 90_000,
      remainingMs: 90_000,
      retryAt: Date.now() + 90_000,
      errorClass: "rate_limit",
      classMessage: "rate limited — the provider is throttling requests",
      message: "rate limited — the provider is throttling requests — retrying (attempt 2 of 6) in 1.5 min",
    });

    // (The SSE reader processes frames on the microtask queue — poll for
    // the state instead of asserting synchronously.)
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.retry).toMatchObject({
        attempt: 2,
        totalAttempts: 6,
        waitMs: 90_000,
        errorClass: "rate_limit",
      });
    });

    // The heartbeat refresh (a tick while waiting).
    sse.emit({
      type: "meta.retry",
      attempt: 2,
      totalAttempts: 6,
      waitMs: 90_000,
      remainingMs: 30_000,
      retryAt: Date.now() + 30_000,
      errorClass: "rate_limit",
      classMessage: "rate limited — the provider is throttling requests",
      message: "rate limited — the provider is throttling requests — retrying (attempt 2 of 6) in 30 s",
    });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.retry?.remainingMs).toBe(30_000);
    });

    // The retry SUCCEEDS: content resumes — the status card clears.
    sse.emit({ type: "text-delta", delta: "…recovered, finishing the work." });
    sse.emit({ type: "done", assistantMessage: { seq: 9, role: "assistant", agentId: "agt_r75", content: "done", ts: new Date().toISOString() }, usage: { agentId: "agt_r75", sessionId: PARENT, provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ts: "" } });
    sse.close();
    await promise;

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveTurn?.retry).toBeNull();
    expect(slice?.liveError).toBeNull();
  });

  it("a terminal error frame after the ladder exhausted carries errorClass + attempts into liveError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          {
            type: "meta.retry",
            attempt: 6,
            totalAttempts: 6,
            waitMs: 1_800_000,
            remainingMs: 1_800_000,
            retryAt: Date.now() + 1_800_000,
            errorClass: "rate_limit",
            classMessage: "rate limited — the provider is throttling requests",
            message: "rate limited — retrying (attempt 6 of 6) in 30 min",
          },
          {
            type: "error",
            status: 502,
            code: "PROVIDER_ERROR",
            message: "provider 'openrouter' call failed (class: rate_limit) — auto-retry ladder exhausted",
            details: {
              providerError: "429 Too Many Requests",
              errorClass: "rate_limit",
              classMessage: "rate limited — the provider is throttling requests",
              attempts: 6,
            },
          },
        ]),
      ),
    );

    await useStreamStore.getState().startStream(PARENT, "work");

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError?.errorClass).toBe("rate_limit");
    expect(slice?.liveError?.attempts).toBe(6);
    expect(slice?.liveError?.message).toContain("auto-retry ladder exhausted");
  });

  it("a meta.overflow_recovery frame sets the transient note; the first content frame clears it", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({ type: "meta.overflow_recovery", message: "[context overflow → auto-compacted conversation → retrying]" });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain("context overflow");
    });

    sse.emit({ type: "text-delta", delta: "recovered after compaction" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toBeNull();
    });

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  // ── ROUND-92 (R92-D): the key-pool juggling frame renders as the transient
  // note — the owner sees "switching to API key 2 of 3" while the swap retries
  // immediately, and the first content frame clears it (the shared effect).
  it("ROUND-92: a meta.key frame sets the transient juggling note; the first content frame clears it", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({
      type: "meta.key",
      key: { attempt: 2, totalKeys: 3, reason: "rate_limit" },
      message: "Rate limited — switching to API key 2 of 3, retrying immediately",
    });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain(
        "switching to API key 2 of 3",
      );
    });

    sse.emit({ type: "text-delta", delta: "the fresh key worked" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toBeNull();
    });

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  // ── ROUND-83 (R83): the compaction + context-limit frames finally RENDER ──
  it("ROUND-83: a meta.compaction frame sets the honest note AND invalidates the context meter (the ring drops)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));
    const invalidated: string[][] = [];
    const qc = getQueryClient();
    if (qc === null) throw new Error("test setup: no query client");
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((arg: { queryKey: string[] }) => {
      invalidated.push(arg.queryKey);
      return Promise.resolve();
    }) as unknown as typeof qc.invalidateQueries;

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({ type: "meta.compaction", tokensSaved: 28_000, droppedMessages: 34, throughSeq: 40 });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain("context compacted");
    });
    expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain("34 messages summarized");
    expect(invalidated.some((key) => key[0] === "session-context")).toBe(true);

    // A content frame clears the note (the R75 contract — the recovery line
    // disappears when real work resumes).
    sse.emit({ type: "text-delta", delta: "continuing after compaction" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toBeNull();
    });

    // Restore the real implementation for later tests.
    qc.invalidateQueries = originalInvalidate as unknown as typeof qc.invalidateQueries;
    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("ROUND-83: a meta.context_limit frame sets the honest terminal note (the pre-R83 store ignored it)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({ type: "meta.context_limit", tokens: 1_095_000, limit: 1_007_808 });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain("context limit reached");
    });
    expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.note).toContain("1007808 available");

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });
});

// ─── ROUND-77 (R77): the unpersisted-failure slice survival ───────────────────
// The owner's report: "tried sending a message, but it was not that
// successful… It was not sending the message properly". Root cause: a turn
// that failed WITHOUT a persisted turn.error (pre-hijack rejections —
// validation / auth / 409 / PROVIDER_DISABLED) fell through the panel's
// clearStream wipe, so BOTH the error card AND the optimistic user bubble
// vanished and the send looked like it never happened. freezeFailedTurn is
// the store half of the fix: liveError + pendingEcho SURVIVE, the live
// turn resolves by its content.
describe("stream store ROUND-77 freezeFailedTurn (unpersisted failures)", () => {
  beforeEach(() => {
    useStreamStore.setState({ bySession: {} });
  });

  it("an EMPTY live turn is DROPPED (no frozen Thinking… row), while liveError + pendingEcho SURVIVE", async () => {
    // A pre-hijack rejection: the POST answers non-2xx JSON — the error
    // arrives as an SSE-shaped error event with NO errorTs (never
    // persisted server-side).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          {
            type: "error",
            status: 409,
            code: "PROVIDER_DISABLED",
            message: "Provider 'openrouter' is disabled — enable it in Settings → Models & Providers",
          },
        ]),
      ),
    );

    // The panel's exact call order: setPendingEcho FIRST, then startStream.
    useStreamStore.getState().setPendingEcho(PARENT, "please build the thing");
    await useStreamStore.getState().startStream(PARENT, "please build the thing");

    // Before the fix: the slice would be wiped on the panel side. The
    // store half: freezeFailedTurn keeps the error + echo, drops the empty
    // live turn.
    useStreamStore.getState().freezeFailedTurn(PARENT);

    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice).toBeDefined();
    // The error card's source SURVIVES — with the REAL code (the R77 api.ts
    // envelope preservation) and no errorTs (nothing was persisted).
    expect(slice?.liveError).toMatchObject({
      code: "PROVIDER_DISABLED",
      status: 409,
    });
    expect(slice?.liveError?.errorTs).toBeUndefined();
    expect(slice?.liveError?.message).toContain("disabled");
    // The optimistic user bubble SURVIVES (the owner's message stays
    // visible under the error card).
    expect(slice?.pendingEcho).toBe("please build the thing");
    // The empty live turn is dropped — no frozen "Thinking…" row.
    expect(slice?.liveTurn).toBeNull();
    // The turn is over: streamBusy false.
    expect(slice?.streamBusy).toBe(false);
  });

  it("a live turn with PARTIALS is FROZEN (stopped, not by user) — the R58 thrown-error shape", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    useStreamStore.getState().setPendingEcho(PARENT, "work");
    sse.emit({ type: "text-delta", delta: "partial streamed answer " });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.streamText).toContain("partial");
    });
    // Mid-stream disconnect: the read loop ends without a terminal frame →
    // the api client synthesizes STREAM_DISCONNECTED (no errorTs).
    sse.emit({
      type: "error",
      status: 0,
      code: "STREAM_DISCONNECTED",
      message: "The stream from the agent ended unexpectedly (connection interrupted). Reconnecting may recover the turn.",
    });
    sse.close();
    await promise;

    useStreamStore.getState().freezeFailedTurn(PARENT);

    const slice = useStreamStore.getState().bySession[PARENT];
    // The partial text stays visible, frozen.
    expect(slice?.liveTurn?.streamText).toContain("partial streamed answer");
    expect(slice?.liveTurn?.stopped).toBe(true);
    expect(slice?.liveTurn?.stoppedByUser).toBe(false);
    // The error + echo survive.
    expect(slice?.liveError?.code).toBe("STREAM_DISCONNECTED");
    expect(slice?.pendingEcho).toBe("work");
  });

  it("freezeFailedTurn on a session with NO slice is a safe no-op", () => {
    expect(() => useStreamStore.getState().freezeFailedTurn("sess_never_existed")).not.toThrow();
  });

  it("a FRESH turn resets the R77 survivors (liveError + pendingEcho clear on the next send)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          sseResponse([
            { type: "error", status: 409, code: "PROVIDER_DISABLED", message: "disabled" },
          ]),
        )
        .mockResolvedValueOnce(
          sseResponse([
            {
              type: "done",
              assistantMessage: { seq: 9, role: "assistant", agentId: "agt_r77", content: "ok", ts: new Date().toISOString() },
              usage: { agentId: "agt_r77", sessionId: PARENT, provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ts: "" },
            },
          ]),
        ),
    );

    await useStreamStore.getState().startStream(PARENT, "first send fails");
    useStreamStore.getState().freezeFailedTurn(PARENT);
    expect(useStreamStore.getState().bySession[PARENT]?.liveError).not.toBeNull();

    // The retry send: startStream resets liveError + pendingEcho (R43/R77
    // reset semantics) — no stale error card under the new turn.
    await useStreamStore.getState().startStream(PARENT, "second send works");
    const slice = useStreamStore.getState().bySession[PARENT];
    expect(slice?.liveError).toBeNull();
    expect(slice?.liveTurn?.stopped).toBe(false);
  });
});

// ─── ROUND-78 (R78-D): the message-queue frames + slice lifecycle ────────────
// The wire contract: user.queued {seq, content, ts} pushes the chip;
// queued.delivered {seq, content, ts} moves it to the delivered-bubble list;
// meta.queue_continue {count} is typed-but-informational. startStream resets
// both arrays; the stream-end finally clears them (the refetched folded log
// owns the render — message.queued events fold as `queued` items there).
// The panel's optimistic push (pushQueuedMessage) dedupes by seq against
// the frame.
describe("stream store ROUND-78 message queue", () => {
  beforeEach(() => {
    useStreamStore.setState({ bySession: {} });
  });

  it("a user.queued frame pushes the chip; queued.delivered moves it to deliveredQueued; meta.queue_continue is a typed no-op", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    // The queue POST landed server-side; the frame announces the chip.
    sse.emit({ type: "user.queued", seq: 12, content: "also add tests", ts: "2026-09-14T10:00:01Z" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.queued).toEqual([
        { seq: 12, content: "also add tests", ts: "2026-09-14T10:00:01Z" },
      ]);
    });

    // The turn-end continuation announced itself (informational — nothing
    // observable changes; the delivered flips own the render).
    sse.emit({ type: "meta.queue_continue", count: 1 });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.queued).toHaveLength(1);
    });

    // The loop top delivered the queued message into the model's history.
    sse.emit({
      type: "queued.delivered",
      seq: 12,
      content: "also add tests",
      ts: "2026-09-14T10:00:09Z",
    });
    await vi.waitFor(() => {
      const slice = useStreamStore.getState().bySession[PARENT];
      expect(slice?.queued).toEqual([]);
      expect(slice?.deliveredQueued).toEqual([
        { seq: 12, content: "also add tests", ts: "2026-09-14T10:00:09Z" },
      ]);
    });

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("user.queued attachments narrow to display-only AttachmentRefs (name/path/size — never text)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({
      type: "user.queued",
      seq: 13,
      content: "look at this",
      ts: "2026-09-14T10:01:00Z",
      attachments: [
        { name: "shot.png", path: "attachments/shot.png", size: 2048, text: "never ships to the UI" },
      ],
    });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.queued).toEqual([
        {
          seq: 13,
          content: "look at this",
          ts: "2026-09-14T10:01:00Z",
          attachments: [{ name: "shot.png", path: "attachments/shot.png", size: 2048 }],
        },
      ]);
    });

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("pushQueuedMessage (the panel's optimistic POST return) DEDUPES by seq against the frame", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({ type: "user.queued", seq: 21, content: "queued msg", ts: "2026-09-14T10:02:00Z" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.queued).toHaveLength(1);
    });

    // The panel's belt-and-suspenders push with the SAME seq — a no-op.
    useStreamStore.getState().pushQueuedMessage(PARENT, {
      seq: 21,
      content: "queued msg",
      ts: "2026-09-14T10:02:05Z",
    });
    expect(useStreamStore.getState().bySession[PARENT]?.queued).toHaveLength(1);

    // A DIFFERENT seq (a second queued message) appends in order.
    useStreamStore.getState().pushQueuedMessage(PARENT, {
      seq: 22,
      content: "second queued msg",
      ts: "2026-09-14T10:02:06Z",
    });
    expect(useStreamStore.getState().bySession[PARENT]?.queued.map((q) => q.seq)).toEqual([21, 22]);

    // removeQueuedMessage (the chip's optimistic X) drops exactly one.
    useStreamStore.getState().removeQueuedMessage(PARENT, 21);
    expect(useStreamStore.getState().bySession[PARENT]?.queued.map((q) => q.seq)).toEqual([22]);
    // Unknown seq is a safe no-op.
    useStreamStore.getState().removeQueuedMessage(PARENT, 999);
    expect(useStreamStore.getState().bySession[PARENT]?.queued.map((q) => q.seq)).toEqual([22]);

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("startStream RESETS the queue arrays (a fresh turn's queue starts empty) and the stream-end finally CLEARS them (the folded log owns the render)", async () => {
    // First stream: queue a message, let the stream end with it STILL
    // queued server-side (the plan's stop-does-not-purge semantics).
    const sse1 = manualSseResponse();
    const sse2 = manualSseResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(sse1.response).mockResolvedValueOnce(sse2.response),
    );

    const first = useStreamStore.getState().startStream(PARENT, "work");
    sse1.emit({ type: "user.queued", seq: 31, content: "still queued after stop", ts: "2026-09-14T10:03:00Z" });
    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.queued).toHaveLength(1);
    });
    sse1.emit({ type: "stopped" });
    sse1.close();
    await first;

    // The finally cleared the live arrays — the refetched fold (a
    // message.queued event) owns the chip render from here.
    const afterEnd = useStreamStore.getState().bySession[PARENT];
    expect(afterEnd?.queued).toEqual([]);
    expect(afterEnd?.deliveredQueued).toEqual([]);
    expect(afterEnd?.streamBusy).toBe(false);

    // The NEXT send resets them again (no stale chips ride into the new
    // turn — the backend pre-flips lingering undelivered events to
    // message.user before the new message).
    const second = useStreamStore.getState().startStream(PARENT, "next turn");
    expect(useStreamStore.getState().bySession[PARENT]?.queued).toEqual([]);
    // Belt-and-suspenders push AFTER the fresh startStream reset: a NEW
    // seq lands (the reset happened, the push is post-reset honest).
    useStreamStore.getState().pushQueuedMessage(PARENT, {
      seq: 32,
      content: "queued on the fresh turn",
      ts: "2026-09-14T10:04:00Z",
    });
    expect(useStreamStore.getState().bySession[PARENT]?.queued.map((q) => q.seq)).toEqual([32]);
    sse2.emit({ type: "stopped" });
    sse2.close();
    await second;
    expect(useStreamStore.getState().bySession[PARENT]?.queued).toEqual([]);
  });

  it("a meta.retry frame carrying providerError lands it in LiveTurnRetry (the honest live card's source)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({
      type: "meta.retry",
      attempt: 2,
      totalAttempts: 6,
      waitMs: 90_000,
      remainingMs: 90_000,
      retryAt: Date.now() + 90_000,
      errorClass: "rate_limit",
      classMessage: "rate limited — the provider is throttling requests",
      message: "rate limited — retrying (attempt 2 of 6) in 1.5 min",
      providerError: "Rate limit exceeded: free-models-per-day. Add 10 credits to continue.",
    });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.retry?.providerError).toBe(
        "Rate limit exceeded: free-models-per-day. Add 10 credits to continue.",
      );
    });

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });

  it("a meta.retry frame WITHOUT providerError leaves the field undefined (pre-R78 sidecars keep the old card)", async () => {
    const sse = manualSseResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse.response));

    const promise = useStreamStore.getState().startStream(PARENT, "work");
    sse.emit({
      type: "meta.retry",
      attempt: 3,
      totalAttempts: 6,
      waitMs: 300_000,
      remainingMs: 300_000,
      retryAt: Date.now() + 300_000,
      errorClass: "network",
      classMessage: "network error — the connection dropped",
      message: "network error — retrying (attempt 3 of 6) in 5 min",
    });

    await vi.waitFor(() => {
      expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.retry?.errorClass).toBe("network");
    });
    expect(useStreamStore.getState().bySession[PARENT]?.liveTurn?.retry?.providerError).toBeUndefined();

    sse.emit({ type: "stopped" });
    sse.close();
    await promise;
  });
});
