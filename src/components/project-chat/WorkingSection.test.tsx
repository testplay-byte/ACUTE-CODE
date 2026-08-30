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
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { WorkingSection } from "./WorkingSection";
import {
  ApiError,
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
import { withAlpha } from "../dashboard/helpers";

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  return {
    ...mod,
    fetchSessionCheckpoints: vi.fn(),
    fetchSnapshot: vi.fn(),
    restoreCheckpoint: vi.fn(),
    fetchSubAgents: vi.fn(),
  };
});

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

function renderDelegateSection(tool: ToolUseEntry = DELEGATE_TOOL) {
  const entries: WorkingEntry[] = [{ type: "tool", tool }];
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
    // Two live children → the row stays a toggle; expanding shows the rows.
    renderDelegateSection();
    fireEvent.click(screen.getByRole("button", { name: /^Delegated / }));

    // Both live rows render with their code chips + progress.
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
    // The row itself keeps its shape: one-line button, "Delegated" label, ✓.
    const row = screen.getByRole("button", { name: /^Delegated / });
    expect(row.textContent).toContain("Delegated");
    expect(row.textContent).toContain("✓");
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

  it("an in-flight edit row (ok === null) borrows the running-blue in-flight tint", () => {
    renderCollapsedRow({ ...EDIT_TOOL, ok: null, outputSummary: undefined }, true);

    const chip = screen.getByTestId("tool-icon-chip");
    expect(chip.style.background).toBe(withAlpha("#3B82F6", 0.12));
    expect(chip.style.color).toBe("#3B82F6");
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
