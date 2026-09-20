/**
 * Providers — the configured-first inventory (R114-f rework): "Your
 * providers" (the SERVER's `configured` bit — custom row OR any held key,
 * pool-aware) as full rows (name, kind badge, the honest key-count chip,
 * enabled state) pushing to the detail page; "Add a provider" COLLAPSED
 * behind ONE prominent half-width action (R115-O — the owner: "by default
 * shows all options — instead ONE option to click then the others
 * appear"): tapping it reveals the unconfigured seeded presets as compact
 * add-rows + the CUSTOM PROVIDER row (the house 30ms stagger ≈ the ~200ms
 * reveal) — tapping it again collapses. The custom row opens the create
 * sheet (name + base URL + api format + the first key); server validation
 * surfaces inline exactly like the New Project sheet. Live: the settings
 * epoch reloads the tiers while the screen is open (another device's key
 * save flips a row's tier the moment the server does).
 *
 * R113-e — the events-bus live reload; R114-f — the phone OWNS its
 * inventory (create included), the tiers re-derived off the fresh rows;
 * R115-O — the add-list collapse + the row polish (one meta line per
 * row, the two-line discipline).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { ChevronRight, KeyRound, Plus } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  Chip,
  ChromeButton,
  ClayInput,
  PressableCard,
  SectionHeader,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, spacing, TOUCH_TARGET } from "@/design/tokens";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import {
  createCustomProvider,
  customProviderBody,
  fetchProviders,
  setProviderKey,
  splitProviders,
  type ProviderApiFormat,
  type ProviderRow,
} from "@/features/config";
import { useEventsEpoch } from "@/features/events";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** The custom-create sheet's api-format options — the POST route's exact
 * enum (anything else falls back to chat-completions server-side). */
const API_FORMATS: ReadonlyArray<{ id: ProviderApiFormat; label: string }> = [
  { id: "chat-completions", label: "Chat completions" },
  { id: "anthropic-messages", label: "Anthropic messages" },
  { id: "responses", label: "Responses" },
];

export default function ProvidersScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [customSheetOpen, setCustomSheetOpen] = useState(false);
  // R115-O: the add-list reveal — collapsed by default (ONE prominent
  // action instead of the always-on preset wall); toggling re-mounts the
  // rows so the stagger entrance replays on every reveal.
  const [addOpen, setAddOpen] = useState(false);

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
          caption="add one below — a preset with a key, or your own endpoint."
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

          {/* ── GROUP 2 — "Add a provider" COLLAPSED behind ONE prominent
              half-width action (R115-O): the presets + the custom row
              reveal below it on the house stagger (~200ms for the preset
              wall); tapping the action again collapses. The custom row
              stays reachable even with every preset configured — the owner
              can always add another endpoint. Tapping a preset pushes to
              its page — the key pool there is where the key lands (the
              desktop's R113-d rule, kept). */}
          <View style={[styles.tierDivider, { borderBottomColor: tokens.borderSubtle }]} />
          <AddProviderAction
            open={addOpen}
            onPress={() => {
              void selectionHaptic();
              setAddOpen((v) => !v);
            }}
          />
          {addOpen ? (
            <>
              {tiers.addable.map((provider, index) => (
                <AddableRowCard key={provider.id} provider={provider} index={index} />
              ))}
              <CustomProviderRow onPress={() => setCustomSheetOpen(true)} index={tiers.addable.length} />
            </>
          ) : null}
        </>
      )}

      <CustomProviderSheet
        open={customSheetOpen}
        onClose={() => setCustomSheetOpen(false)}
        onCreated={() => void load()}
      />
    </ScreenScaffold>
  );
}

// ── the configured row — the full inventory card ────────────────────────────

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
            <Badge tone={provider.keyCount > 0 ? "accent" : "neutral"}>
              {provider.keyCount > 0 ? `${provider.keyCount} key${provider.keyCount === 1 ? "" : "s"}` : "no key"}
            </Badge>
            {provider.enabled ? null : <Badge tone="neutral">off</Badge>}
          </View>
          {/* ONE meta line (the two-line discipline — the archetype's row
              law): the machine truth, the kind riding its tail so the row
              never stacks a third line. */}
          <TypeMono numberOfLines={1} style={styles.rowBaseUrl}>
            {`${provider.baseUrl} · ${provider.kind}`}
          </TypeMono>
        </View>
        <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

// ── the addable preset row — compact, quiet, staggered on reveal ───────────

function AddableRowCard({ provider, index }: { provider: ProviderRow; index: number }) {
  const { tokens } = useTheme();
  const router = useRouter();
  return (
    <PressableCard
      enterIndex={Math.min(index, 12)}
      onPress={() => router.push(`/settings/providers/${encodeURIComponent(provider.id)}`)}
      accessibilityLabel={`Add provider ${provider.name}`}
    >
      <View style={styles.addRowInner}>
        <View style={[styles.addRowIcon, { backgroundColor: tokens.subtleHover }]}>
          <Plus size={16} color={tokens.accent2} strokeWidth={2.2} />
        </View>
        <View style={styles.addRowText}>
          <TypeBodyStrong numberOfLines={1}>{provider.name}</TypeBodyStrong>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            add a key to start using it
          </TypeMicro>
        </View>
        <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

// ── the custom-provider row ─────────────────────────────────────────────────

function CustomProviderRow({ onPress, index }: { onPress: () => void; index: number }) {
  const { tokens } = useTheme();
  return (
    <PressableCard
      enterIndex={Math.min(index, 12)}
      onPress={onPress}
      accessibilityLabel="Add a custom provider"
    >
      <View style={styles.addRowInner}>
        <View style={[styles.addRowIcon, { backgroundColor: tokens.subtleHover }]}>
          <Plus size={16} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.addRowText}>
          <TypeBodyStrong numberOfLines={1}>Custom provider</TypeBodyStrong>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            any OpenAI-compatible endpoint
          </TypeMicro>
        </View>
        <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

// ── the add-provider action — ONE prominent row, half width ─────────────────

/** The section's single resting affordance (the projects list's "New
 *  project" spelling: half width, icon + label, quiet outline — no
 *  description, no chevron). Collapsed it is the ONLY add affordance on
 *  screen; tapping reveals the presets + the custom row below it (the
 *  accordion grammar — children expand under the tapped row); tapping it
 *  again collapses them. */
function AddProviderAction({ open, onPress }: { open: boolean; onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <Pressable
      testID="providers-add-toggle"
      accessibilityRole="button"
      accessibilityLabel="Add a provider"
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.addAction,
        {
          borderColor: pressed ? tokens.borderStrong : tokens.border,
          backgroundColor: pressed ? tokens.subtle : "transparent",
        },
      ]}
    >
      <Plus size={20} color={tokens.accent} strokeWidth={2.2} />
      <TypeBodyStrong style={{ color: tokens.textSecondary }}>Add a provider</TypeBodyStrong>
    </Pressable>
  );
}

// ── the custom-create sheet ─────────────────────────────────────────────────

function CustomProviderSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The list reload after a successful create (the row appears in "Your providers"). */
  onCreated: () => void;
}) {
  const { tokens } = useTheme();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiFormat, setApiFormat] = useState<ProviderApiFormat>("chat-completions");
  const [firstKey, setFirstKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The provider EXISTS (the POST answered ok) but the sheet stayed open —
  // the key save failed. Re-creating would 409 on the name; the only honest
  // action left is Done (close + reload; the key lands from its page).
  const [created, setCreated] = useState(false);

  // Every open resets the form + the stale error (the previous attempt's
  // 409 must not haunt the next one).
  useEffect(() => {
    if (!open) return;
    setName("");
    setBaseUrl("");
    setApiFormat("chat-completions");
    setFirstKey("");
    setError(null);
    setCreated(false);
  }, [open]);

  const finish = useCallback(() => {
    onClose();
    onCreated();
  }, [onClose, onCreated]);

  const onCreate = useCallback(async () => {
    if (busy || created) return;
    const body = customProviderBody(name, baseUrl, apiFormat);
    if (body === null) {
      setError("a name and a base URL are both required");
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await createCustomProvider(getLinkManager(), body);
      if (outcome.ok) {
        mobLog("config", "custom provider created", {
          id: outcome.data.id,
          adopted: outcome.data.adopted === true,
        });
        // The first key does NOT ride the create — the primary key route
        // owns it. A key save failure never loses the provider: the row
        // exists on the server, the sheet says so honestly, Done hands
        // over to the list.
        const key = firstKey.trim();
        if (key === "") {
          void successHaptic();
          finish();
          return;
        }
        const keyOutcome = await setProviderKey(getLinkManager(), outcome.data.id, key);
        if (keyOutcome.ok) {
          mobLog("config", "custom provider key set", { id: outcome.data.id });
          void successHaptic();
          finish();
          return;
        }
        mobWarn("config", "custom provider key save failed", {
          id: outcome.data.id,
          status: keyOutcome.error.status,
          message: keyOutcome.error.message,
        });
        void warningHaptic();
        setCreated(true);
        setError(
          `the provider was created, but its key did not save — ${keyOutcome.error.message}. Add it from the provider's page.`,
        );
      } else {
        mobWarn("config", "custom provider create failed", {
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        // The route names the field (name in use / bad URL) — inline, honestly.
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "custom provider create threw");
      void warningHaptic();
      setError("the host is offline — the provider was not created");
    } finally {
      setBusy(false);
    }
  }, [busy, created, name, baseUrl, apiFormat, firstKey, finish]);

  return (
    <Sheet open={open} onClose={onClose} title="Custom provider" testID="custom-provider-sheet">
      <View style={styles.fieldGap}>
        <ClayInput
          label="Name"
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Provider name"
          caption="unique across your providers — the server refuses a duplicate"
        />
        <ClayInput
          label="Base URL"
          mono
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          accessibilityLabel="Provider base URL"
          caption="the http(s) endpoint the desktop calls"
        />
        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>API format</TypeCaption>
          <View style={styles.formatRow}>
            {API_FORMATS.map((format) => (
              <Chip
                key={format.id}
                selected={apiFormat === format.id}
                onPress={() => setApiFormat(format.id)}
                testID={`api-format-${format.id}`}
              >
                {format.label}
              </Chip>
            ))}
          </View>
        </View>
        <ClayInput
          label="First API key (optional)"
          mono
          value={firstKey}
          onChangeText={setFirstKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="First API key"
          caption="write-only from this phone — it lands in the desktop's keyring and is never shown back"
        />
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={4}>
            {error}
          </TypeCaption>
        ) : null}
        {created ? (
          // The provider exists — creating again would 409 on the name.
          <ChromeButton onPress={finish} accessibilityLabel="Done — close the sheet">
            Done — add its key from the page
          </ChromeButton>
        ) : (
          <ChromeButton
            onPress={() => void onCreate()}
            disabled={busy}
            accessibilityLabel={busy ? "Creating the provider" : "Create the provider"}
          >
            {busy ? "creating…" : "Create provider"}
          </ChromeButton>
        )}
      </View>
    </Sheet>
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
  addRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 56,
  },
  addRowIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  addRowText: { flex: 1, gap: 2 },
  tierEmpty: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  tierDivider: { borderBottomWidth: StyleSheet.hairlineWidth, marginVertical: spacing.md },
  addAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    width: "48%",
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    minHeight: TOUCH_TARGET + 2,
    paddingHorizontal: spacing.lg,
  },
  fieldGap: { gap: spacing.md },
  fieldWrap: { gap: spacing.xs },
  fieldLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  formatRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
