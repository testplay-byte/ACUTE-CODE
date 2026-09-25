import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectsBackend } from "../lib/api";
import { useConfigStore } from "../lib/config-store";

/**
 * Project/workspace data hooks (M3 project-chat screen). Keys embed the data
 * source (demo|live) exactly like use-sessions.ts so flipping the toggle
 * refetches from the correct backend.
 */
function useDataSource() {
  return useConfigStore((s) => s.demoData) ? "demo" : "live";
}

export function useProjects() {
  const source = useDataSource();
  return useQuery({
    queryKey: ["projects", source],
    queryFn: () => getProjectsBackend().list(),
  });
}

export function useProjectTree(projectId: string | null) {
  const source = useDataSource();
  return useQuery({
    queryKey: ["project-tree", source, projectId],
    queryFn: () => {
      if (projectId === null) throw new Error("useProjectTree requires a project id");
      return getProjectsBackend().tree(projectId);
    },
    enabled: projectId !== null,
  });
}

export function useProjectFile(projectId: string | null, path: string | null) {
  const source = useDataSource();
  return useQuery({
    queryKey: ["project-file", source, projectId, path],
    queryFn: () => {
      if (projectId === null || path === null) {
        throw new Error("useProjectFile requires a project id and a path");
      }
      return getProjectsBackend().file(projectId, path);
    },
    enabled: projectId !== null && path !== null,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: ({ name, rootPath, color }: { name: string; rootPath: string; color?: string }) =>
      getProjectsBackend().create(name, rootPath, color),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", source] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: (id: string) => getProjectsBackend().remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects", source] });
      // R128-W3 (SCREENS §2 law #8's frontend half): the backend delete now
      // CASCADES the project's sessions (session_events / usage_events /
      // approvals / file_snapshots / sessions, one transaction) — the
      // sessions LIST cache must converge with it or the deleted project's
      // sessions ghost in every cross-project consumer (recent activity,
      // the ⌘K session search) until an unrelated refetch. The per-session
      // detail queries for the deleted ids are left to age out (their rows
      // render nowhere — the project's route is gone with the row).
      void qc.invalidateQueries({ queryKey: ["sessions", source] });
    },
  });
}
