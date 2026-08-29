// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { deleteProjectMemory, fetchMemorySettings, listProjectMemory } from "../../lib/api";
import { MemoryPanel } from "./MemoryPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

// The panel is a VIEW over the memory REST surface — the api module is
// mocked exactly as the real sidecar shapes it (GET listing + DELETE).
vi.mock("../../lib/api", () => ({
  listProjectMemory: vi.fn(),
  deleteProjectMemory: vi.fn().mockResolvedValue(undefined),
  // ROUND-49: the memory master switch — default ON (no OFF notice).
  fetchMemorySettings: vi.fn().mockResolvedValue({ enabled: true }),
}));

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(listProjectMemory).mockReset().mockResolvedValue([]);
  vi.mocked(deleteProjectMemory).mockReset().mockResolvedValue(undefined);
  vi.mocked(fetchMemorySettings).mockReset().mockResolvedValue({ enabled: true });
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
    kind: m.kind,
    content: m.content,
    source: "agent",
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
});
