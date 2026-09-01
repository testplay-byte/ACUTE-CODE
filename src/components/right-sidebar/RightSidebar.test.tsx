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
 * ROUND-60 (R60-D) — the popover-over-webview z-index fix: while the
 * quick-menu / sub-agent-picker popover is open AND the active tab is a
 * browser tab, the sidebar HIDES that tab's native webview
 * (browser_tab_set_visible false) so the popover is not covered by the
 * OS-level webview layer; closing the popover restores it — guarded to the
 * same-tab-still-active case. The native-browser bridge is mocked
 * (isNativeBrowserAvailable false → the BrowserPanel renders its proxy
 * path and makes NO native calls itself, so every setVisible call below is
 * the sidebar's own effect); global.fetch is stubbed for the panel's
 * session-mint so the suite stays hermetic.
 *
 * getProjectsBackend is mocked (in-memory, sidecar-shaped) because the
 * FilesExplorerPanel + the header project name ride on the real
 * useProjectTree/useProjects hooks; fetchSubAgents/fetchSubAgentDetail are
 * stubbed so the sub-agents surfaces never depend on a live sidecar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Project, SessionDetail, SubAgentStatus, TreeNode } from "../../lib/api";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { RightSidebar } from "./RightSidebar";
// R60-D: the popover-suppression guard (asserted + reset by the tests below).
import { isPopoverWebviewSuppressed, setPopoverWebviewSuppression } from "./popover-webview-guard";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  tree: vi.fn(),
  file: vi.fn(),
  fetchSubAgents: vi.fn(),
  fetchSubAgentDetail: vi.fn(),
  // R60-D: the nativeTabSetVisible spy the popover z-index tests assert on.
  setVisible: vi.fn(() => Promise.resolve()),
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

vi.mock("../../lib/native-browser", () => ({
  isNativeBrowserAvailable: () => false,
  nativeInvoke: () => null,
  nativeTabCreate: vi.fn(() => Promise.resolve()),
  nativeTabNavigate: vi.fn(() => Promise.resolve()),
  nativeTabSetBounds: vi.fn(() => Promise.resolve()),
  nativeTabSetVisible: mocks.setVisible,
  nativeTabSetZoom: vi.fn(() => Promise.resolve()),
  nativeTabGo: vi.fn(() => Promise.resolve()),
  nativeTabUrl: vi.fn(() => Promise.resolve(null)),
  nativeTabClose: vi.fn(() => Promise.resolve()),
  nativeTabsCloseAll: vi.fn(() => Promise.resolve()),
  openExternalUrl: vi.fn(() => Promise.resolve()),
  onBrowserNavigated: vi.fn(() => () => {}),
}));

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

describe("RightSidebar popover vs native webview (R60-D z-index fix)", () => {
  /** The browser tab id the store generated for this test's sidebar. */
  function browserTabId(): string {
    const tabs = Object.values(useRightSidebarStore.getState().byProject).flatMap((s) => s.tabs);
    const id = tabs.find((t) => t.type === "browser")?.id;
    expect(id).toBeTruthy();
    return id as string;
  }

  beforeEach(() => {
    // Hermetic fetch stub for the BrowserPanel's session mint (the panel
    // renders its proxy path under the mocked bridge; everything else 404s
    // and the store's poll catches it silently).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/v1/browser/session")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              sessionId: "sess",
              ticket: "t0",
              expiresAt: Date.now() + 3600_000,
              history: { sessionId: "sess", entries: [], index: -1, canBack: false, canForward: false },
              viewport: { width: 1280, height: 800, preset: "laptop", zoom: 1, rotate: false },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }),
    );
    mocks.setVisible.mockClear();
    // No popover-suppression leak between tests (module-level state).
    setPopoverWebviewSuppression(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opening the quick menu HIDES the active browser tab's webview; closing it RESTORES the same tab", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // Open a browser tab through the quick menu (the panel mounts on the
    // proxy path — it makes no native calls itself in this suite).
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the web in-app");
    await screen.findByTestId("browser-panel");
    mocks.setVisible.mockClear();
    const tabId = browserTabId();

    // Re-open the quick menu: the popover overlaps the page area, the active
    // tab is a BROWSER tab → its webview must hide UNDER the popover.
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await screen.findByText("Browse the project's files");
    await waitFor(() => expect(mocks.setVisible).toHaveBeenCalledWith(tabId, false));

    // Escape closes the popover → the SAME tab is still active and the
    // sidebar is open → the webview comes back (the session never died).
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mocks.setVisible).toHaveBeenCalledWith(tabId, true));
  });

  it("switching the active tab away while the popover is open leaves the webview hidden (no premature restore)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // A browser tab and a Files tab, then back to the browser tab.
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the web in-app");
    await screen.findByTestId("browser-panel");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the project's files");
    await screen.findByTestId("files-explorer-panel");
    const tabId = browserTabId();
    const filesTab = document.querySelector('[role="tab"][title="Files"]') as HTMLElement;
    expect(filesTab).toBeTruthy();
    fireEvent.click(document.querySelector('[role="tab"][title="New tab"]') as HTMLElement);
    await screen.findByTestId("browser-panel");
    mocks.setVisible.mockClear();

    // Open the quick menu (hides the active browser tab's webview)…
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(mocks.setVisible).toHaveBeenCalledWith(tabId, false));

    // …then switch the active tab AWAY through the store (no popover-closing
    // mousedown — a direct setActiveTab keeps the popover open)…
    const slice = Object.entries(useRightSidebarStore.getState().byProject).find(([, s]) =>
      s.tabs.some((t) => t.id === tabId),
    );
    const filesId = slice?.[1].tabs.find((t) => t.type === "files")?.id;
    expect(filesId).toBeTruthy();
    act(() => {
      useRightSidebarStore.getState().setActiveTab("prj_1", filesId as string);
    });

    // …and close the popover: the hidden tab is NOT active anymore → NO
    // restore call (the panel's own remount lifecycle re-shows it later).
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Browse the project's files")).toBeNull());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.setVisible).not.toHaveBeenCalledWith(tabId, true);
  });

  it("with no popover open the sidebar never touches the webview (the panel owns its visibility)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the web in-app");
    await screen.findByTestId("browser-panel");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.setVisible).not.toHaveBeenCalled();
  });

  it("unmounting the sidebar while the popover is open clears the suppression (no webview stays hidden forever)", async () => {
    const { unmount } = renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the web in-app");
    await screen.findByTestId("browser-panel");
    const tabId = browserTabId();

    // Popover opens over the active browser tab → hidden + suppressed.
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(mocks.setVisible).toHaveBeenCalledWith(tabId, false));
    expect(isPopoverWebviewSuppressed(tabId)).toBe(true);

    // The whole sidebar goes away (project/session switch) while the
    // popover is still open → the module suppression must clear so a later
    // panel mount can show the webview again.
    unmount();
    expect(isPopoverWebviewSuppressed(tabId)).toBe(false);
    setPopoverWebviewSuppression(null);
  });
});
