// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  createProjectMemory,
  createWorkspaceMemory,
  deleteProjectMemory,
  deleteWorkspaceMemory,
  fetchMemorySettings,
  listProjectMemory,
  listWorkspaceMemory,
  updateProjectMemory,
  updateWorkspaceMemory,
} from "../../lib/api";
import { MemoryPanel } from "./MemoryPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

// The panel is a VIEW over the memory REST surface — the api module is
// mocked exactly as the real sidecar shapes it (GET listing + DELETE, and
// since R98-F1 the write side: POST create + PUT update — and since R117-b
// the WORKSPACE tier's four siblings behind the segmented scope switch).
vi.mock("../../lib/api", () => ({
  listProjectMemory: vi.fn(),
  deleteProjectMemory: vi.fn().mockResolvedValue(undefined),
  // R98-F1: the write side — resolved by default; tests override to fail.
  createProjectMemory: vi.fn().mockResolvedValue({
    memory: { id: "mem_new", deduplicated: false },
    deduplicated: false,
  }),
  updateProjectMemory: vi.fn().mockResolvedValue({ id: "mem_1" }),
  // ROUND-49: the memory master switch — default ON (no OFF notice).
  fetchMemorySettings: vi.fn().mockResolvedValue({ enabled: true }),
  // R117-b: the workspace tier's CRUD siblings.
  listWorkspaceMemory: vi.fn(),
  deleteWorkspaceMemory: vi.fn().mockResolvedValue(undefined),
  createWorkspaceMemory: vi.fn().mockResolvedValue({
    memory: { id: "mem_ws_new", deduplicated: false },
    deduplicated: false,
  }),
  updateWorkspaceMemory: vi.fn().mockResolvedValue({ id: "mem_ws_1" }),
}));

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(listProjectMemory).mockReset().mockResolvedValue([]);
  vi.mocked(deleteProjectMemory).mockReset().mockResolvedValue(undefined);
  vi.mocked(createProjectMemory)
    .mockReset()
    .mockResolvedValue({
      memory: { id: "mem_new", projectId: "prj_1", scope: "project", kind: "note", content: "", source: "owner", createdAt: now(), updatedAt: now() },
      deduplicated: false,
    });
  vi.mocked(updateProjectMemory)
    .mockReset()
    .mockResolvedValue({ id: "mem_1", projectId: "prj_1", scope: "project", kind: "fact", content: "", source: "agent", createdAt: now(), updatedAt: now() });
  vi.mocked(fetchMemorySettings).mockReset().mockResolvedValue({ enabled: true });
  // R117-b: the workspace siblings reset to the same defaults.
  vi.mocked(listWorkspaceMemory).mockReset().mockResolvedValue([]);
  vi.mocked(deleteWorkspaceMemory).mockReset().mockResolvedValue(undefined);
  vi.mocked(createWorkspaceMemory)
    .mockReset()
    .mockResolvedValue({
      memory: { id: "mem_ws_new", projectId: null, scope: "workspace", kind: "note", content: "", source: "owner", createdAt: now(), updatedAt: now() },
      deduplicated: false,
    });
  vi.mocked(updateWorkspaceMemory)
    .mockReset()
    .mockResolvedValue({ id: "mem_ws_1", projectId: null, scope: "workspace", kind: "fact", content: "", source: "owner", createdAt: now(), updatedAt: now() });
});

const now = () => new Date().toISOString();

const tab: RightSidebarTab = {
  id: "tab-mem",
  type: "memory",
  title: "Memory",
  createdAt: Date.now(),
};

function memFactory(m: {
  id: string;
  kind: "fact" | "decision" | "preference" | "note";
  content: string;
  updatedAt?: string;
}) {
  return {
    id: m.id,
    projectId: "prj_1",
    scope: "project" as const,
    kind: m.kind,
    content: m.content,
    source: "agent",
    createdAt: m.updatedAt ?? now(),
    updatedAt: m.updatedAt ?? now(),
  };
}

/** R117-b: a WORKSPACE-tier row (scope 'workspace', projectId null — the
 * cross-project facts the segmented switch's other side browses). */
function wsFactory(m: {
  id: string;
  kind: "fact" | "decision" | "preference" | "note";
  content: string;
  updatedAt?: string;
}) {
  return {
    id: m.id,
    projectId: null,
    scope: "workspace" as const,
    kind: m.kind,
    content: m.content,
    source: "owner",
    createdAt: m.updatedAt ?? now(),
    updatedAt: m.updatedAt ?? now(),
  };
}

describe("MemoryPanel (ROUND-44 R44-a)", () => {
  it("renders the empty state with the memory_save hint and the auto-loaded footer", async () => {
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("No memories yet")).toBeTruthy();
    expect(
      screen.getByText(/The agent saves durable project knowledge here via memory_save/),
    ).toBeTruthy();
    // Footer hint row.
    expect(screen.getByText("Auto-loaded into every agent turn")).toBeTruthy();
    expect(screen.queryByText("fact")).toBeNull();
  });

  it("ROUND-49: shows the OFF notice (memory disabled) while keeping the list browsable; no notice while ON", async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      memFactory({ id: "mem_1", kind: "fact", content: "The sidecar runs on port 5178." }),
    ]);
    vi.mocked(fetchMemorySettings).mockResolvedValue({ enabled: false });
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    const notice = await screen.findByTestId("memory-off-notice");
    expect(notice.textContent).toContain("turned off");
    // The list is still rendered (pruning while off is a feature).
    expect(await screen.findByText("The sidecar runs on port 5178.")).toBeTruthy();

    // ON → no notice.
    cleanup();
    vi.mocked(fetchMemorySettings).mockResolvedValue({ enabled: true });
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);
    expect(await screen.findByText("The sidecar runs on port 5178.")).toBeTruthy();
    expect(screen.queryByTestId("memory-off-notice")).toBeNull();
  });

  it("renders memories grouped by kind with colored chips", async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      memFactory({ id: "mem_1", kind: "decision", content: "Use pnpm workspaces everywhere." }),
      memFactory({ id: "mem_2", kind: "fact", content: "The sidecar runs on port 5178." }),
      memFactory({ id: "mem_3", kind: "decision", content: "TypeScript strict mode is required." }),
    ]);
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    // Content renders.
    expect(await screen.findByText("Use pnpm workspaces everywhere.")).toBeTruthy();
    expect(screen.getByText("The sidecar runs on port 5178.")).toBeTruthy();
    expect(screen.getByText("TypeScript strict mode is required.")).toBeTruthy();

    // Kind groups: fact + decision sections, each with its chip + count.
    const factSection = document.querySelector('[data-kind="fact"]');
    expect(factSection?.textContent).toContain("The sidecar runs on port 5178.");
    const decisionSection = document.querySelector('[data-kind="decision"]');
    expect(decisionSection?.textContent).toContain("Use pnpm workspaces everywhere.");
    expect(decisionSection?.textContent).toContain("TypeScript strict mode is required.");
    // No preference/note group when no rows of that kind exist.
    expect(document.querySelector('[data-kind="preference"]')).toBeNull();

    // Header count chip reflects the total.
    expect(screen.getByText("3 saved")).toBeTruthy();
  });

  it("deletes a memory via the row button and refreshes the listing", async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      memFactory({ id: "mem_del", kind: "fact", content: "temporary fact" }),
    ]);
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("temporary fact")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete memory: temporary fact/i }));
    await waitFor(() =>
      expect(deleteProjectMemory).toHaveBeenCalledWith("prj_1", "mem_del"),
    );
    // The listing is refetched after the delete settles.
    await waitFor(() => expect(listProjectMemory).toHaveBeenCalledTimes(2));
  });

  it("shows the load-error card with a retry when the sidecar fails", async () => {
    vi.mocked(listProjectMemory).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("Couldn't load project memory")).toBeTruthy();
    expect(screen.getByText("sidecar down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(listProjectMemory).toHaveBeenCalledTimes(2));
  });

  // ── ROUND-98 (R98-F1): the WRITE side — the add-memory form + the
  // per-row inline edit. Pins: the form's exact POST body (trimmed content
  // + the picked kind), the invalidation refetch, the honest failure line,
  // and the row edit's exact PUT patch. ────────────────────────────────────
  it("R98-F1: the add-memory form POSTs {kind, content} (trimmed) and refreshes the listing", async () => {
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    // The empty state renders first; the header's + toggle opens the form.
    expect(await screen.findByText("No memories yet")).toBeTruthy();
    fireEvent.click(screen.getByTestId("memory-add-toggle"));
    expect(await screen.findByTestId("memory-add-form")).toBeTruthy();

    // Pick the kind (default note → decision) + type content with padding
    // (the trim is the form's job — the server never sees the whitespace).
    fireEvent.change(screen.getByTestId("memory-add-kind"), { target: { value: "decision" } });
    fireEvent.change(screen.getByTestId("memory-add-content"), {
      target: { value: "  Use pnpm workspaces everywhere.  " },
    });
    fireEvent.click(screen.getByTestId("memory-add-save"));

    await waitFor(() =>
      expect(createProjectMemory).toHaveBeenCalledWith("prj_1", {
        kind: "decision",
        content: "Use pnpm workspaces everywhere.",
      }),
    );
    // The listing is refetched after the save settles.
    await waitFor(() => expect(listProjectMemory).toHaveBeenCalledTimes(2));
  });

  it("R98-F1: the add form refuses an empty draft (no POST) and surfaces a failed save's honest error", async () => {
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);
    fireEvent.click(await screen.findByTestId("memory-add-toggle"));

    // Empty draft: the Save stays inert — ZERO POSTs.
    const save = screen.getByTestId("memory-add-save");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("memory-add-content"), { target: { value: "   " } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(createProjectMemory).not.toHaveBeenCalled();

    // A failing save (the server's 400 envelope text, verbatim) keeps the
    // form OPEN with the error — nothing silently swallowed.
    vi.mocked(createProjectMemory).mockRejectedValue(
      new Error("content must be at most 4000 characters"),
    );
    fireEvent.change(screen.getByTestId("memory-add-content"), {
      target: { value: "a real draft" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByTestId("memory-add-error")).toBeTruthy();
    expect(screen.getByText("content must be at most 4000 characters")).toBeTruthy();
    expect(screen.getByTestId("memory-add-form")).toBeTruthy();
  });

  it("R98-F1: the per-row Pencil opens the inline editor, Save PUTs the {content, kind} patch, and Cancel abandons", async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      memFactory({ id: "mem_edit", kind: "fact", content: "The sidecar runs on port 5178." }),
    ]);
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    // Open the editor — the textarea is prefilled with the row's content.
    fireEvent.click(
      await screen.findByRole("button", { name: /Edit memory: The sidecar runs on port/i }),
    );
    const content = await screen.findByTestId("memory-edit-content");
    expect((content as HTMLTextAreaElement).value).toBe("The sidecar runs on port 5178.");
    // The Save starts disabled (nothing dirty yet).
    const save = screen.getByTestId("memory-edit-save");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Edit content + move the kind, save → the EXACT partial patch.
    fireEvent.change(content, { target: { value: "The sidecar runs on port 5179." } });
    fireEvent.change(screen.getByTestId("memory-edit-kind"), { target: { value: "decision" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(updateProjectMemory).toHaveBeenCalledWith("prj_1", "mem_edit", {
        content: "The sidecar runs on port 5179.",
        kind: "decision",
      }),
    );
    await waitFor(() => expect(listProjectMemory).toHaveBeenCalledTimes(2));

    // A second row: Cancel ABANDONS — no PUT at all.
    cleanup();
    vi.mocked(listProjectMemory).mockClear().mockResolvedValue([
      memFactory({ id: "mem_keep", kind: "note", content: "keep me untouched" }),
    ]);
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit memory: keep me untouched/i }));
    fireEvent.change(await screen.findByTestId("memory-edit-content"), {
      target: { value: "changed but cancelled" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(updateProjectMemory).toHaveBeenCalledTimes(1); // only the first row's PUT
    // The row renders its ORIGINAL content again (the draft was abandoned).
    expect(await screen.findByText("keep me untouched")).toBeTruthy();
  });

  // ── ROUND-117 (R117-b): the SCOPE LADDER — the segmented switch over the
  // two memory tiers (Workspace | This project). Pins: the default tier is
  // the project's, switching fetches the WORKSPACE listing, the CRUD routes
  // the ACTIVE tier, and the empty/footer copy is scope-honest. ──────────
  it("R117-b: the segmented switch defaults to the project tier; 'Workspace' swaps the listing + CRUD + copy; switching back restores the project tier", async () => {
    vi.mocked(listProjectMemory).mockResolvedValue([
      memFactory({ id: "mem_p1", kind: "fact", content: "The sidecar runs on port 5178." }),
    ]);
    vi.mocked(listWorkspaceMemory).mockResolvedValue([
      wsFactory({ id: "mem_w1", kind: "preference", content: "The owner prefers terse replies." }),
    ]);
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);

    // Default: the project tier — both segments render, the project row shows,
    // the workspace listing is NEVER fetched.
    expect(await screen.findByText("The sidecar runs on port 5178.")).toBeTruthy();
    expect(screen.getByTestId("memory-scope-project").textContent).toContain("This project");
    expect(screen.getByTestId("memory-scope-workspace").textContent).toContain("Workspace");
    expect(screen.getByText("Auto-loaded into every agent turn")).toBeTruthy(); // the project footer
    expect(listWorkspaceMemory).not.toHaveBeenCalled();

    // Switch to the WORKSPACE tier: its listing + row + honest copy.
    fireEvent.click(screen.getByTestId("memory-scope-workspace"));
    expect(await screen.findByText("The owner prefers terse replies.")).toBeTruthy();
    await waitFor(() => expect(listWorkspaceMemory).toHaveBeenCalled());
    expect(screen.getByText("Injected into every project's agent turns")).toBeTruthy();
    expect(screen.queryByText("The sidecar runs on port 5178.")).toBeNull(); // the project row is gone

    // The workspace delete routes the workspace API (no project id).
    fireEvent.click(screen.getByRole("button", { name: /Delete memory: The owner prefers terse replies/i }));
    await waitFor(() => expect(deleteWorkspaceMemory).toHaveBeenCalledWith("mem_w1"));
    expect(deleteProjectMemory).not.toHaveBeenCalled();

    // The workspace add form routes createWorkspaceMemory (no project id).
    fireEvent.click(screen.getByTestId("memory-add-toggle"));
    fireEvent.change(screen.getByTestId("memory-add-content"), {
      target: { value: "The owner's machine is called acutebox." },
    });
    fireEvent.click(screen.getByTestId("memory-add-save"));
    await waitFor(() =>
      expect(createWorkspaceMemory).toHaveBeenCalledWith({
        kind: "note",
        content: "The owner's machine is called acutebox.",
      }),
    );
    expect(createProjectMemory).not.toHaveBeenCalled();

    // Back to the project tier: its listing returns (and the workspace row is
    // gone).
    fireEvent.click(screen.getByTestId("memory-scope-project"));
    expect(await screen.findByText("The sidecar runs on port 5178.")).toBeTruthy();
    expect(screen.queryByText("The owner prefers terse replies.")).toBeNull();
  });

  it("R117-b: the workspace tier's EMPTY state is scope-honest ('No workspace memories yet' + the cross-project hint)", async () => {
    renderWithProviders(<MemoryPanel projectId="prj_1" tab={tab} />);
    expect(await screen.findByText("No memories yet")).toBeTruthy(); // the project tier's empty

    fireEvent.click(screen.getByTestId("memory-scope-workspace"));
    expect(await screen.findByText("No workspace memories yet")).toBeTruthy();
    expect(
      screen.getByText(/Cross-project facts — your identity, preferences, and environment truths/),
    ).toBeTruthy();
    expect(screen.queryByText("No memories yet")).toBeNull(); // the project empty is gone
  });
});
