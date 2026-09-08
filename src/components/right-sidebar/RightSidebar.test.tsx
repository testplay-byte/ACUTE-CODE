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
    taskId: null,
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

describe("RightSidebar quick menu — ROUND-64 (R64-b): the Computer entry is GONE", () => {
  it("the quick menu offers no Computer item (the floating monitor is the only computer surface)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    expect(await screen.findByText("No tabs open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));

    // The ROUND-61 entry (label "Computer", desc "Live desktop-control
    // monitor + STOP") is fully absent — the always-on-top floating monitor
    // window replaced the sidebar tab.
    await screen.findByText("Browse the project's files");
    expect(screen.queryByText("Computer")).toBeNull();
    expect(screen.queryByText("Live desktop-control monitor + STOP")).toBeNull();

    // Every OTHER quick-menu entry is untouched.
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("a persisted computer tab renders as no tab (the store surface no longer produces it)", () => {
    // The tab type is gone from the store + the panel is deleted; the
    // v3→v4 migration (right-sidebar-store.test.ts) sweeps persisted
    // computer rows away. Nothing in the sidebar can create one anymore.
    expect(
      (useRightSidebarStore.getState() as unknown as Record<string, unknown>).openComputer,
    ).toBeUndefined();
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

// ── ROUND-65 (R65): the agent-browser AUTO-OPEN controller ──────────────────
// The owner: after approving the agent's browser action, "the browser never
// even opened". The stream-store bumps `agentBrowserActivity` (burst-gated)
// whenever the agent drives the embedded browser; the sidebar's edge-triggered
// effect opens (or switches to) the Browser tab so the browsing is VISIBLE.
describe("RightSidebar agent-browser AUTO-OPEN (ROUND-65 R65)", () => {
  beforeEach(() => {
    // R65: the burst gate is REAL state — reset it per test (bumps within
    // 8s of the previous test's bump would be swallowed as one burst).
    useRightSidebarStore.setState({ agentBrowserActivityByProject: {}, agentBrowserActivityAtByProject: {} });
    // Hermetic fetch stub for the BrowserPanel's session mint (same as the
    // R60-D suite — the panel renders its proxy path under the mocked
    // native bridge; everything else 404s and the poll catches it).
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
    setPopoverWebviewSuppression(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("R67/E3: an edge opens the SIDEBAR; the browser-open frame's tab lands active (the two-step flow)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);
    expect(await screen.findByText("No tabs open")).toBeTruthy();

    // The owner collapsed the sidebar (no tabs, open: false) — the state in
    // the owner's live report: the agent browsed invisibly.
    useRightSidebarStore.getState().setOpen("prj_1", false);

    // The agent calls browser_control → the stream-store bumps the edge →
    // the sidebar OPENS (no tab yet — R67: the bump no longer mints a blank
    // tab; the tool's browser-open frame owns tab creation).
    act(() => {
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1");
    });
    // The tool's browser-open frame lands (stream-store → openBrowserForChatSession).
    act(() => {
      useRightSidebarStore.getState().setActiveSession("prj_1", "sess_auto");
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });

    // The Browser tab exists and is ACTIVE (the panel renders).
    await screen.findByTestId("browser-panel");
    const tabs = Object.values(useRightSidebarStore.getState().byProject).flatMap((s) => s.tabs);
    const browser = tabs.find((t) => t.type === "browser");
    expect(browser).toBeTruthy();
    expect(browser?.id).toBe("ag-sess_auto");
    const slice = useRightSidebarStore.getState().byProject["prj_1::sess_auto"];
    expect(slice.activeTabId).toBe("ag-sess_auto");
    expect(slice.open).toBe(true);
  });

  it("an edge switches TO the browser tab when another tab is active (the browsing becomes visible)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // The owner is looking at the Files tab.
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the project's files");
    await screen.findByTestId("files-explorer-panel");

    // The agent starts browsing → bump + the browser-open frame's tab.
    act(() => {
      useRightSidebarStore.getState().setActiveSession("prj_1", "sess_auto");
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1");
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });
    await screen.findByTestId("browser-panel");
    const slice = useRightSidebarStore.getState().byProject["prj_1::sess_auto"];
    const active = slice.tabs.find((t) => t.id === slice.activeTabId);
    expect(active?.type).toBe("browser");
  });

  it("no re-fight: an edge while a browser tab is ALREADY active changes nothing (still one tab, same id)", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // First burst: bump + the browser-open frame's tab.
    act(() => {
      useRightSidebarStore.getState().setActiveSession("prj_1", "sess_auto");
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1");
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });
    await screen.findByTestId("browser-panel");
    const before = Object.values(useRightSidebarStore.getState().byProject)
      .flatMap((s) => s.tabs)
      .filter((t) => t.type === "browser");

    // A same-burst follow-up frame (no counter edge) + a NEW burst edge
    // later — both leave the SAME browser tab active (the re-fire of
    // openBrowserForChatSession with the same id is idempotent — never a
    // second tab).
    act(() => {
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1"); // same burst (ms apart)
    });
    useRightSidebarStore.setState({
      agentBrowserActivityAtByProject: { prj_1: Date.now() - 10_000 },
    });
    act(() => {
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1"); // NEW burst
      // The frame re-fired (idempotent re-open of the same tab id).
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });

    const after = Object.values(useRightSidebarStore.getState().byProject)
      .flatMap((s) => s.tabs)
      .filter((t) => t.type === "browser");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    const slice = useRightSidebarStore.getState().byProject["prj_1::sess_auto"];
    expect(slice.activeTabId).toBe(after[0]?.id);
  });

  it("review fix #1: a NEW burst while the browser tab carries a URL SURFACES that tab — never a duplicate blank one", async () => {
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);

    // Burst 1: bump + the browser-open frame's tab.
    act(() => {
      useRightSidebarStore.getState().setActiveSession("prj_1", "sess_auto");
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1");
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });
    await screen.findByTestId("browser-panel");
    const first = Object.values(useRightSidebarStore.getState().byProject)
      .flatMap((s) => s.tabs)
      .find((t) => t.type === "browser");
    expect(first).toBeTruthy();

    // The agent navigated — the tab now carries a URL (what openBrowser's
    // null-URL dedupe would MISS, minting a duplicate blank tab).
    useRightSidebarStore.getState().setBrowserUrl("prj_1", (first as { id: string }).id, "https://example.com/page");

    // The user switches to another tab, then a NEW burst fires (> 8s gap).
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await pickQuickMenuItem("Browse the project's files");
    await screen.findByTestId("files-explorer-panel");
    useRightSidebarStore.setState({
      agentBrowserActivityAtByProject: { prj_1: Date.now() - 10_000 },
    });
    act(() => {
      useRightSidebarStore.getState().noteAgentBrowserActivity("prj_1");
      // The frame re-fires for the SAME tab id (idempotent — surface, never
      // a duplicate).
      useRightSidebarStore.getState().openBrowserForChatSession("prj_1", "sess_auto", "ag-sess_auto", null);
    });

    // The ORIGINAL browser tab is active again — exactly ONE browser tab.
    await screen.findByTestId("browser-panel");
    const slice = useRightSidebarStore.getState().byProject["prj_1::sess_auto"];
    const browserTabs = slice.tabs.filter((t) => t.type === "browser");
    expect(browserTabs).toHaveLength(1);
    expect(slice.activeTabId).toBe(first?.id);
    expect(browserTabs[0]?.browserUrl).toBe("https://example.com/page");
  });

  it("mounting with a non-zero counter does NOT open anything (no mount-time edge)", async () => {
    // A pre-existing counter (persisted across a remount mid-burst) must not
    // auto-open on the mount read — only a genuine NEW edge opens.
    useRightSidebarStore.setState({
      agentBrowserActivityByProject: { prj_1: 7 },
      agentBrowserActivityAtByProject: { prj_1: Date.now() },
    });
    renderWithProviders(<RightSidebar projectId="prj_1" sessionId={null} />);
    await screen.findByText("No tabs open");
    // Give any (wrong) effect a beat to fire.
    await waitFor(() => {
      expect(screen.getByText("No tabs open")).toBeTruthy();
    });
    const slice = Object.values(useRightSidebarStore.getState().byProject)[0];
    expect(slice.tabs.filter((t) => t.type === "browser")).toHaveLength(0);
  });
});
