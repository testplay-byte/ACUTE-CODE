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
