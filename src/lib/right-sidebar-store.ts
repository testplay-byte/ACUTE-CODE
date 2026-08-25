import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * ROUND-39 (owner: "I was hoping for the UI to be much more like a browser,
 * like how on the browser at the very top we can add new tabs… I would be
 * given a plus button. I can click that plus button and then it will give me
 * the options on what I need to open: file viewer / browser / terminal /
 * sub-agents… the sub-agent option only shows if there were sub-agents…
 * select which sub-agent I want to open and that sub-agent will open up as a
 * tab. I can easily switch between the tabs quickly and properly.").
 *
 * The right sidebar now hosts a DYNAMIC list of tabs (browser-style). Each
 * tab is one of: file | browser | terminal | subagent. The "+" button opens a
 * quick menu with SVG icons to add a new tab of any type. Sub-agents only
 * appear in the quick menu when the parent session has child sub-agents.
 *
 * Per-project state (switching projects never bleeds tabs across them, same
 * lesson as project-chat-store). Persisted (open/width/tabs survive reloads).
 */

export type RightSidebarTabType = "file" | "browser" | "terminal" | "subagent";

export interface TerminalLine {
  kind: "in" | "out" | "err";
  text: string;
}

export interface RightSidebarTab {
  /** Unique within the project (uuid-ish; counter-based). */
  id: string;
  type: RightSidebarTabType;
  title: string;
  /** File path (file tabs). */
  filePath?: string;
  /** Browser URL (browser tabs). */
  browserUrl?: string | null;
  /** Browser history (browser tabs; back/forward through this). */
  browserHistory?: string[];
  /** Sub-agent session id (subagent tabs). */
  subAgentId?: string;
  /** Parent session id (subagent tabs — the session whose child this is). */
  parentSessionId?: string;
  /** Sub-agent role (subagent tabs — for the icon color). */
  subRole?: string;
  /** Created at — for stable sort + LRU eviction. */
  createdAt: number;
}

export interface ProjectRightState {
  open: boolean;
  width: number;
  tabs: RightSidebarTab[];
  activeTabId: string | null;
  /** Per-tab terminal scrollback (keyed by tab id; terminal tabs only). */
  terminalLinesByTab: Record<string, TerminalLine[]>;
}

export const RIGHT_SIDEBAR_MIN_WIDTH = 360;
export const RIGHT_SIDEBAR_MAX_WIDTH = 760;
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 460;
/** Max open tabs per project (LRU eviction past this). */
const MAX_TABS = 12;

export function defaultProjectRightState(): ProjectRightState {
  return {
    open: true,
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH,
    tabs: [],
    activeTabId: null,
    terminalLinesByTab: {},
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
  setWidth: (projectId: string, width: number) => void;
  /** Add a tab (or activate an existing tab of the same type+key). */
  addTab: (
    projectId: string,
    tab: Omit<RightSidebarTab, "id" | "createdAt">,
  ) => string;
  /** Close a tab + activate a sensible neighbor. */
  closeTab: (projectId: string, tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  /** Open (or surface) a file tab. */
  openFile: (projectId: string, path: string) => string;
  /** Open (or surface) a browser tab. */
  openBrowser: (projectId: string, url?: string | null) => string;
  /** Open (or surface) a terminal tab. */
  openTerminal: (projectId: string) => string;
  /** Open (or surface) a sub-agent tab. */
  openSubAgent: (
    projectId: string,
    parentSessionId: string,
    subAgentId: string,
    title: string,
    subRole?: string,
  ) => string;
  /** Update a single tab's fields (e.g. browser URL change). */
  patchTab: (projectId: string, tabId: string, patch: Partial<RightSidebarTab>) => void;
  /** Browser: navigate to a URL (pushes history). */
  setBrowserUrl: (projectId: string, tabId: string, url: string | null) => void;
  /** Terminal: append a line to a tab's scrollback. */
  appendTerminal: (projectId: string, tabId: string, line: TerminalLine) => void;
  /** Terminal: clear a tab's scrollback. */
  clearTerminal: (projectId: string, tabId: string) => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

let idCounter = 1;
function nextId(): string {
  return `tab-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

/** Find an existing tab matching the type + a key field. */
function findExistingTab(
  state: ProjectRightState,
  type: RightSidebarTabType,
  key: { filePath?: string; browserUrl?: string | null; subAgentId?: string; terminal?: boolean },
): RightSidebarTab | null {
  for (const t of state.tabs) {
    if (t.type !== type) continue;
    if (type === "file" && key.filePath !== undefined && t.filePath === key.filePath) return t;
    if (type === "browser" && key.browserUrl !== undefined && (t.browserUrl ?? null) === (key.browserUrl ?? null)) return t;
    if (type === "subagent" && key.subAgentId !== undefined && t.subAgentId === key.subAgentId) return t;
    if (type === "terminal" && key.terminal) return t;
  }
  return null;
}

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
      setWidth: (projectId, width) =>
        get().patch(projectId, {
          width: clamp(width, RIGHT_SIDEBAR_MIN_WIDTH, RIGHT_SIDEBAR_MAX_WIDTH),
        }),
      addTab: (projectId, tabInput) => {
        // Compute the id up front so we can return it (set() returns void).
        const id = nextId();
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          // Dedupe: surface an existing tab of the same type+key.
          const existing = findExistingTab(cur, tabInput.type, {
            filePath: tabInput.filePath,
            browserUrl: tabInput.browserUrl,
            subAgentId: tabInput.subAgentId,
            terminal: tabInput.type === "terminal",
          });
          if (existing !== null) {
            return {
              byProject: {
                ...s.byProject,
                [projectId]: { ...cur, open: true, activeTabId: existing.id },
              },
            };
          }
          const tab: RightSidebarTab = { ...tabInput, id, createdAt: Date.now() };
          // LRU eviction: drop the OLDEST tab past MAX_TABS.
          const tabs = [...cur.tabs, tab];
          while (tabs.length > MAX_TABS) tabs.shift();
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...cur, open: true, tabs, activeTabId: id },
            },
          };
        });
        return id;
      },
      closeTab: (projectId, tabId) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const idx = cur.tabs.findIndex((t) => t.id === tabId);
          if (idx === -1) return s;
          const tabs = cur.tabs.filter((t) => t.id !== tabId);
          // Activate the neighbor (prefer the next, fall back to prev, else null).
          const nextActive =
            tabs.length === 0
              ? null
              : tabs[Math.min(idx, tabs.length - 1)].id;
          // Drop the terminal scrollback for the closed tab.
          const terminalLinesByTab = { ...cur.terminalLinesByTab };
          delete terminalLinesByTab[tabId];
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...cur, tabs, activeTabId: nextActive, terminalLinesByTab },
            },
          };
        }),
      setActiveTab: (projectId, tabId) =>
        get().patch(projectId, { activeTabId: tabId, open: true }),
      openFile: (projectId, path) => {
        const state = get().byProject[projectId] ?? defaultProjectRightState();
        const existing = findExistingTab(state, "file", { filePath: path });
        if (existing !== null) {
          get().setActiveTab(projectId, existing.id);
          return existing.id;
        }
        const title = path.split("/").pop() ?? path;
        return get().addTab(projectId, { type: "file", title, filePath: path });
      },
      openBrowser: (projectId, url) => {
        const startUrl = url ?? null;
        const title = startUrl === null ? "New tab" : startUrl.replace(/^https?:\/\//, "").slice(0, 24);
        return get().addTab(projectId, {
          type: "browser",
          title: title === "" ? "New tab" : title,
          browserUrl: startUrl,
          browserHistory: startUrl === null ? [] : [startUrl],
        });
      },
      openTerminal: (projectId) =>
        get().addTab(projectId, { type: "terminal", title: "Terminal" }),
      openSubAgent: (projectId, parentSessionId, subAgentId, title, subRole) =>
        get().addTab(projectId, {
          type: "subagent",
          title: title.length > 30 ? `${title.slice(0, 30)}…` : title,
          subAgentId,
          parentSessionId,
          subRole,
        }),
      patchTab: (projectId, tabId, patch) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
          return { byProject: { ...s.byProject, [projectId]: { ...cur, tabs } } };
        }),
      setBrowserUrl: (projectId, tabId, url) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const tabs = cur.tabs.map((t) => {
            if (t.id !== tabId) return t;
            const browserHistory = url === null ? t.browserHistory ?? [] : [url, ...(t.browserHistory ?? []).filter((u) => u !== url)].slice(0, 20);
            const title = url === null ? "New tab" : url.replace(/^https?:\/\//, "").slice(0, 24);
            return { ...t, browserUrl: url, browserHistory, title: title === "" ? "New tab" : title };
          });
          return { byProject: { ...s.byProject, [projectId]: { ...cur, tabs } } };
        }),
      appendTerminal: (projectId, tabId, line) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const existing = cur.terminalLinesByTab[tabId] ?? [];
          const terminalLinesByTab = {
            ...cur.terminalLinesByTab,
            [tabId]: [...existing, line].slice(-500),
          };
          return { byProject: { ...s.byProject, [projectId]: { ...cur, terminalLinesByTab } } };
        }),
      clearTerminal: (projectId, tabId) =>
        set((s) => {
          const cur = s.byProject[projectId] ?? defaultProjectRightState();
          const terminalLinesByTab = { ...cur.terminalLinesByTab };
          delete terminalLinesByTab[tabId];
          return { byProject: { ...s.byProject, [projectId]: { ...cur, terminalLinesByTab } } };
        }),
    }),
    {
      name: "acute-code.rightSidebar",
      version: 2,
      // v1 → v2: the schema is incompatible (fixed tabs → dynamic tabs). Drop
      // old per-project slices; users re-open files (one click). The cost of
      // a migration shim would be higher than the value (few persisted tabs).
      migrate: () => ({ byProject: {}, activeProjectId: null }),
    },
  ),
);
