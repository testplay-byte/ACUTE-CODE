import { useQuery } from "@tanstack/react-query";
import { fetchProjectDemos } from "../lib/api";

/** Round-28 WS-I: list demos (HTML files under <project>/demos/) for the
 * DemoViewerScreen. */
export function useProjectDemos(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["project-demos", projectId],
    queryFn: () => (projectId ? fetchProjectDemos(projectId) : []),
    enabled: projectId !== null && projectId !== undefined,
    staleTime: 10_000,
  });
}
