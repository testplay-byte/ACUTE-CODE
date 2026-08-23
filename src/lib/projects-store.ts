import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Local project registry (owner round-8: the sidebar's PROJECTS section).
 *
 * Projects are LOCAL-FIRST state for now: name + folder path + a stable
 * color, persisted in localStorage. The orchestration phase (SPEC F3) links
 * projects to backend sessions/workspace data; until then selecting a
 * project opens the project view with an honest "chat integration arrives
 * with orchestration" state. No secrets, nothing synced.
 */

export interface Project {
  id: string;
  name: string;
  /** Workspace folder path (informational until the workspace engine lands). */
  path: string;
  /** Sidebar chip color, assigned round-robin from PROJECT_COLORS. */
  color: string;
  createdAt: string;
}

export const PROJECT_COLORS = [
  "#FF6B2C",
  "#6366F1",
  "#D6FF57",
  "#FF7A3D",
  "#5A8CFF",
  "#7A5CFA",
  "#27C93F",
  "#A0A0A0",
] as const;

interface ProjectsState {
  projects: Project[];
  selectedProjectId: string | null;
  addProject: (name: string, path: string) => Project;
  deleteProject: (id: string) => void;
  selectProject: (id: string | null) => void;
}

function nextColor(projects: Project[]): string {
  return PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
}

export const useProjectsStore = create<ProjectsState>()(
  persist(
    (set, get) => ({
      projects: [],
      selectedProjectId: null,
      addProject: (name, path) => {
        const project: Project = {
          id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          path,
          color: nextColor(get().projects),
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ projects: [...s.projects, project] }));
        return project;
      },
      deleteProject: (id) =>
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
        })),
      selectProject: (id) => set({ selectedProjectId: id }),
    }),
    { name: "acute-code.projects", version: 1 },
  ),
);
