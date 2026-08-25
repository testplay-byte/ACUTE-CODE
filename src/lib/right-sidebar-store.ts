import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * ROUND-38 (owner: "a right side bar a menu… at the very top it will show
 * the tabs kind of view… for the sub agents, for the browser, for the
 * codes"). Per-project state so switching projects never bleeds file/terminal/
 * browser state across them (same lesson as project-chat-store).
 *
 * The store holds a byProject map; components select their project's slice
 * (a stable reference until that slice is replaced). A default factory fills
 * missing entries. Persisted (open/width/tab/open-files survive reloads);
 * terminal lines + browser history are kept too (small, useful to return to).
 */

export type RightSidebarTab = "files" | "terminal" | "browser" | "subagents";

export interface TerminalLine {
  kind: "in" | "out" | "err";
  text: string;
}

export interface ProjectRightState {
  open: boolean;
  activeTab: RightSidebarTab;
  width: number;
  /** Open-file stack (most-recent last). The active file is the last entry. */
  openFiles: string[];
  activeFile: string | null;
  /** Browser tab state (per-project). */
  browserUrl: string | null;
  browserHistory: string[];
  /** Terminal scrollback (per-project). */
  terminalLines: TerminalLine[];
}

export const RIGHT_SIDEBAR_MIN_WIDTH = 320;
export const RIGHT_SIDEBAR_MAX_WIDTH = 720;
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 440;

export function defaultProjectRightState(): ProjectRightState {
  return {
    open: true,
    activeTab: "files",
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH,
    openFiles: [],
    activeFile: null,
    browserUrl: null,
    browserHistory: [],
    terminalLines: [],
  };
}

interface RightSidebarState {
  byProject: Record<string, ProjectRightState>;
  /** Set by ChatFocusLayout so the GapHandle + open toggle know the project. */
  activeProjectId: string | null;
  setActiveProject: (id: string) => void;
  /** Returns the project's slice (creates defaults on first access). */
  ensure: (projectId: string) => ProjectRightState;
  patch: (projectId: string, patch: Partial<ProjectRightState>) => void;
  setOpen: (projectId: string, open: boolean) => void;
  toggleOpen: (projectId: string) => void;
  setTab: (projectId: string, tab: RightSidebarTab) => void;
  setWidth: (projectId: string, width: number) => void;
  /** Open (or surface) a file in the Files tab; switches to files + opens. */
  openFile: (projectId: string, path: string) => void;
  closeFile: (projectId: string, path: string) => void;
  setActiveFile: (projectId: string, path: string) => void;
  setBrowserUrl: (projectId: string, url: string | null) => void;
  pushBrowserHistory: (projectId: string, url: string) => void;
  appendTerminal: (projectId: string, line: TerminalLine) => void;
  clearTerminal: (projectId: string) => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const useRightSidebarStore = create<RightSidebarState>()(
  persist(
    (set, get) => ({
      byProject: {},
      activeProjectId: null,
      setActiveProject: (id) => set({ activeProjectId: id }),
      ensure: (projectId) => {
        const existing = get().byProject[projectId];
        if (existing !== undefined) return existing;
        const next = defaultProjectRightState();
        set((s) => ({ byProject: { ...s.byProject, [projectId]: next } }));
        return next;
      },
      patch: (projectId, patch) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          return { byProject: { ...s.byProject, [projectId]: { ...cur, ...patch } } };
        }),
      setOpen: (projectId, open) => get().patch(projectId, { open }),
      toggleOpen: (projectId) => {
        const cur = get().byProject[projectId] ?? defaultProjectRightState();
        get().patch(projectId, { open: !cur.open });
      },
      setTab: (projectId, activeTab) => get().patch(projectId, { activeTab, open: true }),
      setWidth: (projectId, width) =>
        get().patch(projectId, { width: clamp(width, RIGHT_SIDEBAR_MIN_WIDTH, RIGHT_SIDEBAR_MAX_WIDTH) }),
      openFile: (projectId, path) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          // Dedupe: drop the path if already in the stack, then push it last
          // (most-recent → active). Cap the stack at 8 open files.
          const openFiles = cur.openFiles.filter((p) => p !== path);
          openFiles.push(path);
          while (openFiles.length > 8) openFiles.shift();
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...cur,
                open: true,
                activeTab: "files",
                openFiles,
                activeFile: path,
              },
            },
          };
        }),
      closeFile: (projectId, path) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const openFiles = cur.openFiles.filter((p) => p !== path);
          const activeFile =
            cur.activeFile === path ? (openFiles[openFiles.length - 1] ?? null) : cur.activeFile;
          return {
            byProject: { ...s.byProject, [projectId]: { ...cur, openFiles, activeFile } },
          };
        }),
      setActiveFile: (projectId, path) => get().patch(projectId, { activeFile: path, activeTab: "files", open: true }),
      setBrowserUrl: (projectId, browserUrl) => get().patch(projectId, { browserUrl, open: true, activeTab: "browser" }),
      pushBrowserHistory: (projectId, url) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const browserHistory = [url, ...cur.browserHistory.filter((u) => u !== url)].slice(0, 20);
          return { byProject: { ...s.byProject, [projectId]: { ...cur, browserHistory } } };
        }),
      appendTerminal: (projectId, line) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const terminalLines = [...cur.terminalLines, line].slice(-500);
          return { byProject: { ...s.byProject, [projectId]: { ...cur, terminalLines } } };
        }),
      clearTerminal: (projectId) => get().patch(projectId, { terminalLines: [] }),
    }),
    {
      name: "acute-code.rightSidebar",
      version: 1,
    },
  ),
);
