import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * UI state for the project-chat screen (M3 + round-14 demo-parity). Ported
 * from the demo's lib/project-chat-store.ts but WITHOUT mock data: messages,
 * files and code come from react-query (use-projects.ts / use-sessions.ts);
 * this store owns local selection preferences, persisted so the expanded
 * folders, the selected file and the chosen agent survive reloads.
 *
 * expandedFolders is persisted as a plain array (the demo used a Set, which
 * does not serialize). appSidebarVisible is transient (excluded via
 * partialize).
 *
 * R126-3d-1 (the dead-layouts retirement): `chatFocusMode` and
 * `experimentalMode` are REMOVED — their setters had ZERO UI call sites, so
 * chatFocusMode (default true) made ChatFocusLayout the only reachable chat
 * layout and the 3-panel + ExperimentalLayout branches rendered exclusively
 * for stale persisted state; both layouts' files are deleted with the flags.
 * The persisted shape shrinks accordingly: an existing `acute-code.projectChat`
 * payload may still carry the two stale keys, which zustand's persist simply
 * ignores (they are never read back — unknown keys stay inert; a fresh write
 * stops persisting them). No version bump / migration needed.
 *
 * R126-3h (the flagged-debt ledger's retirement, closing 3d-1's note): the
 * 3d-1 run's two leftover slices are now REMOVED the same way —
 * `freeformPanels` + its three setters (updateFreeformPanel/bringToFront/
 * resetFreeformPanels, the FreeformPanel type + DEFAULT_FREEFORM_PANELS + the
 * MIN/MAX width constants) and the retired 3-panel state group
 * (sidebarOpen/codeVisible/sidebarWidth/chatWidth/collapsedPanels +
 * setSidebarOpen/setCodeVisible/setSidebarWidth/setChatWidth/isPanelCollapsed/
 * togglePanel + the clamp helper). rg proved ZERO consumers for every field
 * + setter (the ExperimentalLayout + LeftSidebar + panels/ files that read
 * them are long deleted; the only width-cap matches are ChatFocusLayout's
 * OWN local sidebarWidthCap function). The same inert-payload rule covers
 * the now-stale persisted keys. The orphan panels themselves
 * (panels/ExplorerPanel + panels/TodoPanel + hooks/use-project-index) are
 * deleted this run too — also zero importers.
 */

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ProjectChatState {
  /** Expanded folder paths (root-relative, matching TreeNode.path). */
  expandedFolders: string[];
  /** Currently selected file path (root-relative, matching TreeNode.path). */
  selectedFileId: string | null;
  /** Agent used for NEW sessions in the project chat (null = first available). */
  selectedAgentId: string | null;
  /** Per-project local to-do lists (no backend task events yet — Phase 3). */
  todos: Record<string, TodoItem[]>;
  /** R60-C (owner): GLOBAL app-sidebar visibility — one control for every
   * route (chat routes included; the round-15/round-32 chat-route scoping is
   * gone). true = the left panel renders everywhere; false = the whole panel
   * is absent and the main content takes the full width (on chat routes that
   * is the extra chat width). Flipped by the TITLE BAR's identity control in
   * Tauri, the floating Acute logo in browser dev mode. Transient — never
   * persisted. */
  appSidebarVisible: boolean;
  /** ROUND-62 (owner: "i should be given the option to minimize it rather
   * than just hiding it completely — at the very top of the left sidebar"):
   * when true the sidebar renders its ICON RAIL (R100-F: ~48px, the
   * activity-bar standard — navigation icons, project tiles, settings/bell)
   * instead of the full panel. The FULL hide
   * (appSidebarVisible, title-bar identity control) stays orthogonal — hide
   * > minimize in precedence. PERSISTED (a layout preference like the panel
   * widths — the owner expects his rail to still be a rail after a
   * restart). */
  appSidebarMinimized: boolean;
  /** ROUND-38 (owner: sessions/files/agent mixing across projects): the
   * active project's scoped UI state (selectedFileId, selectedAgentId,
   * expandedFolders) is snapshotted into byProject on switch and restored
   * when you come back, so opening file X in project A never re-opens it
   * in project B. The flat fields stay as the "current" values consumers
   * read; this map is the per-project cache. */
  activeProjectId: string | null;
  byProject: Record<string, {
    selectedFileId: string | null;
    selectedAgentId: string | null;
    expandedFolders: string[];
  }>;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  setSelectedAgentId: (id: string | null) => void;
  addTodo: (projectId: string, text: string) => void;
  toggleTodo: (projectId: string, todoId: string) => void;
  setAppSidebarVisible: (visible: boolean) => void;
  /** ROUND-62: flips the icon-rail minimize state (persisted). */
  setAppSidebarMinimized: (minimized: boolean) => void;
  /** ROUND-38: snapshot the current project's scoped state + restore the
   * incoming project's (or defaults). Called from AgentChatPanel on
   * projectId change. No-op when the id is unchanged. */
  setActiveProject: (id: string) => void;
}

const toggleMember = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export const useProjectChatStore = create<ProjectChatState>()(
  persist(
    (set) => ({
      expandedFolders: [],
      selectedFileId: null,
      selectedAgentId: null,
      todos: {},
      // R60-C: defaults TRUE — the sidebar is visible on EVERY route (the
      // owner's title-bar identity click is the one and only control that
      // hides it; the old chat-route auto-hide is gone).
      appSidebarVisible: true,
      appSidebarMinimized: false,
      // ROUND-38: per-project scoped-state cache (activeProjectId + the
      // snapshot map). Empty until AgentChatPanel calls setActiveProject.
      activeProjectId: null,
      byProject: {},
      toggleFolder: (path) => set((s) => ({ expandedFolders: toggleMember(s.expandedFolders, path) })),
      selectFile: (path) => set({ selectedFileId: path }),
      setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
      addTodo: (projectId, text) =>
        set((s) => ({
          todos: {
            ...s.todos,
            [projectId]: [
              ...(s.todos[projectId] ?? []),
              { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, done: false },
            ],
          },
        })),
      toggleTodo: (projectId, todoId) =>
        set((s) => ({
          todos: {
            ...s.todos,
            [projectId]: (s.todos[projectId] ?? []).map((t) =>
              t.id === todoId ? { ...t, done: !t.done } : t,
            ),
          },
        })),
      setAppSidebarVisible: (appSidebarVisible) => set({ appSidebarVisible }),
      setAppSidebarMinimized: (appSidebarMinimized) => set({ appSidebarMinimized }),
      setActiveProject: (id) => set((s) => {
        // ROUND-38: no-op when the active project is unchanged (avoids
        // wiping state on every AgentChatPanel render).
        if (s.activeProjectId === id) return s;
        // Snapshot the outgoing project's scoped state.
        const prev = s.activeProjectId;
        const snapshot = {
          selectedFileId: s.selectedFileId,
          selectedAgentId: s.selectedAgentId,
          expandedFolders: s.expandedFolders,
        };
        const byProject = { ...s.byProject };
        if (prev !== null) byProject[prev] = snapshot;
        // Restore the incoming project's cached state (or defaults).
        const restored = byProject[id] ?? {
          selectedFileId: null as string | null,
          selectedAgentId: null as string | null,
          expandedFolders: [] as string[],
        };
        return {
          activeProjectId: id,
          byProject,
          selectedFileId: restored.selectedFileId,
          selectedAgentId: restored.selectedAgentId,
          expandedFolders: restored.expandedFolders,
        };
      }),
    }),
    {
      name: "acute-code.projectChat",
      version: 2,
      // Transient UI state must not survive reloads.
      partialize: (s) => {
        const { appSidebarVisible: _appSidebarVisible, ...rest } = s;
        return rest as ProjectChatState;
      },
    },
  ),
);
