import { useMemo } from "react";
import { useProjectTree } from "../../../hooks/use-projects";
import { flattenTreeFiles } from "./composer-utils";

/**
 * ROUND-50 (R50-c2): the flattened FILE-path list of the active project —
 * the SHARED data source for the composer's Add Context → "Add project
 * files…" picker AND the @ quick-picker (owner: same list both places).
 * Rides the existing useProjectTree query (["project-tree", source,
 * projectId]) so the explorer, the palette and the composer agree.
 */
export function useProjectFilePaths(
  projectId: string,
): { files: string[]; isLoading: boolean } {
  const treeQuery = useProjectTree(projectId);
  const files = useMemo(
    () => (treeQuery.data ? flattenTreeFiles(treeQuery.data.tree) : []),
    [treeQuery.data],
  );
  return { files, isLoading: treeQuery.isLoading };
}
