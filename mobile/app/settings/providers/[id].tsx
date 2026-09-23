/**
 * The provider detail — the phone's full Models & Providers replica (R114-f):
 * the THREE-ZONE HERO (R118-E §2B1: the name-hash identity tile + the
 * enabled toggle → the one-honest-line BASE-URL strip → the Test/Rename
 * pair), the API KEY POOL (masked slots — add via the next-free-slot math,
 * per-slot test with a busy→ok/fail verdict, per-slot remove with a confirm
 * sheet; the key VALUE is never shown back — poolInfo's `abcd…wxyz` masking
 * is the only read), and MODELS — THE SAVED ROWS ONLY (GET
 * /providers/:id/models-config, the DB truth the owner asked for — never
 * the live catalog): NAME-ONLY rows (R118-E §2B3 — the modelId line is
 * deleted; the id survives on detail surfaces only) with capability chips
 * (vision/thinking/hidden) + the quiet FACTS line (context · pricing · max
 * output) and a tap → the model actions sheet (a 2×2 GRID — test / edit /
 * hide / delete), plus the add-model flow (from the live catalog with
 * static-catalog prefill, or custom). Server validation surfaces inline
 * everywhere.
 *
 * R115-O — the surgical UX pass; R116-j — the owner's verdicts #40-#43 (the
 * model menu is the 2×2 action grid, the edit sheet owns the FULL R87 field
 * set, the preload race is fixed, every test call waits 35s with an honest
 * class-based failure line). R118-E — the hero rebuild + the key-pool row
 * anatomy + the name-only model rows + the R118-A sheet migrations (no
 * captions anywhere, SegmentedControl for the mode pair, centered CTAs,
 * the danger tone on the remove confirm).
 *
 * R120-M (round-120 §1 items 10-22 — the models overhaul): the hero's
 * context line IS the base URL (the "Chat Completion API" label is dead —
 * item 10; the labeled BASE-URL strip zone with it), the "Rename" button
 * reads "Edit" (12) and the hero pair rides the quiet-solid FLAT CTA
 * family (13 — the sheen glint is the "weird effect" the owner reported).
 * The key rows lost their inline Test/Replace buttons — the row tap opens
 * the KEY ACTIONS sheet (14: Test / Replace / Copy key id / Remove). The
 * model test + hide verdicts are TOASTS now (16 — the details at the
 * sheet's bottom are gone; see components/toast.tsx's law), the actions
 * sheet renders its content off the LIVE record (15 — no first-frame blank
 * content), and the ADD + EDIT flows both land on the CONFIGURE SCREEN
 * (19/22 — app/settings/providers/[id]/model.tsx: the tap carries the
 * id/name in, the model is committed to the list ONLY by that screen's
 * explicit save; cancel discards the draft).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  Brain,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  PencilLine,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  ClayCard,
  ClayInput,
  ClaySwitch,
  Hairline,
  PressableCard,
  QuietButton,
  SectionHeader,
  SegmentedControl,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { modelColor } from "@/design/model-colors";
import {
  fontFamily,
  getContrastText,
  RADIUS_INPUT,
  SHEET_CTA_MIN_W,
  spacing,
  TYPE_BODY,
} from "@/design/tokens";
// R120-M (item 16 — the toast law): the test/hide verdicts fire through the
// app-wide toast provider; the sheets render their own <ToastHost /> so a
// verdict fired inside a Modal-hosted sheet is VISIBLE (see toast.tsx).
import { ToastHost, useToast } from "@/components/toast";
import * as Clipboard from "expo-clipboard";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import {
  deleteModel,
  deleteProviderKeySlot,
  fetchProviderKeys,
  fetchProviderModels,
  fetchProviderModelsConfig,
  fetchProviders,
  modelCapabilityChips,
  modelTestToastText,
  nextFreeKeySlot,
  putProviderKeySlot,
  searchCatalogEntries,
  setProviderKey,
  testModel,
  testProvider,
  testTransportFailureMessage,
  updateModel,
  updateProvider,
  type ModelRecord,
  type ModelSummary,
  type ProviderKeySlot,
  type ProviderRow,
} from "@/features/config";
import { useEventsEpoch } from "@/features/events";
import {
  KEY_SLOT_MONO_LINE,
  KEY_SLOT_MONO_SIZE,
  keyReferenceText,
  keySlotMetaLine,
  modelFactsLine,
  modelRowLabel,
} from "@/features/provider-display";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** The one-line truth under every action (saved / not saved). R119-P adds
 * the CAUTION tone — the model test's tools leg that passed the base checks
 * but is honest-bad news ("answered in text, not called"): green would
 * overstate, red would cry wolf. */
interface ActionNote {
  kind: "saved" | "error" | "caution";
  text: string;
}

export default function ProviderDetailScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";
  const { id } = useLocalSearchParams<{ id: string }>();
  const providerId = typeof id === "string" ? id : null;

  const [provider, setProvider] = useState<ProviderRow | null>(null);
  const [keys, setKeys] = useState<ProviderKeySlot[] | null>(null);
  const [models, setModels] = useState<ModelRecord[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The header actions: enabled toggle, rename sheet, provider test.
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [enabledNote, setEnabledNote] = useState<ActionNote | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<ActionNote | null>(null);

  // The key pool: the per-row ACTIONS SHEET (R120-M item 14 — the inline
  // Test/Replace buttons are gone; the row tap opens the menu), the add-key
  // sheet (null slot = the next-free math, a number targets that slot), and
  // the remove confirm.
  const [keyMenuSlot, setKeyMenuSlot] = useState<number | null>(null);
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [addKeySlot, setAddKeySlot] = useState<number | null>(null);
  const [removeKeySlot, setRemoveKeySlot] = useState<number | null>(null);

  // The models: actions sheet (by row id — re-derived off the fresh list so
  // hide/delete update it live) + the add-model picker (the CONFIGURE
  // screen owns the editor now — R120-M items 19/22).
  const [actionsModelId, setActionsModelId] = useState<string | null>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);

  // R113-e: the live settings epoch — another device's writes (or our own
  // writes broadcast back) reload the truth while this screen is open.
  const settingsEpoch = useEventsEpoch("settings");
  const mountEpoch = useRef(settingsEpoch);

  const refreshProvider = useCallback(async () => {
    if (providerId === null) return;
    const outcome = await fetchProviders(getLinkManager());
    if (outcome.ok) {
      const row = outcome.data.providers.find((p) => p.id === providerId) ?? null;
      setProvider(row);
      setNotFound(row === null);
    }
  }, [providerId]);

  const refreshKeys = useCallback(async () => {
    if (providerId === null) return;
    const outcome = await fetchProviderKeys(getLinkManager(), providerId);
    if (outcome.ok) setKeys(outcome.data.keys);
  }, [providerId]);

  const refreshModels = useCallback(async () => {
    if (providerId === null) return;
    const outcome = await fetchProviderModelsConfig(getLinkManager(), providerId);
    if (outcome.ok) setModels(outcome.data.models);
  }, [providerId]);

  const load = useCallback(async () => {
    if (!connected || providerId === null) return;
    setLoading(true);
    const sender = getLinkManager();
    try {
      const [providersOutcome, keysOutcome, modelsOutcome] = await Promise.all([
        fetchProviders(sender),
        fetchProviderKeys(sender, providerId),
        fetchProviderModelsConfig(sender, providerId),
      ]);
      let firstError: string | null = null;
      if (providersOutcome.ok) {
        const row = providersOutcome.data.providers.find((p) => p.id === providerId) ?? null;
        setProvider(row);
        setNotFound(row === null);
      } else {
        firstError = `providers: ${providersOutcome.error.message}`;
      }
      if (keysOutcome.ok) {
        setKeys(keysOutcome.data.keys);
      } else {
        firstError = firstError ?? `keys: ${keysOutcome.error.message}`;
      }
      if (modelsOutcome.ok) {
        setModels(modelsOutcome.data.models);
      } else {
        firstError = firstError ?? `models: ${modelsOutcome.error.message}`;
      }
      setLoadError(firstError);
      if (firstError !== null) {
        mobWarn("config", "provider detail load partially failed", { id: providerId, firstError });
        warningHaptic();
      } else {
        mobLog("config", "provider detail loaded", {
          id: providerId,
          keys: keysOutcome.ok ? keysOutcome.data.keys.length : -1,
          models: modelsOutcome.ok ? modelsOutcome.data.models.length : -1,
        });
      }
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "provider detail load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [connected, providerId]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  // The live refetch — the settings world changed after mount (our own
  // writes land here too through the events bus; the explicit refreshes
  // below are the fast path, this is the backstop).
  useEffect(() => {
    if (settingsEpoch === mountEpoch.current) return;
    if (connected) void load();
  }, [settingsEpoch, connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── header actions ────────────────────────────────────────────────────────

  async function toggleEnabled(next: boolean): Promise<void> {
    if (provider === null || togglingEnabled) return;
    setTogglingEnabled(true);
    setEnabledNote(null);
    try {
      const outcome = await updateProvider(getLinkManager(), provider.id, { enabled: next });
      if (outcome.ok) {
        setProvider(outcome.data);
        mobLog("config", "provider enabled toggled", { id: provider.id, enabled: next });
      } else {
        setEnabledNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "provider enabled PATCH failed", {
          id: provider.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      setEnabledNote({ kind: "error", text: "the host dropped while saving — nothing was changed" });
      mobWarn("config", "provider enabled PATCH transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTogglingEnabled(false);
    }
  }

  async function runTest(): Promise<void> {
    if (provider === null) return;
    setTesting(true);
    setTestNote(null);
    try {
      const outcome = await testProvider(getLinkManager(), provider.id, {});
      if (outcome.ok) {
        const { ok, latencyMs, message } = outcome.data;
        setTestNote({
          kind: ok ? "saved" : "error",
          text: ok
            ? `ok · ${latencyMs !== undefined ? `${latencyMs}ms` : "answered"}${message ? ` — ${message}` : ""}`
            : `failed — ${message ?? "the provider refused"}`,
        });
        mobLog("config", "provider tested", { id: provider.id, ok, latencyMs });
      } else {
        setTestNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "provider test failed", {
          id: provider.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      // R116-j (§1.8): the class-based one-liner — never the blanket
      // "the host dropped during the test".
      setTestNote({ kind: "error", text: testTransportFailureMessage(err) });
      mobWarn("config", "provider test transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  // ── the key pool actions ──────────────────────────────────────────────────

  // R120-M (item 14): the per-slot test lives INSIDE the key actions sheet
  // now (a busy tile + the toast verdict — item 16's law), and the add-key
  // sheet targets the tapped slot: null = the next-free math, 0 = the
  // primary replace flow, N = that pool slot.
  function openAddKey(slot: number | null): void {
    void selectionHaptic();
    setAddKeySlot(slot);
    setAddKeyOpen(true);
  }

  // ── the model sheets' plumbing (sheets own their busy/error states) ───────

  // R118-E §2B1 — the hero's identity tile hue: the provider's stable
  // name-hash color (the same palette the list row wears), resolved once.
  const heroTileColor = provider !== null ? modelColor(provider.name, tokens.isDark) : null;

  const actionsModel = useMemo(
    () => (models ?? []).find((m) => m.id === actionsModelId) ?? null,
    [models, actionsModelId],
  );
  // R120-M (item 14): the key actions sheet reads the LIVE slot row off the
  // pool (re-derived off the fresh keys so a replace/remove updates it).
  const keyMenu = useMemo(
    () => (keys ?? []).find((k) => k.slot === keyMenuSlot) ?? null,
    [keys, keyMenuSlot],
  );
  const savedModelIds = useMemo(() => new Set((models ?? []).map((m) => m.modelId)), [models]);

  function openModelActions(model: ModelRecord): void {
    void selectionHaptic();
    setActionsModelId(model.id);
  }

  // R120-M (items 19/22): "Edit model" lands on the CONFIGURE SCREEN — the
  // editor is a screen now (the reasoning ladder + the one-line capability
  // rows never fit the 0.86 sheet), and the row's truth changes only on
  // that screen's explicit save.
  function openModelEdit(model: ModelRecord): void {
    setActionsModelId(null);
    if (providerId === null) return;
    router.push({
      pathname: "/settings/providers/[id]/model",
      params: { id: providerId, record: model.id },
    });
  }

  const openAddModel = useCallback(() => {
    void selectionHaptic();
    setAddModelOpen(true);
  }, []);

  // R120-M (item 22): the configure screen commits models on ITS save —
  // this screen refetches the saved rows the moment it regains focus (the
  // model writes do not ride the settings-events epoch, so the focus edge
  // is the refresh; the pull-to-refresh stays the manual backstop).
  useFocusEffect(
    useCallback(() => {
      if (connected) void refreshModels();
    }, [connected, refreshModels]),
  );

  return (
    <ScreenScaffold
      title={provider?.name ?? "Provider"}
      back
      subtitle={provider !== null ? `${provider.kind} provider` : undefined}
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
      ) : loading && provider === null && !notFound ? (
        <SkeletonList rows={4} rowHeight={76} />
      ) : notFound ? (
        <ErrorState
          title="provider not found"
          caption="it may have been deleted on the desktop — the list is one back tap away."
          retryLabel="back to the list"
          onRetry={() => router.back()}
        />
      ) : loadError !== null && provider === null ? (
        <ErrorState
          title="could not load the provider"
          caption={loadError}
          retryLabel="try again"
          onRetry={() => void load()}
        />
      ) : provider !== null ? (
        <>
          {/* ── the hero (R118-E §2B1 → R120-M): identity + base URL +
              toggle → hairline → the Test/Edit pair. The list's name-hash
              hue carries onto the page (the identity tile). R120-M item 10:
              the context line under the name IS THE BASE URL — directly,
              no heading/title (the "Chat Completion API" label and the
              labeled BASE-URL strip zone are both dead — one truth, one
              place); kind lives in the scaffold's subtitle, key truth is
              the keys section's own. ── */}
          <ClayCard elevated>
            <View style={styles.identityPad}>
              <View style={styles.identityHead}>
                {/* The identity tile — the provider's stable name-hash hue
                    (the same palette the list row wears), Server 24 in the
                    tile's own contrast ink. */}
                <View style={[styles.identityIcon, { backgroundColor: heroTileColor ?? tokens.surfaceWell }]}>
                  <Server
                    size={24}
                    color={heroTileColor !== null ? getContrastText(heroTileColor) : tokens.textTertiary}
                    strokeWidth={2.2}
                  />
                </View>
                <View style={styles.identityText}>
                  <TypeTitle numberOfLines={1} style={styles.identityName}>
                    {provider.name}
                  </TypeTitle>
                  {/* R120-M (item 10 — "Below the provider name it says 'Chat
                      Completion API' — replace with the base URL itself,
                      directly, no heading/title"): the ONE context line is
                      the machine truth itself — TypeMono's own 13/19
                      recipe, one line, tail-clipped. */}
                  <TypeMono numberOfLines={1} style={styles.identityBaseUrl}>
                    {provider.baseUrl}
                  </TypeMono>
                </View>
                <View style={styles.identityToggleWrap}>
                  {/* R120-M (item 11): the on/off toggle rides the RIGHT of
                      the title row — the provider-name row — never beside
                      the base URL (the URL is the context line under the
                      name, the toggle is the row's trailing control). */}
                  <ClaySwitch
                    value={provider.enabled}
                    onValueChange={(next) => void toggleEnabled(next)}
                    disabled={togglingEnabled}
                    label="Provider enabled toggle"
                  />
                </View>
              </View>
              {enabledNote !== null ? <NoteLine note={enabledNote} /> : null}

              {/* Zone divider → the actions: the primary is a PRIMARY —
                  ChromeButton flex 1 (busy swaps the label for the
                  spinner, the a11y label follows the swap) + the quiet
                  Edit peer, minHeight-matched at 50.
                  R119-P (§1 item 10 — "the Test connection button
                  line-breaks"): the hero instance opts into labelFit —
                  the 15px bold label shrinks to fit ONE line (down to
                  0.85×) instead of wrapping to "Test"/"connection" at
                  360dp, and the button's horizontal padding breathes
                  xl→md so the shrink rarely engages at all.
                  R120-M (item 13 — the "weird effect (the glow family)"):
                  the sheen glint is OFF — `flat` is the quiet-solid CTA
                  family (solid accentDeep, NO gradient glint, the clay
                  elevation; the R115 wizard-CTA verdict, now the settings
                  CTAs' spelling too). */}
              <Hairline />
              <View style={styles.heroActions}>
                <ChromeButton
                  flat
                  onPress={() => void runTest()}
                  disabled={testing}
                  busy={testing}
                  labelFit
                  style={styles.heroAction}
                  accessibilityLabel={testing ? "Testing the connection" : "Test the connection"}
                >
                  {testing ? "testing…" : "Test connection"}
                </ChromeButton>
                {/* R120-M (item 12): "Rename" reads "Edit" — the sheet it
                    opens edits the name AND the base URL. */}
                <QuietButton onPress={() => setRenameOpen(true)} style={styles.heroQuiet}>
                  Edit
                </QuietButton>
              </View>
              {testNote !== null ? <NoteLine note={testNote} /> : null}
            </View>
          </ClayCard>

          {/* ── the API key pool (masked — the value never comes back) ── */}
          <SectionHeader>API keys</SectionHeader>
          {keys === null ? (
            <SkeletonList rows={2} rowHeight={76} />
          ) : (
            <ClayCard>
              {/* R118-E §2B2 — the key-pool row anatomy: the accentTint key
                  tile (surfaceWell + tertiary glyph when empty), the title
                  + "empty" Badge, ONE mono meta line (the mask · the last
                  use — keySlotMetaLine), inset hairlines between the rows
                  and a final rule.
                  R120-M (item 14 — the right-side inline "Test"/"Replace"
                  options are REMOVED): the ROW is the affordance — a tap
                  opens the key actions sheet (Test / Replace / Copy key id
                  / Remove; an empty slot's menu is its "Add key here"). */}
              <View style={styles.poolPad}>
                {keys.map((slot, index) => {
                  return (
                    <View key={slot.slot}>
                      {index > 0 ? <Hairline inset={spacing.lg} /> : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          slot.slot === 0 ? "Primary key actions" : `Key ${slot.slot} actions`
                        }
                        onPress={() => {
                          void selectionHaptic();
                          setKeyMenuSlot(slot.slot);
                        }}
                        style={({ pressed }) => [
                          styles.slotRow,
                          { backgroundColor: pressed ? tokens.subtle : "transparent" },
                        ]}
                      >
                        <View
                          style={[
                            styles.slotIcon,
                            { backgroundColor: slot.hasKey ? tokens.accentTint : tokens.surfaceWell },
                          ]}
                        >
                          <KeyRound
                            size={16}
                            color={slot.hasKey ? tokens.accentDeep : tokens.textTertiary}
                            strokeWidth={2.2}
                          />
                        </View>
                        <View style={styles.slotText}>
                          <View style={styles.slotTitleLine}>
                            <TypeBodyStrong style={styles.slotTitle}>
                              {slot.slot === 0 ? "Primary key" : `Key ${slot.slot}`}
                            </TypeBodyStrong>
                            {!slot.hasKey ? <Badge tone="neutral">empty</Badge> : null}
                          </View>
                          {/* The ONE meta line — the mask (plus the honest
                              " · used <short>" when the OPTIONAL lastUsedAt
                              rides the slot; an older sidecar degrades to
                              the mask-only line). */}
                          <TypeMono numberOfLines={1} style={styles.slotMasked}>
                            {keySlotMetaLine(slot)}
                          </TypeMono>
                        </View>
                      </Pressable>
                    </View>
                  );
                })}
                <Hairline inset={spacing.lg} />
                {/* The add-key row — the accentTint tile + the one-line
                    label (the caption line is DELETED: the sheet that
                    follows owns the explanation, and it also carries none). */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add an API key"
                  onPress={() => openAddKey(null)}
                  style={({ pressed }) => [
                    styles.addKeyRow,
                    { backgroundColor: pressed ? tokens.subtle : "transparent" },
                  ]}
                >
                  <View style={[styles.addRowIcon, { backgroundColor: tokens.accentTint }]}>
                    <Plus size={16} color={tokens.accentDeep} strokeWidth={2.2} />
                  </View>
                  <View style={styles.addRowText}>
                    <TypeBodyStrong numberOfLines={1}>Add a key</TypeBodyStrong>
                  </View>
                </Pressable>
              </View>
            </ClayCard>
          )}

          {/* ── the models — THE SAVED ROWS ONLY (models-config, the DB
                  truth — never the live catalog the old screen listed). */}
          <SectionHeader>
            {`Models${models !== null ? ` (${models.length})` : ""}`}
          </SectionHeader>
          {models === null ? (
            <SkeletonList rows={3} rowHeight={68} />
          ) : models.length === 0 ? (
            <ClayCard>
              <View style={styles.emptyPad}>
                <TypeCaption numberOfLines={1}>
                  no models saved yet — add one below.
                </TypeCaption>
              </View>
            </ClayCard>
          ) : (
            <>
              {models.map((model) => (
                <SavedModelRow key={model.id} model={model} onPress={() => openModelActions(model)} />
              ))}
            </>
          )}
          <PressableCard onPress={openAddModel} accessibilityLabel="Add a model">
            <View style={styles.addRowInner}>
              {/* R118-E §2B3 — the add-model row carries the accentTint tile
                  (the same add grammar as the key pool's add row). */}
              <View style={[styles.addRowIcon, { backgroundColor: tokens.accentTint }]}>
                <Plus size={16} color={tokens.accentDeep} strokeWidth={2.2} />
              </View>
              <View style={styles.addRowText}>
                <TypeBodyStrong numberOfLines={1}>Add a model</TypeBodyStrong>
                <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                  from the provider's catalog, or a custom model id
                </TypeMicro>
              </View>
            </View>
          </PressableCard>

          {loadError !== null && provider !== null ? (
            <View style={styles.noteRow}>
              <StatusDot color={tokens.warning} />
              <TypeCaption style={[styles.noteText, { color: tokens.warning }]} numberOfLines={2}>
                {loadError}
              </TypeCaption>
            </View>
          ) : null}
        </>
      ) : (
        <LoadingState caption="loading the provider…" />
      )}

      {/* ── the sheets (always mounted, `open` toggling — the house pattern
              that keeps the exit animation; each save refreshes its own
              section's truth; the actions sheet hands off to the edit sheet). */}
      {provider !== null ? (
        <RenameProviderSheet
          open={renameOpen}
          provider={provider}
          onClose={() => setRenameOpen(false)}
          onSaved={() => void refreshProvider()}
        />
      ) : null}
      {providerId !== null ? (
        <AddKeySheet
          open={addKeyOpen}
          providerId={providerId}
          keys={keys ?? []}
          slot={addKeySlot}
          onClose={() => setAddKeyOpen(false)}
          onSaved={() => {
            void refreshKeys();
            void refreshProvider();
          }}
        />
      ) : null}
      {providerId !== null ? (
        <KeyActionsSheet
          open={keyMenuSlot !== null}
          providerId={providerId}
          slot={keyMenu}
          onClose={() => setKeyMenuSlot(null)}
          onReplace={(slot) => {
            setKeyMenuSlot(null);
            openAddKey(slot);
          }}
          onRemove={(slot) => {
            setKeyMenuSlot(null);
            setRemoveKeySlot(slot);
          }}
        />
      ) : null}
      {providerId !== null ? (
        <RemoveKeySheet
          open={removeKeySlot !== null}
          providerId={providerId}
          slot={removeKeySlot ?? -1}
          masked={removeKeySlot !== null ? (keys?.find((k) => k.slot === removeKeySlot)?.masked ?? null) : null}
          onClose={() => setRemoveKeySlot(null)}
          onRemoved={() => {
            void refreshKeys();
            void refreshProvider();
          }}
        />
      ) : null}
      {providerId !== null ? (
        <ModelActionsSheet
          open={actionsModelId !== null}
          providerId={providerId}
          model={actionsModel}
          onClose={() => setActionsModelId(null)}
          onChanged={() => void refreshModels()}
          onEdit={openModelEdit}
        />
      ) : null}
      {providerId !== null ? (
        <AddModelSheet
          open={addModelOpen}
          providerId={providerId}
          savedModelIds={savedModelIds}
          onClose={() => setAddModelOpen(false)}
        />
      ) : null}
    </ScreenScaffold>
  );
}

// ── the saved-model row (the owner's core demand — the SAVED truth) ─────────

function SavedModelRow({ model, onPress }: { model: ModelRecord; onPress: () => void }) {
  const { tokens } = useTheme();
  const chips = modelCapabilityChips(model);
  // R118-E §2B3 — NAME-ONLY: the label is displayName ?? cleanModelName
  // (modelRowLabel — never the raw id); the modelId TypeMono line under it
  // is DELETED (the owner: "It should not show the model ID"). The id
  // survives on the DETAIL surfaces — the actions sheet's mono block and
  // the edit form's read-only field.
  const label = modelRowLabel(model);
  return (
    <PressableCard onPress={onPress} accessibilityLabel={`Model ${label}`}>
      <View style={[styles.modelRowInner, chips.hidden ? styles.modelRowHidden : null]}>
        <View style={styles.rowText}>
          {/* R116-j (verdict #40): NO flexWrap — the one-line title keeps its
              line, the chips sit inline after it, and chips that don't fit
              drop off the clipped edge (the actions sheet shows everything
              anyway — this row is the at-a-glance read, not the record). */}
          <View style={styles.modelTitleLine}>
            <TypeBodyStrong numberOfLines={1} style={styles.rowTitle}>
              {label}
            </TypeBodyStrong>
            {chips.vision ? (
              <View style={[styles.capChip, { backgroundColor: tokens.pillBg }]}>
                <Eye size={11} color={tokens.accent2} strokeWidth={2.4} />
                <TypeMicro numberOfLines={1} style={{ color: tokens.textSecondary }}>vision</TypeMicro>
              </View>
            ) : null}
            {chips.thinking ? (
              <View style={[styles.capChip, { backgroundColor: tokens.pillBg }]}>
                <Brain size={11} color={tokens.accent2} strokeWidth={2.4} />
                <TypeMicro numberOfLines={1} style={{ color: tokens.textSecondary }}>thinking</TypeMicro>
              </View>
            ) : null}
            {chips.hidden ? <Badge tone="neutral">hidden</Badge> : null}
          </View>
          {/* The quiet FACTS line (verdict #40: "models not detailed") — the
              sizing/pricing numbers that are SET, honest "— ctx" when
              unknown; never a fabricated 0. Line 2 of 2 — the id line is
              gone, the row is NAME-only. */}
          <TypeMono numberOfLines={1} style={[styles.modelIdMono, { color: tokens.textTertiary }]}>
            {modelFactsLine(model)}
          </TypeMono>
        </View>
      </View>
    </PressableCard>
  );
}

// ── the rename sheet (name + base URL — both PATCHable) ─────────────────────

function RenameProviderSheet({
  open,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider: ProviderRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tokens } = useTheme();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate on the OPEN EDGE only — a mid-rename refetch (another device's
  // write) must never clobber what's typed. Deps are deliberately [open]
  // (the provider prop's fresh values are read on every open).
  useEffect(() => {
    if (!open) return;
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setError(null);
  }, [open]);

  const onSave = useCallback(async () => {
    if (busy) return;
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setError("name cannot be empty");
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await updateProvider(getLinkManager(), provider.id, {
        name: trimmedName,
        baseUrl: baseUrl.trim(),
      });
      if (outcome.ok) {
        mobLog("config", "provider renamed", { id: provider.id });
        void successHaptic();
        onClose();
        onSaved();
      } else {
        mobWarn("config", "provider rename PATCH failed", {
          id: provider.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "provider rename threw");
      void warningHaptic();
      setError("the host is offline — nothing was changed");
    } finally {
      setBusy(false);
    }
  }, [busy, name, baseUrl, provider, onClose, onSaved]);

  return (
    <Sheet open={open} onClose={onClose} title="Edit provider" testID="rename-provider-sheet">
      <View style={styles.fieldGap}>
        {/* R118-A: label + input only — the captions are banned in sheets. */}
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
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onSave()}
          disabled={busy}
          accessibilityLabel={busy ? "Saving the provider" : "Save the provider"}
          style={styles.sheetCta}
        >
          {busy ? "saving…" : "Save changes"}
        </ChromeButton>
      </View>
    </Sheet>
  );
}

// ── the add-key sheet (next-free-slot math; any-slot replace mode) ──────────

function AddKeySheet({
  open,
  providerId,
  keys,
  slot,
  onClose,
  onSaved,
}: {
  open: boolean;
  providerId: string;
  keys: ProviderKeySlot[];
  /** R120-M (item 14): the TARGET slot — null = the next-free math (the
   * pool's add row), 0 = the primary replace flow, N = that pool slot
   * (the key actions sheet's Replace / an empty slot's "Add key here"). */
  slot: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tokens } = useTheme();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = slot ?? nextFreeKeySlot(keys);
  // The honest title: a replace for a HELD slot, an add for an empty one.
  const held = keys.find((k) => k.slot === target)?.hasKey === true;
  const title =
    slot === null
      ? "Add an API key"
      : target === 0
        ? "Replace the primary key"
        : held
          ? `Replace key ${target}`
          : `Add key ${target}`;

  useEffect(() => {
    if (!open) return;
    setValue("");
    setError(null);
  }, [open]);

  const onSave = useCallback(async () => {
    if (busy) return;
    const key = value.trim();
    if (key === "") {
      setError("paste the key first");
      void warningHaptic();
      return;
    }
    if (target === -1) {
      setError("the pool is full — 31 keys is the server's ceiling");
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Slot 0 IS the primary — its canonical write path is the primary
      // endpoint; pool slots ride the slot route. Either way the VALUE
      // never comes back: the pool re-reads masked.
      const outcome =
        target === 0
          ? await setProviderKey(getLinkManager(), providerId, key)
          : await putProviderKeySlot(getLinkManager(), providerId, target, key);
      if (outcome.ok) {
        mobLog("config", "provider key saved", { id: providerId, slot: target });
        void successHaptic();
        setValue("");
        onClose();
        onSaved();
      } else {
        mobWarn("config", "provider key save failed", {
          id: providerId,
          slot: target,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "provider key save threw");
      void warningHaptic();
      setError("the host is offline — the key was not saved");
    } finally {
      setBusy(false);
    }
  }, [busy, value, target, providerId, onClose, onSaved]);

  return (
    <Sheet open={open} onClose={onClose} title={title} testID="add-key-sheet">
      <View style={styles.fieldGap}>
        {/* R118-A — the slot-explainer block and the field caption are
            DELETED (sheets ask ONE question with label + input only). The
            slot math still owns the save (slot 0 rides the primary route);
            the pool-full refusal surfaces through the honest error line
            the moment the CTA is tapped, not through a pre-emptive essay. */}
        <ClayInput
          label="API key"
          mono
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="API key"
        />
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onSave()}
          disabled={busy}
          accessibilityLabel={busy ? "Saving the key" : "Save the key"}
          style={styles.sheetCta}
        >
          {busy ? "saving…" : "Save key"}
        </ChromeButton>
      </View>
    </Sheet>
  );
}

// ── the remove-key confirm sheet ────────────────────────────────────────────

function RemoveKeySheet({
  open,
  providerId,
  slot,
  masked,
  onClose,
  onRemoved,
}: {
  open: boolean;
  providerId: string;
  slot: number;
  masked: string | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { tokens } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The snapshot keeps the content alive through the close animation (the
  // parent nulls the slot the moment onClose fires).
  const [shown, setShown] = useState<{ slot: number; masked: string | null } | null>(null);
  useEffect(() => {
    if (open) setShown({ slot, masked });
  }, [open, slot, masked]);

  const onRemove = useCallback(async () => {
    if (busy || shown === null) return;
    const targetSlot = shown.slot;
    setBusy(true);
    setError(null);
    try {
      const outcome = await deleteProviderKeySlot(getLinkManager(), providerId, targetSlot);
      if (outcome.ok) {
        mobLog("config", "provider key removed", { id: providerId, slot: targetSlot });
        void successHaptic();
        onClose();
        onRemoved();
      } else {
        mobWarn("config", "provider key remove failed", {
          id: providerId,
          slot: targetSlot,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "provider key remove threw");
      void warningHaptic();
      setError("the host is offline — the key was not removed");
    } finally {
      setBusy(false);
    }
  }, [busy, shown, providerId, onClose, onRemoved]);

  return (
    <Sheet open={open} onClose={onClose} title="Remove a key" testID="remove-key-sheet">
      {shown !== null ? (
        <View style={styles.fieldGap}>
          {/* R118-A — the sheet asks ONE question; the consequence caption
              is DELETED (the danger CTA's own spelling carries the stakes). */}
          <TypeBodyStrong>
            {`Remove pool slot ${shown.slot}${shown.masked !== null ? ` (${shown.masked})` : ""}?`}
          </TypeBodyStrong>
          {error !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {error}
            </TypeCaption>
          ) : null}
          <ChromeButton
            tone="danger"
            onPress={() => void onRemove()}
            disabled={busy}
            accessibilityLabel={busy ? "Removing the key" : "Remove the key"}
            style={styles.sheetCta}
          >
            {busy ? "removing…" : "Remove key"}
          </ChromeButton>
          <QuietButton onPress={onClose} disabled={busy} style={styles.sheetQuiet}>
            Keep it
          </QuietButton>
        </View>
      ) : null}
    </Sheet>
  );
}

// ── the key actions sheet (R120-M item 14: the row's bottom-up menu) ────────
//
// The house Sheet (the model menu's grammar): the 2×2 ActionTile grid —
// Test / Replace / Copy key id / Remove (the primary keeps its Replace
// flow; slot 0 is never removed over HTTP — the 409 the route answers);
// an EMPTY slot's menu is its one "Add key here" tile. Every action wires
// an EXISTING route: the per-slot test probe (POST /providers/:id/test
// {slot}), the slot-targeted key write (PUT /providers/:id/key for 0,
// PUT /providers/:id/keys/:slot for N), the remove (DELETE
// /providers/:id/keys/:slot). "Copy key id" copies the key's REFERENCE
// (provider · slot · mask — provider-display's keyReferenceText): the raw
// value never crosses to the phone by design (the reveal route is
// device-token blocklisted — config.ts's security note).
//
// The test verdict is a TOAST (item 16's law — the sheet-bottom detail
// lines are gone); the toast renders through this sheet's own ToastHost
// (a Modal is its own native window — see toast.tsx's law).

function KeyActionsSheet({
  open,
  providerId,
  slot,
  onClose,
  onReplace,
  onRemove,
}: {
  open: boolean;
  providerId: string;
  /** The LIVE slot row (null while closed — the snapshot below carries the
   * content through the close animation). */
  slot: ProviderKeySlot | null;
  onClose: () => void;
  onReplace: (slot: number) => void;
  onRemove: (slot: number) => void;
}) {
  const toast = useToast();
  const [shown, setShown] = useState<ProviderKeySlot | null>(null);
  useEffect(() => {
    if (slot !== null) setShown(slot);
  }, [slot]);
  // R120-M (item 15's content law, applied here too): the LIVE row renders
  // the moment the sheet opens — `slot` re-derives off the fresh pool in
  // the SAME commit the sheet opens (no first-frame blank content); the
  // snapshot only carries the close animation.
  const view = slot ?? shown;
  const [testing, setTesting] = useState(false);

  const runTest = useCallback(async () => {
    if (testing || view === null || !view.hasKey) return;
    const targetSlot = view.slot;
    setTesting(true);
    try {
      const outcome = await testProvider(getLinkManager(), providerId, { slot: targetSlot });
      if (outcome.ok) {
        const { ok, latencyMs, message } = outcome.data;
        toast.show({
          kind: ok ? "saved" : "error",
          text: ok
            ? `key ${targetSlot === 0 ? "primary" : targetSlot} ok · ${latencyMs !== undefined ? `${latencyMs}ms` : "answered"}`
            : `failed — ${message ?? "the provider refused"}`,
        });
        mobLog("config", "provider slot tested", { id: providerId, slot: targetSlot, ok, latencyMs });
      } else {
        toast.show({ kind: "error", text: outcome.error.message });
        mobWarn("config", "provider slot test failed", {
          id: providerId,
          slot: targetSlot,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      toast.show({ kind: "error", text: testTransportFailureMessage(err) });
      mobWarn("config", "provider slot test transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [testing, view, providerId, toast]);

  const copyReference = useCallback(() => {
    if (view === null) return;
    const reference = keyReferenceText(view, providerId);
    void Clipboard.setStringAsync(reference)
      .then((ok) => {
        if (ok) {
          void selectionHaptic();
          toast.show({ kind: "saved", text: "key reference copied" });
          mobLog("config", "key reference copied", { id: providerId, slot: view.slot });
        } else {
          toast.show({ kind: "error", text: "the clipboard refused the copy" });
        }
      })
      .catch(() => {
        toast.show({ kind: "error", text: "the clipboard refused the copy" });
      });
  }, [view, providerId, toast]);

  const title = view === null ? "Key" : view.slot === 0 ? "Primary key" : `Key ${view.slot}`;

  return (
    <Sheet open={open} onClose={onClose} title={title} testID="key-actions-sheet">
      {view !== null ? (
        <View style={styles.fieldGap}>
          {/* The toast host — a verdict fired inside this Modal-hosted sheet
              must render in the sheet's own native window (toast.tsx's law). */}
          <ToastHost />
          {/* The head's mono line — the same meta line the row renders. */}
          <View style={styles.sheetHeadMono}>
            <TypeMono numberOfLines={1} style={styles.slotMasked}>
              {keySlotMetaLine(view)}
            </TypeMono>
          </View>

          {view.hasKey ? (
            <View style={styles.actionGrid}>
              <View style={styles.actionGridRow}>
                <ActionTile
                  testID="key-action-test"
                  icon={FlaskConical}
                  label={testing ? "testing…" : "Test key"}
                  busy={testing}
                  disabled={testing}
                  onPress={() => void runTest()}
                  accessibilityLabel={testing ? "Testing the key" : "Test the key"}
                />
                <ActionTile
                  testID="key-action-replace"
                  icon={RefreshCw}
                  label="Replace key"
                  onPress={() => onReplace(view.slot)}
                  accessibilityLabel="Replace the key"
                />
              </View>
              <View style={styles.actionGridRow}>
                <ActionTile
                  testID="key-action-copy"
                  icon={Copy}
                  label="Copy key id"
                  onPress={copyReference}
                  accessibilityLabel="Copy the key reference"
                />
                {view.slot !== 0 ? (
                  <ActionTile
                    testID="key-action-remove"
                    icon={Trash2}
                    label="Remove key"
                    tone="danger"
                    onPress={() => onRemove(view.slot)}
                    accessibilityLabel="Remove the key"
                  />
                ) : null}
              </View>
            </View>
          ) : (
            <View style={styles.actionGridRow}>
              <ActionTile
                testID="key-action-add"
                icon={Plus}
                label="Add key here"
                onPress={() => onReplace(view.slot)}
                accessibilityLabel="Add a key to this slot"
              />
            </View>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

// ── the model actions sheet (test / edit / hide / delete) ───────────────────

function ModelActionsSheet({
  open,
  providerId,
  model,
  onClose,
  onChanged,
  onEdit,
}: {
  open: boolean;
  providerId: string;
  /** The LIVE record (null while closed — the snapshot below carries the
   * content through the close animation and refetch hiccups). */
  model: ModelRecord | null;
  onClose: () => void;
  /** The saved list refetch (hide/show/delete land their truth). */
  onChanged: () => void;
  onEdit: (model: ModelRecord) => void;
}) {
  const { tokens } = useTheme();
  const toast = useToast();
  const [shown, setShown] = useState<ModelRecord | null>(null);
  useEffect(() => {
    if (model !== null) setShown(model);
  }, [model]);
  // R120-M (item 15 — the MODEL-SHEET content law): the LIVE record renders
  // the moment the sheet opens — `model` is re-derived off the fresh list in
  // the SAME commit the sheet opens (the old `shown`-only render spent its
  // first frame on null content: the sheet slid up EMPTY and the grid
  // popped in a beat late — the re-mount flicker); the snapshot now only
  // carries the content through the close animation + refetch gaps. The
  // sheet's shared motion legs (the R119-P content ride) are track S's
  // retune — this is the content behavior only.
  const view = model ?? shown;

  const [testing, setTesting] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reset the transient confirm whenever a different model opens.
  const shownId = shown?.id ?? null;
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteError(null);
  }, [shownId]);

  const label = useMemo(() => (view === null ? "" : modelRowLabel(view)), [view]);

  const runTest = useCallback(async () => {
    if (testing || view === null) return;
    const targetId = view.id;
    setTesting(true);
    try {
      const outcome = await testModel(getLinkManager(), targetId, {});
      if (outcome.ok) {
        // R120-M (item 16 — "A failed model test … show their details at
        // the bottom of the sheet — they must be a toast"): ONE toast line
        // carrying the base chat verdict joined with the tools leg's
        // verdict when it ran (modelTestToastText — the worst news on the
        // line sets the tone; the sheet's bottom note lines are GONE).
        toast.show(modelTestToastText(outcome.data));
        mobLog("config", "model tested", {
          id: targetId,
          ok: outcome.data.ok,
          toolsAccepted: outcome.data.checks?.toolsAccepted ?? null,
          toolCalled: outcome.data.checks?.toolCalled ?? null,
        });
      } else {
        toast.show({ kind: "error", text: outcome.error.message });
        mobWarn("config", "model test failed", {
          id: targetId,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      // R116-j (§1.8): the class-based one-liner — never the blanket
      // "the host dropped during the test".
      toast.show({ kind: "error", text: testTransportFailureMessage(err) });
      mobWarn("config", "model test threw", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [testing, view, toast]);

  const toggleHidden = useCallback(async () => {
    if (hiding || view === null) return;
    const target = view;
    setHiding(true);
    try {
      const outcome = await updateModel(getLinkManager(), target.id, {
        hidden: !target.hidden,
      });
      if (outcome.ok) {
        mobLog("config", "model hidden toggled", { id: target.id, hidden: !target.hidden });
        // R120-M (item 16 — the Hide action's confirmation rides the toast
        // too; the sheet's bottom detail lines are gone).
        toast.show({
          kind: "saved",
          text: outcome.data.hidden ? "hidden — stays out of every picker" : "visible again",
        });
        onChanged();
      } else {
        toast.show({ kind: "error", text: outcome.error.message });
        mobWarn("config", "model hidden PATCH failed", {
          id: target.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch {
      toast.show({ kind: "error", text: "the host dropped while saving — nothing changed" });
      mobWarn("config", "model hidden PATCH threw");
    } finally {
      setHiding(false);
    }
  }, [hiding, view, onChanged, toast]);

  const onDelete = useCallback(async () => {
    if (deleting || view === null) return;
    const targetId = view.id;
    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await deleteModel(getLinkManager(), targetId);
      if (outcome.ok) {
        mobLog("config", "model deleted", { id: targetId });
        void successHaptic();
        onClose();
        onChanged();
      } else {
        mobWarn("config", "model delete failed", {
          id: targetId,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
        setDeleteError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "model delete threw");
      warningHaptic();
      setDeleteError("the host is offline — the model was not deleted");
    } finally {
      setDeleting(false);
    }
  }, [deleting, view, onClose, onChanged]);

  return (
    <Sheet open={open} onClose={onClose} title={label} testID="model-actions-sheet">
      {view !== null ? (
        <View style={styles.fieldGap}>
          {/* The toast host — a verdict fired inside this Modal-hosted sheet
              must render in the sheet's own native window (toast.tsx's
              law). R120-M (item 16): the test/hide verdicts land here as
              toasts — the sheet-bottom note lines are GONE. */}
          <ToastHost />
          {/* The head's mono blocks — ONE line each (verdict #40). */}
          <View style={styles.sheetHeadMono}>
            <TypeMono numberOfLines={1} style={styles.modelIdMono}>
              {view.modelId}
            </TypeMono>
            <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
              {providerId}
            </TypeMicro>
          </View>

          {/* R116-j (verdict #41 / components.md "Sheets"): the four actions
              as a 2×2 GRID of equal tiles — Test / Edit on the first row,
              Hide / Delete below it (Delete last, in the danger tint). The
              note lines span the FULL width BELOW the grid. */}
          <View style={styles.actionGrid}>
            <View style={styles.actionGridRow}>
              <ActionTile
                testID="model-action-test"
                icon={FlaskConical}
                label={testing ? "testing…" : "Test model"}
                busy={testing}
                disabled={testing}
                onPress={() => void runTest()}
                accessibilityLabel={testing ? "Testing the model" : "Test the model"}
              />
              <ActionTile
                testID="model-action-edit"
                icon={PencilLine}
                label="Edit model"
                onPress={() => onEdit(view)}
                accessibilityLabel="Edit the model"
              />
            </View>
            <View style={styles.actionGridRow}>
              <ActionTile
                testID="model-action-hide"
                icon={view.hidden ? Eye : EyeOff}
                label={hiding ? "saving…" : view.hidden ? "Show model" : "Hide model"}
                busy={hiding}
                disabled={hiding}
                onPress={() => void toggleHidden()}
                accessibilityLabel={
                  view.hidden
                    ? "Show the model in the chat picker"
                    : "Hide the model from the chat picker"
                }
              />
              <ActionTile
                testID="model-action-delete"
                icon={Trash2}
                label="Delete model"
                tone="danger"
                onPress={() => setConfirmingDelete(true)}
                accessibilityLabel="Delete the model"
              />
            </View>
          </View>

          {/* R120-M (item 16): the verdict lines above the grid are RETIRED —
              the test verdict + the hide confirmation ride the TOAST now
              (modelTestToastText joins the base chat verdict with the
              tools leg — the R119-P honesty survives, one transient line
              instead of a permanent block at the sheet's bottom). */}

          {/* Delete's confirm step lives inline BELOW the grid (never a
              one-tap loss) — the tiles stay for context. R118-A: the
              confirm box's consequence caption is DELETED — the question
              itself + the danger verbs carry the stakes. */}
          {confirmingDelete ? (
            <View style={[styles.confirmBox, { borderColor: tokens.danger }]}>
              <TypeBodyStrong numberOfLines={1}>{`Delete ${label}?`}</TypeBodyStrong>
              {deleteError !== null ? (
                <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
                  {deleteError}
                </TypeCaption>
              ) : null}
              <View style={styles.identityButtons}>
                <QuietButton
                  tone="danger"
                  onPress={() => void onDelete()}
                  disabled={deleting}
                  textStyle={styles.actionButtonText}
                >
                  {deleting ? "deleting…" : "Delete it"}
                </QuietButton>
                <QuietButton
                  onPress={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  textStyle={styles.actionButtonText}
                >
                  Keep it
                </QuietButton>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

// ── ActionTile — the grid tile (R116-j, verdict #41) ────────────────────────
//
// The model menu's 2×2 spelling: an equal square-ish tile (icon over a
// 2-word label, minHeight 84, RADIUS_INPUT, hairline border) — a PEER grid,
// never a vertical stack of rows. `busy` swaps the icon for the spinner
// (the Test tile's probe + the Hide tile's save); tone="danger" is the
// destructive hue. The header's Rename/Test pair keeps the horizontal
// ActionRow grammar — this tile owns the action menu.

function ActionTile({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  busy = false,
  tone = "neutral",
  testID,
  accessibilityLabel,
}: {
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "neutral" | "danger";
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { tokens } = useTheme();
  const fg = tone === "danger" ? tokens.danger : tokens.textSecondary;
  const border = tone === "danger" ? tokens.danger : tokens.borderStrong;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionTile,
        {
          borderColor: border,
          backgroundColor: pressed ? tokens.subtle : "transparent",
          opacity: disabled ? 0.6 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Icon size={20} color={fg} strokeWidth={2.2} />
      )}
      <Text style={{ color: fg, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── the add-model picker (R120-M items 19/22 — search + custom seed; the
// CONFIGURE SCREEN owns the editor + the commit) ─────────────────────────────

function AddModelSheet({
  open,
  providerId,
  savedModelIds,
  onClose,
}: {
  open: boolean;
  providerId: string;
  savedModelIds: Set<string>;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const router = useRouter();
  const [mode, setMode] = useState<"catalog" | "custom">("catalog");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ModelSummary[] | null>(null);
  const [catalogSource, setCatalogSource] = useState<"live" | "static" | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // R120-M (items 19/22): the picker SEEDS the custom id — the editor + the
  // commit live on the configure screen; nothing is added from this sheet.
  const [customId, setCustomId] = useState("");

  // The catalog loads on open: the LIVE listing first (the provider's own
  // /models — the working path the old screen used), the STATIC catalog as
  // the fallback when it fails or answers empty.
  const loadCatalog = useCallback(async () => {
    setEntries(null);
    setCatalogSource(null);
    setCatalogError(null);
    try {
      const [liveOutcome] = await Promise.all([
        fetchProviderModels(getLinkManager(), providerId),
      ]);
      if (liveOutcome.ok && liveOutcome.data.models.length > 0) {
        setEntries(liveOutcome.data.models);
        setCatalogSource("live");
        mobLog("config", "add-model catalog loaded (live)", {
          providerId,
          count: liveOutcome.data.models.length,
        });
      } else if (liveOutcome.ok) {
        // The live listing answered EMPTY — the honest empty catalog (no
        // static fallback: the entries below only ever carried {id, name},
        // and the configure screen's own smart fetch + static prefill own
        // the details now).
        setEntries([]);
        setCatalogSource("live");
        mobLog("config", "add-model catalog empty (live)", { providerId });
      } else {
        setCatalogError(liveOutcome.error.message);
        mobWarn("config", "add-model catalog failed", {
          providerId,
          message: liveOutcome.error.message,
        });
      }
    } catch {
      setCatalogError("the host dropped while listing the catalog");
      mobWarn("config", "add-model catalog threw", { providerId });
    }
  }, [providerId]);

  useEffect(() => {
    if (!open) return;
    setMode("catalog");
    setQuery("");
    setCustomId("");
    void loadCatalog();
  }, [open, loadCatalog]);

  // Saved models stay out of the pick-list (the desktop's rule — re-adding
  // is an upsert, but the list should show what's ADDABLE).
  const addable = useMemo(() => {
    if (entries === null) return null;
    return searchCatalogEntries(query, entries.filter((e) => !savedModelIds.has(e.id)));
  }, [entries, query, savedModelIds]);

  // R120-M (item 19 — "tapping a result opens the Edit Model screen for
  // that model … the tap carries the model id/name into the configure
  // flow"; item 22 — the model lands in the list only on THAT screen's
  // explicit save): the tap closes the picker and pushes the configure
  // screen carrying the entry's id + name.
  const configure = useCallback(
    (modelId: string, name?: string) => {
      void selectionHaptic();
      onClose();
      router.push({
        pathname: "/settings/providers/[id]/model",
        params: {
          id: providerId,
          modelId,
          ...(name !== undefined && name !== "" ? { name } : {}),
        },
      });
    },
    [providerId, onClose, router],
  );

  const trimmedCustomId = customId.trim();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a model"
      testID="add-model-sheet"
      maxHeightFraction={0.9}
    >
      <View style={styles.fieldGap}>
        {/* the two modes — R118-A: the local ModeChip drift is DELETED; the
            shared SegmentedControl carries the catalog/custom pair (one
            line, all visible; the a11y labels speak the modes in full). */}
        <SegmentedControl
          options={[
            { id: "catalog", label: "Catalog", accessibilityLabel: "From the provider's catalog" },
            { id: "custom", label: "Custom", accessibilityLabel: "Custom model id" },
          ]}
          selectedId={mode}
          onSelect={setMode}
          testID="add-model-mode"
        />

        {mode === "catalog" ? (
          <View style={styles.fieldGap}>
            {catalogError !== null ? (
              <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
                {catalogError}
              </TypeCaption>
            ) : entries === null ? (
              <LoadingState caption="listing the provider's models…" />
            ) : (
              <View style={styles.fieldWrap}>
                <ClayInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="search by model id or name…"
                  placeholderTextColor={tokens.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Search catalog models"
                />
                {catalogSource !== null ? (
                  <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                    {catalogSource === "live"
                      ? "live catalog from the provider"
                      : "static catalog — the live listing was empty or unreachable"}
                  </TypeMicro>
                ) : null}
                <View style={styles.catalogList}>
                  {addable === null ? null : addable.length === 0 ? (
                    <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary, paddingVertical: spacing.md }}>
                      {entries.length === 0 ? "the catalog is empty — use Custom." : "everything it offers is already saved."}
                    </TypeCaption>
                  ) : (
                    addable.slice(0, 60).map((entry) => (
                      <Pressable
                        key={entry.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Configure ${entry.name}`}
                        onPress={() => configure(entry.id, entry.name)}
                        style={({ pressed }) => [
                          styles.catalogRow,
                          {
                            backgroundColor: pressed ? tokens.subtle : "transparent",
                            borderBottomColor: tokens.borderSubtle,
                          },
                        ]}
                      >
                        <View style={styles.rowText}>
                          <TypeBodyStrong numberOfLines={1} style={styles.rowTitle}>
                            {entry.name}
                          </TypeBodyStrong>
                          <TypeMono numberOfLines={1} style={styles.modelIdMono}>
                            {entry.id}
                          </TypeMono>
                        </View>
                      </Pressable>
                    ))
                  )}
                  {addable !== null && addable.length > 60 ? (
                    <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary, paddingVertical: spacing.xs }}>
                      {`showing the first 60 of ${addable.length} — search to narrow`}
                    </TypeMicro>
                  ) : null}
                </View>
              </View>
            )}
          </View>
        ) : (
          // R120-M (items 19/22): the custom mode is the model-id SEED —
          // one field + the configure CTA (the editor + the commit live on
          // the configure screen; R118-A's seed row is retired with the
          // in-sheet form).
          <View style={styles.fieldGap}>
            <ClayInput
              label="Model id"
              mono
              value={customId}
              onChangeText={setCustomId}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Custom model id"
            />
            <ChromeButton
              onPress={() => configure(trimmedCustomId)}
              disabled={trimmedCustomId === ""}
              accessibilityLabel={trimmedCustomId === "" ? "Type a model id first" : "Configure the model"}
              style={styles.sheetCta}
            >
              Configure model
            </ChromeButton>
          </View>
        )}
      </View>
    </Sheet>
  );
}

// ── small shared pieces ─────────────────────────────────────────────────────

function NoteLine({ note }: { note: ActionNote }) {
  const { tokens } = useTheme();
  // R119-P: the caution tone rides warningDeep (the amber text tier) — the
  // tools leg's "answered in text" verdict; saved/error keep their hues.
  const color =
    note.kind === "error" ? tokens.danger : note.kind === "caution" ? tokens.warningDeep : tokens.success;
  return (
    <View style={styles.noteRow}>
      <StatusDot color={color} />
      <TypeCaption style={[styles.noteText, { color }]} numberOfLines={3}>
        {note.text}
      </TypeCaption>
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
          ? "this provider lives on the desktop — pair one to configure it here."
          : "the provider reloads the moment the link returns."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  identityPad: { padding: spacing.lg, gap: spacing.md },
  identityHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  identityIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  // R116-j (verdict #40): the identity card breathes — the single-line rows
  // get one more pixel of air between them.
  identityText: { flex: 1, gap: 4 },
  /** R118-E §2B1 — the name at TypeTitle 20/700, one line, tail-clipped,
   *  shrinking before the switch ever moves. */
  identityName: { flexShrink: 1 },
  identityToggleWrap: { alignItems: "flex-end" },
  /** R120-M (item 10) — the ONE context line under the name IS the base
   *  URL: TypeMono's own 13/19 recipe, one line, tail-clipped by
   *  numberOfLines. */
  identityBaseUrl: { fontSize: 13, lineHeight: 19 },
  identityButtons: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  /** R118-E §2B1 — the hero's action pair: the primary rides flex 1 (the
   *  CTA grammar — a REAL primary, not a quiet peer), the Rename quiet
   *  button matches it at minHeight 50. R119-P: the primary opts into
   *  ChromeButton's labelFit so the pair's ~144dp share at 360dp never
   *  wraps the label (see the hero JSX comment). */
  heroActions: { flexDirection: "row", gap: spacing.sm, alignItems: "stretch" },
  heroAction: { flex: 1 },
  heroQuiet: { flex: 1, minHeight: 50 },
  actionButtonText: { fontSize: 13 },
  /** R118-E §2B2 — the pool card's vertical rhythm (paddingVertical sm). */
  poolPad: { paddingVertical: spacing.sm },
  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 72,
  },
  slotIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  slotText: { flex: 1, gap: 3 },
  slotTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  slotTitle: { flexShrink: 1 },
  /** R118-E §2B2 — the ONE mono meta line: 12/18 (the mono ladder's own
   *  caption size, one step up from the old 11/15 — pinned via
   *  provider-display's KEY_SLOT_MONO pair so the cut cannot drift). */
  slotMasked: { fontSize: KEY_SLOT_MONO_SIZE, lineHeight: KEY_SLOT_MONO_LINE },
  addKeyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 56,
  },
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
  modelRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 64,
  },
  modelRowHidden: { opacity: 0.55 },
  // R116-j (verdict #40): NO flexWrap — the chips sit inline after the
  // one-line title; overflow: "hidden" drops the chips that don't fit (the
  // actions sheet shows everything anyway).
  modelTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm, overflow: "hidden" },
  modelIdMono: { fontSize: 11, lineHeight: 15 },
  capChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { flexShrink: 1 },
  emptyPad: { padding: spacing.lg },
  noteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noteText: { flex: 1 },
  fieldGap: { gap: spacing.md },
  fieldWrap: { gap: spacing.xs },
  /** R118-A §2.4 — the sheet CTA zone: centered, self-sized, minWidth 200;
   *  the quiet escape centers beneath at its natural width. */
  sheetCta: { alignSelf: "center", minWidth: SHEET_CTA_MIN_W },
  sheetQuiet: { alignSelf: "center" },
  // R116-j: the model menu's 2×2 grid — two explicit rows of equal tiles
  // (deterministic halves, never a wrap guess).
  actionGrid: { gap: spacing.md },
  actionGridRow: { flexDirection: "row", gap: spacing.md },
  actionTile: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 84,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
  },
  sheetHeadMono: { gap: 2 },
  confirmBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: spacing.md,
    gap: spacing.md,
  },
  catalogList: { borderRadius: 14, overflow: "hidden" },
  catalogRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
});
