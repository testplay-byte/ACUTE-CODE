/**
 * Providers — the two-tier list (R113-e, mirroring the desktop's R113-d
 * structure): "Your providers" (the SERVER's `configured` bit — R113-a:
 * custom row OR any held key, pool-aware) first, the addable catalog below a
 * divider. Every row (name, base URL in mono, the enabled badge, the honest
 * key line — "key set · 2 pooled" / "no key yet") pushes to the SAME editor:
 * that is where a key lands, configured or not. Nothing configured yet → the
 * honest empty line above the catalog (never a fake "no providers" when the
 * presets exist). Unpaired/offline → the honest gate; pull-to-refresh rides
 * the same load.
 *
 * R113-e — LIVE: every settings PUT broadcasts on the events bus, so a
 * provider key saved on the PC (or another phone) lands here while the
 * screen is open — the events store's settings epoch moves → this screen
 * reloads (the row jumps tiers the moment the server flips its bit).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { ChevronRight, KeyRound } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  PressableCard,
  SectionHeader,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { fetchProviders, splitProviders, type ProviderRow } from "@/features/config";
import { useEventsEpoch } from "@/features/events";
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

  // R113-e: the live settings epoch — a settings frame (another device's
  // key save / toggle, or the hello resync) moves it while this screen is
  // open; the tiers re-derive off the fresh rows.
  const settingsEpoch = useEventsEpoch("settings");
  // The MOUNT value — the refetch fires only when the epoch moves PAST it
  // (the mount load above owns the first fetch).
  const mountEpoch = useRef(settingsEpoch);

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

  // R113-e: the live refetch — the settings world changed AFTER this screen
  // mounted (a key landed on the PC, a reconnect's hello).
  useEffect(() => {
    if (settingsEpoch === mountEpoch.current) return;
    if (connected) void load();
  }, [settingsEpoch, connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // The two tiers (pure derivation, unit-tested in __tests__/config.test.ts):
  // the server's configured bit owns the split — a pool-only provider the old
  // hasKey read would miss sits in "Your providers" where it belongs.
  const tiers = splitProviders(providers ?? []);

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
        <>
          {/* ── GROUP 1 — "Your providers" (the server's configured bit). */}
          <SectionHeader>Your providers</SectionHeader>
          {tiers.configured.length === 0 ? (
            // The honest empty line — the presets below are a catalog, not
            // an inventory; never pretend "no providers" when they exist.
            <TypeCaption style={[styles.tierEmpty, { color: tokens.textTertiary }]}>
              none configured yet — add a key to your first provider below.
            </TypeCaption>
          ) : (
            tiers.configured.map((provider, index) => (
              <ProviderRowCard key={provider.id} provider={provider} index={index} />
            ))
          )}

          {/* ── GROUP 2 — "Add a provider": the unconfigured presets under a
              divider. Still selectable — the editor is where the key lands
              (the desktop's R113-d rule: the catalog stays visible). */}
          {tiers.addable.length > 0 ? (
            <>
              <View style={[styles.tierDivider, { borderBottomColor: tokens.borderSubtle }]} />
              <SectionHeader>Add a provider</SectionHeader>
              {tiers.addable.map((provider, index) => (
                <ProviderRowCard key={provider.id} provider={provider} index={index} />
              ))}
            </>
          ) : null}
        </>
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
  tierEmpty: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  tierDivider: { borderBottomWidth: StyleSheet.hairlineWidth, marginVertical: spacing.md },
});
