// @vitest-environment happy-dom
/**
 * ROUND-48 (R48-c) — RightSidebar quick-menu wiring for the file explorer:
 * the "Files" quick-menu item opens the REAL explorer tab (owner: "clicking
 * Files opens the file system on the right sidebar") instead of firing the
 * CommandPalette request, while the palette stays reachable from the
 * EmptyState's "Open a file" action (requestFilePicker unchanged).
 *
 * ROUND-48 (R48-e2) — the Sub-agent picker's code badges: every picker row
 * leads with the child's monospace 4-char code (owner: "so I can easily
 * identify which sub-agent is which") and picking one opens a tab titled
 * `CODE · title` (the same convention the Delegated card's live rows use).
 *
 * getProjectsBackend is mocked (in-memory, sidecar-shaped) because the
 * FilesExplorerPanel + the header project name ride on the real
 * useProjectTree/useProjects hooks; fetchSubAgents/fetchSubAgentDetail are
 * stubbed so the sub-agents surfaces never depend on a live sidecar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Project, SessionDetail, SubAgentStatus, TreeNode } from "../../lib/api";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { RightSidebar } from "./RightSidebar";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  tree: vi.fn(),
  file: vi.fn(),
  fetchSubAgents: vi.fn(),
  fetchSubAgentDetail: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getProjectsBackend: () => ({
      list: mocks.list,
      get: mocks.get,
      remove: mocks.remove,
      tree: mocks.tree,
      file: mocks.file,
    }),
    fetchSubAgents: mocks.fetchSubAgents,
    fetchSubAgentDetail: mocks.fetchSubAgentDetail,
  };
});

afterEach(cleanup);

const PROJECT: Project = {
  id: "prj_1",
  name: "ACUTE-CODE",
  rootPath: "/home/dev/ACUTE-CODE",
  color: "#FF6B2C",
  createdAt: "2026-08-20T08:00:00Z",
};

const TREE: TreeNode[] = [
  { name: "README.md", type: "file", path: "README.md", size: 1204 },
  { name: "src", type: "folder", path: "src", children: [] },
];

beforeEach(() => {
  resetTestState();
  useRightSidebarStore.setState({
    byProject: {},
    activeProjectId: null,
    activeSessionByProject: {},
  });
  useRightSidebarEvents.setState({ filePickerRequest: 0, terminalFocusRequest: 0 });
  vi.mocked(mocks.list).mockReset().mockResolvedValue([PROJECT]);
  vi.mocked(mocks.get).mockReset().mockResolvedValue(PROJECT);
  vi.mocked(mocks.remove).mockReset().mockResolvedValue(undefined);
  vi.mocked(mocks.tree).mockReset().mockResolvedValue({ tree: TREE, rootPath: PROJECT.rootPath });
  vi.mocked(mocks.file).mockReset().mockResolvedValue({ path: "README.md", content: "# hi\n" });
  vi.mocked(mocks.fetchSubAgents).mockReset().mockResolvedValue([]);
  vi.mocked(mocks.fetchSubAgentDetail).mockReset().mockResolvedValue({
    id: "sess_child_a",
    projectId: "prj_1",
    agentId: "agt_coder",
    mode: "single",
    status: "completed",
    title: "Refactor auth module",
    createdAt: "2026-08-28T10:00:00Z",
    updatedAt: "2026-08-28T10:01:00Z",
    parentSessionId: "sess_parent",
    subRole: "coder",
    events: [],
    lastSeq: 0,
  } satisfies SessionDetail);
});

/** Click a quick-menu item via its unique description line (the label
 * "Files" is ambiguous once a Files tab exists in the strip). */
async function pickQuickMenuItem(desc: string): Promise<void> {
  const el = await screen.findByText(desc);
  fireEvent.click(el.closest("button") as HTMLElement);
}

describe("RightSidebar quick menu (ROUND-48 R48-c files explorer)", () => {
  it("the quick-menu Files item opens the Files explorer TAB (not the palette)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // Empty sidebar first.
    expect(await screen.findByText("No tabs open")).toBeTruthy();

    // Open the "+" quick menu and pick Files.
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the project's files");

    // The Files tab is in the strip + the explorer panel renders (its own
    // tree + header project name), driven by the mocked GET /tree.
    const explorer = await screen.findByTestId("files-explorer-panel");
    expect(explorer).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("ACUTE-CODE").length).toBeGreaterThan(0));
    const tabEl = document.querySelector('[role="tab"][title="Files"]');
    expect(tabEl).toBeTruthy();
    expect(screen.queryByText("No tabs open")).toBeNull();

    // The OLD quick-menu behavior (open the CommandPalette search) is NOT
    // fired anymore — the palette lives on the explorer's Search button now.
    expect(useRightSidebarEvents.getState().filePickerRequest).toBe(0);
  });

  it("opening Files twice from the quick menu surfaces the SAME tab (singleton)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "New tab" }));
      await pickQuickMenuItem("Browse the project's files");
      await screen.findByTestId("files-explorer-panel");
      // Let the popover's exit animation finish before reopening the menu.
      await waitFor(() =>
        expect(screen.queryByText("Browse the project's files")).toBeNull(),
      );
    }

    const filesTabs = Array.from(document.querySelectorAll('[role="tab"][title="Files"]'));
    expect(filesTabs).toHaveLength(1);
    const slice =
      useRightSidebarStore.getState().byProject["prj_1::default"] ?? undefined;
    expect(slice?.tabs.filter((t) => t.type === "files")).toHaveLength(1);
    expect(slice?.tabs[0]).toMatchObject({ type: "files", title: "Files" });
  });

  it("the EmptyState 'Open a file' action still fires the file-picker (palette) request", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    expect(await screen.findByText("No tabs open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open a file/i }));

    expect(useRightSidebarEvents.getState().filePickerRequest).toBe(1);
  });
});

describe("RightSidebar sub-agent picker (ROUND-48 R48-e2 code badges)", () => {
  const SUB: SubAgentStatus = {
    id: "sess_child_a",
    code: "K7Q2",
    title: "Refactor auth module",
    subRole: "coder",
    status: "running",
    createdAt: "2026-08-28T10:00:00Z",
    updatedAt: "2026-08-28T10:00:30Z",
    todosDone: 1,
    todosTotal: 3,
    inputTokens: 1200,
    outputTokens: 340,
    model: null, // ROUND-50 (R50-b): stats-footer field (null = no usage row yet)
    report: null,
    error: null,
  };

  it("picker rows lead with the monospace code badge; picking opens a tab titled 'CODE · title'", async () => {
    vi.mocked(mocks.fetchSubAgents).mockResolvedValue([SUB]);
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId="sess_parent" />);

    // The sub-agents list must land before the quick menu offers the entry.
    await waitFor(() => expect(mocks.fetchSubAgents).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Inspect a child sub-agent");

    // The picker row: LEADING monospace code badge + role chip + title + status.
    const codeBadge = await screen.findByTestId("subagent-picker-code");
    expect(codeBadge.textContent).toBe("K7Q2");
    const row = codeBadge.closest("button") as HTMLElement;
    expect(row.textContent).toContain("coder");
    expect(row.textContent).toContain("Refactor auth module");
    expect(row.textContent).toContain("running");

    // Picking opens the child's chat tab, titled with the code prefix — the
    // same `${code} · ${title}` convention the Delegated card's rows use.
    fireEvent.click(row);
    await waitFor(() => {
      expect(
        document.querySelector('[role="tab"][title="K7Q2 · Refactor auth module"]'),
      ).toBeTruthy();
    });
    expect(await screen.findByTestId("subagent-panel")).toBeTruthy();

    // The tab landed in the store (the slice key follows the store's ACTIVE
    // session, not the prop — search the slices rather than pin the key).
    const allTabs = Object.values(useRightSidebarStore.getState().byProject).flatMap(
      (s) => s.tabs,
    );
    const tab = allTabs.find((t) => t.type === "subagent");
    expect(tab).toMatchObject({
      type: "subagent",
      subAgentId: "sess_child_a",
      parentSessionId: "sess_parent",
      subRole: "coder",
      title: "K7Q2 · Refactor auth module",
    });
  });
});
