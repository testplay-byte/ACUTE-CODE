import { keepPreviousData, useQuery, useQueries } from "@tanstack/react-query";
import {
  fetchDetailedUsage,
  fetchKeyPool,
  fetchProviders,
  fetchUsageStats,
  type KeyPoolSlot,
  type ProviderView,
} from "../lib/api";
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
export function useDetailedUsage(days = 30, granularity: "day" | "hour" = "day") {
  const source = useConfigStore((s) => (s.demoData ? "demo" : "live"));
  return useQuery({
    // R127: the granularity rides the key — a day↔hour switch must never
    // serve the other's buckets from cache. The DAY call keeps its
    // historical single-arg shape (fetchDetailedUsage(days)) so every
    // existing exact-args pin stays true.
    queryKey: ["usage-detailed", source, days, granularity],
    queryFn: () =>
      granularity === "hour" ? fetchDetailedUsage(days, "hour") : fetchDetailedUsage(days),
    enabled: source === "live",
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * ROUND-98 (R98-I2, owner: "Data & statistics"): the windowed stats surface
 * (GET /usage/stats) behind the shared DataStatsPanel — rendered in BOTH the
 * settings "Data & Statistics" tab AND the /usage screen. Same patterns as
 * useDetailedUsage: live sidecar only (idle in demo mode), one-minute
 * staleTime, keepPreviousData so a months-picker switch (6/12/24) never
 * flashes the skeleton between windows. The key carries ONLY the months
 * value — the panel owns the picker state.
 */
export function useUsageStats(months = 12) {
  const source = useConfigStore((s) => (s.demoData ? "demo" : "live"));
  return useQuery({
    queryKey: ["usage-stats", months],
    queryFn: () => fetchUsageStats(months),
    enabled: source === "live",
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * ROUND-64 (R64-e, owner: per-API-key usage stats): the /usage screen's
 * "API keys" section needs the providers list + each provider's masked
 * key-pool info (GET /providers/:id/keys) to join against the detailed
 * usage's `keys` rollup — that join renders every configured key (zeros +
 * "not used yet" when unused) and honestly flags usage on slots the
 * keyring no longer holds ("removed key"). Dashboard semantics like
 * useDetailedUsage: live sidecar only (idle in demo mode), one refetch on
 * mount suffices (no live updates); SAME query keys as
 * ModelsProvidersTab's providers list / KeyPoolSection pools so the shared
 * react-query cache dedupes them. Fails soft — a failed fetch never claims
 * a removal, it just omits that provider's masked preview.
 */
export function useUsageKeyPools(): {
  providers: ProviderView[];
  poolsById: Map<string, KeyPoolSlot[]>;
  /** Provider ids whose pool query SUCCEEDED — gates the "removed key"
   * flag so an in-flight OR FAILED pool never reads as a removal. */
  settledPoolIds: Set<string>;
  /** True once the providers list settles — gates "removed provider". */
  providersSettled: boolean;
  /** Any query still in flight (section hides while true and card-less). */
  isPending: boolean;
} {
  const source = useConfigStore((s) => (s.demoData ? "demo" : "live"));
  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: () => fetchProviders(),
    enabled: source === "live",
    staleTime: 60_000,
    retry: false,
  });
  const providers = providersQuery.data ?? [];
  const poolQueries = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ["key-pool", provider.id],
      queryFn: () => fetchKeyPool(provider.id),
      enabled: source === "live",
      staleTime: 60_000,
      retry: false,
    })),
  });
  const poolsById = new Map<string, KeyPoolSlot[]>();
  const settledPoolIds = new Set<string>();
  providers.forEach((provider, index) => {
    const data = poolQueries[index]?.data;
    if (data !== undefined) {
      poolsById.set(provider.id, data);
      settledPoolIds.add(provider.id);
    }
  });
  return {
    providers,
    poolsById,
    settledPoolIds,
    providersSettled: !providersQuery.isPending,
    isPending: providersQuery.isPending || poolQueries.some((query) => query.isPending),
  };
}
