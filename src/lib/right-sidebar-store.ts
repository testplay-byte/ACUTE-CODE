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
 *
 * ROUND-41 (owner: "the sidebar will be different in each one of the
 * sessions. If I switch sessions then the sidebar will close or open but
 * the content in it will change based on the one which was previously in
 * it. If I was in session A and the sub-agent menu was opened up in the
 * sidebar, then in session B it will not be opened up. If I go back to
 * session A then that sidebar will open up exactly the same."). The store
 * is now keyed by `${projectId}::${sessionId}` (the "state key") so each
 * SESSION within a project has its OWN independent sidebar state — tabs,
 * open/closed, width, active tab, terminal scrollback. `setActiveSession`
 * records the active session per project; all reads/writes go through the
 * active session's state key. When no session is active (a brand-new
 * project with no sessions yet), the key falls back to
 * `${projectId}::default` so the sidebar still renders before the first
 * session is created. The public API still takes `projectId` everywhere —
 * callers don't need to know the session id (the store resolves it).
 */

/**
 * The internal storage key for a project's per-session sidebar state.
 * Keyed by `${projectId}::${sessionId}` (or `::default` when no session is
 * active yet). This is what makes per-session state isolation work without
 * threading the session id through every caller. Exported so components
 * that read the slice directly (RightSidebar) can resolve the active
 * session's key the same way the store's actions do.
 */
export function stateKey(projectId: string, sessionId: string | null): string {
  return `${projectId}::${sessionId ?? "default"}`;
}

/** ROUND-44 (R44-a): "memory" joins the tab set — the project's persistent
 * agent knowledge (facts/decisions/preferences saved via memory_save),
 * rendered by MemoryPanel and auto-injected into every agent turn.
 *
 * ROUND-48 (R48-c): "files" — the project file EXPLORER tab (owner: "the
 * right sidebar will be divided into two sections: on the left half, the
 * actual file system with navigation/open folders/click files; on the right
 * side, the actual content of the files"). A singleton tab like the terminal
 * and memory tabs, rendered by FilesExplorerPanel. The single-path "file"
 * tab type (FileViewerPanel) is unchanged — the chat's DiffDetail "Open" and
 * openFile() keep opening one bound file per tab.
 *
 * ROUND-59 (R59-E): "console" — the diagnostics console (owner: "proper
 * console-like error monitoring and error handling"). A singleton tab like
 * terminal/memory/files, rendered by ConsolePanel: the frontend error bus +
 * the engine's error ring in one live, copyable, clearable list.
 *
 * ROUND-64 (R64-b): the ROUND-61 "computer" tab is REMOVED (owner: "There
 * is actually no need to show the computer use in the right sidebar menu at
 * all") — the ALWAYS-ON-TOP floating monitor window (src-tauri/src/mini.rs +
 * src/mini/**) is the only computer-use surface now. Persisted v3 slices
 * that still carry a computer tab are migrated away (v4 below). */
export type RightSidebarTabType =
  | "file"
  | "files"
  | "browser"
  | "terminal"
  | "subagent"
  | "memory"
  | "console";

export interface TerminalLine {
  /** ROUND-44 (R44-e): "exit" lines carry the streaming exit-code footer
   * (`↳ exit 0` / `↳ stopped`) and color themselves via `ok` instead of the
   * fixed kind palette. Additive — pre-R44 persisted scrollbacks only carry
   * in/out/err and keep rendering unchanged. */
  kind: "in" | "out" | "err" | "exit";
  text: string;
  /** Exit lines only: true = success green, false/undefined = danger red. */
  ok?: boolean;
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
/** ROUND-65 (R65): agent-browser activity burst gap — frames closer than
 * this to the previous bump are the SAME burst (one auto-open edge). */
export const AGENT_BROWSER_BURST_MS = 8_000;

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
  /** Internal: keyed by stateKey (projectId::sessionId). Public API still
   * takes projectId; the store resolves the active session's key. */
  byProject: Record<string, ProjectRightState>;
  /** Set by ChatFocusLayout so the GapHandle + open toggle know the project. */
  activeProjectId: string | null;
  /** ROUND-41: the active session id per project (drives stateKey). */
  activeSessionByProject: Record<string, string | null>;
  /** ROUND-65 (R65): agent browser-activity signal, PER PROJECT — bumped
  * (burst-gated) by the stream-store whenever the agent drives the
  * embedded browser in THAT project's session (browser_control tool calls
  * + browser-command bridge frames). The RightSidebar watches its own
  * project's counter and AUTO-OPENS the browser tab so the owner sees what
  * the agent is doing (the owner: after approving a browser action "the
  * browser never even opened"). Per-project scoping (review fix #2): a
  * background agent browsing in project A never pops a tab in project B's
  * sidebar. Transient — partialize keeps it out of localStorage. */
  agentBrowserActivityByProject: Record<string, number>;
  /** ROUND-65 (R65): last activity-bump timestamp per project (epoch ms) —
   * the burst gate. Same-burst frames (< 8s apart) refresh this WITHOUT
   * bumping the counter, so one browsing burst = ONE auto-open edge. */
  agentBrowserActivityAtByProject: Record<string, number>;
  /** ROUND-65 (R65): the burst-gated activity bump (see above). */
  noteAgentBrowserActivity: (projectId: string) => void;
  setActiveProject: (id: string) => void;
  /** ROUND-41: record the active session for a project. Called by
   * ChatFocusLayout whenever useActiveSessionId resolves a new value. */
  setActiveSession: (projectId: string, sessionId: string | null) => void;
  /** Returns the project's ACTIVE SESSION's slice (creates defaults). */
  ensure: (projectId: string) => ProjectRightState;
  patch: (projectId: string, patch: Partial<ProjectRightState>) => void;
  setOpen: (projectId: string, open: boolean) => void;
  toggleOpen: (projectId: string) => void;
  setWidth: (projectId: string, width: number, effectiveMax?: number) => void;
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
  /** ROUND-48 (R48-c): open (or surface) the file-explorer tab (singleton). */
  openFiles: (projectId: string) => string;
  /** Open (or surface) a browser tab. */
  openBrowser: (projectId: string, url?: string | null) => string;
  /** ROUND-67 (R67, E3): open THIS chat session's agent browser tab (the
   * browser-open SSE frame target) — the tab id IS the sidecar session id. */
  openBrowserForChatSession: (projectId: string, chatSessionId: string, tabId: string, url?: string | null) => string;
  /** Open (or surface) a terminal tab. */
  openTerminal: (projectId: string) => string;
  /** ROUND-44 (R44-a): open (or surface) the project-memory tab. */
  openMemory: (projectId: string) => string;
  /** ROUND-59 (R59-E): open (or surface) the diagnostics console tab
   * (singleton — the error console is app-global, one per sidebar). */
  openConsole: (projectId: string) => string;
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
  key: { filePath?: string; browserUrl?: string | null; subAgentId?: string; terminal?: boolean; memory?: boolean; files?: boolean; console?: boolean },
): RightSidebarTab | null {
  for (const t of state.tabs) {
    if (t.type !== type) continue;
    if (type === "file" && key.filePath !== undefined && t.filePath === key.filePath) return t;
    if (type === "browser" && key.browserUrl !== undefined && (t.browserUrl ?? null) === (key.browserUrl ?? null)) return t;
    if (type === "subagent" && key.subAgentId !== undefined && t.subAgentId === key.subAgentId) return t;
    if (type === "terminal" && key.terminal) return t;
    // ROUND-44 (R44-a): memory is a singleton tab like the terminal — one
    // per session's sidebar.
    if (type === "memory" && key.memory) return t;
    // ROUND-48 (R48-c): files explorer is a singleton tab like the terminal
    // and memory — one per session's sidebar.
    if (type === "files" && key.files) return t;
    // ROUND-59 (R59-E): the console is a singleton tab like the terminal /
    // memory / files — one per session's sidebar.
    if (type === "console" && key.console) return t;
  }
  return null;
}

export const useRightSidebarStore = create<RightSidebarState>()(
  persist(
    (set, get) => ({
      byProject: {},
      activeProjectId: null,
      activeSessionByProject: {},
      agentBrowserActivityByProject: {},
      agentBrowserActivityAtByProject: {},
      noteAgentBrowserActivity: (projectId) => {
        const now = Date.now();
        const last = get().agentBrowserActivityAtByProject[projectId] ?? null;
        if (last !== null && now - last < AGENT_BROWSER_BURST_MS) {
          // Same burst — keep the gate fresh WITHOUT a new edge (the sidebar
          // already opened once for this burst; a sparse follow-up > 8s later
          // is a NEW burst and bumps again).
          set({
            agentBrowserActivityAtByProject: {
              ...get().agentBrowserActivityAtByProject,
              [projectId]: now,
            },
          });
          return;
        }
        set({
          agentBrowserActivityByProject: {
            ...get().agentBrowserActivityByProject,
            [projectId]: (get().agentBrowserActivityByProject[projectId] ?? 0) + 1,
          },
          agentBrowserActivityAtByProject: {
            ...get().agentBrowserActivityAtByProject,
            [projectId]: now,
          },
        });
      },
      setActiveProject: (id) => set({ activeProjectId: id }),
      setActiveSession: (projectId, sessionId) =>
        set((s) => ({
          activeSessionByProject: { ...s.activeSessionByProject, [projectId]: sessionId },
        })),
      ensure: (projectId) => {
        const key = stateKey(projectId, get().activeSessionByProject[projectId] ?? null);
        const existing = get().byProject[key];
        if (existing !== undefined) return existing;
        const next = defaultProjectRightState();
        set((s) => ({ byProject: { ...s.byProject, [key]: next } }));
        return next;
      },
      patch: (projectId, patch) =>
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          return { byProject: { ...s.byProject, [key]: { ...cur, ...patch } } };
        }),
      setOpen: (projectId, open) => get().patch(projectId, { open }),
      toggleOpen: (projectId) => {
        const key = stateKey(projectId, get().activeSessionByProject[projectId] ?? null);
        const cur = get().byProject[key] ?? defaultProjectRightState();
        get().patch(projectId, { open: !cur.open });
      },
      setWidth: (projectId, width, effectiveMax) =>
        get().patch(projectId, {
          // R89-D1: the ABSOLUTE 760 ceiling is now only the DEFAULT — the
          // layout passes the LIVE container cap (container − chat floor −
          // chrome) so the sidebar can grow past 760 and the chat reaches
          // its floor at ANY window width (the owner's verdict: with the
          // left sidebar hidden the chat could not shrink as far as
          // before — the absolute clamp silently rose the chat's minimum
          // as the container widened). When the cap is narrower than the
          // min, the render-time cap (RightSidebar's maxWidth) still does
          // the honest clamping — the stored value just stays at the min.
          width: clamp(
            width,
            RIGHT_SIDEBAR_MIN_WIDTH,
            effectiveMax ?? RIGHT_SIDEBAR_MAX_WIDTH,
          ),
        }),
      addTab: (projectId, tabInput) => {
        // Compute the id up front so we can return it (set() returns void).
        const id = nextId();
        // ROUND-48 (R48-c): when the dedupe branch ACTIVATES an existing tab,
        // return THAT tab's id — the action's contract is "the id of the tab
        // that ended up open/active". (Previously the pre-computed fresh id
        // leaked out here even though no new tab was created; harmless for
        // the fire-and-forget callers, but openFiles' dedupe contract needs
        // the honest id. No caller relied on the old value.)
        let resolvedId = id;
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          // Dedupe: surface an existing tab of the same type+key.
          const existing = findExistingTab(cur, tabInput.type, {
            filePath: tabInput.filePath,
            browserUrl: tabInput.browserUrl,
            subAgentId: tabInput.subAgentId,
            terminal: tabInput.type === "terminal",
            memory: tabInput.type === "memory",
            files: tabInput.type === "files",
            console: tabInput.type === "console",
          });
          if (existing !== null) {
            resolvedId = existing.id;
            return {
              byProject: {
                ...s.byProject,
                [key]: { ...cur, open: true, activeTabId: existing.id },
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
              [key]: { ...cur, open: true, tabs, activeTabId: id },
            },
          };
        });
        return resolvedId;
      },
      closeTab: (projectId, tabId) =>
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
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
              [key]: { ...cur, tabs, activeTabId: nextActive, terminalLinesByTab },
            },
          };
        }),
      setActiveTab: (projectId, tabId) =>
        get().patch(projectId, { activeTabId: tabId, open: true }),
      openFile: (projectId, path) => {
        const key = stateKey(projectId, get().activeSessionByProject[projectId] ?? null);
        const state = get().byProject[key] ?? defaultProjectRightState();
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
      // ROUND-67 (R67, E3): the browser_control tool minted THIS chat
      // session's agent tab (ag-<chatSession>) and announced it with a
      // browser-open SSE frame — the stream-store calls this to open the
      // tab. Key differences from openBrowser: (a) the tab lands in the
      // CHAT session's slice even when it is NOT the active sidebar slice
      // (a background turn browses into its own session's sidebar, never
      // the visible one); (b) the tab id IS the sidecar session id the
      // agent drives, so panel/bridge/history align on one id; (c) the
      // slice only AUTO-OPENS (sidebar expands + tab activates) when it is
      // the ACTIVE session's slice. Idempotent: a tab with that exact id
      // already exists (the frame re-fired) just gets activated/patched.
      openBrowserForChatSession: (projectId, chatSessionId, tabId, url) => {
        const startUrl = url ?? null;
        set((s) => {
          const key = stateKey(projectId, chatSessionId);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          const existing = cur.tabs.find((t) => t.id === tabId) ?? null;
          const isActiveSlice = s.activeSessionByProject[projectId] === chatSessionId;
          const title =
            startUrl === null
              ? "Agent browser"
              : startUrl.replace(/^https?:\/\//, "").slice(0, 24) || "Agent browser";
          let tabs: RightSidebarTab[];
          if (existing !== null) {
            // Re-fire: patch the URL when one arrived and keep it.
            tabs = cur.tabs.map((t) =>
              t.id === tabId && startUrl !== null && (t.browserUrl ?? null) !== startUrl
                ? { ...t, browserUrl: startUrl, title, browserHistory: [startUrl, ...(t.browserHistory ?? []).filter((u) => u !== startUrl)].slice(0, 20) }
                : t,
            );
          } else {
            const tab: RightSidebarTab = {
              type: "browser",
              title,
              browserUrl: startUrl,
              browserHistory: startUrl === null ? [] : [startUrl],
              id: tabId,
              createdAt: Date.now(),
            };
            // LRU eviction like addTab (drop the OLDEST past MAX_TABS).
            tabs = [...cur.tabs, tab];
            while (tabs.length > MAX_TABS) tabs.shift();
          }
          return {
            byProject: {
              ...s.byProject,
              [key]: {
                ...cur,
                tabs,
                // Auto-open ONLY the visible slice: a background session's
                // browsing must never yank the user's sidebar.
                ...(isActiveSlice ? { open: true, activeTabId: tabId } : {}),
              },
            },
          };
        });
        return tabId;
      },
      openTerminal: (projectId) =>
        get().addTab(projectId, { type: "terminal", title: "Terminal" }),
      openMemory: (projectId) =>
        get().addTab(projectId, { type: "memory", title: "Memory" }),
      // ROUND-59 (R59-E): the diagnostics console — singleton (deduped by
      // type, like the terminal/memory/files tabs), so the quick-menu
      // "Console" action always surfaces the ONE console.
      openConsole: (projectId) =>
        get().addTab(projectId, { type: "console", title: "Console" }),
      // ROUND-48 (R48-c): the file explorer — a singleton tab (deduped by
      // type, like the terminal/memory tabs), so the quick-menu "Files"
      // action always surfaces the ONE explorer instead of stacking tabs.
      openFiles: (projectId) =>
        get().addTab(projectId, { type: "files", title: "Files" }),
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
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
          return { byProject: { ...s.byProject, [key]: { ...cur, tabs } } };
        }),
      setBrowserUrl: (projectId, tabId, url) =>
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          const tabs = cur.tabs.map((t) => {
            if (t.id !== tabId) return t;
            const browserHistory = url === null ? t.browserHistory ?? [] : [url, ...(t.browserHistory ?? []).filter((u) => u !== url)].slice(0, 20);
            const title = url === null ? "New tab" : url.replace(/^https?:\/\//, "").slice(0, 24);
            return { ...t, browserUrl: url, browserHistory, title: title === "" ? "New tab" : title };
          });
          return { byProject: { ...s.byProject, [key]: { ...cur, tabs } } };
        }),
      appendTerminal: (projectId, tabId, line) =>
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          const existing = cur.terminalLinesByTab[tabId] ?? [];
          const terminalLinesByTab = {
            ...cur.terminalLinesByTab,
            [tabId]: [...existing, line].slice(-500),
          };
          return { byProject: { ...s.byProject, [key]: { ...cur, terminalLinesByTab } } };
        }),
      clearTerminal: (projectId, tabId) =>
        set((s) => {
          const key = stateKey(projectId, s.activeSessionByProject[projectId] ?? null);
          const cur = s.byProject[key] ?? defaultProjectRightState();
          const terminalLinesByTab = { ...cur.terminalLinesByTab };
          delete terminalLinesByTab[tabId];
          return { byProject: { ...s.byProject, [key]: { ...cur, terminalLinesByTab } } };
        }),
    }),
    {
      name: "acute-code.rightSidebar",
      // ROUND-65 (R65, review fix #3): persist ONLY the durable layout
      // state. The transient agent-browser activity signal (counter + burst
      // gate) must never ride localStorage — a restored stale
      // agentBrowserActivityAt would swallow the first post-reload frame
      // as "same burst" and the auto-open would silently never fire.
      partialize: (state) => ({
        byProject: state.byProject,
        activeProjectId: state.activeProjectId,
        activeSessionByProject: state.activeSessionByProject,
      }),
      version: 4,
      // v2 → v3 (ROUND-41): the storage key changed from `projectId` to
      // `projectId::sessionId` for per-session sidebar state. Old slices
      // are unreachable under the new key scheme, so drop them. Users
      // re-open files (one click); the cost of a migration shim would
      // exceed the value (few persisted tabs per project).
      //
      // v3 → v4 (ROUND-64): the "computer" tab type is GONE (the floating
      // monitor window replaced the right-sidebar panel). v3 slices that
      // still carry computer tabs keep every OTHER tab; the computer rows
      // are dropped and an activeTabId pointing at one falls back to the
      // first surviving tab (the floating monitor is the surface now —
      // nothing is lost, the STOP bar is always on top while it matters).
      migrate: (persisted: unknown, version: number) => {
        if (version < 3 || typeof persisted !== "object" || persisted === null) {
          return { byProject: {}, activeProjectId: null, activeSessionByProject: {} };
        }
        const state = persisted as {
          byProject?: Record<string, ProjectRightState>;
          activeProjectId?: string | null;
          activeSessionByProject?: Record<string, string | null>;
        };
        const byProject: Record<string, ProjectRightState> = {};
        for (const [key, slice] of Object.entries(state.byProject ?? {})) {
          // The persisted rows are untrusted JSON — read the type through a
          // permissive cast (a "computer" row cannot exist in TODAY's store,
          // but v3 data on disk can still carry one).
          const rawTabs = Array.isArray(slice?.tabs)
            ? (slice.tabs as Array<{ id: string; type: string }>)
            : [];
          const tabs = rawTabs.filter((t) => t.type !== "computer") as RightSidebarTab[];
          const activeTabId =
            slice?.activeTabId !== null &&
            slice?.activeTabId !== undefined &&
            tabs.some((t) => t.id === slice.activeTabId)
              ? slice.activeTabId
              : (tabs[0]?.id ?? null);
          byProject[key] = { ...slice, tabs, activeTabId };
        }
        return {
          byProject,
          activeProjectId: state.activeProjectId ?? null,
          activeSessionByProject: state.activeSessionByProject ?? {},
        };
      },
    },
  ),
);
