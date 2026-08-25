import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { useSessions } from "./use-sessions";

/**
 * ROUND-38: resolves the AUTHORITATIVE active session id for a project the
 * same way AgentChatPanel does (?session= URL param → that session if it
 * belongs to this project, else the project's most-recently-updated session).
 * Used by the right sidebar's Sub-agents tab (which needs the parent session
 * id to list its child sub-agents) without duplicating the resolution logic.
 *
 * Returns null when the project has no sessions yet (or projectId is null).
 */
export function useActiveSessionId(projectId: string | null): string | null {
  const [searchParams] = useSearchParams();
  const sessionIdParam = searchParams.get("session");
  const sessions = useSessions().data ?? [];
  const projectSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, projectId],
  );
  return useMemo(() => {
    if (projectId === null) return null;
    if (sessionIdParam !== null) {
      const fromParam = projectSessions.find((s) => s.id === sessionIdParam);
      if (fromParam !== undefined) return fromParam.id;
    }
    return projectSessions[0]?.id ?? null;
  }, [projectSessions, sessionIdParam, projectId]);
}
