import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Slim UI state for the project-chat screen (M3). Ported from the demo's
 * lib/project-chat-store.ts but WITHOUT any mock data: messages, files and
 * code now come from react-query (use-projects.ts / use-sessions.ts); this
 * store only owns local layout/selection preferences, persisted so panel
 * widths, expanded folders and the selected file survive reloads.
 *
 * collapsedPanels/expandedFolders are persisted as plain arrays (the demo
 * used Sets, which do not serialize).
 */

/** Panel resize bounds, mirrored from the demo's ProjectChatView. */
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 400;
export const MIN_CHAT_WIDTH = 320;
export const MAX_CHAT_WIDTH = 800;

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
    }),
    // Functions are dropped by JSON.stringify; every persisted field is data.
    { name: "acute-code.projectChat", version: 1 },
  ),
);
