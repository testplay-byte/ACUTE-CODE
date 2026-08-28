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
  restoreCheckpoint,
  type CheckpointMeta,
  type FileSnapshotContent,
  type ToolUseEntry,
  type WorkingEntry,
} from "../../lib/api";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { renderWithProviders, resetTestState } from "../../test-utils";

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  return {
    ...mod,
    fetchSessionCheckpoints: vi.fn(),
    fetchSnapshot: vi.fn(),
    restoreCheckpoint: vi.fn(),
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
