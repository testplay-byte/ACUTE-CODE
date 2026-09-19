/**
 * Providers — the list: every provider row (name, base URL in mono, the
 * enabled badge, the honest key line — "key set · 2 pooled" / "no key yet")
 * pushes to the editor. Unpaired/offline → the honest gate; empty → the
 * honest empty state; pull-to-refresh rides the same load.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  PressableCard,
  TypeBodyStrong,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { fetchProviders, type ProviderRow } from "@/features/config";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

export default function ProvidersScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!connected) return;
    try {
      const outcome = await fetchProviders(getLinkManager());
      if (outcome.ok) {
        setProviders(outcome.data.providers);
        setLoadError(null);
        mobLog("config", "providers loaded", { count: outcome.data.providers.length });
      } else {
        setLoadError(outcome.error.message);
        mobWarn("config", "providers load failed", {
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "providers load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connected]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScreenScaffold
      title="Providers"
      back
      subtitle="models & API keys"
      refreshControl={
        connected ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.card}
          />
        ) : undefined
      }
    >
      {!connected ? (
        <HostGate status={status} />
      ) : providers === null ? (
        loadError !== null ? (
          <ErrorState title="could not load providers" caption={loadError} retryLabel="try again" onRetry={() => void load()} />
        ) : (
          <LoadingState caption="loading providers…" />
        )
      ) : providers.length === 0 ? (
        <EmptyState
          title="no providers yet"
          caption="add one on the desktop — it appears here the moment it exists."
        />
      ) : (
        providers.map((provider, index) => (
          <ProviderRowCard key={provider.id} provider={provider} index={index} />
        ))
      )}
    </ScreenScaffold>
  );
}

function ProviderRowCard({ provider, index }: { provider: ProviderRow; index: number }) {
  const { tokens } = useTheme();
  const router = useRouter();
  return (
    <PressableCard
      enterIndex={Math.min(index, 12)}
      onPress={() => router.push(`/settings/providers/${encodeURIComponent(provider.id)}`)}
      accessibilityLabel={`Provider ${provider.name}`}
    >
      <View style={styles.rowInner}>
        <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
          <KeyRound size={20} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <TypeBodyStrong numberOfLines={1} style={styles.rowTitle}>
              {provider.name}
            </TypeBodyStrong>
            <Badge tone={provider.enabled ? "success" : "neutral"}>
              {provider.enabled ? "enabled" : "off"}
            </Badge>
          </View>
          <TypeMono numberOfLines={1} style={styles.rowBaseUrl}>
            {provider.baseUrl}
          </TypeMono>
          <TypeMicro>
            {provider.hasKey
              ? provider.keyCount > 1
                ? `key set · ${provider.keyCount} pooled`
                : "key set"
              : "no key yet"}
          </TypeMicro>
        </View>
        <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

/** The honest not-connected gate (shared spelling across the settings pages). */
function HostGate({ status }: { status: "unpaired" | "probing" | "offline" }) {
  const router = useRouter();
  const unpaired = status === "unpaired";
  return (
    <ErrorState
      title={unpaired ? "no host linked" : "host offline"}
      caption={
        unpaired
          ? "providers and keys live on the desktop — pair one to manage them from here."
          : "the list reloads the moment the link returns — nothing is lost."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 72,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowTitle: { flex: 1 },
  rowBaseUrl: { fontSize: 11, lineHeight: 15 },
});
