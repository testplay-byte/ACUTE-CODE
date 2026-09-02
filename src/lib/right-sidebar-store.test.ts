// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultProjectRightState,
  stateKey,
  useRightSidebarStore,
  type RightSidebarTab,
} from "./right-sidebar-store";

/**
 * ROUND-48 (R48-c) — right-sidebar store: the "files" explorer tab.
 *
 * openFiles() follows the singleton-tab contract the terminal (ROUND-39) and
 * memory (ROUND-44) tabs established: ONE explorer tab per session sidebar —
 * first call creates + activates it, every later call re-activates the SAME
 * tab (never stacks a second one), and closing it lets the next openFiles
 * create a fresh one. The single-path "file" tabs (FileViewerPanel) are
 * untouched: still one tab per path, and never confused with the explorer.
 */

function reset() {
  localStorage.clear();
  useRightSidebarStore.setState({
    byProject: {},
    activeProjectId: null,
    activeSessionByProject: {},
  });
}

beforeEach(reset);

function slice(projectId: string): ReturnType<typeof defaultProjectRightState> {
  const key = stateKey(projectId, useRightSidebarStore.getState().activeSessionByProject[projectId] ?? null);
  return useRightSidebarStore.getState().byProject[key] ?? defaultProjectRightState();
}

function tabs(projectId: string): RightSidebarTab[] {
  return slice(projectId).tabs;
}

describe("right-sidebar store — openFiles (R48-c files explorer tab)", () => {
  it("creates one 'files' tab, activates it and opens the sidebar", () => {
    useRightSidebarStore.getState().setOpen("prj_1", false);

    const id = useRightSidebarStore.getState().openFiles("prj_1");

    const state = slice("prj_1");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ id, type: "files", title: "Files" });
    expect(state.activeTabId).toBe(id);
    expect(state.open).toBe(true);
  });

  it("is a singleton: a second openFiles activates the SAME tab (no stacking)", () => {
    const first = useRightSidebarStore.getState().openFiles("prj_1");
    // Another tab becomes active in between (e.g. the user opened a terminal).
    useRightSidebarStore.getState().openTerminal("prj_1");
    expect(slice("prj_1").activeTabId).not.toBe(first);

    const second = useRightSidebarStore.getState().openFiles("prj_1");

    expect(second).toBe(first);
    expect(tabs("prj_1").filter((t) => t.type === "files")).toHaveLength(1);
    expect(tabs("prj_1")).toHaveLength(2); // files + terminal, not files ×2
    expect(slice("prj_1").activeTabId).toBe(first);
  });

  it("re-creates the explorer after the tab is closed", () => {
    const first = useRightSidebarStore.getState().openFiles("prj_1");
    useRightSidebarStore.getState().closeTab("prj_1", first);
    expect(tabs("prj_1")).toHaveLength(0);

    const second = useRightSidebarStore.getState().openFiles("prj_1");

    expect(second).not.toBe(first);
    expect(tabs("prj_1")).toHaveLength(1);
    expect(slice("prj_1").activeTabId).toBe(second);
  });

  it("does not dedupe against single-path 'file' tabs (separate types)", () => {
    useRightSidebarStore.getState().openFile("prj_1", "README.md");
    const explorerId = useRightSidebarStore.getState().openFiles("prj_1");

    const rows = tabs("prj_1");
    expect(rows).toHaveLength(2);
    expect(rows.filter((t) => t.type === "file")).toHaveLength(1);
    expect(rows.filter((t) => t.type === "files")).toHaveLength(1);
    expect(slice("prj_1").activeTabId).toBe(explorerId);
  });

  it("keeps per-session isolation (explorer tabs are per sessionId key)", () => {
    useRightSidebarStore.getState().setActiveSession("prj_1", "sess_a");
    const idA = useRightSidebarStore.getState().openFiles("prj_1");

    useRightSidebarStore.getState().setActiveSession("prj_1", "sess_b");
    const idB = useRightSidebarStore.getState().openFiles("prj_1");

    expect(idB).not.toBe(idA);
    // Back in session A the explorer is still there, still one tab.
    useRightSidebarStore.getState().setActiveSession("prj_1", "sess_a");
    const again = useRightSidebarStore.getState().openFiles("prj_1");
    expect(again).toBe(idA);
    expect(tabs("prj_1")).toHaveLength(1);
  });
});

describe("right-sidebar store — ROUND-64 (R64-b): the computer tab is GONE", () => {
  it("openComputer no longer exists on the store (no computer tab surface)", () => {
    // The ROUND-61 action was removed with the tab type: the always-on-top
    // floating monitor window is the only computer-use surface now.
    expect(
      (useRightSidebarStore.getState() as unknown as Record<string, unknown>).openComputer,
    ).toBeUndefined();
    // Every other singleton action is still there (untouched).
    const state = useRightSidebarStore.getState() as unknown as Record<string, unknown>;
    for (const action of ["openFiles", "openTerminal", "openMemory", "openConsole", "openBrowser"]) {
      expect(typeof state[action]).toBe("function");
    }
  });

  it("the v3 → v4 migration drops persisted computer tabs and keeps every other tab", () => {
    const migrate = useRightSidebarStore.persist.getOptions().migrate;
    expect(migrate).toBeTypeOf("function");

    const v3 = {
      activeProjectId: "prj_1",
      activeSessionByProject: { prj_1: "sess_a" },
      byProject: {
        "prj_1::sess_a": {
          open: true,
          width: 500,
          tabs: [
            { id: "tab-computer", type: "computer", title: "Computer", createdAt: 1 },
            { id: "tab-terminal", type: "terminal", title: "Terminal", createdAt: 2 },
            { id: "tab-files", type: "files", title: "Files", createdAt: 3 },
          ],
          // The owner had the computer tab ACTIVE when the app last closed.
          activeTabId: "tab-computer",
          terminalLinesByTab: { "tab-terminal": [{ kind: "in", text: "ls" }] },
        },
      },
    };
    const migrated = (migrate as (persisted: unknown, version: number) => unknown)(v3, 3) as {
      byProject: Record<string, { tabs: Array<{ id: string; type: string }>; activeTabId: string | null }>;
    };

    const slice = migrated.byProject["prj_1::sess_a"];
    expect(slice.tabs.map((t) => t.type)).toEqual(["terminal", "files"]);
    // The active pointer fell back to a SURVIVING tab (never a dangling id).
    expect(slice.activeTabId).toBe("tab-terminal");
  });

  it("the migration resets pre-v3 shapes wholesale (the v2 → v3 behavior stays)", () => {
    const migrate = useRightSidebarStore.persist.getOptions().migrate;
    const migrated = (migrate as (persisted: unknown, version: number) => unknown)(
      { byProject: { prj_1: { tabs: [{ id: "t", type: "terminal", title: "Terminal", createdAt: 1 }] } } },
      2,
    ) as { byProject: Record<string, unknown> };
    expect(migrated.byProject).toEqual({});
  });
});
