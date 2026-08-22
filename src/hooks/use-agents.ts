import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AgentPatch, type AgentDraft, getAgentsBackend } from "../lib/api";
import { useConfigStore } from "../lib/config-store";

/**
 * Agent-registry data hooks. Every key embeds demoData so flipping the
 * data-source toggle refetches from the correct backend (fixture vs HTTP).
 */
function useDataSource() {
  return useConfigStore((s) => s.demoData) ? "demo" : "live";
}

export function useAgents(includeTemplates: boolean) {
  const source = useDataSource();
  return useQuery({
    queryKey: ["agents", source, includeTemplates],
    queryFn: () => getAgentsBackend().list(includeTemplates),
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: (draft: AgentDraft) => getAgentsBackend().create(draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", source] }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AgentPatch }) =>
      getAgentsBackend().update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", source] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: (id: string) => getAgentsBackend().remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", source] }),
  });
}

export function useDuplicateAgent() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      getAgentsBackend().duplicate(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", source] }),
  });
}
