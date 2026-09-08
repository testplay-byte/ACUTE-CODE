// @vitest-environment happy-dom
/**
 * ROUND-48 (R48-e2) — SubAgentPanel CHAT-transcript tests (owner: "it should
 * look like the main chat, show the tools it runs live; the timer updates
 * every 5s instead of every second"). The R43 phase-card suite was rewritten
 * for the new UI — nothing deleted, every old guarantee carried forward:
 *
 *  1. The transcript renders from the polled GET /sessions/:childId event
 *     log: task bubble, todo progress line, main-chat-styled tool rows (ok
 *     glyph + expandable output), the informational approval card (decisions
 *     happen in the PARENT chat), and the code chip in the header.
 *  2. The header clock ticks EVERY SECOND (fake timers — 1000ms advance
 *     moves 0:00 → 0:01; the old 5000ms panel could not).
 *  3. Failed child → explicit banner with the error reason + the Retry
 *     primary action wired to POST …/subagents/:child/retry; a persisted
 *     turn.error renders the transcript error banner.
 *  4. Completed child → the LAST assistant message is the "Final report"
 *     bubble (markdown), earlier narration stays a plain bubble.
 *  5. approval.resolved folds into its requested card (approved state).
 *  6. Code chip resolves from the SSE live map even before the polled row
 *     lands; the tab-title fallback strips its "CODE · " prefix.
 *  7. The single initial-load spinner + the unbound-tab empty message.
 *
 * ROUND-51 (R51-b) additions (owner's fourth test round):
 *  8. The final-report bubble carries NO accent left rail — its border is
 *     IDENTICAL to a plain assistant bubble, and the "Final report"
 *     mini-label is quiet tertiary (not the accent).
 *  9. todo.update renders the FULL checklist — every item row with its
 *     status glyph (✓ / pulsing dot / ○) inside a max-h-40 scroll clamp.
 * 10. The stats footer is a CENTERED row (justify-center, hairline
 *     dividers, no stretching flex-1 cell) with all five stat testids.
 *
 * api is mocked with the importOriginal spread (FileViewerPanel's shared
 * Markdown renderer rides on use-projects → getProjectsBackend, so the mock
 * must keep the real module's other exports alive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchSubAgentDetail,
  fetchSubAgents,
  retrySubAgent,
  stopSessionTurn,
  type SessionDetail,
  type SessionEvent,
  type SubAgentStatus,
} from "../../lib/api";
import { useStreamStore } from "../../lib/stream-store";
import { SubAgentPanel } from "./SubAgentPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchSubAgentDetail: vi.fn(),
    fetchSubAgents: vi.fn(),
    retrySubAgent: vi.fn(),
    stopSessionTurn: vi.fn(),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(fetchSubAgentDetail).mockReset();
  vi.mocked(fetchSubAgents).mockReset().mockResolvedValue([]);
  vi.mocked(retrySubAgent).mockReset().mockResolvedValue(undefined);
  vi.mocked(stopSessionTurn).mockReset().mockResolvedValue(undefined);
  // Isolate the stream-store live map (the header code chip's freshest source).
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
});

const now = () => new Date().toISOString();

function ev(seq: number, type: string, payload: unknown): SessionEvent {
  return { seq, type, agentId: null, payload, ts: now() };
}

function detail(status: SessionDetail["status"], events: SessionEvent[]): SessionDetail {
  return {
    id: "child-1",
    projectId: "prj_1",
    agentId: "agt_coder",
    mode: "single",
    status,
    title: "Refactor auth module",
    createdAt: now(),
    updatedAt: now(),
    parentSessionId: "parent-1",
    subRole: "coder",
    events,
    lastSeq: events.length,
  };
}

/** GET /sessions/:parent/subagents row — now carries the required `code`
 * (R48-e1 wire contract; this is the fixture that fixed the repo's one
 * typecheck error) and `model` (R50-b stats footer). */
function subRow(over: Partial<SubAgentStatus> = {}): SubAgentStatus {
  return {
    id: "child-1",
    code: "K7Q2",
    taskId: null,
    title: "Refactor auth module",
    subRole: "coder",
    status: "running",
    createdAt: now(),
    updatedAt: now(),
    todosDone: 1,
    todosTotal: 3,
    inputTokens: 1200,
    outputTokens: 340,
    model: "deepseek/deepseek-chat-v3.1",
    report: null,
    error: null,
    ...over,
  };
}

const tab: RightSidebarTab = {
  id: "tab-1",
  type: "subagent",
  title: "Refactor auth module",
  subAgentId: "child-1",
  parentSessionId: "parent-1",
  subRole: "coder",
  createdAt: Date.now(),
};

const RUNNING_EVENTS: SessionEvent[] = [
  ev(1, "message.user", { role: "user", content: "Refactor src/auth into smaller modules and keep the public API." }),
  ev(2, "todo.update", {
    todos: [
      { content: "Map the auth module", status: "completed" },
      { content: "Extract session logic", status: "in_progress" },
      { content: "Write tests", status: "pending" },
    ],
  }),
  ev(3, "tool.use", { toolName: "write_file", argsSummary: "src/auth/fix.ts", ok: true, outputSummary: "wrote 42 lines" }),
  ev(4, "approval.requested", { approvalId: "appr_1", toolName: "run_command", argsSummary: "pnpm test", category: "confirm" }),
  ev(5, "tool.use", { toolName: "run_command", argsSummary: "pnpm test", ok: null }),
];

describe("SubAgentPanel (R48-e2 chat transcript)", () => {
  it("renders the chat transcript: task bubble, todo line, tool rows, informational approval card + the header code chip", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // The task — a right-aligned bubble (the main chat's user-bubble language).
    expect(await screen.findByTestId("subagent-task-bubble")).toBeTruthy();
    expect(
      screen.getByText("Refactor src/auth into smaller modules and keep the public API."),
    ).toBeTruthy();

    // todo.update — the FULL checklist (R51-b): the bar + 1/3 header, then
    // EVERY item as a status-glyph row (per-item coverage is pinned in the
    // dedicated R51-b test below; here the header + in-progress text).
    const todoLine = await screen.findByTestId("subagent-todo-line");
    expect(todoLine.textContent).toContain("1/3");
    expect(todoLine.textContent).toContain("Extract session logic");

    // Tool rows in the main chat's visual language: past-tense label + mono
    // args + the ok glyph. The finished write_file carries ✓ and its output
    // expands; the in-flight run_command carries the live "…".
    const writeRow = screen.getByRole("button", { name: "Wrote src/auth/fix.ts" });
    expect(writeRow.textContent).toContain("✓");
    const runRow = screen.getByRole("button", { name: "Ran pnpm test" });
    expect(runRow.textContent).toContain("…");
    expect(screen.queryByTestId("subagent-tool-output")).toBeNull();
    fireEvent.click(writeRow);
    expect(screen.getByTestId("subagent-tool-output").textContent).toContain("wrote 42 lines");

    // The approval ask — a compact INFORMATIONAL card; decisions happen in
    // the parent chat (no decision buttons here).
    const approval = screen.getByTestId("subagent-approval-card");
    expect(approval.textContent).toContain("Permission asked");
    expect(approval.textContent).toContain("run_command pnpm test");
    expect(approval.textContent).toContain("Decide in the main chat");
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();

    // Header: the child's code chip (polled row) + role + live status.
    expect(screen.getByTestId("subagent-code-chip").textContent).toBe("K7Q2");
    expect(screen.getByText("coder")).toBeTruthy();
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("running");

    // The live tail while work is in flight.
    expect(screen.getByText("working…")).toBeTruthy();
  });

  it("the header clock ticks every SECOND while running (was 5000ms)", async () => {
    // Fake ONLY the interval + Date (waitFor's own polling stays real), and
    // build the fixtures UNDER the fake clock so firstTs === now exactly.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const events: SessionEvent[] = [
        ev(1, "message.user", { role: "user", content: "Refactor src/auth into smaller modules." }),
        ev(2, "tool.use", { toolName: "run_command", argsSummary: "pnpm test", ok: null }),
      ];
      vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", events));
      vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
      renderWithProviders(<SubAgentPanel tab={tab} />);

      // Drain the initial mocked fetch + first render. The mocked fetch is
      // already resolved, but React 18 schedules the post-fetch re-render as
      // a MACROTASK (MessageChannel scheduler) — a real 0ms timeout yields
      // to it; pure-microtask draining would never flush it.
      await act(async () => {
        for (let i = 0; i < 20 && screen.queryByTestId("subagent-elapsed") === null; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });

      const clock = screen.getByTestId("subagent-elapsed");
      expect(clock.textContent).toBe("0:00");

      // ONE second of fake time must move the clock — the old 5000ms panel
      // would still read 0:00 here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId("subagent-elapsed").textContent).toBe("0:01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("failed child → banner with the recorded error + Retry primary action; a persisted turn.error renders the transcript error banner", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("failed", [
        ev(1, "message.user", { role: "user", content: "do the thing" }),
        ev(2, "tool.use", { toolName: "run_command", argsSummary: "pnpm build", ok: false, outputSummary: "exit 1" }),
        ev(3, "turn.error", {
          code: "PROVIDER_ERROR",
          message: "provider 'openrouter' call failed for session child-1",
          providerError: "429 rate limited",
        }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subRow({ status: "failed", error: "provider 'openrouter' call failed: 429 rate limited", todosDone: 0, todosTotal: 0 }),
    ]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    const failedBanner = screen.getByTestId("subagent-failed-banner");
    expect(failedBanner.textContent).toContain("Sub-agent failed");
    expect(failedBanner.textContent).toContain("429 rate limited");
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("failed");

    // The persisted turn.error event → the transcript's own error banner.
    const errorBanner = screen.getByTestId("subagent-error-banner");
    expect(errorBanner.textContent).toContain("Turn failed");
    expect(errorBanner.textContent).toContain("PROVIDER_ERROR");

    // Retry = the existing endpoint, wired to (parent, child).
    fireEvent.click(screen.getByRole("button", { name: "Retry sub-agent" }));
    await waitFor(() => expect(retrySubAgent).toHaveBeenCalledWith("parent-1", "child-1"));
  });

  it("completed child → the LAST assistant message is the markdown Final report bubble; earlier narration stays plain", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "summarize the change" }),
        ev(2, "tool.use", { toolName: "read_file", argsSummary: "src/auth/fix.ts", ok: true, outputSummary: null }),
        ev(3, "message.assistant", { role: "assistant", content: "Reading the files now." }),
        ev(4, "message.assistant", { role: "assistant", content: "Done — **auth split** into 3 modules, all tests green." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ status: "completed" })]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // Exactly one "Final report" label — on the LAST assistant bubble, and
    // it renders through the shared markdown renderer (bold → <strong>).
    expect(await screen.findAllByTestId("subagent-assistant-bubble")).toHaveLength(2);
    expect(screen.getAllByText("Final report")).toHaveLength(1);
    expect(screen.getByText("Reading the files now.")).toBeTruthy();
    const strong = screen.getByText("auth split");
    expect(strong.tagName).toBe("STRONG");

    // ROUND-51 (R51-b): NO accent left rail on the final report (the owner's
    // "AI slope" complaint) — the report bubble's border is IDENTICAL to a
    // plain assistant bubble: no borderLeft, the same borderColor, and the
    // quiet "Final report" mini-label wears the same tertiary color as the
    // bot glyph (NOT the accent — the header's code chip is the accent
    // reference).
    const [plainBubble, reportBubble] = screen.getAllByTestId("subagent-assistant-bubble");
    expect(reportBubble.style.borderLeft).toBe("");
    expect(reportBubble.style.borderLeftWidth).toBe("");
    expect(reportBubble.style.borderColor).not.toBe("");
    expect(reportBubble.style.borderColor).toBe(plainBubble.style.borderColor);
    const accentColor = screen.getByTestId("subagent-code-chip").style.color;
    expect(reportBubble.style.borderColor).not.toBe(accentColor);
    const label = screen.getByTestId("subagent-final-report-label");
    const botGlyph = reportBubble.previousElementSibling as HTMLElement;
    expect(label.style.color).toBe(botGlyph.style.color);
    expect(label.style.color).not.toBe(accentColor);

    // Terminal run: no live tail, no clock; the chip reads done.
    expect(screen.queryByText("working…")).toBeNull();
    expect(screen.queryByTestId("subagent-elapsed")).toBeNull();
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("done");
  });

  it("approval.resolved folds into its requested card (approved state, no decision note)", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "run the tests" }),
        ev(2, "approval.requested", { approvalId: "appr_1", toolName: "run_command", argsSummary: "pnpm test", category: "confirm" }),
        ev(3, "approval.resolved", { approvalId: "appr_1", decision: "approved", remember: "once" }),
        ev(4, "tool.use", { toolName: "run_command", argsSummary: "pnpm test", ok: true, outputSummary: "exit 0" }),
      ]),
    );
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const approval = await screen.findByTestId("subagent-approval-card");
    expect(approval.textContent).toContain("Permission approved");
    expect(approval.textContent).not.toContain("Permission asked");
    expect(approval.textContent).not.toContain("Decide in the main chat");
  });

  it("the code chip resolves from the SSE live map (fresher than the poll)", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": {
          childSessionId: "child-1",
          parentSessionId: "parent-1",
          code: "X9PL",
          role: "coder",
          task: "Refactor auth module",
          status: "running",
          updatedAtMs: Date.now(),
          // ROUND-50 (R50-b): the live raw-stream fields.
          liveText: "",
          liveThinking: "",
          liveToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          lastActivityTs: 0,
          liveSteps: [],
          startedAtMs: Date.now(),
        },
      },
    });
    // The polled row is EMPTY — only the live map knows the code.
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByTestId("subagent-code-chip")).toBeTruthy();
    expect(screen.getByTestId("subagent-code-chip").textContent).toBe("X9PL");
  });

  it("ROUND-79: an addressable child shows the task_id chip beside the code chip (polled row)", async () => {
    // The polled /subagents row carries taskId (migration 0028) — the
    // addressable surface: what delegate_task {"resume":"…"} accepts.
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subRow({ taskId: "bg-research", status: "running" }),
    ]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByTestId("subagent-taskid-chip")).toBeTruthy();
    expect(screen.getByTestId("subagent-taskid-chip").textContent).toBe("bg-research");
    // The code chip is still there (the two are siblings, never merged).
    expect(screen.getByTestId("subagent-code-chip").textContent).toBe("K7Q2");
  });

  it("ROUND-79: an unaddressed child (taskId null — every pre-R79 child) renders NO task_id chip", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ status: "running" })]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByTestId("subagent-code-chip")).toBeTruthy();
    expect(screen.queryByTestId("subagent-taskid-chip")).toBeNull();
  });

  it("ROUND-79: the task_id chip resolves from the SSE live map (fresher than the poll)", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": {
          childSessionId: "child-1",
          parentSessionId: "parent-1",
          code: "X9PL",
          taskId: "live-task",
          role: "coder",
          task: "Refactor auth module",
          status: "running",
          updatedAtMs: Date.now(),
          liveText: "",
          liveThinking: "",
          liveToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          lastActivityTs: 0,
          liveSteps: [],
          startedAtMs: Date.now(),
        },
      },
    });
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByTestId("subagent-taskid-chip")).toBeTruthy();
    expect(screen.getByTestId("subagent-taskid-chip").textContent).toBe("live-task");
  });

  it("without a polled row, the header title falls back to the tab title minus its code prefix (no chip)", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([]);
    renderWithProviders(<SubAgentPanel tab={{ ...tab, title: "K7Q2 · Legacy tab title" }} />);

    expect(await screen.findByTestId("subagent-status-chip")).toBeTruthy();
    expect(screen.queryByTestId("subagent-code-chip")).toBeNull();
    // The code is shown as its own chip or not at all — never duplicated in
    // the title text.
    expect(screen.getByTitle("Legacy tab title")).toBeTruthy();
  });

  it("initial load shows the single spinner state (no transcript yet)", async () => {
    vi.mocked(fetchSubAgentDetail).mockReturnValue(new Promise<SessionDetail>(() => {}));
    renderWithProviders(<SubAgentPanel tab={tab} />);
    expect(await screen.findByText("Loading sub-agent…")).toBeTruthy();
    expect(screen.queryByTestId("subagent-task-bubble")).toBeNull();
  });

  it("unbound tab → the empty message", () => {
    renderWithProviders(
      <SubAgentPanel
        tab={{ ...tab, subAgentId: undefined, parentSessionId: undefined }}
      />,
    );
    expect(screen.getByText("No sub-agent bound to this tab.")).toBeTruthy();
  });
});

// ─── ROUND-50 (R50-b): the LIVE raw-stream segment + the pinned stats footer ──

describe("SubAgentPanel (R50-b live raw stream + stats footer)", () => {
  /** A full live-map entry (the R50-b shape) for the running child. */
  function liveEntry(over: Partial<Parameters<typeof makeLive>[0]> = {}) {
    return makeLive(over);
  }
  // Helper indirection so the fixture's fields stay optional per-call.
  function makeLive(over: Record<string, unknown> = {}) {
    return {
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      code: "K7Q2",
      role: "coder",
      task: "Refactor auth module",
      status: "running" as const,
      updatedAtMs: Date.now(),
      model: "deepseek/deepseek-chat-v3.1",
      liveText: "Reading src/auth.ts",
      liveThinking: "I should read the file first.",
      liveToolCalls: 1,
      inputTokens: 7,
      outputTokens: 3,
      lastActivityTs: Date.now(),
      liveSteps: [
        { type: "thinking" as const, text: "I should read the file first." },
        {
          type: "tool" as const,
          tool: { toolName: "read_file", argsSummary: "path: src/auth.ts", ok: true, outputSummary: "42 chars" },
        },
        { type: "text" as const, text: "Reading src/auth.ts" },
      ],
      startedAtMs: Date.now(),
      ...over,
    };
  }

  it("renders the child's LIVE raw stream — thinking block, interleaved tool row, streaming text with caret", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: { "child-1": liveEntry() },
    });
    // The polled detail lags: its persisted tool/assistant rows are for OTHER
    // work (different content) so the suppression rule is observable.
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("running", [
        ev(1, "message.user", { role: "user", content: "Refactor src/auth into smaller modules." }),
        ev(2, "todo.update", {
          todos: [{ content: "Map the module", status: "in_progress" }],
        }),
        ev(3, "tool.use", { toolName: "run_command", argsSummary: "polled-only row", ok: true }),
        ev(4, "message.assistant", { role: "assistant", content: "Polled-only interim reply." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // The live segment: raw thinking (ThoughtRow renders live expanded),
    // the live tool row, and the raw text streaming WITH the main chat's
    // caret — in arrival order.
    const segment = await screen.findByTestId("subagent-live-stream");
    expect(segment.textContent).toContain("I should read the file first.");
    const liveText = screen.getByTestId("subagent-live-text");
    expect(liveText.textContent).toContain("Reading src/auth.ts");
    expect(liveText.querySelector(".ac-caret-blink")).not.toBeNull();
    const liveToolRow = screen.getByRole("button", { name: "Read path: src/auth.ts" });
    expect(liveToolRow.textContent).toContain("✓");
    expect(screen.getByText("streaming live")).toBeTruthy();

    // Poll-suppression rule: the polled tool/assistant rows are hidden while
    // the live segment renders them (no duplication) — but the task bubble +
    // todo line (kinds the live stream never carries) still render.
    expect(screen.queryByRole("button", { name: "Ran polled-only row" })).toBeNull();
    expect(screen.queryByText("Polled-only interim reply.")).toBeNull();
    expect(screen.getByTestId("subagent-task-bubble").textContent).toContain(
      "Refactor src/auth into smaller modules.",
    );
    expect(screen.getByTestId("subagent-todo-line").textContent).toContain("0/1");

    // The live segment carries the in-flight beat (no separate "working…" tail).
    expect(screen.queryByText("working…")).toBeNull();
  });

  it("the live segment hides once the polled transcript catches up after completion (the handoff rule)", async () => {
    // Terminal child: the live entry is FROZEN with its final text, and the
    // polled log already carries the closing assistant reply → the folded
    // transcript takes over (live segment hidden, full transcript renders).
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": liveEntry({ status: "completed", liveText: "Done — auth split.", liveSteps: [
          { type: "text" as const, text: "Done — auth split." },
        ] }),
      },
    });
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "summarize the change" }),
        ev(2, "tool.use", { toolName: "read_file", argsSummary: "src/auth/fix.ts", ok: true, outputSummary: null }),
        ev(3, "message.assistant", { role: "assistant", content: "Done — **auth split** into 3 modules." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ status: "completed" })]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // The folded transcript owns the render: the persisted tool row + final
    // assistant bubble are back, the live segment is gone.
    expect(await screen.findByRole("button", { name: "Read src/auth/fix.ts" })).toBeTruthy();
    expect(screen.getAllByTestId("subagent-assistant-bubble")).toHaveLength(1);
    expect(screen.queryByTestId("subagent-live-stream")).toBeNull();
  });

  it("stats footer — LIVE values while running: live clock, live token counters, live tps, model", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      useStreamStore.setState({
        bySession: {},
        subagentsLive: {
          // Live counters (7/60) differ from the row's (1200/340) — the LIVE
          // ones must win while the child works.
          "child-1": liveEntry({ inputTokens: 7, outputTokens: 60 }),
        },
      });
      vi.mocked(fetchSubAgentDetail).mockResolvedValue(
        detail("running", [
          ev(1, "message.user", { role: "user", content: "do the work" }),
        ]),
      );
      vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ createdAt, updatedAt: createdAt })]);
      renderWithProviders(<SubAgentPanel tab={tab} />);

      // Drain the mocked fetch + first render (React 18 macrotask scheduling).
      await act(async () => {
        for (let i = 0; i < 20 && screen.queryByTestId("subagent-stats-footer") === null; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });

      expect(screen.getByTestId("subagent-stat-time").textContent).toBe("TIME1:00");
      expect(screen.getByTestId("subagent-stat-in").textContent).toBe("SENT↑ 7");
      expect(screen.getByTestId("subagent-stat-out").textContent).toBe("RECV↓ 60");
      // 60 output tokens over 60s = 1.0 tok/s (live feed).
      expect(screen.getByTestId("subagent-stat-tps").textContent).toBe("TOK/S1.0");
      // ROUND-51 (R51-b): the model cell is now a centered StatCell like
      // the others — its testid covers label+value (same as TIME/SENT/…).
      expect(screen.getByTestId("subagent-stat-model").textContent).toBe("MODELdeepseek/deepseek-chat-v3.1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stats footer — authoritative ROW values after completion: createdAt→updatedAt elapsed, ledger tokens, row model", async () => {
    useStreamStore.setState({
      bySession: {},
      // A frozen live entry with DIFFERENT values — the row must win.
      subagentsLive: {
        "child-1": liveEntry({
          status: "completed",
          inputTokens: 7,
          outputTokens: 3,
          liveText: "",
          liveThinking: "",
          liveSteps: [],
          liveToolCalls: 0,
        }),
      },
    });
    const createdAt = new Date(Date.now() - 90_000).toISOString();
    const updatedAt = new Date(Date.now()).toISOString();
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "summarize" }),
        ev(2, "message.assistant", { role: "assistant", content: "Done." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subRow({ status: "completed", createdAt, updatedAt, model: "test/model-1" }),
    ]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByTestId("subagent-stats-footer")).toBeTruthy();
    // Total time = createdAt → updatedAt = 1:30; row tokens 1200/340;
    // tps = 340 / 90s = 3.8; the row's usage-derived model.
    expect(screen.getByTestId("subagent-stat-time").textContent).toBe("TIME1:30");
    expect(screen.getByTestId("subagent-stat-in").textContent).toBe("SENT↑ 1.2k");
    expect(screen.getByTestId("subagent-stat-out").textContent).toBe("RECV↓ 340");
    expect(screen.getByTestId("subagent-stat-tps").textContent).toBe("TOK/S3.8");
    expect(screen.getByTestId("subagent-stat-model").textContent).toBe("MODELtest/model-1");
  });
});

// ─── ROUND-52 (R52-b/R52-c): Stop button + watch line + terminal detail ─────

describe("SubAgentPanel (R52-c supervision: Stop + watch + detail)", () => {
  /** A live-map entry for the running child (the R50-b shape + R52 watch). */
  function liveEntry(over: Record<string, unknown> = {}) {
    return {
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      code: "K7Q2",
      role: "coder",
      task: "Refactor auth module",
      status: "running" as const,
      updatedAtMs: Date.now(),
      liveText: "",
      liveThinking: "",
      liveToolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastActivityTs: Date.now(),
      liveSteps: [],
      startedAtMs: Date.now(),
      ...over,
    };
  }

  it("running child → the Stop button renders; click calls stopSessionTurn and flips the chip to 'stopping'", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // The button carries the child's code and fires the stop endpoint with
    // the CHILD session id (POST /sessions/:id/stop aborts only this child —
    // the parent turn continues).
    const stop = await screen.findByRole("button", { name: "Stop sub-agent K7Q2" });
    expect(screen.queryByTestId("subagent-status-detail")).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(stopSessionTurn).toHaveBeenCalledWith("child-1"));

    // Optimistic local flip: the chip reads "stopping" and the button is
    // disabled while the turn settles (no double-fire).
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("stopping");
    expect((screen.getByTestId("subagent-stop-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a settled child shows no Stop button (settled turns can't be stopped)", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "do it" }),
        ev(2, "message.assistant", { role: "assistant", content: "Done." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ status: "completed" })]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // Wait for the SETTLED state (the polled detail lands) before asserting
    // the affordance is gone — while loading, the derived status is "queued"
    // and the button legitimately renders.
    await waitFor(() =>
      expect(screen.getByTestId("subagent-status-chip").textContent).toContain("done"),
    );
    expect(screen.queryByTestId("subagent-stop-button")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stop sub-agent/ })).toBeNull();
    expect(stopSessionTurn).not.toHaveBeenCalled();
  });

  it("a running frame's watch payload renders the live activity strip (activity · age · tools · todos)", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": liveEntry({
          watch: {
            lastEventAgeMs: 1200,
            lastActivity: "run_command pnpm build",
            toolCount: 3,
            todosDone: 1,
            todosTotal: 4,
            elapsedMs: 47_000,
            stalled: false,
          },
        }),
      },
    });
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const line = await screen.findByTestId("subagent-watch-line");
    expect(line.textContent).toContain("run_command pnpm build");
    expect(line.textContent).toContain("· 47s");
    expect(line.textContent).toContain("3 tools");
    expect(line.textContent).toContain("✓ 1/4");
    expect(line.getAttribute("data-stalled")).toBeNull();
  });

  it("a STALLED watch sample turns the line amber with the no-activity warning", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": liveEntry({
          watch: {
            lastEventAgeMs: 340_000,
            lastActivity: "run_command pnpm build",
            toolCount: 3,
            todosDone: 1,
            todosTotal: 4,
            elapsedMs: 47_000,
            stalled: true,
          },
        }),
      },
    });
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const line = await screen.findByTestId("subagent-watch-line");
    expect(line.textContent).toContain("no activity for 340s — supervisor watching");
    expect(line.getAttribute("data-stalled")).toBe("true");
    // The quiet activity text is REPLACED by the warning, not shown twice.
    expect(line.textContent).not.toContain("run_command pnpm build");
  });

  it("a failed frame's detail renders as the status line instead of a bare 'failed'", async () => {
    useStreamStore.setState({
      bySession: {},
      subagentsLive: {
        "child-1": liveEntry({
          status: "failed" as const,
          detail: "stopped by the owner",
        }),
      },
    });
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("failed", [ev(1, "message.user", { role: "user", content: "do the thing" })]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subRow({ status: "failed", error: "stopped by the owner" }),
    ]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const detailLine = await screen.findByTestId("subagent-status-detail");
    expect(detailLine.textContent).toContain("stopped by the owner");
    // The chip still reads the honest terminal state (once the polled detail
    // lands — the strip renders from the live map immediately, the chip
    // derives from the query); the watch line is gone (heartbeats are
    // running-only) and a settled child has no Stop button.
    await waitFor(() =>
      expect(screen.getByTestId("subagent-status-chip").textContent).toContain("failed"),
    );
    expect(screen.queryByTestId("subagent-watch-line")).toBeNull();
    expect(screen.queryByTestId("subagent-stop-button")).toBeNull();
  });
});

describe("SubAgentPanel (R51-b full todo list + centered stats footer)", () => {
  it("todo.update renders the FULL checklist — every item row with its per-status glyph, in a max-h-40 scroll clamp", async () => {
    // A multi-item snapshot through the panel's real path (the polled
    // transcript — the child's todo_write only persists todo.update events;
    // the SSE stream carries no todo frames, so this IS the live source too
    // while the 600ms poll runs).
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("running", [
        ev(1, "message.user", { role: "user", content: "Refactor src/auth into smaller modules." }),
        ev(2, "todo.update", {
          todos: [
            { content: "Map the auth module", status: "completed" },
            { content: "Extract session logic", status: "in_progress" },
            { content: "Write tests", status: "pending" },
            { content: "Update the docs", status: "pending" },
          ],
        }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow()]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const todoLine = await screen.findByTestId("subagent-todo-line");
    // The one-line header: bar + 1/4 (one completed of four — the
    // TRANSCRIPT's own snapshot rules the header, not the subagents row).
    expect(todoLine.textContent).toContain("1/4");

    // EVERY item renders — the owner only saw the progress before.
    const rows = screen.getAllByTestId("subagent-todo-item");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual([
      "completed",
      "in_progress",
      "pending",
      "pending",
    ]);

    // Per-status glyphs: ✓ (completed), a pulsing dot (in-progress — no text
    // glyph), ○ (pending).
    expect(rows[0].textContent).toContain("Map the auth module");
    expect(rows[0].textContent).toContain("✓");
    expect(rows[0].querySelector(".rounded-full")).toBeNull();

    expect(rows[1].textContent).toContain("Extract session logic");
    expect(rows[1].textContent).not.toContain("✓");
    expect(rows[1].textContent).not.toContain("○");
    expect(rows[1].querySelector(".rounded-full")).not.toBeNull();

    expect(rows[2].textContent).toContain("Write tests");
    expect(rows[2].textContent).toContain("○");
    expect(rows[3].textContent).toContain("Update the docs");
    expect(rows[3].textContent).toContain("○");

    // Long plans scroll inside the clamp instead of blowing up the panel.
    expect(todoLine.querySelector(".max-h-40.overflow-y-auto")).not.toBeNull();
  });

  it("the stats footer is a CENTERED row — justify-center, hairline dividers, no stretching cell, all five stats", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "summarize" }),
        ev(2, "message.assistant", { role: "assistant", content: "Done." }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([subRow({ status: "completed" })]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    const footer = await screen.findByTestId("subagent-stats-footer");
    // CENTERED (the owner's ask) — not the old left-aligned items-end row.
    expect(footer.className).toContain("justify-center");
    expect(footer.className).not.toContain("items-end");
    expect(footer.className).toContain("h-10");
    // No stretching flex-1 model cell (the old layout stretched it left).
    expect(footer.querySelector(".flex-1")).toBeNull();
    // Hairline dividers between the five cells.
    expect(footer.querySelectorAll(".h-4.w-px")).toHaveLength(4);
    // All five stats render.
    for (const id of [
      "subagent-stat-time",
      "subagent-stat-in",
      "subagent-stat-out",
      "subagent-stat-tps",
      "subagent-stat-model",
    ]) {
      expect(footer.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});
