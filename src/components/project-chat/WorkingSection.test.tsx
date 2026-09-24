// @vitest-environment happy-dom
/**
 * ROUND-46 (R46-c) tests — the checkpoint restore UI in WorkingSection's
 * DiffDetail (the write_file/edit_file expanded bodies), plus the loadDiff
 * race fix that came out of it.
 *
 * The api module is mocked at the checkpoint-function level: DiffDetail calls
 * fetchSessionCheckpoints/fetchSnapshot/restoreCheckpoint DIRECTLY (no backend
 * selector), so the mock factory keeps the real module but overrides exactly
 * those three. Toasts are asserted on the notification stream store (the
 * Toaster itself is mounted in AppShell, not in this test tree) — the same
 * pattern as the R44-c revert tests in AgentChatPanel.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  BareWorkingEntries,
  FILE_MUTATION_TOOLS,
  WorkingSection,
  assignDelegateChildren,
  toolStatusDetail,
} from "./WorkingSection";
import {
  ApiError,
  fetchComputerFrameRaster,
  fetchSessionCheckpoints,
  fetchSnapshot,
  fetchSubAgents,
  restoreCheckpoint,
  type CheckpointMeta,
  type FileSnapshotContent,
  type SubAgentStatus,
  type ToolUseEntry,
  type WorkingEntry,
} from "../../lib/api";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { useStreamStore } from "../../lib/stream-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { deriveThemeStyles } from "../../lib/themes";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { withAlpha } from "../dashboard/helpers";

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  return {
    ...mod,
    fetchSessionCheckpoints: vi.fn(),
    fetchSnapshot: vi.fn(),
    restoreCheckpoint: vi.fn(),
    fetchSubAgents: vi.fn(),
    // ROUND-68 (R68-A): the INLINE ScreenshotRow lazy-fetches its raster —
    // mock it so the inline-row tests below never touch the network.
    fetchComputerFrameRaster: vi.fn(),
  };
});

// R101-F (DEFECT 4): the mermaid mock — a CLOSED ```mermaid fence inside a
// thinking block now mounts MermaidDiagram (the same renderer the answers
// use). The vi.mock shape mirrors ChatMarkdown.test's: nothing here imports
// mermaid at module scope, so the mock only ever answers the component's
// LAZY dynamic import — and initialize/render are vi.fn()s armed per-test
// (the file-level afterEach restoreAllMocks wipes the behaviors).
const mockMermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mockMermaid.initialize,
    render: mockMermaid.render,
  },
}));

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetTestState();
  useNotificationStreamStore.getState().reset();
  vi.mocked(fetchSessionCheckpoints).mockReset().mockResolvedValue([]);
  vi.mocked(fetchSnapshot).mockReset().mockResolvedValue(null);
  vi.mocked(restoreCheckpoint)
    .mockReset()
    .mockResolvedValue({ restored: true, message: "restored src/app.ts to previous content" });
  vi.mocked(fetchSubAgents).mockReset().mockResolvedValue([]);
  // ROUND-48 (R48-e2): isolate the stream-store live map + the sidebar store
  // (openSubAgent lands tabs in byProject).
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  useRightSidebarStore.setState({ byProject: {}, activeProjectId: null, activeSessionByProject: {} });
});

const SESSION_ID = "sess_ws_probe";

/** An edit_file tool.use row whose snapshot (seq 4) touched src/app.ts. */
const EDIT_TOOL: ToolUseEntry = {
  seq: 4,
  toolName: "edit_file",
  argsSummary: "path: src/app.ts, content: 20 chars",
  ok: true,
  ts: "2026-08-28T10:00:04Z",
  outputSummary: "edited src/app.ts",
};

/** A write_file row that CREATED src/created.ts (snapshot has no before). */
const WRITE_TOOL: ToolUseEntry = {
  seq: 4,
  toolName: "write_file",
  argsSummary: "path: src/created.ts, content: 14 chars",
  ok: true,
  ts: "2026-08-28T10:00:04Z",
  outputSummary: "wrote src/created.ts",
};

const CP: CheckpointMeta = {
  id: "snap_1",
  seq: 4,
  path: "src/app.ts",
  toolName: "edit_file",
  ts: "2026-08-28T10:00:04Z",
  hadBefore: true,
};

const CREATE_CP: CheckpointMeta = {
  id: "snap_2",
  seq: 4,
  path: "src/created.ts",
  toolName: "write_file",
  ts: "2026-08-28T10:00:04Z",
  hadBefore: false,
};

function snapshotBody(hadBefore: boolean): FileSnapshotContent {
  return {
    id: hadBefore ? "snap_1" : "snap_2",
    sessionId: SESSION_ID,
    seq: 4,
    path: hadBefore ? "src/app.ts" : "src/created.ts",
    toolName: hadBefore ? "edit_file" : "write_file",
    ts: "2026-08-28T10:00:04Z",
    beforeContent: hadBefore ? "old line\nshared" : null,
    afterContent: hadBefore ? "new line\nshared" : "new file body",
  };
}

/** Render one tool row inside an expanded Working section, then expand the
 * tool line itself so its DiffDetail body mounts. */
function renderExpandedTool(tool: ToolUseEntry = EDIT_TOOL) {
  const entries: WorkingEntry[] = [{ type: "tool", tool }];
  renderWithProviders(
    <WorkingSection
      entries={entries}
      sessionId={SESSION_ID}
      projectId="proj_probe"
      defaultOpen
    />,
  );
  const label = tool.toolName === "edit_file" ? "Edited" : "Wrote";
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label} `) }));
}

/** Resolve a normal edit snapshot (before + after) so the diff + Restore render. */
async function setupResolvedSnapshot() {
  vi.mocked(fetchSessionCheckpoints).mockResolvedValue([CP]);
  vi.mocked(fetchSnapshot).mockResolvedValue(snapshotBody(true));
  renderExpandedTool();
  expect(await screen.findByText("new line")).toBeTruthy();
}

describe("DiffDetail loadDiff race fix (ROUND-46 R46-c)", () => {
  it("waits for the checkpoints query instead of baking 'no snapshot recorded' forever", async () => {
    // The checkpoints list resolves LATE — the diff card mounts while the
    // query is still in flight. The pre-R46-c code resolved against `?? []`
    // right here, baked the miss, and the `diffLines !== null` guard blocked
    // the re-run when the data finally arrived.
    let release!: (value: CheckpointMeta[]) => void;
    const gate = new Promise<CheckpointMeta[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchSessionCheckpoints).mockReturnValue(gate);
    vi.mocked(fetchSnapshot).mockResolvedValue(snapshotBody(true));

    renderExpandedTool();

    // Still loading → the race guard returns early: nothing fetched, nothing baked.
    expect(vi.mocked(fetchSnapshot)).not.toHaveBeenCalled();

    release([CP]);
    // Data arrival re-fires the effect → the REAL diff renders (not the miss).
    expect(await screen.findByText("new line")).toBeTruthy();
    expect(screen.queryByText(/no snapshot recorded/)).toBeNull();
    expect(vi.mocked(fetchSnapshot)).toHaveBeenCalledWith(SESSION_ID, 4);
  });

  it("still renders 'no snapshot recorded' when the session genuinely has none", async () => {
    vi.mocked(fetchSessionCheckpoints).mockResolvedValue([]);
    renderExpandedTool();

    expect(await screen.findByText(/no snapshot recorded for this change/)).toBeTruthy();
    expect(vi.mocked(fetchSnapshot)).not.toHaveBeenCalled();
  });
});

describe("DiffDetail restore action (ROUND-46 R46-c)", () => {
  it("Restore is hidden for a create (beforeContent === null — the backend would DELETE the file)", async () => {
    vi.mocked(fetchSessionCheckpoints).mockResolvedValue([CREATE_CP]);
    vi.mocked(fetchSnapshot).mockResolvedValue(snapshotBody(false));
    renderExpandedTool(WRITE_TOOL);

    // The all-add create diff renders…
    expect(await screen.findByText("new file body")).toBeTruthy();
    // …but no Restore affordance: restoring a create is the backend's unlink
    // (delete) branch, deliberately not exposed from this UI.
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(vi.mocked(restoreCheckpoint)).not.toHaveBeenCalled();
  });

  it("restore is two-step: the first click only arms 'Confirm restore?' + Cancel (no API call)", async () => {
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(screen.getByRole("button", { name: /Confirm restore\?/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(vi.mocked(restoreCheckpoint)).not.toHaveBeenCalled();
  });

  it("Cancel disarms back to idle without calling the API", async () => {
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm restore\?/ })).toBeNull();
    expect(vi.mocked(restoreCheckpoint)).not.toHaveBeenCalled();
  });

  it("confirming calls restoreCheckpoint with the resolved snapshot's id", async () => {
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm restore\?/ }));

    await waitFor(() => expect(vi.mocked(restoreCheckpoint)).toHaveBeenCalledWith("snap_1"));
  });

  it("success: green Restored pill + honest history note + 'File restored' toast + tree/file invalidation", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm restore\?/ }));

    // Terminal green pill (a span, not a button) + the honest note that the
    // diff above is the recorded history — the stored snapshot didn't change.
    expect(await screen.findByText("Restored")).toBeTruthy();
    expect(screen.getByText(/diff above is the recorded history/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();

    // Success toast landed in the stream store carrying the server's message.
    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("File restored"),
    );
    expect(useNotificationStreamStore.getState().lastNotification?.body).toBe(
      "restored src/app.ts to previous content",
    );

    // The explorer tree + open file views refetch (same keys as the send path).
    const keys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["project-tree"]);
    expect(keys).toContainEqual(["project-file"]);
  });

  it("failure: persistent task_failed toast carries the server message and returns to idle for retry", async () => {
    vi.mocked(restoreCheckpoint).mockRejectedValue(
      new ApiError(409, "CONFLICT", "session has no project — cannot determine root"),
    );
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm restore\?/ }));

    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("Restore failed"),
    );
    const toast = useNotificationStreamStore.getState().lastNotification;
    expect(toast?.kind).toBe("task_failed");
    expect(toast?.body).toContain("cannot determine root");

    // Back to idle — the Restore button is armed again (retry is possible)
    // and no success note was rendered.
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByText(/diff above is the recorded history/)).toBeNull();
  });

  it("while restoring: a disabled 'Restoring…' pill replaces the confirm affordance", async () => {
    let release!: (value: { restored: true; message: string }) => void;
    vi.mocked(restoreCheckpoint).mockReturnValue(
      new Promise<{ restored: true; message: string }>((resolve) => {
        release = resolve;
      }),
    );
    await setupResolvedSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm restore\?/ }));

    const busy = await screen.findByRole("button", { name: /Restoring…/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    // The destructive affordances are gone while the call is in flight.
    expect(screen.queryByRole("button", { name: /Confirm restore\?/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    release({ restored: true, message: "restored src/app.ts to previous content" });
    await waitFor(() => expect(screen.getByText("Restored")).toBeTruthy());
  });
});

// ─── ROUND-48 (R48-e2): the live Delegated card + sub-agent approval attribution ──

function subAgentRow(over: Partial<SubAgentStatus> = {}): SubAgentStatus {
  return {
    id: "sess_child-a",
    code: "K7Q2",
    taskId: null,
    title: "Refactor auth module",
    subRole: "coder",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    todosDone: 2,
    todosTotal: 5,
    inputTokens: 1200,
    outputTokens: 340,
    model: null, // ROUND-50 (R50-b): stats-footer field (null = no usage row yet)
    report: null,
    error: null,
    ...over,
  };
}

const DELEGATE_TOOL: ToolUseEntry = {
  seq: 7,
  toolName: "delegate_task",
  argsSummary: "task: Refactor auth module, role: coder",
  ok: null,
  ts: "2026-08-28T10:00:07Z",
};

function renderDelegateSection(tool: ToolUseEntry = DELEGATE_TOOL, extraEntries: WorkingEntry[] = []) {
  const entries: WorkingEntry[] = [{ type: "tool", tool }, ...extraEntries];
  renderWithProviders(
    <WorkingSection
      entries={entries}
      sessionId={SESSION_ID}
      projectId="proj_probe"
      live
      defaultOpen
    />,
  );
}

describe("Delegated card live rows (ROUND-48 R48-e2)", () => {
  it("renders live child rows (code/role/status/todos/tokens + lastActivity) and opens the child on click", async () => {
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subAgentRow(),
      subAgentRow({ id: "sess_child-b", code: "M3XN", title: "Write tests", subRole: "tester", status: "queued", todosDone: 0, todosTotal: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
    // ROUND-64 (R64-c): TWO pending delegate rows — each CLAIMS one live
    // child (earliest-created first), so expanding each row shows its own
    // child (the pre-R64 code showed ALL live children in EVERY row).
    const second = {
      ...DELEGATE_TOOL,
      seq: 8,
      argsSummary: "task: Write tests, role: tester",
    };
    renderDelegateSection(DELEGATE_TOOL, [{ type: "tool", tool: second }]);
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Refactor auth module/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Write tests/ }));

    // Each expanded body renders its OWN claimed child's row (code chip +
    // progress) — and ONLY that one.
    expect(await screen.findByText("K7Q2")).toBeTruthy();
    expect(screen.getByText("M3XN")).toBeTruthy();
    expect(screen.getByText("2/5 todos")).toBeTruthy();
    expect(screen.getByText("↑1.2k ↓340")).toBeTruthy();

    // Clicking a live row opens THAT child's tab with a code-prefixed title.
    fireEvent.click(screen.getByRole("button", { name: "Open sub-agent K7Q2 · Refactor auth module in sidebar" }));
    const slices = Object.values(useRightSidebarStore.getState().byProject);
    expect(slices).toHaveLength(1);
    const tab = slices[0].tabs.find((t) => t.type === "subagent");
    expect(tab).toMatchObject({
      type: "subagent",
      subAgentId: "sess_child-a",
      parentSessionId: SESSION_ID,
      subRole: "coder",
      title: "K7Q2 · Refactor auth module",
    });
  });

  it("renders the live map's lastActivity under the matching row (fresher than the poll)", async () => {
    vi.mocked(fetchSubAgents).mockResolvedValue([subAgentRow()]);
    useStreamStore.setState({
      subagentsLive: {
        "sess_child-a": {
          childSessionId: "sess_child-a",
          parentSessionId: SESSION_ID,
          code: "K7Q2",
          role: "coder",
          task: "Refactor auth module",
          status: "running",
          lastActivity: "run_command ✓ exit 0",
          updatedAtMs: Date.now(),
          // ROUND-50 (R50-b): the live raw-stream fields (empty — this test
          // only exercises lastActivity).
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
    renderDelegateSection();
    fireEvent.click(screen.getByRole("button", { name: /^Delegated / }));

    expect(await screen.findByText("run_command ✓ exit 0")).toBeTruthy();
  });

  it("with exactly ONE live child the Delegated row itself opens that child (no expand toggle)", async () => {
    vi.mocked(fetchSubAgents).mockResolvedValue([subAgentRow()]);
    renderDelegateSection();

    const row = await screen.findByRole("button", {
      name: "Open sub-agent K7Q2 · Refactor auth module in sidebar",
    });
    // The trailing affordance reads as open-in-sidebar, and clicking the row
    // opens the child directly.
    expect(row.textContent).toContain("live");
    fireEvent.click(row);

    const slices = Object.values(useRightSidebarStore.getState().byProject);
    const tab = slices[0]?.tabs.find((t) => t.type === "subagent");
    expect(tab).toMatchObject({ subAgentId: "sess_child-a", title: "K7Q2 · Refactor auth module" });
    // The row did NOT expand (its action is open, not toggle).
    expect(screen.queryByTestId("live-delegate-row")).toBeNull();
  });

  it("a completed delegate_task shows the code chip above the SubAgentCard (match by child session id)", async () => {
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subAgentRow({ status: "completed" }),
    ]);
    renderDelegateSection({
      ...DELEGATE_TOOL,
      ok: true,
      outputSummary: "[subagent session: sess_child-a | role: coder]\nSub-agent completed.\n\nDone.",
    });
    fireEvent.click(screen.getByRole("button", { name: /^Delegated / }));

    const chip = await screen.findByTestId("subagent-code-chip");
    expect(chip.textContent).toBe("K7Q2");
  });

  it("ROUND-79: an addressable child's SubAgentCard shows the task_id chip in the meta line", async () => {
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subAgentRow({ status: "completed", taskId: "bg-research" }),
    ]);
    renderDelegateSection({
      ...DELEGATE_TOOL,
      ok: true,
      outputSummary: "[subagent session: sess_child-a | role: coder]\nSub-agent completed.\n\nDone.",
    });
    fireEvent.click(screen.getByRole("button", { name: /^Delegated / }));

    const taskChip = await screen.findByTestId("subagent-card-taskid");
    expect(taskChip.textContent).toBe("bg-research");
    expect(taskChip.getAttribute("title")).toContain('{"resume":"bg-research"}');
  });

  it("a pending delegate with NO child session yet shows the quiet 'delegating…' beat", async () => {
    // The moment between the delegate_task call and the child session
    // appearing in the listing (acquireSlot can queue) — the expanded body
    // is honest about it instead of a bare spinner.
    vi.mocked(fetchSubAgents).mockResolvedValue([]);
    renderDelegateSection();
    fireEvent.click(screen.getByRole("button", { name: /^Delegated / }));

    expect(await screen.findByText("delegating")).toBeTruthy();
    expect(screen.queryByTestId("live-delegate-row")).toBeNull();
  });

  // ── ROUND-64 (R64-c): claim-matched delegated rows ──────────────────────
  it("claim-matching: 3 pending delegate rows each expand to EXACTLY ONE claimed child (never all of them)", async () => {
    // Owner: "When I expanded any one of them, it showed me all three or so
    // sub-agents which were active. This was not good."
    // Children: A is still RUNNING but already CLAIMED by the completed
    // delegate row (its parsed session id); B (older) and C (newer) are free.
    const T0 = "2026-08-28T10:00:00Z";
    vi.mocked(fetchSubAgents).mockResolvedValue([
      subAgentRow({ id: "sess_child-a", code: "K7Q2", status: "running", createdAt: T0 }),
      subAgentRow({ id: "sess_child-b", code: "M3XN", title: "Write tests", subRole: "tester", status: "running", createdAt: "2026-08-28T10:00:01Z", todosDone: 0, todosTotal: 3, inputTokens: 0, outputTokens: 0 }),
      subAgentRow({ id: "sess_child-c", code: "P8LT", title: "Audit deps", subRole: "reviewer", status: "queued", createdAt: "2026-08-28T10:00:02Z", todosDone: 0, todosTotal: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
    const pending = (seq: number, task: string): ToolUseEntry => ({
      ...DELEGATE_TOOL,
      seq,
      argsSummary: `task: ${task}, role: coder`,
    });
    const done: ToolUseEntry = {
      ...DELEGATE_TOOL,
      seq: 6,
      ok: true,
      argsSummary: "task: Ship the parser, role: coder",
      outputSummary: "[subagent session: sess_child-a | role: coder]\nSub-agent completed.\n\nDone.",
    };
    renderDelegateSection(pending(7, "Refactor auth module"), [
      { type: "tool", tool: pending(8, "Write tests") },
      { type: "tool", tool: pending(9, "Audit deps") },
      { type: "tool", tool: done },
    ]);

    // Expanding EVERY pending row (all three stay toggles — 3 live children
    // means no single-live-child affordance).
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Refactor auth module/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Write tests/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Audit deps/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Delegated task: Ship the parser/ }));

    // Each expanded pending body carries EXACTLY ONE live-delegate-row:
    // row 7 → child-b (the earliest-created UNCLAIMED running child; child-a
    // belongs to the completed row), row 8 → child-c, row 9 → no child left
    // ("delegating…"). The completed row renders its SubAgentCard, not live
    // rows.
    await waitFor(() => {
      expect(screen.getByText("M3XN")).toBeTruthy();
      expect(screen.getByText("P8LT")).toBeTruthy();
    });
    expect(screen.getByText("delegating")).toBeTruthy();
    const liveRows = document.querySelectorAll('[data-testid="live-delegate-row"]');
    expect(liveRows).toHaveLength(2);
    // The completed row's child (K7Q2, still running) never leaks into any
    // PENDING row's body — it only renders as the completed row's code chip.
    for (const row of liveRows) {
      expect(row.textContent).not.toContain("K7Q2");
    }
    expect(
      screen.getAllByTestId("subagent-code-chip").some((el) => el.textContent === "K7Q2"),
    ).toBe(true);

    // Per-row-container counts: each pending row's ToolLine wrapper owns
    // EXACTLY its claimed child (the third owns none — "delegating…").
    // R117-f re-pin: the row head is a div[role=button] now (the PathPill
    // nesting change) — the wrapper is addressed by its data-testid, not by
    // closest("div") (which would stop at the row head itself).
    const perRow = [
      /^Delegated task: Refactor auth module/,
      /^Delegated task: Write tests/,
      /^Delegated task: Audit deps/,
    ].map((re) => {
      const button = screen.getByRole("button", { name: re });
      const rowRoot = button.closest('[data-testid="tool-line"]') as HTMLElement;
      return rowRoot.querySelectorAll('[data-testid="live-delegate-row"]').length;
    });
    expect(perRow).toEqual([1, 1, 0]);
  });

  it("assignDelegateChildren (pure): completed rows claim by parsed session id, pending rows by earliest createdAt", () => {
    const pending = (seq: number): ToolUseEntry => ({ ...DELEGATE_TOOL, seq });
    const entries: WorkingEntry[] = [
      { type: "tool", tool: pending(7) },
      { type: "tool", tool: pending(8) },
      {
        type: "tool",
        tool: {
          ...DELEGATE_TOOL,
          seq: 9,
          ok: true,
          outputSummary: "[subagent session: sess_child-a | role: coder]\nDone.",
        },
      },
    ];
    const children: SubAgentStatus[] = [
      subAgentRow({ id: "sess_child-a", status: "running", createdAt: "2026-08-28T10:00:00Z" }),
      subAgentRow({ id: "sess_child-b", status: "queued", createdAt: "2026-08-28T10:00:02Z" }),
      subAgentRow({ id: "sess_child-c", status: "running", createdAt: "2026-08-28T10:00:01Z" }),
      subAgentRow({ id: "sess_child-d", status: "completed", createdAt: "2026-08-28T09:59:00Z" }),
    ];
    const claims = assignDelegateChildren(entries, children);
    // sess_child-a is taken by the completed row (parsed session id); the
    // completed child (sess_child-d) is not live → skipped; pending rows
    // take the earliest-created live ones: child-c then child-b.
    expect(claims.get(7)).toBe("sess_child-c");
    expect(claims.get(8)).toBe("sess_child-b");
    expect(claims.has(9)).toBe(false); // completed rows are not in the map
    // More pending rows than children → the leftover row claims nothing.
    const two = assignDelegateChildren([{ type: "tool", tool: pending(1) }], []);
    expect(two.get(1)).toBeNull();
  });
});

describe("sub-agent approval attribution (ROUND-48 R48-e2)", () => {
  const childApproval: WorkingEntry = {
    type: "approval",
    approvalId: "appr_child_9",
    toolName: "run_command",
    argsSummary: "pnpm test",
    category: "confirm",
    status: "pending",
    subAgentId: "sess_child-a",
    ts: "2026-08-28T10:00:09Z",
  };

  it("a sub-agent ask renders the 'Sub-agent {code} · {role} —' attribution prefix with decision buttons unchanged", () => {
    useStreamStore.setState({
      subagentsLive: {
        "sess_child-a": {
          childSessionId: "sess_child-a",
          parentSessionId: SESSION_ID,
          code: "K7Q2",
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
    renderWithProviders(
      <WorkingSection
        entries={[childApproval]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
        onApprovalDecision={() => {}}
      />,
    );

    const attribution = screen.getByTestId("subagent-approval-attribution");
    expect(attribution.textContent).toContain("Sub-agent");
    expect(attribution.textContent).toContain("K7Q2");
    expect(attribution.textContent).toContain("coder");
    // The card itself (title + ask + decision buttons) is unchanged.
    expect(screen.getByText("Permission needed")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("a main-agent approval renders NO attribution prefix (unchanged behavior)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[
          {
            type: "approval",
            approvalId: "appr_main_9",
            toolName: "run_command",
            argsSummary: "pnpm build",
            category: "confirm",
            status: "pending",
            ts: "2026-08-28T10:00:09Z",
          },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("subagent-approval-attribution")).toBeNull();
    expect(screen.getByText("Permission needed")).toBeTruthy();
  });

  it("attribution ALSO resolves from the polled /subagents row when the SSE live map is empty (reload mid-ask)", async () => {
    // After a page reload the stream-store live map starts empty — the
    // approval entry still carries subAgentId, and the polled listing
    // answers the code/role lookup.
    vi.mocked(fetchSubAgents).mockResolvedValue([subAgentRow()]);
    renderWithProviders(
      <WorkingSection
        entries={[childApproval]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
        onApprovalDecision={() => {}}
      />,
    );

    const attribution = screen.getByTestId("subagent-approval-attribution");
    // The span renders immediately with the bare prefix; the polled row's
    // code/role land a beat later (the query resolves async).
    await waitFor(() => expect(attribution.textContent).toContain("K7Q2"));
    expect(attribution.textContent).toContain("coder");
    expect(fetchSubAgents).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ─── ROUND-51 (R51-d): collapsed-row icon chips (delegate + file edits) ──────
// Owner: "When the agents were called those areas should be highlighted. When
// the file edits were made those areas should be highlighted properly. Even if
// they are minimized, those should be highlighted a bit better." The two tool
// families that CHANGE the project get a tinted rounded-square icon chip that
// reads at a glance while the row is collapsed — an icon-chip, NOT a left rail
// (the owner rejected rails in R51-b). Expected colors are computed from the
// same theme source the component reads (resetTestState pins nova/dark).

describe("collapsed-row icon chips (ROUND-51 R51-d)", () => {
  const theme = deriveThemeStyles("nova", true); // resetTestState pins nova + dark

  function renderCollapsedRow(tool: ToolUseEntry, live = false) {
    const entries: WorkingEntry[] = [{ type: "tool", tool }];
    renderWithProviders(
      <WorkingSection
        entries={entries}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live={live}
        defaultOpen
      />,
    );
  }

  it("a delegate_task row renders the accent-tinted chip (visible while collapsed)", () => {
    renderCollapsedRow({
      ...DELEGATE_TOOL,
      ok: true,
      outputSummary: "[subagent session: sess_child-a | role: coder]\nSub-agent completed.",
    });

    const chip = screen.getByTestId("tool-icon-chip");
    // Accent wash at low alpha + the accent itself for the glyph (nova dark).
    expect(chip.style.background).toBe(withAlpha(theme.accent, 0.12));
    expect(chip.style.color).toBe(theme.accent);
    // The row itself keeps its shape: one-line button, "Delegated" label,
    // and the completed status — R100-D re-pin (§C4.5): the old ✓ TEXT
    // glyph is now the 12px lucide CircleCheck icon (no text content); the
    // state rides data-tool-status-kind, the status word the aria-label.
    const row = screen.getByRole("button", { name: /^Delegated / });
    expect(row.textContent).toContain("Delegated");
    expect(row.querySelector('[data-tool-status-kind="ok"]')).not.toBeNull();
  });

  it("a completed write_file/edit_file row renders the calm subtle chip", () => {
    renderCollapsedRow(EDIT_TOOL); // ok: true

    const chip = screen.getByTestId("tool-icon-chip");
    // Calm treatment: subtle background + textSecondary glyph — the chip
    // SHAPE differentiates edits, not a loud color. (Whitespace-normalized:
    // happy-dom re-serializes rgba() with spaces; themes.ts writes it tight.)
    const tight = (v: string): string => v.replace(/\s+/g, "");
    expect(tight(chip.style.background)).toBe(tight(theme.subtle));
    expect(tight(chip.style.color)).toBe(tight(theme.textSecondary));
    expect(screen.getByRole("button", { name: /^Edited / })).toBeTruthy();
  });

  it("an in-flight edit row (ok === null) borrows the RUNNING ACCENT in-flight tint (R125: the theme accent, RUNNING_BLUE retired)", () => {
    renderCollapsedRow({ ...EDIT_TOOL, ok: null, outputSummary: undefined }, true);

    const chip = screen.getByTestId("tool-icon-chip");
    // R125 re-pin: the running voice is the THEME ACCENT now (the owner's
    // "It shows me in the blue colored area" verdict retired the hard-coded
    // #3b82f6 from this file); the wash + glyph follow styles.accent.
    expect(chip.style.background).toBe(withAlpha(theme.accent, 0.12));
    expect(chip.style.color).toBe(theme.accent);
    // Still collapsed + one-line: the chip is the live signal, not an expansion.
    expect(screen.getByRole("button", { name: /^Edited / })).toBeTruthy();
    expect(screen.queryByTestId("live-delegate-row")).toBeNull();
  });

  it("plain tool rows (read_file / search_code) do NOT get a chip", () => {
    const plainRead: ToolUseEntry = {
      seq: 3,
      toolName: "read_file",
      argsSummary: "path: src/main.ts",
      ok: true,
      ts: "2026-08-28T10:00:03Z",
      outputSummary: "120 lines",
    };
    const plainSearch: ToolUseEntry = {
      seq: 4,
      toolName: "search_code",
      argsSummary: "query: auth flow",
      ok: true,
      ts: "2026-08-28T10:00:04Z",
      outputSummary: "3 matches",
    };
    renderWithProviders(
      <WorkingSection
        entries={[
          { type: "tool", tool: plainRead },
          { type: "tool", tool: plainSearch },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );

    // No chip anywhere — plain rows are byte-identical to pre-R51.
    expect(screen.queryByTestId("tool-icon-chip")).toBeNull();
    expect(screen.getByRole("button", { name: /^Read / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Searched / })).toBeTruthy();
  });
});

// ─── ROUND-52 (R52-c): the live terminal tail under in-flight commands ──────

describe("live command output tail (ROUND-52 R52-c)", () => {
  /** An in-flight run_command with a live tail the store accumulated. */
  const LIVE_CMD: ToolUseEntry & { liveOutput?: string } = {
    seq: -3,
    toolName: "run_command",
    argsSummary: "pnpm test",
    ok: null,
    ts: "2026-08-28T10:00:03Z",
    liveOutput: "PASS src/a.test.ts\nPASS src/b.test.ts\n",
  };

  it("an in-flight run_command with accumulated output renders the live tail under the pill", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: LIVE_CMD }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    const tail = screen.getByTestId("live-command-output");
    // The streamed chunks render + the tiny live indicator.
    expect(tail.textContent).toContain("PASS src/a.test.ts");
    expect(tail.textContent).toContain("PASS src/b.test.ts");
    expect(tail.textContent).toContain("live");
  });

  it("the tool-result clears the tail — the settled pill shows the final output only", () => {
    // The settled shape the store produces (liveOutput STRIPPED on the
    // tool-result, ok + outputSummary attached).
    const settled: ToolUseEntry = {
      seq: -3,
      toolName: "run_command",
      argsSummary: "pnpm test",
      ok: true,
      ts: "2026-08-28T10:00:03Z",
      outputSummary: "2 passed",
    };
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: settled }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("live-command-output")).toBeNull();
    // The completed pill's expanded body shows the FINAL output instead.
    fireEvent.click(screen.getByRole("button", { name: /^Ran pnpm test/ }));
    expect(screen.getByText("2 passed")).toBeTruthy();
  });

  it("an in-flight command with NO output yet renders no tail (nothing to stream)", () => {
    const noOutput: ToolUseEntry & { liveOutput?: string } = { ...LIVE_CMD, liveOutput: undefined };
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: noOutput }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("live-command-output")).toBeNull();
  });

  it("the tail keeps only the LAST ~10 lines of the accumulated output", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    const longTail: ToolUseEntry & { liveOutput?: string } = { ...LIVE_CMD, liveOutput: lines };
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: longTail }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    const tail = screen.getByTestId("live-command-output");
    expect(tail.textContent).toContain("line 15");
    expect(tail.textContent).toContain("line 6");
    expect(tail.textContent).not.toContain("line 5");
  });
});

// ─── ROUND-58 (R58-cf): the live write preview + the thinking redesign ──────

describe("live write preview (ROUND-58 R58-cf)", () => {
  /** An in-flight write_file whose args raw the store attached (tool-call frame landed). */
  const LIVE_WRITE: ToolUseEntry & { liveInput?: string } = {
    seq: -4,
    toolName: "write_file",
    argsSummary: "path: src/app.ts, content: 22 chars",
    ok: null,
    ts: "2026-08-31T12:00:04Z",
    liveInput: '{"path":"src/app.ts","content":"<!DOCTYPE html>\\n<html>"}',
  };

  it("an in-flight write_file with liveInput renders the preview UNDER the pill (collapsed row)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: LIVE_WRITE }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    const preview = screen.getByTestId("live-write-preview");
    // The label: filename (not the full path) + the decoded char count.
    expect(preview.textContent).toContain("writing app.ts");
    expect(preview.textContent).toContain("22 chars");
    // The partial content, JSON-escapes decoded (\n became a newline node).
    expect(preview.textContent).toContain("<!DOCTYPE html>");
    expect(preview.textContent).toContain("<html>");
    // No diff machinery ran while in flight (the preview IS the body).
    expect(vi.mocked(fetchSessionCheckpoints)).not.toHaveBeenCalled();
  });

  it("expanding the in-flight row keeps the preview as the body (the snapshot doesn't exist yet)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: LIVE_WRITE }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Wrote / }));

    // Still the preview — never DiffDetail's "loading diff…" placeholder.
    expect(screen.getByTestId("live-write-preview")).toBeTruthy();
    expect(screen.queryByText(/loading diff/)).toBeNull();
    expect(screen.queryByText(/no snapshot recorded/)).toBeNull();
    expect(vi.mocked(fetchSessionCheckpoints)).not.toHaveBeenCalled();
  });

  it("the tool-result replaces the preview: the settled row expands into the real DiffDetail", () => {
    // The settled shape the store produces (liveInput STRIPPED on the result).
    const settled: ToolUseEntry = {
      seq: -4,
      toolName: "write_file",
      argsSummary: "path: src/app.ts, content: 22 chars",
      ok: true,
      ts: "2026-08-31T12:00:04Z",
      outputSummary: "wrote src/app.ts",
    };
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: settled }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("live-write-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Wrote / }));
    // DiffDetail took over (empty checkpoints → the honest miss line).
    expect(vi.mocked(fetchSessionCheckpoints)).toHaveBeenCalledWith(SESSION_ID);
  });

  it("a NON-diff tool never renders the write preview (only write_file/edit_file)", () => {
    const liveRead: ToolUseEntry & { liveInput?: string } = {
      seq: -5,
      toolName: "run_command",
      argsSummary: "pnpm test",
      ok: null,
      ts: "2026-08-31T12:00:05Z",
      liveInput: '{"command":"pnpm test"}',
    };
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: liveRead }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("live-write-preview")).toBeNull();
    expect(screen.queryByTestId("live-write-pending-row")).toBeNull();
  });

  it("a PENDING write (tool-input frames, no ToolUseEntry yet) renders its own row + preview from the pendingWrites PROP (R125-2: the panel threads the store's inputs to the tail-owning section)", () => {
    // R125-2: the pending rows arrive as a PROP now — the component's old
    // internal store selector (which made EVERY mounted live section render
    // the same row — the owner's duplicate) is gone. The store below seeds
    // NOTHING; the prop is the only source.
    renderWithProviders(
      <WorkingSection
        entries={[]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
        pendingWrites={[
          {
            toolCallId: "call_w9",
            toolName: "write_file",
            raw: '{"path":"src/generated.ts","content":"export const A = 1;\\nexport const B = 2;',
          },
        ]}
      />,
    );

    const row = screen.getByTestId("live-write-pending-row");
    expect(row.textContent).toContain("Writing");
    expect(row.textContent).toContain("path: src/generated.ts");
    const preview = screen.getByTestId("live-write-preview");
    expect(preview.textContent).toContain("writing generated.ts");
    expect(preview.textContent).toContain("export const A = 1;");
  });

  it("sections WITHOUT the pendingWrites prop render NO pending rows (folded reloads, non-owning live sections — R125-2's single-owner law)", () => {
    // R125-2: the store can carry a live turn with streaming inputs (another
    // section owns them); THIS section — folded, or a live non-owner — never
    // reads them. The prop is undefined → no rows, even mid-turn elsewhere.
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            startedAtMs: Date.now(),
            working: [],
            streamText: "",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [
              { toolCallId: "call_w9", toolName: "write_file", raw: '{"path":"a.ts"' },
            ],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
          feedbackEvent: null,
        },
      },
    });
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "text", content: "done", ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );

    expect(screen.queryByTestId("live-write-pending-row")).toBeNull();
  });
});

// ─── ROUND-96 (R96-H): the modern-IDE DIFF BLOCK + tool status details ─────
//
// The owner's ask (verbatim): "When it edits a file it does not show the
// status properly, like which parts of the code it changed and how it
// changed them. It was not precisely changing the things as modern IDEs do."
// + "The chat window is not handled that well… The chat area should show the
// details properly." The data source is UNCHANGED from R46-c — the (sessionId,
// seq)-resolved file snapshot (GET /sessions/:id/checkpoints →
// GET /sessions/:id/snapshots/:seq) — only the RENDER changed: hunks with
// "@@ -l,c +l,c @@" headers, +/− gutter line numbers, NEW FILE for creates,
// and honest tail notes instead of the old silent 200-line cut.

/** An edit row whose output carries the R96-C confirmation line. */
const R96_EDIT_TOOL: ToolUseEntry = {
  seq: 4,
  toolName: "edit_file",
  argsSummary: "path: src/app.ts, content: 20 chars",
  ok: true,
  ts: "2026-08-28T10:00:04Z",
  outputSummary: "Edited 'src/app.ts': 2 replacements, +12 −3 lines",
};

describe("R96-H diff blocks (modern-IDE shape)", () => {
  it("an edit row expands into the unified diff: hunk header, red/green rows, BOTH-side gutter numbers", async () => {
    vi.mocked(fetchSessionCheckpoints).mockResolvedValue([CP]);
    vi.mocked(fetchSnapshot).mockResolvedValue(snapshotBody(true));
    renderExpandedTool(EDIT_TOOL);

    // The hunk header — the WHERE of the change (1 del + 1 add + 1 ctx row).
    const header = await waitFor(() => {
      const el = document.querySelector("[data-diff-hunk-header]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(header.textContent).toBe("@@ -1,2 +1,2 @@");

    // Red: the removed line, numbered on the OLD side only.
    const del = document.querySelector('[data-diff-type="del"]');
    expect(del?.textContent).toContain("old line");
    expect(del?.querySelector("[data-diff-old]")?.textContent).toBe("1");
    // Green: the added line, numbered on the NEW side only.
    const add = document.querySelector('[data-diff-type="add"]');
    expect(add?.textContent).toContain("new line");
    expect(add?.querySelector("[data-diff-new]")?.textContent).toBe("1");
    // Context carries BOTH numbers.
    const ctx = document.querySelector('[data-diff-type="ctx"]');
    expect(ctx?.textContent).toContain("shared");
    expect(ctx?.querySelector("[data-diff-old]")?.textContent).toBe("2");
    expect(ctx?.querySelector("[data-diff-new]")?.textContent).toBe("2");

    // The stats chips (+1 / −1) in the card header.
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
  });

  it("a write_file CREATE renders the ALL-GREEN NEW FILE shape (no red, no old-side numbers)", async () => {
    vi.mocked(fetchSessionCheckpoints).mockResolvedValue([CREATE_CP]);
    vi.mocked(fetchSnapshot).mockResolvedValue(snapshotBody(false));
    renderExpandedTool(WRITE_TOOL);

    expect(await screen.findByText("new file body")).toBeTruthy();
    expect(document.querySelector('[data-diff-kind="create"]')?.textContent).toBe("NEW FILE");
    // Every row is an add; nothing red, nothing contextual.
    expect(document.querySelectorAll('[data-diff-type="add"]').length).toBe(1);
    expect(document.querySelectorAll('[data-diff-type="del"]').length).toBe(0);
    expect(document.querySelectorAll('[data-diff-type="ctx"]').length).toBe(0);
    const add = document.querySelector('[data-diff-type="add"]');
    expect(add?.querySelector("[data-diff-new]")?.textContent).toBe("1");
    // The git-shape create header.
    expect(document.querySelector("[data-diff-hunk-header]")?.textContent).toBe("@@ -0,0 +1,1 @@");
  });

  it("far-apart edits render as SEPARATE hunks, each located by its own header", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const before = lines.join("\n");
    const after = before.replace("line 5\n", "FIVE\n").replace("line 35\n", "THIRTYFIVE\n");
    vi.mocked(fetchSessionCheckpoints).mockResolvedValue([CP]);
    vi.mocked(fetchSnapshot).mockResolvedValue({
      id: "snap_1",
      sessionId: SESSION_ID,
      seq: 4,
      path: "src/app.ts",
      toolName: "edit_file",
      ts: "2026-08-28T10:00:04Z",
      beforeContent: before,
      afterContent: after,
    });
    renderExpandedTool(EDIT_TOOL);

    await waitFor(() => {
      expect(document.querySelectorAll("[data-diff-hunk-header]").length).toBe(2);
    });
    const headers = Array.from(document.querySelectorAll("[data-diff-hunk-header]")).map(
      (h) => h.textContent,
    );
    // Hunk 1 around old line 5, hunk 2 around old line 35 — located, not one blob.
    expect(headers[0]).toContain("-2,7");
    expect(headers[1]).toContain("-32,7");
    // Between the hunks the far context is COLLAPSED (no "line 12" anywhere).
    expect(screen.queryByText("line 12")).toBeNull();
  });

  it("the collapsed edit row shows its +A −B chip AT REST (from the R96-C confirmation line)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: R96_EDIT_TOOL }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    // The tool row is COLLAPSED (never clicked — the snapshot is never fetched).
    expect(vi.mocked(fetchSessionCheckpoints)).not.toHaveBeenCalled();
    // Yet the stats chip renders: +12 green, −3 red.
    const chip = document.querySelector('[data-tool-status="+12 −3"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("+12");
    expect(chip?.textContent).toContain("−3");
  });
});

describe("R96-H tool status details (toolStatusDetail — pure, honest)", () => {
  const detail = (toolName: string, ok: boolean | null, outputSummary?: string) =>
    toolStatusDetail({ seq: 1, toolName, argsSummary: "x", ok, ts: "t", ...(outputSummary ? { outputSummary } : {}) });

  it("run_command: ok:true renders exit 0; a stamped non-zero code renders exit N (danger)", () => {
    // R117-f re-pin: exit 0 moved to the SUCCESS tone (the colored exit
    // chip — quiet success tint, not the neutral muted pill) — including a
    // STAMPED "[exit code: 0]" (the stamp is the record).
    expect(detail("run_command", true, "build output…")).toEqual({ label: "exit 0", tone: "success" });
    expect(detail("run_command", true, "3 passed\n[exit code: 0]")).toEqual({ label: "exit 0", tone: "success" });
    expect(detail("run_command", false, "boom\n[exit code: 127]")).toEqual({ label: "exit 127", tone: "danger" });
  });

  it("run_command honesty: background jobs and code-less failures render NOTHING (never an invented code)", () => {
    expect(
      detail("run_command", true, "…\n[background job job_1] The launching shell exited cleanly…"),
    ).toBeNull();
    expect(detail("run_command", false, "command timed out after 120s — killed the process tree")).toBeNull();
  });

  it("edit_file: the R96-C confirmation line parses into the +A −B stats chip", () => {
    expect(detail("edit_file", true, "Edited 'src/app.ts': 2 replacements, +12 −3 lines")).toEqual({
      label: "+12 −3",
      tone: "diff",
    });
    expect(detail("edit_file", true, "Edited 'a.ts': 1 replacement, +1 −0 lines (whitespace-normalized rung on #1)")).toEqual({
      label: "+1 −0",
      tone: "diff",
    });
    // The legacy pre-R96-C summary shape carries no stats → no chip.
    expect(detail("edit_file", true, "edited src/app.ts")).toBeNull();
  });

  it("read_file: the marker lines carry the file's true total; numbered whole reads count", () => {
    expect(
      detail("read_file", true, "     1  a\n…[file truncated: showing lines 1-100 of 2400 total (8 bytes omitted after line 100) — use offset=101 to continue]…"),
    ).toEqual({ label: "2400 lines", tone: "muted" });
    expect(detail("read_file", true, "     1  a\n     2  b\n[end of file: returned lines 1-2 of 2]")).toEqual({
      label: "2 lines",
      tone: "muted",
    });
    expect(detail("read_file", true, "     1  a\n     2  b\n     3  c")).toEqual({ label: "3 lines", tone: "muted" });
  });

  it("read_file honesty: a summary the 4K budget CUT renders nothing (a partial count would lie)", () => {
    expect(detail("read_file", true, "…[truncated 12000 chars]…")).toBeNull();
    expect(detail("read_file", true, "cannot read 'x': no such file")).toBeNull();
  });

  it("search_code / search_files: the counts from their own headers", () => {
    expect(detail("search_code", true, "12 matches in 3 files for 'foo'")).toEqual({
      label: "12 matches · 3 files",
      tone: "muted",
    });
    expect(detail("search_code", true, "1 match in 1 file for 'foo'")).toEqual({
      label: "1 match · 1 file",
      tone: "muted",
    });
    expect(detail("search_code", true, "no content matches for 'foo'")).toEqual({
      label: "0 matches",
      tone: "muted",
    });
    expect(detail("search_files", true, "5 files matching 'foo' (newest first)")).toEqual({
      label: "5 files",
      tone: "muted",
    });
  });

  it("in-flight rows (ok === null) and unknown summaries render nothing", () => {
    expect(detail("run_command", null, undefined)).toBeNull();
    expect(detail("list_dir", true, "src\nREADME.md")).toBeNull();
  });
});

describe("thinking display redesign (ROUND-58 R58-cf — no accent rails)", () => {
  const theme = deriveThemeStyles("nova", true); // resetTestState pins nova + dark

  it("the thought body is a clean notes block: subtle bg, NO left border rail, NO accent color", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: "I should inspect the file first.", ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    // ThoughtRow starts collapsed — expand it.
    fireEvent.click(screen.getByRole("button", { name: "Expand thought" }));

    const body = screen.getByText("I should inspect the file first.").closest("div.font-mono") as HTMLElement;
    expect(body).toBeTruthy();
    // NO rail: neither the class nor a computed left border.
    expect(body.className).not.toContain("border-l-2");
    expect(body.style.borderLeftWidth).toBe("");
    expect(body.style.borderColor).toBe("");
    // The very subtle neutral wash (styles.subtle ≈ 4% white on nova dark).
    const tight = (v: string): string => v.replace(/\s+/g, "");
    expect(tight(body.style.background)).toBe(tight(theme.subtle));
  });

  it("the section body carries NO accent rail either (rows align in a plain column)", () => {
    const { container } = renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: "Thinking aloud.", ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    const rowsColumn = container.querySelector("div.py-1.flex.flex-col.gap-0\\.5") as HTMLElement;
    expect(rowsColumn).toBeTruthy();
    expect(rowsColumn.className).not.toContain("border-l-2");
    expect(rowsColumn.className).not.toContain("ml-[7px]");
    expect(rowsColumn.style.borderColor).toBe("");
  });

  it("the collapse/expand affordances survive the redesign (chevron + label + preview line)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: "A longer thought that should preview when collapsed.", ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    const toggle = screen.getByRole("button", { name: "Expand thought" });
    expect(toggle.textContent).toContain("Thought");
    // The collapsed preview line rides inside the toggle.
    expect(toggle.textContent).toContain("A longer thought that should preview");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Collapse thought" })).toBeTruthy();
  });
});

// ── ROUND-95 (R95-D): the thinking area's own stick-to-bottom ───────────────
// Owner (v0.91.0): "The thinking area was not auto-scrolling to the very
// bottom. The thinking area should be automatically scrolling if the user
// was at the very bottom of it… If I scroll up in the thinking area, then it
// should not auto-scroll again. It should only scroll if I scroll to the
// very bottom and leave it there."
//
// happy-dom has NO layout (scrollHeight/clientHeight are 0; assigning
// scrollTop stores the value but fires no events) — so the follow is
// asserted on the ELEMENT's scrollTop after a re-render with grown text,
// geometry rides in via Object.defineProperty getters, and the user's
// gestures are dispatched exactly as the browser would (scroll events
// with the position set first) — the AgentChatPanel R94-D2 convention.
describe("thinking area stick-to-bottom (ROUND-95 R95-D)", () => {
  /** Mutable geometry for the thought body (1000px of content in the 256px
   * max-h-64 viewport). */
  function giveGeometry(el: HTMLElement): { scrollHeight: number } {
    const geometry = { scrollHeight: 1000 };
    Object.defineProperty(el, "scrollHeight", {
      get: () => geometry.scrollHeight,
      configurable: true,
    });
    Object.defineProperty(el, "clientHeight", { value: 256, configurable: true });
    return geometry;
  }

  /** The inner jump pill (present only while a LIVE thought is detached
   * from its own tail). */
  const innerPill = () => screen.queryByRole("button", { name: "Jump to the latest thinking" });

  /** The LIVE section's element for the given streaming text (built fresh
   * for each growth re-render — the providers ride along via RTL's
   * `wrapper` OPTION below, which rerender preserves). */
  function liveSection(text: string): ReactElement {
    return (
      <WorkingSection
        entries={[{ type: "thinking", text, ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        liveEntryIndex={0}
      />
    );
  }

  /** Render a LIVE section whose single thinking entry streams, wait for
   * the auto-expanded body's scroller, and attach the geometry. */
  async function renderLiveThinking(text: string): Promise<{
    scroller: HTMLElement;
    geometry: { scrollHeight: number };
    rerender: (ui: ReactElement) => void;
  }> {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const utils = render(liveSection(text), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      ),
    });
    // Live rows auto-expand (the owner watches progress).
    const scroller = await waitFor(() => {
      const el = document.querySelector("[data-thinking-scroll]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    return { scroller, geometry: giveGeometry(scroller), rerender: utils.rerender };
  }

  it("a LIVE thought follows its own stream while the user sits at the block's bottom — and the pill stays hidden", async () => {
    const { scroller, geometry, rerender } = await renderLiveThinking("first thinking chunk");

    rerender(liveSection("first thinking chunk — and it kept growing"));
    expect(scroller.scrollTop).toBe(geometry.scrollHeight);

    // Growth keeps following while pinned.
    geometry.scrollHeight = 1400;
    rerender(liveSection("first thinking chunk — and it kept growing even more"));
    expect(scroller.scrollTop).toBe(1400);
    expect(innerPill()).toBeNull();
  });

  it("scrolling UP inside the thinking area STOPS the follow (no yank) and shows the inner Jump-to-latest pill", async () => {
    const { scroller, geometry, rerender } = await renderLiveThinking("first thinking chunk");
    rerender(liveSection("first thinking chunk — grown"));
    expect(scroller.scrollTop).toBe(geometry.scrollHeight);

    // The user scrolls up inside the block (300px — far past the 24px
    // threshold, moving up from the followed bottom).
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(await screen.findByRole("button", { name: "Jump to the latest thinking" })).toBeTruthy();

    // New content lands — the block must NOT yank them back down.
    geometry.scrollHeight = 1600;
    rerender(liveSection("first thinking chunk — grown — and still streaming"));
    expect(scroller.scrollTop).toBe(300);
  });

  it("clicking the inner pill re-pins + smooth-jumps, the pill hides, and the stream follows again", async () => {
    const { scroller, geometry, rerender } = await renderLiveThinking("first thinking chunk");
    rerender(liveSection("first thinking chunk — grown"));
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    const pillButton = await screen.findByRole("button", { name: "Jump to the latest thinking" });

    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    fireEvent.click(pillButton);
    expect(scrollTo).toHaveBeenCalledWith({ top: geometry.scrollHeight, behavior: "smooth" });
    await waitFor(() => expect(innerPill()).toBeNull());

    // Re-pinned: the next growth follows again.
    geometry.scrollHeight = 1800;
    rerender(liveSection("first thinking chunk — grown — resumed following the stream"));
    expect(scroller.scrollTop).toBe(1800);
  });

  it("scrolling back to the very bottom RE-PINS the block: the next tick follows again, no pill", async () => {
    const { scroller, geometry, rerender } = await renderLiveThinking("first thinking chunk");
    rerender(liveSection("first thinking chunk — grown"));
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(await screen.findByRole("button", { name: "Jump to the latest thinking" })).toBeTruthy();

    // The user returns to the very bottom (scrollHeight - clientHeight).
    scroller.scrollTop = geometry.scrollHeight - 256;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(innerPill()).toBeNull());

    geometry.scrollHeight = 1800;
    rerender(liveSection("first thinking chunk — grown — resumed at the bottom"));
    expect(scroller.scrollTop).toBe(1800);
  });

  it("a COMPLETED thought opened by a manual tap never follows (the user reads from the top) and never shows the pill", async () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: "a settled, completed thought", ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand thought" }));
    const scroller = await waitFor(() => {
      const el = document.querySelector("[data-thinking-scroll]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    giveGeometry(scroller);

    // Manual tap wins: settled text is read from the top — no auto-scroll to
    // the bottom, no pill (the R95-D enabled gate).
    expect(scroller.scrollTop).toBe(0);
    expect(innerPill()).toBeNull();

    // Even a scroll up + re-render never re-follows or arms the pill.
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(innerPill()).toBeNull();
  });
});

// ── ROUND-68 (R68-A): the INLINE screenshot row ─────────────────────────────
describe("inline screenshot rows (ROUND-68 R68-A)", () => {
  beforeEach(() => {
    vi.mocked(fetchComputerFrameRaster)
      .mockReset()
      .mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
  });

  it("a screenshot entry renders INLINE BETWEEN two tool rows (at its capture moment, not a bottom strip)", async () => {
    const entries: WorkingEntry[] = [
      { type: "tool", tool: { seq: 11, toolName: "screenshot", argsSummary: "full display", ok: true, ts: "2026-09-06T10:00:03Z" } },
      { type: "screenshot", frameId: "f-1", tool: "screenshot", ts: "2026-09-06T10:00:04Z" },
      { type: "tool", tool: { seq: 12, toolName: "zoom", argsSummary: "region: 100,100 300x200", ok: true, ts: "2026-09-06T10:00:05Z" } },
    ];
    const { container } = renderWithProviders(
      <WorkingSection entries={entries} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    const row = await screen.findByTestId("screenshot-row");
    expect(row).toBeTruthy();
    // The inline tile fetched its raster and shows the PNG.
    await waitFor(() => expect(fetchComputerFrameRaster).toHaveBeenCalledWith("f-1"));
    expect(screen.getByRole("img", { name: "Screenshot captured by screenshot" })).toBeTruthy();
    // INLINE = BETWEEN the tool rows: the row's DOM position sits after the
    // screenshot tool pill and before the zoom pill (compareDocumentPosition).
    // (R99-B re-pin: the tool rows' accessible names now carry the status
    // word — "— completed" — so match on the prefix.)
    const firstTool = screen.getByRole("button", { name: /^screenshot full display/ }) as HTMLElement;
    const secondTool = screen.getByRole("button", { name: /^zoom region: 100,100 300x200/ }) as HTMLElement;
    expect(firstTool.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(secondTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No strip remnant: no "Screenshots" section header, no strip testid.
    expect(screen.queryByText("Screenshots")).toBeNull();
    expect(container.querySelector('[data-testid="screenshot-strip"]')).toBeNull();
  });

  it("the section still counts TOOLS only — a screenshot never inflates the tool count (R99-B re-pin: steps count entries, tools count tool rows)", async () => {
    const entries: WorkingEntry[] = [
      { type: "tool", tool: { seq: 11, toolName: "screenshot", argsSummary: "full display", ok: true, ts: "t" } },
      { type: "screenshot", frameId: "f-1", tool: "screenshot", ts: "t2" },
      { type: "screenshot", frameId: "f-2", tool: "zoom", ts: "t3" },
    ];
    renderWithProviders(
      <WorkingSection entries={entries} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    // ONE tool row + two inline captures → "Completed 3 steps · 1 tool"
    // (3 entries, 1 tool — the R99-B folded summary grammar).
    const header = screen.getByRole("button", { name: /Completed 3 steps · 1 tool\./ });
    expect(header).toBeTruthy();
    const rows = await screen.findAllByTestId("screenshot-row");
    expect(rows).toHaveLength(2);
  });

  it("BareWorkingEntries renders NO inline row for a screenshot (a tools-free block has no section to anchor one)", () => {
    const { container } = renderWithProviders(
      <BareWorkingEntries entries={[{ type: "screenshot", frameId: "f-1", tool: "screenshot", ts: "t" }]} />,
    );
    expect(container.querySelector('[data-testid="screenshot-row"]')).toBeNull();
  });
});

// ─── R99-B: the chat visual overhaul — the compressed summary + tool rows ───
describe("R99-B working-section summaries + tool-row anatomy", () => {
  const theme = deriveThemeStyles("nova", true); // resetTestState pins nova + dark

  /** A folded three-entry section: thought + read + run (ts/endTs 72s apart). */
  const FOLDED_ENTRIES: WorkingEntry[] = [
    { type: "thinking", text: "plan the change", ts: "2026-09-06T10:00:00Z", thinkingMs: 800 },
    { type: "tool", tool: { seq: 21, toolName: "read_file", argsSummary: "path: src/app.ts", ok: true, ts: "2026-09-06T10:00:20Z", outputSummary: "of 42 total" } },
    { type: "tool", tool: { seq: 22, toolName: "run_command", argsSummary: "cmd: pnpm test", ok: true, ts: "2026-09-06T10:00:40Z", outputSummary: "3 passed\n[exit code: 0]" } },
  ];

  it("the FOLDED summary row: ✓ success glyph + 'Completed N steps' + '· N tools' — NO duration (R120-C-PC item 36: the turn footer's ONE consolidated block owns it)", () => {
    renderWithProviders(
      <WorkingSection entries={FOLDED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" />,
    );

    // The compressed grammar: 3 steps · 2 tools — and NOTHING else. The
    // per-section right-aligned duration chip is GONE (the owner's
    // "8-9 separate right-side blocks"); the turn footer's ONE consolidated
    // "Ran … · N actions · … tokens" block (AgentChatPanel's ReplyStats)
    // owns the how-long answer for the whole turn.
    const header = screen.getByTestId("work-section-header");
    expect(header.textContent).toContain("Completed 3 steps");
    expect(header.textContent).toContain("· 2 tools");
    // The leading ✓ glyph — the lucide Check mark in the success color
    // (SEMANTIC_COLORS.success — the de-slop spelling).
    const glyphSvg = header.querySelector("svg");
    expect(glyphSvg).not.toBeNull();
    expect(glyphSvg!.style.color).toBe(SEMANTIC_COLORS.success);
    // The row announces the outcome in its label (aria-label replaces
    // interior content for AT — the word rides the label) — duration-free.
    expect(header.getAttribute("aria-label")).toContain("Completed 3 steps · 2 tools.");
    expect(header.getAttribute("aria-label")).not.toContain("1:12");
    // The retired chip is REALLY gone — never a phantom right-side block.
    expect(screen.queryByTestId("work-duration-chip")).toBeNull();
    // Item 35's law, the negative leg: this fold carries only reads/commands
    // (no file mutations) → NO fold-file-rows block renders at all.
    expect(screen.queryByTestId("fold-file-rows")).toBeNull();
  });

  it("honest pluralization — ONE entry + ONE tool reads '1 step · 1 tool', and no duration ever rides the fold now", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: { seq: 31, toolName: "list_dir", argsSummary: "path: .", ok: true, ts: "t" } }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
      />,
    );
    const header = screen.getByTestId("work-section-header");
    // ONE entry + ONE tool: "1 step · 1 tool" — pluralized honestly.
    expect(header.textContent).toContain("Completed 1 step");
    expect(header.textContent).toContain("· 1 tool");
    // R120-C-PC (item 36): the folded duration is gone ENTIRELY (the
    // ts/endTs props died with it) — never a fake 0:00, never any clock.
    expect(screen.queryByTestId("work-duration-chip")).toBeNull();
  });

  it("the LIVE header: 'Working' + the actions counter and elapsed clock RIGHT-ALIGNED (mono tabular-nums, no per-row jitter)", () => {
    renderWithProviders(
      <WorkingSection
        entries={FOLDED_ENTRIES}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        startedAtMs={Date.now() - 5_000}
        defaultOpen
      />,
    );
    const header = screen.getByTestId("work-section-header");
    expect(header.textContent).toContain("Working");
    // The right cluster: the actions counter + the elapsed clock, both mono
    // tabular-nums (the counter pluralizes honestly: 2 tools → "2 actions").
    const counter = header.querySelector("span.tabular-nums.font-mono, span.font-mono.tabular-nums");
    expect(counter).not.toBeNull();
    expect(counter!.textContent).toBe("2 actions");
    // The clock rides the counter's sibling — m:ss with a leading zero minute
    // (a ~5s-old turn → 0:0x whatever the tick caught).
    const monoSpans = Array.from(header.querySelectorAll("span.font-mono"));
    const clock = monoSpans.find((s) => /^0:0\d$/.test(s.textContent ?? ""));
    expect(clock).toBeTruthy();
    expect(clock!.className).toContain("tabular-nums");
    // Both sit AFTER the flex-1 spacer (right-aligned, beside the chevron).
    const spacer = header.querySelector("span.flex-1");
    expect(spacer!.compareDocumentPosition(counter!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a stopped LIVE section keeps the quiet Square glyph + 'Stopped' — never a success ✓", () => {
    renderWithProviders(
      <WorkingSection
        entries={FOLDED_ENTRIES}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        stopped
        startedAtMs={Date.now() - 5_000}
      />,
    );
    const header = screen.getByTestId("work-section-header");
    expect(header.textContent).toContain("Stopped");
    // The aria-label carries the status word (the glyph is decorative — the
    // label REPLACES interior content for AT, so the word must ride it).
    expect(header.getAttribute("aria-label")).toMatch(/^Stopped\b/);
  });

  it("ToolLine: the LEADING outcome status icon (lucide, R100-D) + the status word in the row's aria-label; the result summary chip stays", () => {
    renderWithProviders(
      <WorkingSection entries={FOLDED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );

    // read_file with "of 42 total" → the leading completed icon + the
    // "42 lines" summary. R100-D re-pin (§C4.5): the ✓/✗/◌ TEXT glyphs
    // became 12px lucide icons (CircleCheck / CircleX / Loader) — the
    // semantic colors ride the inner SVG's style; the state rides
    // data-tool-status-kind; the status WORD still rides the aria-label
    // (the a11y contract is unchanged — a button's aria-label replaces
    // interior content, so screen readers still hear "completed").
    const readRow = screen.getByRole("button", { name: /^Read path: src\/app\.ts — completed$/ });
    expect(readRow.querySelector('[data-tool-status-kind="ok"]')).not.toBeNull();
    // The glyph LEADS the row (before the family icon + verb label).
    const readGlyph = readRow.querySelector('[data-testid="tool-status-glyph"]');
    expect(readGlyph).not.toBeNull();
    const readLabel = Array.from(readRow.querySelectorAll("span")).find(
      (s) => s.textContent === "Read",
    );
    expect(readLabel).toBeTruthy();
    expect(readGlyph!.compareDocumentPosition(readLabel!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The one-line result summary the tool's own output carries (R96-H).
    expect(readRow.querySelector('[data-tool-status="42 lines"]')).not.toBeNull();

    // run_command "exit 0" → its summary chip + the completed icon.
    const runRow = screen.getByRole("button", { name: /^Ran cmd: pnpm test — completed$/ });
    expect(runRow.querySelector('[data-tool-status="exit 0"]')).not.toBeNull();

    // A FAILED call: ✗ in the danger color + "failed" in the label.
    renderWithProviders(
      <WorkingSection
        entries={[
          {
            type: "tool",
            tool: { seq: 41, toolName: "run_command", argsSummary: "cmd: boom", ok: false, ts: "t", outputSummary: "[exit code: 1]" },
          },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    const failRow = screen.getByRole("button", { name: /^Ran cmd: boom — failed$/ });
    const failGlyph = failRow.querySelector('[data-testid="tool-status-glyph"]') as HTMLElement | null;
    // The danger color rides the inner SVG (the glyph span is a wrapper).
    expect(failGlyph!.querySelector("svg")!.style.color).toBe(SEMANTIC_COLORS.danger);
    expect(failGlyph!.getAttribute("data-tool-status-kind")).toBe("failed");

    // An IN-FLIGHT call (ok === null): the loader icon in the subtle
    // tertiary tone. Whitespace-normalized — happy-dom re-serializes
    // rgba() with spaces (the same treatment the R51-d chip tests use).
    renderWithProviders(
      <WorkingSection
        entries={[
          { type: "tool", tool: { seq: 51, toolName: "read_file", argsSummary: "path: x.ts", ok: null, ts: "t" } },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );
    const runGlyph = screen
      .getAllByTestId("tool-status-glyph")
      .find((g) => g.getAttribute("data-tool-status-kind") === "running");
    expect(runGlyph).toBeTruthy();
    const tight = (v: string): string => v.replace(/\s+/g, "");
    // SVGElement carries .style — typed via unknown (happy-dom's lucide svg).
    expect(tight((runGlyph!.querySelector("svg") as unknown as HTMLElement).style.color)).toBe(tight(theme.textTertiary));
  });

  it("R99-B numbers discipline: the numeric chips the tool rows render carry tabular-nums", () => {
    renderWithProviders(
      <WorkingSection entries={FOLDED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    const readRow = screen.getByRole("button", { name: /^Read path: src\/app\.ts — completed$/ });
    const summary = readRow.querySelector('[data-tool-status="42 lines"]');
    expect(summary!.className).toContain("tabular-nums");
  });
});

// ── ROUND-120 (R120-C-PC): item 35 — the file-mutation rows ride OUTSIDE the
//    collapse; item 36 — ONE live clock per turn (clockVisible) ──────────────
// The owner's round-120 verdict: "file edits, created files… are not shown —
// the center never renders them" — the R38 fold-by-default design hid every
// write/edit/create/delete behind the "Completed N steps" header. Now the
// FILE-MUTATION family renders as the same compact ToolLine rows the expanded
// body speaks, visible whether the section is collapsed or not; reads/
// searches/commands keep their home behind the expand.
describe("R120-C-PC item 35: file-mutation rows outside the collapse", () => {
  /** A folded section with one write, one edit, one create_dir — and reads/
   *  commands that must stay behind the expand. */
  const MUTATION_ENTRIES: WorkingEntry[] = [
    { type: "tool", tool: { seq: 101, toolName: "read_file", argsSummary: "path: src/app.ts", ok: true, ts: "t1", outputSummary: "of 42 total" } },
    { type: "tool", tool: { seq: 102, toolName: "write_file", argsSummary: "path: src/new-file.ts, content: 120 chars", ok: true, ts: "t2", outputSummary: "wrote 120 chars" } },
    { type: "tool", tool: { seq: 103, toolName: "edit_file", argsSummary: "path: src/app.ts, content: 40 chars", ok: true, ts: "t3", outputSummary: "+3 −1" } },
    { type: "tool", tool: { seq: 104, toolName: "create_dir", argsSummary: "path: src/lib/generated", ok: true, ts: "t4" } },
    { type: "tool", tool: { seq: 105, toolName: "run_command", argsSummary: "cmd: pnpm test", ok: true, ts: "t5", outputSummary: "3 passed\n[exit code: 0]" } },
  ];

  it("COLLAPSED: every write/edit/create/delete row renders outside the collapse — reads and commands stay behind the expand", () => {
    renderWithProviders(
      <WorkingSection entries={MUTATION_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" />,
    );
    // The fold-file-rows block exists and carries EXACTLY the three
    // file-mutation rows (the write, the edit, the create_dir).
    const fold = screen.getByTestId("fold-file-rows");
    const rows = fold.querySelectorAll('[data-testid="tool-line"]');
    expect(rows).toHaveLength(3);
    // The rows are the SAME compact ToolLines the expanded body speaks:
    // verb label + clickable path pill + status glyph.
    expect(fold.textContent).toContain("Wrote");
    expect(fold.textContent).toContain("Edited");
    expect(fold.textContent).toContain("Created");
    expect(fold.querySelectorAll('[data-tool-status-kind="ok"]')).toHaveLength(3);
    const writeRow = screen.getByRole("button", { name: /Wrote path: src\/new-file\.ts, content: 120 chars — completed$/ });
    expect(writeRow.closest('[data-testid="fold-file-rows"]')).not.toBeNull();
    // Reads and commands NEVER ride outside the collapse (the fold block
    // carries no "Read"/"Ran" row — they stay behind the expand).
    expect(fold.textContent).not.toContain("Read");
    expect(fold.textContent).not.toContain("Ran");
    expect(screen.queryByRole("button", { name: /Read path: src\/app\.ts — completed$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ran cmd: pnpm test — completed$/ })).toBeNull();
  });

  it("EXPANDING swaps the rows into the full timeline IN PLACE — never a duplicate, and the fold block is gone", async () => {
    renderWithProviders(
      <WorkingSection entries={MUTATION_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" />,
    );
    // Collapsed: the three mutation rows live in the fold block, the read +
    // command rows are hidden.
    expect(screen.getAllByTestId("tool-line")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("work-section-header"));
    // Expanded: the fold block is GONE and the full timeline renders all
    // FIVE rows exactly once (the mutations moved in place, not duplicated).
    // The body mounts through framer-motion's height animation — wait for
    // the fold block to be gone rather than asserting synchronously.
    await waitFor(() => expect(screen.queryByTestId("fold-file-rows")).toBeNull());
    expect(screen.getAllByTestId("tool-line")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Read path: src\/app\.ts — completed$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ran cmd: pnpm test — completed$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Wrote path: src\/new-file\.ts, content: 120 chars — completed$/ })).toBeTruthy();
    // Collapsing again brings the fold block back (the swap is reversible)
    // — after the body's AnimatePresence EXIT settles (never both at once).
    fireEvent.click(screen.getByTestId("work-section-header"));
    expect(screen.getByTestId("fold-file-rows")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("tool-line")).toHaveLength(3));
  });

  it("a LIVE section the user collapsed keeps the PENDING streaming write visible (a file being written is never hidden by a fold)", async () => {
    // R125-2: the pending input arrives via the prop (the panel chose THIS
    // section as the tail owner); the store seeding of the old test is gone.
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: { seq: 201, toolName: "write_file", argsSummary: "path: src/gen.ts, content: 80 chars", ok: true, ts: "t1", outputSummary: "wrote 80 chars" } }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        pendingWrites={[
          {
            toolCallId: "call_r120",
            toolName: "write_file",
            raw: '{"path":"src/streaming.ts","content":"export const A = 1;',
          },
        ]}
      />,
    );
    // Live sections auto-expand — collapse it by hand (the owner's own
    // tap wins over the auto-expand), then wait for the body's exit to
    // settle so exactly ONE pending row remains.
    fireEvent.click(screen.getByTestId("work-section-header"));
    await waitFor(() => expect(screen.getAllByTestId("live-write-pending-row")).toHaveLength(1));
    // The fold block carries BOTH the settled write row AND the pending
    // streaming write row (with its live preview).
    const fold = screen.getByTestId("fold-file-rows");
    expect(fold.querySelectorAll('[data-testid="tool-line"]')).toHaveLength(1);
    const pending = screen.getByTestId("live-write-pending-row");
    expect(fold.contains(pending)).toBe(true);
    expect(pending.textContent).toContain("Writing");
    expect(screen.getByTestId("live-write-preview").textContent).toContain("export const A = 1;");
  });

  it("FILE_MUTATION_TOOLS is exactly the write/edit/create/delete family — reads, commands and searches are NOT members", () => {
    expect(FILE_MUTATION_TOOLS.has("write_file")).toBe(true);
    expect(FILE_MUTATION_TOOLS.has("edit_file")).toBe(true);
    expect(FILE_MUTATION_TOOLS.has("create_dir")).toBe(true);
    expect(FILE_MUTATION_TOOLS.has("delete_file")).toBe(true);
    expect(FILE_MUTATION_TOOLS.has("read_file")).toBe(false);
    expect(FILE_MUTATION_TOOLS.has("run_command")).toBe(false);
    expect(FILE_MUTATION_TOOLS.has("search_code")).toBe(false);
    expect(FILE_MUTATION_TOOLS.has("list_dir")).toBe(false);
  });
});

describe("R120-C-PC item 36: ONE live clock per turn (clockVisible)", () => {
  it("clockVisible=false renders NO elapsed clock on the live header (the turn's first section owns the ONE clock)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        startedAtMs={Date.now() - 5_000}
        clockVisible={false}
      />,
    );
    const header = screen.getByTestId("work-section-header");
    // No mono span matching the m:ss clock shape (a ~5s turn would render
    // 0:0x while the clock were on).
    const monoSpans = Array.from(header.querySelectorAll("span.font-mono"));
    expect(monoSpans.find((s) => /^0:0\d$/.test(s.textContent ?? ""))).toBeUndefined();
    expect(header.getAttribute("aria-label")).not.toMatch(/0:0\d/);
  });

  it("clockVisible defaults to true — the first live section still renders the elapsed clock", () => {
    renderWithProviders(
      <WorkingSection
        entries={[]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        startedAtMs={Date.now() - 5_000}
      />,
    );
    const header = screen.getByTestId("work-section-header");
    const monoSpans = Array.from(header.querySelectorAll("span.font-mono"));
    expect(monoSpans.find((s) => /^0:0\d$/.test(s.textContent ?? ""))).toBeTruthy();
  });
});

// ── ROUND-101 (R101-F, DEFECT 4): mermaid fences in the thinking area ─────────
// Owner (v0.98.0): "in the chat area it was not showing me the properly
// rendered flow diagrams" — the ANSWER leg rendered diagrams since R98-D, but
// a ```mermaid fence the model emitted inside a thinking block showed as
// SOURCE forever: WorkingSection's fence-split rendered every fence through
// the plain CodeBlock. Now a mermaid-language fence mounts MermaidDiagram.
describe("mermaid fences in the thinking area (ROUND-101 R101-F)", () => {
  it("a CLOSED ```mermaid fence in a thought mounts MermaidDiagram with the exact code", async () => {
    mockMermaid.render.mockResolvedValue({ svg: '<svg data-acute-mermaid="working-probe"></svg>' });
    renderWithProviders(
      <WorkingSection
        entries={[
          {
            type: "thinking",
            text: "I will sketch the flow first.\n```mermaid\ngraph TD;\nA-->B\n```",
            ts: "t",
          },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    // ThoughtRow starts collapsed — expand it (the diagram renders wherever
    // the fence text renders; the collapsed/expanded states are unchanged).
    fireEvent.click(screen.getByRole("button", { name: "Expand thought" }));
    // The prose part survives as the quiet mono note...
    expect(screen.getByText("I will sketch the flow first.")).toBeTruthy();
    // ...and the fence mounts the DIAGRAM (the fence-family card's badge +
    // the injected SVG), with the fence's code handed over VERBATIM.
    await waitFor(
      () => expect(document.querySelector('[data-acute-mermaid="working-probe"]')).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(document.querySelector('[data-code-lang="mermaid"]')?.textContent).toBe("mermaid");
    expect(mockMermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^acute-mermaid-\d+$/),
      "graph TD;\nA-->B",
    );
    // It is NOT a plain CodeBlock anymore — no Copy button for the fence.
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });
});

// ── ROUND-117 (R117-f): FAILURE VISIBILITY + terminal polish + Show-all ─────
// The round's #1 PC bug (round-117.md §1 item 13): a failed tool call was a
// 12px red glyph on an identical row, and the folded section header showed a
// green ✓ "Completed N steps" even when tools failed inside it. Now: the row
// tints (mobile ToolShell's language), the excerpt rides under the head, the
// header tells the truth — plus the terminal's colored exit chip + Copy and
// the settled thought's Show-all past the max-h-64 clamp.
describe("R117-f failure visibility (the folded header + the failed row)", () => {
  // Whitespace-normalizer: happy-dom re-serializes rgba() with its own
  // spacing (the same treatment the R51-d chip tests use).
  const tight = (v: string): string => v.replace(/\s+/g, "");

  /** A folded section whose run_command FAILED (stamped exit 1 + an error). */
  const FAILED_ENTRIES: WorkingEntry[] = [
    { type: "thinking", text: "try the build", ts: "2026-09-21T10:00:00Z", thinkingMs: 400 },
    { type: "tool", tool: { seq: 61, toolName: "read_file", argsSummary: "path: src/app.ts", ok: true, ts: "2026-09-21T10:00:20Z", outputSummary: "of 42 total" } },
    {
      type: "tool",
      tool: {
        seq: 62,
        toolName: "run_command",
        argsSummary: "command: pnpm build",
        ok: false,
        ts: "2026-09-21T10:00:40Z",
        outputSummary: "error TS2304: Cannot find name 'foo'\n[exit code: 1]",
      },
    },
  ];

  it("the folded header tells the truth: ✗ danger glyph + 'Completed N steps' + '· 1 failed' (never a clean ✓ over failed work)", () => {
    renderWithProviders(
      <WorkingSection entries={FAILED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" />,
    );
    const header = screen.getByTestId("work-section-header");
    // The step + tool counts keep their grammar; the failure count joins in
    // the danger color (mono tabular-nums like its siblings).
    expect(header.textContent).toContain("Completed 3 steps");
    expect(header.textContent).toContain("· 2 tools");
    expect(header.textContent).toContain("· 1 failed");
    const failedChip = screen.getByTestId("work-failed-count");
    expect(failedChip.className).toContain("tabular-nums");
    expect(failedChip.className).toContain("font-mono");
    // The glyph is the danger ✗ (lucide CircleX), not the success Check.
    const glyphSvg = header.querySelector("svg");
    expect(glyphSvg).not.toBeNull();
    expect(glyphSvg!.style.color).toBe(SEMANTIC_COLORS.danger);
    // The aria-label carries the failure too (the label REPLACES interior
    // content for AT) — duration-free since R120-C-PC item 36.
    expect(header.getAttribute("aria-label")).toContain("Completed 3 steps · 2 tools · 1 failed.");
  });

  it("a clean folded section keeps the green ✓ grammar — no failure chip (the no-regression pin)", () => {
    renderWithProviders(
      <WorkingSection entries={FAILED_ENTRIES.slice(0, 2)} sessionId={SESSION_ID} projectId="proj_probe" />,
    );
    const header = screen.getByTestId("work-section-header");
    expect(header.textContent).toContain("Completed 2 steps");
    expect(header.textContent).not.toContain("failed");
    expect(screen.queryByTestId("work-failed-count")).toBeNull();
    expect(header.querySelector("svg")!.style.color).toBe(SEMANTIC_COLORS.success);
  });

  it("a failed row TINTS its whole container — danger border + ~5% danger wash (mobile ToolShell's language)", () => {
    renderWithProviders(
      <WorkingSection entries={FAILED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    const failRow = screen.getByRole("button", { name: /^Ran command: pnpm build — failed$/ });
    const container = failRow.closest('[data-testid="tool-line"]') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.getAttribute("data-tool-failed")).toBe("true");
    // The tint: a 1px danger-family border + the quiet 5% wash (dark theme →
    // the 0.55 border spelling; whitespace-normalized for happy-dom).
    expect(tight(container.style.borderColor)).toBe(tight(withAlpha(SEMANTIC_COLORS.danger, 0.55)));
    expect(tight(container.style.background)).toBe(tight(withAlpha(SEMANTIC_COLORS.danger, 0.05)));
    expect(container.className).toContain("rounded-lg");
    // The status glyph KEEPS its red (the leading ✗ is unchanged).
    const glyph = container.querySelector('[data-testid="tool-status-glyph"]') as HTMLElement;
    expect(glyph.querySelector("svg")!.style.color).toBe(SEMANTIC_COLORS.danger);
    // A clean sibling row carries NO tint (byte-identical to pre-R117).
    const okRow = screen.getByRole("button", { name: /^Read path: src\/app\.ts — completed$/ });
    const okContainer = okRow.closest('[data-testid="tool-line"]') as HTMLElement;
    expect(okContainer.getAttribute("data-tool-failed")).toBeNull();
    expect(okContainer.className).not.toContain("border");
    expect(okContainer.style.borderColor).toBe("");
  });

  it("the failed row's ONE-LINE error excerpt: the output's first line, mono danger, truncated — expanding swaps it for the full dump", () => {
    renderWithProviders(
      <WorkingSection entries={FAILED_ENTRIES} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    const failRow = screen.getByRole("button", { name: /^Ran command: pnpm build — failed$/ });
    // Collapsed: the excerpt rides under the head (the error's first line).
    const excerpt = screen.getByTestId("tool-error-excerpt");
    expect(excerpt.textContent).toBe("error TS2304: Cannot find name 'foo'");
    expect(excerpt.querySelector("span")!.className).toContain("truncate");
    expect(excerpt.querySelector("span")!.className).toContain("font-mono");
    expect(excerpt.querySelector("span")!.style.color).toBe(SEMANTIC_COLORS.danger);

    // Expanding: the excerpt goes, the FULL dump (both lines + the exit chip
    // + Copy) renders instead.
    fireEvent.click(failRow);
    expect(screen.queryByTestId("tool-error-excerpt")).toBeNull();
    expect(screen.getByText("error TS2304: Cannot find name 'foo'")).toBeTruthy();
    expect(screen.getByText("[exit code: 1]")).toBeTruthy();
  });

  it("a failed row with NO output renders no excerpt (the ✗ alone stays honest)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: { seq: 71, toolName: "web_fetch", argsSummary: "url: https://x.test", ok: false, ts: "t" } }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    expect(screen.queryByTestId("tool-error-excerpt")).toBeNull();
  });
});

describe("R117-f humanized tool args (the collapsed row's glance)", () => {
  it("file tools render the CLICKABLE PATH PILL — and the pill opens the file without toggling the row", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "tool", tool: { seq: 81, toolName: "read_file", argsSummary: "path: src/app.ts", ok: true, ts: "t", outputSummary: "of 42 total" } }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    const row = screen.getByRole("button", { name: /^Read path: src\/app\.ts — completed$/ });
    // The pill (the R40 affordance — the same component the answers speak).
    const pill = screen.getByRole("button", { name: "Open src/app.ts in sidebar" });
    expect(row.contains(pill)).toBe(true);
    // The RAW summary still rides the row's title (the record).
    expect(row.getAttribute("title")).toBe("read_file path: src/app.ts");
    // Clicking the PILL opens the file — the row does NOT expand.
    fireEvent.click(pill);
    const slices = Object.values(useRightSidebarStore.getState().byProject);
    const tab = slices[0]?.tabs.find((t) => t.type === "file");
    expect(tab).toMatchObject({ filePath: "src/app.ts" });
    expect(screen.queryByTestId("terminal-detail")).toBeNull();
    // Clicking the ROW itself still expands (the toggle survives the pill).
    fireEvent.click(row);
    expect(screen.getByText("of 42 total")).toBeTruthy();
  });

  it("run_command shows the command headline; delegate shows role · task_id; the raw string stays the fallback", () => {
    renderWithProviders(
      <WorkingSection
        entries={[
          { type: "tool", tool: { seq: 82, toolName: "run_command", argsSummary: "command: pnpm exec vitest run", ok: true, ts: "t", outputSummary: "3 passed\n[exit code: 0]" } },
          { type: "tool", tool: { seq: 83, toolName: "delegate_task", argsSummary: "task: Fix the login flow, role: coder, task_id: 4f2a", ok: null, ts: "t" } },
          { type: "tool", tool: { seq: 84, toolName: "web_search", argsSummary: "query: fix the login bug", ok: true, ts: "t", outputSummary: "no results" } },
        ]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        defaultOpen
      />,
    );
    // run_command → the command's headline (mono, truncated, raw on title).
    const runRow = screen.getByRole("button", { name: /^Ran command: pnpm exec vitest run — completed$/ });
    expect(runRow.textContent).toContain("pnpm exec vitest run");
    expect(runRow.getAttribute("title")).toBe("run_command command: pnpm exec vitest run");
    // delegate → role · task_id (the task text stays behind the expand).
    const delegateRow = screen.getByRole("button", { name: /^Delegated task: Fix the login flow, role: coder, task_id: 4f2a — running$/ });
    expect(delegateRow.textContent).toContain("coder · 4f2a");
    expect(delegateRow.textContent).not.toContain("Fix the login flow");
    // Unknown family → the RAW string (the fallback).
    const searchRow = screen.getByRole("button", { name: /^Searched query: fix the login bug — completed$/ });
    expect(searchRow.textContent).toContain("query: fix the login bug");
  });
});

describe("R117-f terminal polish (the colored exit chip + Copy)", () => {
  /** Expand a settled run_command row and return its TerminalDetail card. */
  function renderTerminal(tool: ToolUseEntry): HTMLElement {
    renderWithProviders(
      <WorkingSection entries={[{ type: "tool", tool }]} sessionId={SESSION_ID} projectId="proj_probe" defaultOpen />,
    );
    const label = TOOL_LABELS_RUN;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label} `) }));
    return screen.getByTestId("terminal-detail");
  }
  const TOOL_LABELS_RUN = "Ran";

  it("exit 0 renders the QUIET SUCCESS chip (tinted background, not the neutral pill)", () => {
    const card = renderTerminal({
      seq: 91,
      toolName: "run_command",
      argsSummary: "command: pnpm test",
      ok: true,
      ts: "t",
      outputSummary: "3 passed\n[exit code: 0]",
    });
    const chip = card.querySelector('[data-tool-status="exit 0"]') as HTMLElement;
    expect(chip).not.toBeNull();
    const tight = (v: string): string => v.replace(/\s+/g, "");
    expect(tight(chip.style.background)).toBe(tight(withAlpha(SEMANTIC_COLORS.success, 0.12)));
    expect(chip.style.color).toBe(SEMANTIC_COLORS.success);
  });

  it("a non-zero exit renders the DANGER chip — and the Copy button writes the full output to the clipboard", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    const card = renderTerminal({
      seq: 92,
      toolName: "run_command",
      argsSummary: "command: pnpm build",
      ok: false,
      ts: "t",
      outputSummary: "error TS2304\n[exit code: 1]",
    });
    const chip = card.querySelector('[data-tool-status="exit 1"]') as HTMLElement;
    expect(chip).not.toBeNull();
    const tight = (v: string): string => v.replace(/\s+/g, "");
    expect(tight(chip.style.background)).toBe(tight(withAlpha(SEMANTIC_COLORS.danger, 0.1)));
    expect(chip.style.color).toBe(SEMANTIC_COLORS.danger);

    // The Copy button (the CodeBlock idiom): writes the COMPLETE output and
    // flashes "Copied".
    fireEvent.click(screen.getByTestId("terminal-copy"));
    expect(write).toHaveBeenCalledWith("error TS2304\n[exit code: 1]");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("the preview keeps its 3 lines — the rest stays behind the +N toggle", () => {
    const output = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");
    renderTerminal({
      seq: 93,
      toolName: "run_command",
      argsSummary: "command: echo",
      ok: true,
      ts: "t",
      outputSummary: output,
    });
    expect(screen.getByText("line 1")).toBeTruthy();
    expect(screen.getByText("line 3")).toBeTruthy();
    expect(screen.queryByText("line 4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+3 more lines" }));
    expect(screen.getByText("line 4")).toBeTruthy();
    expect(screen.getByText("line 6")).toBeTruthy();
  });
});

describe("R117-f the settled thought's Show-all (past the max-h-64 clamp)", () => {
  /** A 30-line settled thought (well past the ~15-line clamp). */
  const LONG_THOUGHT = Array.from({ length: 30 }, (_, i) => `thought line ${i + 1}`).join("\n");

  it("a long settled thought offers 'Show all' — clicking REMOVES the clamp; a live thought never shows it", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: LONG_THOUGHT, ts: "t", thinkingMs: 900 }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand thought" }));
    const scroller = document.querySelector("[data-thinking-scroll]") as HTMLElement;
    expect(scroller).not.toBeNull();
    // Settled + over the clamp → the toggle shows and the clamp is ON.
    expect(scroller.className).toContain("max-h-64");
    const toggle = screen.getByTestId("thought-show-all");
    expect(toggle.textContent).toBe("Show all");
    expect(toggle.className).toContain("underline");
    fireEvent.click(toggle);
    // The clamp is GONE (the full body opens) and the toggle flips.
    const opened = document.querySelector("[data-thinking-scroll]") as HTMLElement;
    expect(opened.className).not.toContain("max-h-64");
    expect(screen.getByTestId("thought-show-all").textContent).toBe("Show less");
    // Show less restores the clamp.
    fireEvent.click(screen.getByTestId("thought-show-all"));
    expect((document.querySelector("[data-thinking-scroll]") as HTMLElement).className).toContain("max-h-64");
  });

  it("a SHORT settled thought renders no toggle (nothing to unclamp)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: "short thought", ts: "t", thinkingMs: 100 }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        defaultOpen
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand thought" }));
    expect(screen.queryByTestId("thought-show-all")).toBeNull();
  });

  it("a LIVE thought never shows the toggle (the stick-to-bottom scroller owns that view)", () => {
    renderWithProviders(
      <WorkingSection
        entries={[{ type: "thinking", text: LONG_THOUGHT, ts: "t" }]}
        sessionId={SESSION_ID}
        projectId="proj_probe"
        live
        liveEntryIndex={0}
        defaultOpen
      />,
    );
    expect(screen.queryByTestId("thought-show-all")).toBeNull();
  });
});
