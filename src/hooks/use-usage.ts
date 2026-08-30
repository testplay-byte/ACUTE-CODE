import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchDetailedUsage } from "../lib/api";
import { useConfigStore } from "../lib/config-store";

/**
 * ROUND-52 (R52-b): whole-history usage analytics for the in-app /usage
 * screen (GET /usage/detailed — projects → sessions drill-down with sub-agent
 * children, tool leaderboard, model mix). Mirrors useUsageSummary's contract:
 * the fixture backend has no usage log, so the query only runs against the
 * live sidecar — in demo mode it stays idle and the screen renders its empty
 * state. `days` scopes only the zero-filled activity series (7/14/30/90 range
 * selector); the rollups are whole-history either way. keepPreviousData keeps
 * the previous window on screen while a range switch refetches (no skeleton
 * flash between 7d/14d/30d/90d).
 */
export function useDetailedUsage(days = 30) {
  const source = useConfigStore((s) => (s.demoData ? "demo" : "live"));
  return useQuery({
    queryKey: ["usage-detailed", source, days],
    queryFn: () => fetchDetailedUsage(days),
    enabled: source === "live",
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
