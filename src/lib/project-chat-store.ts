import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * UI state for the project-chat screen (M3 + round-14 demo-parity). Ported
 * from the demo's lib/project-chat-store.ts but WITHOUT mock data: messages,
 * files and code come from react-query (use-projects.ts / use-sessions.ts);
 * this store owns local layout/selection preferences, persisted so panel
 * widths, expanded folders, the selected file, the chosen agent and the
 * freeform layout survive reloads.
 *
 * collapsedPanels/expandedFolders are persisted as plain arrays (the demo
 * used Sets, which do not serialize). appSidebarVisible is transient (excluded
 * via partialize).
 */

/** Panel resize bounds, mirrored from the demo's ProjectChatView. */
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 400;
export const MIN_CHAT_WIDTH = 320;
export const MAX_CHAT_WIDTH = 800;

/** Freeform (experimental) layout panel descriptor — demo port. */
export interface FreeformPanel {
  id: "sidebar" | "code" | "chat" | "todo";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
}

export const DEFAULT_FREEFORM_PANELS: FreeformPanel[] = [
  { id: "sidebar", title: "Explorer", x: 24, y: 24, width: 260, height: 520, zIndex: 1, minimized: false },
  { id: "code", title: "Code", x: 304, y: 24, width: 520, height: 520, zIndex: 2, minimized: false },
  { id: "chat", title: "Chat", x: 832, y: 24, width: 440, height: 640, zIndex: 3, minimized: false },
  { id: "todo", title: "To-Do", x: 304, y: 560, width: 300, height: 200, zIndex: 4, minimized: false },
];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ProjectChatState {
  /** Explorer (left) panel visibility. */
  sidebarOpen: boolean;
  /** Code (center) panel visibility. */
  codeVisible: boolean;
  sidebarWidth: number;
  chatWidth: number;
  /** Collapsed sidebar section ids (e.g. "explorer"). */
  collapsedPanels: string[];
  /** Expanded folder paths (root-relative, matching TreeNode.path). */
  expandedFolders: string[];
  /** Currently selected file path (root-relative, matching TreeNode.path). */
  selectedFileId: string | null;
  /** Demo-parity (round-14): experimental freeform layout mode + panels. */
  experimentalMode: boolean;
  freeformPanels: FreeformPanel[];
  /** Agent used for NEW sessions in the project chat (null = first available). */
  selectedAgentId: string | null;
  /** Per-project local to-do lists (no backend task events yet — Phase 3). */
  todos: Record<string, TodoItem[]>;
  /** Round-15 (owner): on the chat screen the APP sidebar is HIDDEN; the
   * TopBar hamburger toggles it. Transient — never persisted. */
  appSidebarVisible: boolean;
  setSidebarOpen: (open: boolean) => void;
  setCodeVisible: (visible: boolean) => void;
  /** Clamps to [MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH]. */
  setSidebarWidth: (px: number) => void;
  /** Clamps to [MIN_CHAT_WIDTH, MAX_CHAT_WIDTH]. */
  setChatWidth: (px: number) => void;
  isPanelCollapsed: (id: string) => boolean;
  togglePanel: (id: string) => void;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  setExperimentalMode: (on: boolean) => void;
  updateFreeformPanel: (id: FreeformPanel["id"], patch: Partial<FreeformPanel>) => void;
  bringToFront: (id: FreeformPanel["id"]) => void;
  resetFreeformPanels: () => void;
  setSelectedAgentId: (id: string | null) => void;
  addTodo: (projectId: string, text: string) => void;
  toggleTodo: (projectId: string, todoId: string) => void;
  setAppSidebarVisible: (visible: boolean) => void;
}

const toggleMember = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const useProjectChatStore = create<ProjectChatState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      codeVisible: true,
      sidebarWidth: 250,
      chatWidth: 400,
      collapsedPanels: [],
      expandedFolders: [],
      selectedFileId: null,
      experimentalMode: false,
      freeformPanels: DEFAULT_FREEFORM_PANELS,
      selectedAgentId: null,
      todos: {},
      appSidebarVisible: false,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setCodeVisible: (codeVisible) => set({ codeVisible }),
      setSidebarWidth: (sidebarWidth) =>
        set({ sidebarWidth: clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH) }),
      setChatWidth: (chatWidth) =>
        set({ chatWidth: clamp(chatWidth, MIN_CHAT_WIDTH, MAX_CHAT_WIDTH) }),
      isPanelCollapsed: (id) => get().collapsedPanels.includes(id),
      togglePanel: (id) => set((s) => ({ collapsedPanels: toggleMember(s.collapsedPanels, id) })),
      toggleFolder: (path) => set((s) => ({ expandedFolders: toggleMember(s.expandedFolders, path) })),
      selectFile: (path) => set({ selectedFileId: path }),
      setExperimentalMode: (experimentalMode) => set({ experimentalMode }),
      updateFreeformPanel: (id, patch) =>
        set((s) => ({
          freeformPanels: s.freeformPanels.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      bringToFront: (id) =>
        set((s) => {
          const top = Math.max(...s.freeformPanels.map((p) => p.zIndex));
          const panel = s.freeformPanels.find((p) => p.id === id);
          if (!panel || panel.zIndex === top) return s;
          return {
            freeformPanels: s.freeformPanels.map((p) => (p.id === id ? { ...p, zIndex: top + 1 } : p)),
          };
        }),
      resetFreeformPanels: () => set({ freeformPanels: DEFAULT_FREEFORM_PANELS }),
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
    }),
    {
      name: "acute-code.projectChat",
      version: 1,
      // Transient UI state must not survive reloads.
      partialize: (s) => {
        const { appSidebarVisible: _appSidebarVisible, ...rest } = s;
        return rest as ProjectChatState;
      },
    },
  ),
);
