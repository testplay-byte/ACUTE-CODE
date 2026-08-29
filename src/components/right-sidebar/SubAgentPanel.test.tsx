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
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(fetchSubAgentDetail).mockReset();
  vi.mocked(fetchSubAgents).mockReset().mockResolvedValue([]);
  vi.mocked(retrySubAgent).mockReset().mockResolvedValue(undefined);
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
 * typecheck error). */
function subRow(over: Partial<SubAgentStatus> = {}): SubAgentStatus {
  return {
    id: "child-1",
    code: "K7Q2",
    title: "Refactor auth module",
    subRole: "coder",
    status: "running",
    createdAt: now(),
    updatedAt: now(),
    todosDone: 1,
    todosTotal: 3,
    inputTokens: 1200,
    outputTokens: 340,
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

    // todo.update — the compact progress line: bar + 1/3 + the current item.
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
