/**
 * Providers — the configured-first inventory (R114-f rework): "Your
 * providers" (the SERVER's `configured` bit — custom row OR any held key,
 * pool-aware) as full rows pushing to the detail page; "Add a provider"
 * COLLAPSED behind ONE CTA (R115-O — the owner: "by default shows all
 * options — instead ONE option to click then the others appear"): tapping
 * it reveals the unconfigured seeded presets as compact add-rows + the
 * CUSTOM PROVIDER row (the house 30ms stagger ≈ the ~200ms reveal) —
 * tapping it again collapses. The custom row opens the create sheet (name
 * + base URL + api format + the first key); server validation surfaces
 * inline exactly like the New Project sheet. Live: the settings epoch
 * reloads the tiers while the screen is open (another device's key save
 * flips a row's tier the moment the server does).
 *
 * R113-e — the events-bus live reload; R114-f — the phone OWNS its
 * inventory (create included), the tiers re-derived off the fresh rows;
 * R115-O — the add-list collapse + the row polish (one meta line per row,
 * the two-line discipline); R116-j — the owner's verdict #39: the row is a
 * COLORED identity (the provider's name-hash hue — the same palette as
 * model colors, never the neutral key glyph) over the MODELS count (the
 * baseUrl/key-count machine truth is gone — donts #35).
 *
 * R118-E (§2A) — the registry-screen grammar: "Your providers" carries the
 * LARGE tier heading (SectionHeader large — TypeTitle 20/700, the peer of
 * the screen that heads it); the configured rows' names read 15/700 (the
 * inventory is primary — the revealed catalog rows stay 600, suggestion
 * weight); the tier break is the VISIBLE clay divider (Hairline strong,
 * inset md, marginVertical xl — ~65px of total break, a step the 12px
 * intra-group rhythm can never fake); and AddProviderAction (the old
 * full-width outlined row doing a CTA's job) is DELETED — the centered
 * self-sized ChromeButton (minWidth PAGE_CTA_MIN_W, accessibilityExpanded)
 * in ALL THREE states (empty / configured-only / mixed), so the zero-state
 * caption's "add one below" finally points at a real affordance. The sheet
 * rides the R118-A law: no field captions, the API format is the shared
 * SegmentedControl, the CTA centered.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { ChevronRight, Plus, Server } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  ClayInput,
  Hairline,
  PressableCard,
  SectionHeader,
  SegmentedControl,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import {
  fontFamily,
  getContrastText,
  PAGE_CTA_MIN_W,
  RADIUS_CHIP,
  SHEET_CTA_MIN_W,
  spacing,
} from "@/design/tokens";
import { modelColor } from "@/design/model-colors";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import {
  createCustomProvider,
  customProviderBody,
  fetchConfiguredModels,
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

/**
 * The custom-create sheet's api-format options — the POST route's exact
 * enum (anything else falls back to chat-completions server-side). R118-A:
 * the labels are SHORT ("Chat" / "Anthropic" / "Responses" — three on one
 * line at 360dp) and the a11y labels carry the full names.
 */
const API_FORMATS: ReadonlyArray<{
  id: ProviderApiFormat;
  label: string;
  accessibilityLabel: string;
}> = [
  { id: "chat-completions", label: "Chat", accessibilityLabel: "Chat completions" },
  { id: "anthropic-messages", label: "Anthropic", accessibilityLabel: "Anthropic messages" },
  { id: "responses", label: "Responses", accessibilityLabel: "Responses" },
];

export default function ProvidersScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [customSheetOpen, setCustomSheetOpen] = useState(false);
  // R116-j (verdict #39): the per-provider MODELS count — grouped by
  // providerId off ONE fetchConfiguredModels call. null = not loaded yet
  // (the row's meta line renders the honest "—", never a fabricated 0).
  const [modelCounts, setModelCounts] = useState<Map<string, number> | null>(null);
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
      // R116-j: the list + the models counts ride ONE parallel load — the
      // rows' meta line lands with the rows (a failed count call leaves
      // the honest "—", the list itself still lives).
      const [providersOutcome, modelsOutcome] = await Promise.all([
        fetchProviders(getLinkManager()),
        fetchConfiguredModels(getLinkManager()),
      ]);
      if (providersOutcome.ok) {
        setProviders(providersOutcome.data.providers);
        setLoadError(null);
        mobLog("config", "providers loaded", { count: providersOutcome.data.providers.length });
      } else {
        setLoadError(providersOutcome.error.message);
        mobWarn("config", "providers load failed", {
          status: providersOutcome.error.status,
          message: providersOutcome.error.message,
        });
      }
      if (modelsOutcome.ok) {
        const counts = new Map<string, number>();
        for (const model of modelsOutcome.data.models) {
          counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
        }
        setModelCounts(counts);
      } else {
        setModelCounts(null);
        mobWarn("config", "provider model counts failed", {
          status: modelsOutcome.error.status,
          message: modelsOutcome.error.message,
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

  // R118-E (A4): the ONE add affordance, shared by all three states — the
  // centered self-sized CTA (the old AddProviderAction full-width row is
  // deleted). accessibilityExpanded speaks the reveal; the icon dies with
  // the row it lived in.
  const onAddToggle = useCallback(() => {
    void selectionHaptic();
    setAddOpen((v) => !v);
  }, []);

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
      ) : (
        <>
          {providers.length === 0 ? (
            // ── the ZERO state — the CTA below is a real affordance now
            // (R118-E: the old branch's caption pointed at nothing; the
            // centered ChromeButton + its reveal live here too).
            <EmptyState
              title="no providers yet"
              caption="add one below — a preset with a key, or your own endpoint."
            />
          ) : (
            <>
              {/* ── GROUP 1 — "Your providers" (the server's configured bit);
                  R118-E: the LARGE tier heading — the inventory tier reads a
                  ladder step above every other section header. */}
              <SectionHeader large>Your providers</SectionHeader>
              {tiers.configured.length === 0 ? (
                // The honest empty line — the presets below are a catalog,
                // not an inventory; never pretend "no providers" when they
                // exist.
                <TypeCaption style={[styles.tierEmpty, { color: tokens.textTertiary }]} numberOfLines={1}>
                  none configured yet — add a key to your first provider below.
                </TypeCaption>
              ) : (
                tiers.configured.map((provider, index) => (
                  <ProviderRowCard
                    key={provider.id}
                    provider={provider}
                    index={index}
                    modelsCount={modelCounts?.get(provider.id) ?? null}
                  />
                ))
              )}

              {/* ── the TIER BREAK (R118-E A3): the visible clay divider —
                  Hairline strong, inset md, marginVertical xl — ~65px of
                  total break, unmistakable against the 12px row rhythm. */}
              <Hairline strong inset={spacing.md} style={styles.tierBreak} />
            </>
          )}

          {/* ── GROUP 2 — "Add a provider" COLLAPSED behind the ONE CTA
              (R115-O + R116-j + R118-E A4): the presets + the custom row
              reveal below it on the house stagger (~200ms for the preset
              wall); tapping the CTA again collapses. The custom row stays
              reachable even with every preset configured — the owner can
              always add another endpoint. Tapping a preset pushes to its
              page — the key pool there is where the key lands (the
              desktop's R113-d rule, kept). */}
          <ChromeButton
            onPress={onAddToggle}
            accessibilityLabel="Add a provider"
            accessibilityExpanded={addOpen}
            testID="providers-add-toggle"
            style={styles.addCta}
          >
            Add a provider
          </ChromeButton>
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

function ProviderRowCard({
  provider,
  index,
  modelsCount,
}: {
  provider: ProviderRow;
  index: number;
  /** The provider's saved-model count (null = not loaded — the honest "—"). */
  modelsCount: number | null;
}) {
  const { tokens } = useTheme();
  const router = useRouter();
  // R116-j (components.md "Provider identity"): the stable name-hash hue —
  // the same palette as model colors, resolved once per row. The icon ink
  // is the tile's own contrast answer (white on the saturated light hues,
  // near-black on the pastel dark hues) — never a neutral glyph.
  const tileColor = modelColor(provider.name, tokens.isDark);
  return (
    <PressableCard
      enterIndex={Math.min(index, 12)}
      onPress={() => router.push(`/settings/providers/${encodeURIComponent(provider.id)}`)}
      accessibilityLabel={`Provider ${provider.name}`}
    >
      <View style={styles.rowInner}>
        <View style={[styles.rowIcon, { backgroundColor: tileColor }]}>
          <Server size={20} color={getContrastText(tileColor)} strokeWidth={2.2} />
        </View>
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            {/* R118-E A2: the INVENTORY's names read 15/700 — the primary
                tier (the revealed catalog rows below keep 600: the
                inventory is what the owner owns, the catalog is
                suggestion). */}
            <TypeBodyStrong numberOfLines={1} style={styles.rowTitleBold}>
              {provider.name}
            </TypeBodyStrong>
            {provider.enabled ? null : <Badge tone="neutral">off</Badge>}
          </View>
          {/* ONE meta line (the two-line discipline — the archetype's row
              law): the MODELS count, the owner's at-a-glance number. "—"
              while the count call is in flight or failed — never a
              fabricated 0 (donts #35: no baseUrl, no key counts). */}
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {modelsCount === null
              ? "—"
              : `${modelsCount} model${modelsCount === 1 ? "" : "s"}`}
          </TypeMicro>
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
        {/* R118-A: label + input ONLY — the field captions are banned in
            sheets (the route's own validation message surfaces inline when
            there is something to say). */}
        <ClayInput
          label="Name"
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Provider name"
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
        />
        {/* R118-A: the API format is the shared SegmentedControl — three
            choices on ONE line (the wrapping Chip row is gone); the full
            names ride the a11y labels. */}
        <SegmentedControl
          options={API_FORMATS}
          selectedId={apiFormat}
          onSelect={setApiFormat}
          testID="api-format"
        />
        <ClayInput
          label="First API key (optional)"
          mono
          value={firstKey}
          onChangeText={setFirstKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="First API key"
        />
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={4}>
            {error}
          </TypeCaption>
        ) : null}
        {/* R118-A §2.4: the CTA zone — centered, self-sized, minWidth 200;
            the created-state label is the one-word "Done" (the 8-word essay
            died with the full-width idiom). */}
        {created ? (
          // The provider exists — creating again would 409 on the name.
          <ChromeButton onPress={finish} accessibilityLabel="Done — close the sheet" style={styles.sheetCta}>
            Done
          </ChromeButton>
        ) : (
          <ChromeButton
            onPress={() => void onCreate()}
            disabled={busy}
            accessibilityLabel={busy ? "Creating the provider" : "Create the provider"}
            style={styles.sheetCta}
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
    borderRadius: RADIUS_CHIP,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  /** R118-E A2 — the INVENTORY tier's name override: 15/700 (the bold
   *  face over TypeBodyStrong's semibold — same size, same line box). */
  rowTitleBold: { flexShrink: 1, fontFamily: fontFamily.bold },
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
  /** R118-E A3 — the tier break: the strong hairline's own breathing room
   *  (marginVertical xl both sides; the scaffold's 12px gap rides on top —
   *  ~65px of total break). */
  tierBreak: { marginVertical: spacing.xl },
  /** R118-E A4 — the page-level CTA law: centered, self-sized, minWidth
   *  200 (never a full-width row pretending to be a button). */
  addCta: { alignSelf: "center", minWidth: PAGE_CTA_MIN_W },
  /** R118-A — the sheet CTA law: centered, self-sized, minWidth 200. */
  sheetCta: { alignSelf: "center", minWidth: SHEET_CTA_MIN_W },
  fieldGap: { gap: spacing.md },
});
