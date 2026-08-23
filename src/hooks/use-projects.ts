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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects", source] }),
  });
}
