/**
 * Providers — the configured-first inventory (R114-f rework): "Your
 * providers" (the SERVER's `configured` bit — custom row OR any held key,
 * pool-aware) as full rows pushing to the detail page; "Add a provider"
 * behind ONE CTA (R115-O — the owner: "by default shows all options —
 * instead ONE option to click then the others appear"). Live: the settings
 * epoch reloads the tiers while the screen is open (another device's key
 * save flips a row's tier the moment the server does).
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
 * self-sized ChromeButton (minWidth PAGE_CTA_MIN_W) in ALL THREE states
 * (empty / configured-only / mixed). The sheet rides the R118-A law: no
 * field captions, the API format is the shared SegmentedControl, the CTA
 * centered.
 *
 * ── ROUND-120 (why): ── R120-S, the owner's report §1 C (items 5/6/7/9):
 * the Add-a-Provider OPTIONS moved OFF the page INTO the bottom-up sheet —
 * "all of those options should be in a dedicated section. There should be
 * a dedicated background to all of them so that they look separate from
 * the whole UI" (the sheet's own clay panel IS that dedicated background;
 * the old inline reveal — rows floating on the page with no surface of
 * their own — is deleted). And the five presets NO LONGER navigate
 * directly to the provider page: tapping OpenAI / NVIDIA / Anthropic /
 * Google / OpenRouter swaps the SAME sheet to that provider's
 * configuration entry (the name rides the sheet's title, the base URL
 * arrives prefilled, the API key input commits the add) — the exact
 * custom-providers grammar, mirrored for the presets; the add flow happens
 * IN the sheet, then commits. The CTA's glow (the ChromeButton sheen
 * family) died in primitives.tsx this round (item 5); "Create provider"
 * joins the same quiet-solid family (item 9).
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
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
  QuietButton,
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
  presetAddPlan,
  setProviderKey,
  splitProviders,
  updateProvider,
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
  // ── ROUND-120 (why): ── the Add-a-Provider options live in the SHEET now
  // (the owner's §1 C6: "there should be a dedicated background to all of
  // them so that they look separate from the whole UI") — the old inline
  // reveal state (addOpen + the staggered page rows) is deleted with it.
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // R116-j (verdict #39): the per-provider MODELS count — grouped by
  // providerId off ONE fetchConfiguredModels call. null = not loaded yet
  // (the row's meta line renders the honest "—", never a fabricated 0).
  const [modelCounts, setModelCounts] = useState<Map<string, number> | null>(null);

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

  // ── ROUND-120 (why): ── the ONE add affordance opens the SHEET (items
  // 6+7: the options render on the sheet's own clay surface — the dedicated
  // background the owner asked for — and every option, presets included,
  // configures IN the sheet; nothing navigates to the provider page from
  // here anymore). The old reveal toggle + accessibilityExpanded die with
  // the inline rows.
  const onAddOpen = useCallback(() => {
    void selectionHaptic();
    setAddSheetOpen(true);
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
            // centered ChromeButton + its sheet live here too).
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

          {/* ── GROUP 2 — "Add a provider" behind the ONE CTA (R115-O +
              R116-j + R118-E A4 + R120-S): tapping it opens the bottom-up
              sheet whose clay panel is the options' DEDICATED background
              (the owner's item 6) — the presets + the custom row render
              inside it, and every pick configures in place (item 7: no
              direct navigation to the provider page). The CTA itself is
              the quiet-solid ChromeButton (item 5 — the glow is gone). */}
          <ChromeButton
            onPress={onAddOpen}
            accessibilityLabel="Add a provider"
            testID="providers-add-cta"
            style={styles.addCta}
          >
            Add a provider
          </ChromeButton>
        </>
      )}

      <AddProviderSheet
        open={addSheetOpen}
        addable={tiers.addable}
        onClose={() => setAddSheetOpen(false)}
        onChanged={() => void load()}
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

// ── ROUND-120 (why): ── the Add-Provider SHEET (items 6+7) ─────────────────
//
// The options' dedicated home: the sheet's own clay panel is the background
// that separates them from the page (the owner's "they look separate from
// the whole UI"). ONE sheet, three levels:
//
//   options — the unconfigured presets + the custom row, each a quiet row
//             on the sheet's surface (the old page-floating reveal rows
//             are gone);
//   preset  — the tapped provider's configuration entry: the name rides
//             the sheet's TITLE, the base URL arrives prefilled (editable),
//             the API key input commits the add (updateProvider PATCH when
//             the URL drifted, then setProviderKey) — the custom-providers
//             grammar mirrored for the five presets, NO navigation to the
//             provider page;
//   custom  — the R115-O custom-create form (name + base URL + api format
//             + the first key), absorbed from the old CustomProviderSheet.
//
// Every level carries the R118-A sheet laws (label + input only, no field
// captions; the CTA centered + self-sized; the quiet escape centered
// beneath at natural width).

function AddProviderSheet({
  open,
  addable,
  onClose,
  onChanged,
}: {
  open: boolean;
  /** The unconfigured presets (the server's configured bit owns the tier). */
  addable: ProviderRow[];
  /** Dismiss (the scrim tap, the X, Android's back button). */
  onClose: () => void;
  /** The inventory may have changed — re-read the list (fired on close only
   *  when something committed; a pure cancel reads nothing). */
  onChanged: () => void;
}) {
  // The sheet's level state: `preset` non-null = that preset's config entry;
  // `custom` = the custom-create form; both null/false = the options list.
  // The states persist through the close animation (the content stays alive
  // under the departing panel) and reset on the NEXT open.
  const [preset, setPreset] = useState<ProviderRow | null>(null);
  const [custom, setCustom] = useState(false);
  // The dirty flag: something committed inside the sheet (a created row the
  // key save could not finish, at minimum) — the close path re-reads the
  // list so the inventory can never go stale behind a cancelled sheet.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPreset(null);
    setCustom(false);
    dirtyRef.current = false;
  }, [open]);

  const finish = useCallback(() => {
    dirtyRef.current = true;
    onClose();
    onChanged();
  }, [onClose, onChanged]);

  const close = useCallback(() => {
    const dirty = dirtyRef.current;
    onClose();
    if (dirty) onChanged();
  }, [onClose, onChanged]);

  const goOptions = useCallback(() => {
    setPreset(null);
    setCustom(false);
  }, []);

  const title =
    preset !== null ? preset.name : custom ? "Custom provider" : "Add a provider";

  return (
    <Sheet open={open} onClose={close} title={title} testID="add-provider-sheet">
      {preset !== null ? (
        <PresetConfigLevel key={preset.id} provider={preset} onBack={goOptions} onFinish={finish} />
      ) : custom ? (
        <CustomProviderLevel
          onBack={goOptions}
          onFinish={finish}
          onDirtied={() => {
            dirtyRef.current = true;
          }}
        />
      ) : (
        <View style={styles.optionList}>
          {/* ── ROUND-120 (why): ── the presets route through the SHEET (the
              owner's item 7: tapping OpenAI / NVIDIA / Anthropic / Google /
              OpenRouter must NOT navigate to the provider page) — the row
              swaps this sheet to that provider's configuration entry. The
              rows knit by the inset hairline, the key-pool row grammar
              (components.md "Key-pool rows": inset hairlines between rows —
              never after the last). */}
          {addable.map((provider, index) => (
            <Fragment key={provider.id}>
              {index > 0 ? <Hairline inset={spacing.lg} /> : null}
              <SheetOptionRow
                iconTone="preset"
                title={provider.name}
                meta="add a key to start using it"
                onPress={() => {
                  void selectionHaptic();
                  setPreset(provider);
                }}
                accessibilityLabel={`Add provider ${provider.name}`}
              />
            </Fragment>
          ))}
          {addable.length > 0 ? <Hairline inset={spacing.lg} /> : null}
          <SheetOptionRow
            iconTone="custom"
            title="Custom provider"
            meta="any OpenAI-compatible endpoint"
            onPress={() => {
              void selectionHaptic();
              setCustom(true);
            }}
            accessibilityLabel="Add a custom provider"
          />
        </View>
      )}
    </Sheet>
  );
}

// ── one option row on the sheet's own surface ───────────────────────────────

/**
 * The options level's row — the quiet sheet-row idiom (NOT a card: these
 * rows sit on the panel's own clay surface, knit by the strong Hairline
 * dividers): [32px add-tile] [name + ONE meta line] [chevron]. The press is
 * the house tint (no ripple, no scale — the sheet's own entrance carries
 * the motion). minHeight 56 keeps the 44px touch discipline.
 */
function SheetOptionRow({
  iconTone,
  title,
  meta,
  onPress,
  accessibilityLabel,
}: {
  /** "preset" — the catalog suggestion's accent2 glyph; "custom" — the ember. */
  iconTone: "preset" | "custom";
  title: string;
  meta: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        { backgroundColor: pressed ? tokens.subtle : "transparent" },
      ]}
    >
      <View style={[styles.optionIcon, { backgroundColor: tokens.subtleHover }]}>
        <Plus size={16} color={iconTone === "custom" ? tokens.accent : tokens.accent2} strokeWidth={2.2} />
      </View>
      <View style={styles.optionText}>
        <TypeBodyStrong numberOfLines={1}>{title}</TypeBodyStrong>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
          {meta}
        </TypeMicro>
      </View>
      <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
    </Pressable>
  );
}

// ── the preset's configuration entry (the sheet's second level) ─────────────

/**
 * ── ROUND-120 (why): ── the owner's item 7 — the preset's add flow happens
 * IN the sheet (the old row navigated straight to the provider page). The
 * provider's NAME rides the sheet's title; the base URL arrives prefilled
 * (editable — a mirror endpoint is a legitimate want); the API key input
 * commits the add: `presetAddPlan` (pure, in features/config.ts) owns the
 * honesty — the key is REQUIRED (the server's `configured` bit flips on a
 * held key; a keyless "add" would be a lie) and the base-URL PATCH rides
 * only when the field drifted from the preset's own URL.
 */
function PresetConfigLevel({
  provider,
  onBack,
  onFinish,
}: {
  provider: ProviderRow;
  /** The quiet escape — back to the sheet's options level. */
  onBack: () => void;
  /** Close + re-read (the add committed). */
  onFinish: () => void;
}) {
  const { tokens } = useTheme();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = useCallback(async () => {
    if (busy) return;
    const plan = presetAddPlan(provider, baseUrl, apiKey);
    if ("error" in plan) {
      setError(plan.error);
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (plan.baseUrlPatch !== null) {
        const urlOutcome = await updateProvider(getLinkManager(), provider.id, {
          baseUrl: plan.baseUrlPatch,
        });
        if (!urlOutcome.ok) {
          mobWarn("config", "preset base url update failed", {
            id: provider.id,
            status: urlOutcome.error.status,
            message: urlOutcome.error.message,
          });
          void warningHaptic();
          setError(urlOutcome.error.message);
          return;
        }
        mobLog("config", "preset base url updated", { id: provider.id });
      }
      const keyOutcome = await setProviderKey(getLinkManager(), provider.id, plan.key);
      if (keyOutcome.ok) {
        mobLog("config", "preset provider key set", { id: provider.id });
        void successHaptic();
        onFinish();
        return;
      }
      mobWarn("config", "preset provider key save failed", {
        id: provider.id,
        status: keyOutcome.error.status,
        message: keyOutcome.error.message,
      });
      void warningHaptic();
      setError(keyOutcome.error.message);
    } catch {
      mobWarn("config", "preset provider add threw");
      void warningHaptic();
      setError("the host is offline — the key was not saved");
    } finally {
      setBusy(false);
    }
  }, [busy, provider, baseUrl, apiKey, onFinish]);

  return (
    <View style={styles.fieldGap}>
      {/* R118-A: label + input ONLY — the field captions are banned in
          sheets (the plan's own validation message surfaces inline when
          there is something to say). */}
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
      <ClayInput
        label="API key"
        mono
        value={apiKey}
        onChangeText={setApiKey}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        accessibilityLabel="Provider API key"
      />
      {error !== null ? (
        <TypeCaption style={{ color: tokens.danger }} numberOfLines={4}>
          {error}
        </TypeCaption>
      ) : null}
      {/* R118-A §2.4: the CTA zone — centered, self-sized, minWidth 200; the
          quiet escape sits centered beneath at natural width. */}
      <ChromeButton
        onPress={() => void onAdd()}
        disabled={busy}
        accessibilityLabel={busy ? "Adding the provider" : "Add the provider"}
        style={styles.sheetCta}
      >
        {busy ? "adding…" : "Add provider"}
      </ChromeButton>
      <QuietButton onPress={onBack} style={styles.sheetQuiet}>
        Back
      </QuietButton>
    </View>
  );
}

// ── the custom-provider create form (the sheet's third level) ───────────────

/**
 * The R115-O custom-create form, absorbed from the old CustomProviderSheet
 * (R120-S — one Add-Provider sheet, one grammar): name + base URL + the
 * api format + the first key. The create/key-save split keeps its honest
 * created state (the provider EXISTS but the key save failed — re-creating
 * would 409 on the name; Done hands over to the list) and now also flushes
 * the sheet's dirty flag so the close path re-reads the inventory.
 */
function CustomProviderLevel({
  onBack,
  onFinish,
  onDirtied,
}: {
  /** The quiet escape — back to the sheet's options level. */
  onBack: () => void;
  /** Close + re-read (the create committed). */
  onFinish: () => void;
  /** The provider exists but the sheet stayed open — the close path must
   *  re-read the list whenever it eventually happens. */
  onDirtied: () => void;
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
          onFinish();
          return;
        }
        const keyOutcome = await setProviderKey(getLinkManager(), outcome.data.id, key);
        if (keyOutcome.ok) {
          mobLog("config", "custom provider key set", { id: outcome.data.id });
          void successHaptic();
          onFinish();
          return;
        }
        mobWarn("config", "custom provider key save failed", {
          id: outcome.data.id,
          status: keyOutcome.error.status,
          message: keyOutcome.error.message,
        });
        void warningHaptic();
        // The row exists server-side — every future close of this sheet
        // must re-read the list (the dirty flag).
        onDirtied();
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
  }, [busy, created, name, baseUrl, apiFormat, firstKey, onFinish, onDirtied]);

  return (
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
          died with the full-width idiom). The quiet Back escape sits
          centered beneath at natural width. */}
      {created ? (
        // The provider exists — creating again would 409 on the name.
        <ChromeButton onPress={onFinish} accessibilityLabel="Done — close the sheet" style={styles.sheetCta}>
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
      <QuietButton onPress={onBack} style={styles.sheetQuiet}>
        Back
      </QuietButton>
    </View>
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
  tierEmpty: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  /** R118-E A3 — the tier break: the strong hairline's own breathing room
   *  (marginVertical xl both sides; the scaffold's 12px gap rides on top —
   *  ~65px of total break). */
  tierBreak: { marginVertical: spacing.xl },
  /** R118-E A4 — the page-level CTA law: centered, self-sized, minWidth
   *  200 (never a full-width row pretending to be a button). */
  addCta: { alignSelf: "center", minWidth: PAGE_CTA_MIN_W },
  /** ── ROUND-120 (why): ── the options list on the sheet's own surface —
   *  the rows knit inside the panel (the owner's dedicated background),
   *  never floating on the page. */
  optionList: { gap: 0 },
  /** The quiet sheet-row anatomy: [32px tile] [name + one meta line]
   *  [chevron], minHeight 56 (the 44px touch law), the house press tint. */
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 56,
  },
  optionIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1, gap: 2 },
  /** R118-A — the sheet CTA law: centered, self-sized, minWidth 200; the
   *  quiet escape beneath at natural width. */
  sheetCta: { alignSelf: "center", minWidth: SHEET_CTA_MIN_W },
  sheetQuiet: { alignSelf: "center" },
  fieldGap: { gap: spacing.md },
});
