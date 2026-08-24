import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CreateSessionInput,
  fetchUsageSummary,
  getSessionsBackend,
} from "../lib/api";
import { useConfigStore } from "../lib/config-store";

/**
 * Session/chat data hooks. Keys embed the data source (demo|live) exactly like
 * use-agents.ts so flipping the toggle refetches from the correct backend.
 */
function useDataSource() {
  return useConfigStore((s) => s.demoData) ? "demo" : "live";
}

export function useSessions() {
  const source = useDataSource();
  return useQuery({
    queryKey: ["sessions", source],
    queryFn: () => getSessionsBackend().list(),
  });
}

export function useSession(id: string | null) {
  const source = useDataSource();
  return useQuery({
    queryKey: ["session", source, id],
    queryFn: () => {
      if (id === null) throw new Error("useSession requires an id");
      return getSessionsBackend().get(id);
    },
    enabled: id !== null,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: (input: CreateSessionInput) => getSessionsBackend().create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions", source] }),
  });
}

/**
 * DELETE /sessions/:id (round-30, owner request). Invalidates the session
 * LIST on success; the detail query for the deleted id is removed outright so
 * a stale cache entry can't keep rendering the deleted conversation.
 */
export function useDeleteSession() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: (id: string) => getSessionsBackend().remove(id),
    onSuccess: (_result, id) => {
      void qc.removeQueries({ queryKey: ["session", source, id] });
      void qc.invalidateQueries({ queryKey: ["sessions", source] });
    },
  });
}

/**
 * One synchronous chat turn. Invalidates the session detail (event log) and
 * the list (updatedAt / status changes) on success AND failure — a failed
 * provider call still leaves the turn's user event in the log (ADR-0010).
 * Errors surface as ApiError envelopes (409 CONFLICT unconfigured agent,
 * 502 PROVIDER_ERROR upstream failure).
 */
export function useSendMessage() {
  const qc = useQueryClient();
  const source = useDataSource();
  return useMutation({
    mutationFn: ({ sessionId, content }: { sessionId: string; content: string }) =>
      getSessionsBackend().sendMessage(sessionId, content),
    onSettled: (_result, _error, { sessionId }) => {
      void qc.invalidateQueries({ queryKey: ["session", source, sessionId] });
      void qc.invalidateQueries({ queryKey: ["sessions", source] });
    },
  });
}

/**
 * Per-day usage totals for the dashboard chart (GET /usage/summary). The
 * fixture backend has no usage log, so the query only runs against the live
 * sidecar — in demo mode it stays idle and callers render zero/empty states.
 */
export function useUsageSummary(days = 14) {
  const source = useDataSource();
  return useQuery({
    queryKey: ["usage-summary", source, days],
    queryFn: () => fetchUsageSummary(days),
    enabled: source === "live",
    staleTime: 60_000,
  });
}
