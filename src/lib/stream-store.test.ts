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
  getSubAgentLiveEntry,
  selectSubAgentsLive,
  useStreamStore,
} from "./stream-store";
import { useActiveStreams } from "./active-streams";
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
