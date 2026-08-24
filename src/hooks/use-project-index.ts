import { useQuery } from "@tanstack/react-query";
import { fetchProjectIndex } from "../lib/api";

/**
 * Round-28 WS-G2: fetch the codebase index summary for a project.
 * Used by the CodebasePanel. Returns null when the project hasn't been
 * indexed yet (the agent calls index_project on the first turn).
 */
export function useProjectIndex(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["project-index", projectId],
    queryFn: () => {
      if (!projectId) return null;
      return fetchProjectIndex(projectId);
    },
    enabled: projectId !== null && projectId !== undefined,
    staleTime: 30_000, // index is stable until reindex; don't refetch constantly
  });
}
