/**
 * The provider detail — the phone's full Models & Providers replica (R114-f):
 * the header card (name, kind/baseUrl, the live enabled toggle, rename via a
 * small sheet, "Test connection"), the API KEY POOL (masked slots — add via
 * the next-free-slot math, per-slot test with a busy→ok/fail verdict,
 * per-slot remove with a confirm sheet; the key VALUE is never shown back —
 * poolInfo's `abcd…wxyz` masking is the only read), and MODELS — THE SAVED
 * ROWS ONLY (GET /providers/:id/models-config, the DB truth the owner asked
 * for — never the live catalog): each row's capability chips (vision/
 * thinking/hidden) + the quiet FACTS line (context · pricing · max output)
 * and a tap → the model actions sheet (a 2×2 GRID — test / edit / hide /
 * delete), plus the add-model flow (from the live catalog with static-catalog
 * prefill, or custom). Server validation surfaces inline everywhere.
 *
 * R115-O — the surgical UX pass: the model actions sheet reads as ONE
 * hierarchy, the edit-model sheet breathes, the header's Rename / Test
 * actions carry icons on 46px targets. R116-j — the owner's verdicts
 * #40-#43: the broken layout fixed (the model title line never wraps —
 * chips sit inline, overflow drops; the identity card breathes on single
 * lines), the model menu is the 2×2 action grid, the edit sheet owns the
 * FULL R87 field set (sizing + the pricing trio incl. cache read + the
 * input/output capability chips — the Thinking toggle is GONE: reasoning
 * and tool use are detected automatically), the preload race is fixed
 * (hydrate keyed on the model identity, §1.9), and every test call waits
 * 35s with an honest class-based failure line (§1.8 — never the blanket
 * "the host dropped").
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
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Brain,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  PencilLine,
  Plus,
  Trash2,
  Zap,
} from "lucide-react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  Chip,
  ChromeButton,
  ClayCard,
  ClayInput,
  PressableCard,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import {
  fontFamily,
  RADIUS_INPUT,
  spacing,
  TOUCH_TARGET,
  TYPE_BODY,
} from "@/design/tokens";
import { SPRING } from "@/design/motion";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import { formatTokens } from "@/features/context-meter";
import {
  addProviderModel,
  catalogEntriesFromStatic,
  catalogPrefillFor,
  cleanModelName,
  deleteModel,
  deleteProviderKeySlot,
  fetchModelCatalog,
  fetchProviderKeys,
  fetchProviderModels,
  fetchProviderModelsConfig,
  fetchProviders,
  modelAddBody,
  modelCapabilityChips,
  modelDraftFromRecord,
  modelEditBody,
  nextFreeKeySlot,
  parseModelNumericField,
  putProviderKeySlot,
  searchCatalogEntries,
  setProviderKey,
  testModel,
  testProvider,
  testTransportFailureMessage,
  updateModel,
  updateProvider,
  type CatalogModelEntry,
  type ModelFormDraft,
  type ModelRecord,
  type ModelSummary,
  type ModelTestResult,
  type ProviderKeySlot,
  type ProviderRow,
} from "@/features/config";
import { useEventsEpoch } from "@/features/events";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** The one-line truth under every action (saved / not saved). */
interface ActionNote {
  kind: "saved" | "error";
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

  // The key pool: add (auto slot / primary replace), remove, per-slot test.
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [addKeyReplacePrimary, setAddKeyReplacePrimary] = useState(false);
  const [removeKeySlot, setRemoveKeySlot] = useState<number | null>(null);
  const [slotTestBusy, setSlotTestBusy] = useState<number | null>(null);
  const [slotTestNote, setSlotTestNote] = useState<({ slot: number } & ActionNote) | null>(null);

  // The models: actions sheet (by row id — re-derived off the fresh list so
  // hide/delete update it live), edit sheet, add sheet.
  const [actionsModelId, setActionsModelId] = useState<string | null>(null);
  const [editModelId, setEditModelId] = useState<string | null>(null);
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

  async function testSlot(slot: number): Promise<void> {
    if (providerId === null || slotTestBusy !== null) return;
    setSlotTestBusy(slot);
    setSlotTestNote(null);
    try {
      const outcome = await testProvider(getLinkManager(), providerId, { slot });
      if (outcome.ok) {
        const { ok, latencyMs, message } = outcome.data;
        setSlotTestNote({
          slot,
          kind: ok ? "saved" : "error",
          text: ok
            ? `ok · ${latencyMs !== undefined ? `${latencyMs}ms` : "answered"}`
            : `failed — ${message ?? "the provider refused"}`,
        });
        mobLog("config", "provider slot tested", { id: providerId, slot, ok, latencyMs });
      } else {
        setSlotTestNote({ slot, kind: "error", text: outcome.error.message });
        mobWarn("config", "provider slot test failed", {
          id: providerId,
          slot,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setSlotTestNote({
        slot,
        kind: "error",
        text: "the host dropped during the test",
      });
      mobWarn("config", "provider slot test transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSlotTestBusy(null);
    }
  }

  function openAddKey(replacePrimary: boolean): void {
    void selectionHaptic();
    setAddKeyReplacePrimary(replacePrimary);
    setAddKeyOpen(true);
  }

  // ── the model sheets' plumbing (sheets own their busy/error states) ───────

  const actionsModel = useMemo(
    () => (models ?? []).find((m) => m.id === actionsModelId) ?? null,
    [models, actionsModelId],
  );
  const editModel = useMemo(
    () => (models ?? []).find((m) => m.id === editModelId) ?? null,
    [models, editModelId],
  );
  const savedModelIds = useMemo(() => new Set((models ?? []).map((m) => m.modelId)), [models]);

  function openModelActions(model: ModelRecord): void {
    void selectionHaptic();
    setActionsModelId(model.id);
  }

  function openModelEdit(model: ModelRecord): void {
    setActionsModelId(null);
    setEditModelId(model.id);
  }

  const openAddModel = useCallback(() => {
    void selectionHaptic();
    setAddModelOpen(true);
  }, []);

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
          {/* ── the header card: identity, enabled, rename, live test ── */}
          <ClayCard elevated>
            <View style={styles.identityPad}>
              <View style={styles.identityHead}>
                <View style={[styles.identityIcon, { backgroundColor: tokens.subtleHover }]}>
                  <FlaskConical size={22} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <View style={styles.identityText}>
                  <TypeBodyStrong numberOfLines={1}>{provider.name}</TypeBodyStrong>
                  <TypeMono numberOfLines={1} style={styles.identityMono}>
                    {provider.baseUrl}
                  </TypeMono>
                  <TypeMicro numberOfLines={1}>
                    {provider.apiFormat !== undefined && provider.apiFormat !== ""
                      ? `${provider.kind} · ${provider.apiFormat}`
                      : provider.kind}
                    {provider.keyCount > 0
                      ? ` · ${provider.keyCount} key${provider.keyCount === 1 ? "" : "s"}`
                      : " · no key yet"}
                  </TypeMicro>
                </View>
                <View style={styles.identityToggleWrap}>
                  <ClaySwitch
                    value={provider.enabled}
                    onValueChange={(next) => void toggleEnabled(next)}
                    disabled={togglingEnabled}
                    label="Provider enabled toggle"
                  />
                </View>
              </View>
              {enabledNote !== null ? <NoteLine note={enabledNote} /> : null}
              <View style={styles.identityActions}>
                {/* R115-O — the header actions carry icons on 46px targets
                    (the ActionRow grammar; a busy spinner rides the test). */}
                <View style={styles.identityButtons}>
                  <ActionRow
                    icon={PencilLine}
                    label="Rename"
                    onPress={() => setRenameOpen(true)}
                    accessibilityLabel="Rename the provider"
                  />
                  <ActionRow
                    icon={Zap}
                    label={testing ? "testing…" : "Test connection"}
                    busy={testing}
                    disabled={testing}
                    onPress={() => void runTest()}
                    accessibilityLabel="Test the connection"
                  />
                </View>
                {testNote !== null ? <NoteLine note={testNote} /> : null}
              </View>
            </View>
          </ClayCard>

          {/* ── the API key pool (masked — the value never comes back) ── */}
          <SectionHeader>API keys</SectionHeader>
          {keys === null ? (
            <SkeletonList rows={2} rowHeight={64} />
          ) : (
            <ClayCard>
              <View style={styles.poolPad}>
                {keys.map((slot, index) => {
                  const note =
                    slotTestNote !== null && slotTestNote.slot === slot.slot ? slotTestNote : null;
                  const busy = slotTestBusy === slot.slot;
                  return (
                    <View key={slot.slot}>
                      {index > 0 ? <View style={[styles.poolRule, { borderBottomColor: tokens.borderSubtle }]} /> : null}
                      <View style={styles.slotRow}>
                        <View style={[styles.slotIcon, { backgroundColor: tokens.subtleHover }]}>
                          <KeyRound
                            size={16}
                            color={slot.hasKey ? tokens.accent : tokens.textTertiary}
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
                          <TypeMono numberOfLines={1} style={styles.slotMasked}>
                            {slot.hasKey ? (slot.masked ?? "••••••••") : "—"}
                          </TypeMono>
                          {note !== null ? <NoteLine note={note} /> : null}
                        </View>
                        {slot.hasKey ? (
                          <View style={styles.slotActions}>
                            <QuietButton
                              onPress={() => void testSlot(slot.slot)}
                              disabled={busy}
                              textStyle={styles.actionButtonText}
                              style={styles.slotActionButton}
                            >
                              {busy ? "…" : "Test"}
                            </QuietButton>
                            {slot.slot === 0 ? (
                              <QuietButton
                                onPress={() => openAddKey(true)}
                                textStyle={styles.actionButtonText}
                                style={styles.slotActionButton}
                              >
                                Replace
                              </QuietButton>
                            ) : (
                              <QuietButton
                                tone="danger"
                                onPress={() => setRemoveKeySlot(slot.slot)}
                                textStyle={styles.actionButtonText}
                                style={styles.slotActionButton}
                              >
                                Remove
                              </QuietButton>
                            )}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
                <View style={[styles.poolRule, { borderBottomColor: tokens.borderSubtle }]} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add an API key"
                  onPress={() => openAddKey(false)}
                  style={({ pressed }) => [
                    styles.addKeyRow,
                    { backgroundColor: pressed ? tokens.subtle : "transparent" },
                  ]}
                >
                  <View style={[styles.addRowIcon, { backgroundColor: tokens.subtleHover }]}>
                    <Plus size={16} color={tokens.accent} strokeWidth={2.2} />
                  </View>
                  <View style={styles.addRowText}>
                    <TypeBodyStrong numberOfLines={1}>Add a key</TypeBodyStrong>
                    <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                      pasted once, masked forever — the value never returns to this phone
                    </TypeMicro>
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
              <View style={[styles.addRowIcon, { backgroundColor: tokens.subtleHover }]}>
                <Plus size={16} color={tokens.accent} strokeWidth={2.2} />
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
          replacePrimary={addKeyReplacePrimary}
          onClose={() => setAddKeyOpen(false)}
          onSaved={() => {
            void refreshKeys();
            void refreshProvider();
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
      <EditModelSheet
        open={editModelId !== null}
        model={editModel}
        onClose={() => setEditModelId(null)}
        onSaved={() => void refreshModels()}
      />
      {providerId !== null ? (
        <AddModelSheet
          open={addModelOpen}
          providerId={providerId}
          savedModelIds={savedModelIds}
          onClose={() => setAddModelOpen(false)}
          onSaved={() => void refreshModels()}
        />
      ) : null}
    </ScreenScaffold>
  );
}

// ── the saved-model row (the owner's core demand — the SAVED truth) ─────────

function SavedModelRow({ model, onPress }: { model: ModelRecord; onPress: () => void }) {
  const { tokens } = useTheme();
  const chips = modelCapabilityChips(model);
  const label =
    model.displayName !== null && model.displayName.trim() !== ""
      ? model.displayName
      : cleanModelName(model.modelId);
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
          <TypeMono numberOfLines={1} style={styles.modelIdMono}>
            {model.modelId}
          </TypeMono>
          {/* The quiet FACTS line (verdict #40: "models not detailed") — the
              sizing/pricing numbers that are SET, honest "— ctx" when
              unknown; never a fabricated 0. */}
          <TypeMono numberOfLines={1} style={[styles.modelIdMono, { color: tokens.textTertiary }]}>
            {modelFactsLine(model)}
          </TypeMono>
        </View>
      </View>
    </PressableCard>
  );
}

/** The model row's facts line: "131k ctx · $0.14 in · $0.60 out · 8k max
 * out" — context always (unknown → "—"), prices and max output only when
 * set (the PC's honest-omission discipline). Pure. */
function modelFactsLine(model: ModelRecord): string {
  const parts: string[] = [
    `${model.contextWindow === null ? "—" : formatTokens(model.contextWindow)} ctx`,
  ];
  if (model.inputPricePerMtok !== null) parts.push(`$${model.inputPricePerMtok} in`);
  if (model.outputPricePerMtok !== null) parts.push(`$${model.outputPricePerMtok} out`);
  if (model.maxOutputTokens !== null) parts.push(`${formatTokens(model.maxOutputTokens)} max out`);
  return parts.join(" · ");
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
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onSave()}
          disabled={busy}
          accessibilityLabel={busy ? "Saving the provider" : "Save the provider"}
        >
          {busy ? "saving…" : "Save changes"}
        </ChromeButton>
      </View>
    </Sheet>
  );
}

// ── the add-key sheet (next-free-slot math; primary replace mode) ───────────

function AddKeySheet({
  open,
  providerId,
  keys,
  replacePrimary,
  onClose,
  onSaved,
}: {
  open: boolean;
  providerId: string;
  keys: ProviderKeySlot[];
  replacePrimary: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tokens } = useTheme();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slot = replacePrimary ? 0 : nextFreeKeySlot(keys);

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
    if (slot === -1) {
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
        slot === 0
          ? await setProviderKey(getLinkManager(), providerId, key)
          : await putProviderKeySlot(getLinkManager(), providerId, slot, key);
      if (outcome.ok) {
        mobLog("config", "provider key saved", { id: providerId, slot });
        void successHaptic();
        setValue("");
        onClose();
        onSaved();
      } else {
        mobWarn("config", "provider key save failed", {
          id: providerId,
          slot,
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
  }, [busy, value, slot, providerId, onClose, onSaved]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={replacePrimary ? "Replace the primary key" : "Add an API key"}
      testID="add-key-sheet"
    >
      <View style={styles.fieldGap}>
        <TypeCaption style={{ color: tokens.textSecondary }}>
          {replacePrimary
            ? "the primary key (slot 0) is overwritten — the old value is gone."
            : slot === -1
              ? "the pool is full (31 keys) — remove one first."
              : slot === 0
                ? "this becomes the PRIMARY key (slot 0) — the one every turn uses first."
                : `this lands in POOL SLOT ${slot} — a second key the runners juggle for load.`}
        </TypeCaption>
        <ClayInput
          label="API key"
          mono
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="API key"
          caption="write-only from this phone — the desktop's keyring holds it, only the mask ever returns"
        />
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onSave()}
          disabled={busy || slot === -1}
          accessibilityLabel={busy ? "Saving the key" : "Save the key"}
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
          <TypeBodyStrong>
            {`Remove pool slot ${shown.slot}${shown.masked !== null ? ` (${shown.masked})` : ""}?`}
          </TypeBodyStrong>
          <TypeCaption style={{ color: tokens.textSecondary }}>
            the desktop forgets this key — turns stop juggling it immediately.
          </TypeCaption>
          {error !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {error}
            </TypeCaption>
          ) : null}
          <ChromeButton
            onPress={() => void onRemove()}
            disabled={busy}
            accessibilityLabel={busy ? "Removing the key" : "Remove the key"}
          >
            {busy ? "removing…" : "Remove key"}
          </ChromeButton>
          <QuietButton onPress={onClose} disabled={busy}>
            Keep it
          </QuietButton>
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
  const [shown, setShown] = useState<ModelRecord | null>(null);
  useEffect(() => {
    if (model !== null) setShown(model);
  }, [model]);

  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<ActionNote | null>(null);
  const [hiding, setHiding] = useState(false);
  const [hideNote, setHideNote] = useState<ActionNote | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reset the transient verdicts whenever a different model opens.
  const shownId = shown?.id ?? null;
  useEffect(() => {
    setTestNote(null);
    setHideNote(null);
    setConfirmingDelete(false);
    setDeleteError(null);
  }, [shownId]);

  const label = useMemo(() => {
    if (shown === null) return "";
    return shown.displayName !== null && shown.displayName.trim() !== ""
      ? shown.displayName
      : cleanModelName(shown.modelId);
  }, [shown]);

  const runTest = useCallback(async () => {
    if (testing || shown === null) return;
    const targetId = shown.id;
    setTesting(true);
    setTestNote(null);
    try {
      const outcome = await testModel(getLinkManager(), targetId, {});
      if (outcome.ok) {
        setTestNote(testResultNote(outcome.data));
        mobLog("config", "model tested", { id: targetId, ok: outcome.data.ok });
      } else {
        setTestNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "model test failed", {
          id: targetId,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      // R116-j (§1.8): the class-based one-liner — never the blanket
      // "the host dropped during the test".
      setTestNote({ kind: "error", text: testTransportFailureMessage(err) });
      mobWarn("config", "model test threw", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [testing, shown]);

  const toggleHidden = useCallback(async () => {
    if (hiding || shown === null) return;
    const target = shown;
    setHiding(true);
    setHideNote(null);
    try {
      const outcome = await updateModel(getLinkManager(), target.id, {
        hidden: !target.hidden,
      });
      if (outcome.ok) {
        mobLog("config", "model hidden toggled", { id: target.id, hidden: !target.hidden });
        setHideNote({
          kind: "saved",
          text: outcome.data.hidden ? "hidden — stays out of every picker" : "visible again",
        });
        onChanged();
      } else {
        setHideNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "model hidden PATCH failed", {
          id: target.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch {
      setHideNote({ kind: "error", text: "the host dropped while saving — nothing changed" });
      mobWarn("config", "model hidden PATCH threw");
    } finally {
      setHiding(false);
    }
  }, [hiding, shown, onChanged]);

  const onDelete = useCallback(async () => {
    if (deleting || shown === null) return;
    const targetId = shown.id;
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
  }, [deleting, shown, onClose, onChanged]);

  return (
    <Sheet open={open} onClose={onClose} title={label} testID="model-actions-sheet">
      {shown !== null ? (
        <View style={styles.fieldGap}>
          {/* The head's mono blocks — ONE line each (verdict #40). */}
          <View style={styles.sheetHeadMono}>
            <TypeMono numberOfLines={1} style={styles.modelIdMono}>
              {shown.modelId}
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
                onPress={() => onEdit(shown)}
                accessibilityLabel="Edit the model"
              />
            </View>
            <View style={styles.actionGridRow}>
              <ActionTile
                testID="model-action-hide"
                icon={shown.hidden ? Eye : EyeOff}
                label={hiding ? "saving…" : shown.hidden ? "Show model" : "Hide model"}
                busy={hiding}
                disabled={hiding}
                onPress={() => void toggleHidden()}
                accessibilityLabel={
                  shown.hidden
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

          {testNote !== null ? <NoteLine note={testNote} /> : null}
          {hideNote !== null ? <NoteLine note={hideNote} /> : null}

          {/* Delete's confirm step lives inline BELOW the grid (never a
              one-tap loss) — the tiles stay for context. */}
          {confirmingDelete ? (
            <View style={[styles.confirmBox, { borderColor: tokens.danger }]}>
              <TypeBodyStrong numberOfLines={1}>{`Delete ${label}?`}</TypeBodyStrong>
              <TypeCaption numberOfLines={1} style={{ color: tokens.textSecondary }}>
                This removes it from every picker.
              </TypeCaption>
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

/** The per-model test verdict line — ok+latency (+ a reply peek) or the
 * honest scrubbed reason. */
function testResultNote(result: ModelTestResult): ActionNote {
  if (result.ok) {
    const preview =
      result.contentPreview !== undefined && result.contentPreview.trim() !== ""
        ? ` — “${result.contentPreview.trim().slice(0, 60)}”`
        : "";
    return { kind: "saved", text: `ok · ${result.latencyMs}ms${preview}` };
  }
  return { kind: "error", text: `failed — ${result.reason ?? "the provider refused"}` };
}

// ── the edit-model sheet (PATCH — the full R87 field set, R116-j) ────────────

function EditModelSheet({
  open,
  model,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The LIVE record (null while closed — the snapshot carries the content). */
  model: ModelRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tokens } = useTheme();
  const [shown, setShown] = useState<ModelRecord | null>(null);
  const [draft, setDraft] = useState<ModelFormDraft>(() => blankDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R116-j (§1.9 — THE PRELOAD RACE FIX): the hydrate is keyed on the model
  // IDENTITY, not the [open] edge alone — `open` and `model` arrive in the
  // SAME commit (the actions sheet's Edit tile hands both over at once), so
  // the draft populates the same commit-cycle the sheet opens; the old
  // [open]-only effect ran against the stale shown === null and opened a
  // BLANK form. The open-edge discipline holds: hydrate on open + model-id
  // change — a background refetch while open (a fresh object, SAME id)
  // never clobbers what's typed.
  const hydrateId = model?.id ?? null;
  useEffect(() => {
    if (open && model !== null) {
      setShown(model);
      setDraft(modelDraftFromRecord(model));
      setError(null);
    }
    // `model` is read when the effect runs; `hydrateId` — the record's
    // identity, never the object — is the dependency (see above).
  }, [open, hydrateId]);

  const patch = useCallback((next: Partial<ModelFormDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const onSave = useCallback(async () => {
    if (busy || shown === null) return;
    // Validate the numerics first — the per-field message shows inline.
    const numericError = firstNumericError(draft);
    if (numericError !== null) {
      setError(numericError);
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await updateModel(getLinkManager(), shown.id, modelEditBody(draft));
      if (outcome.ok) {
        mobLog("config", "model record updated", { id: shown.id, modelId: shown.modelId });
        void successHaptic();
        onClose();
        onSaved();
      } else {
        mobWarn("config", "model PATCH failed", {
          id: shown.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "model PATCH threw");
      void warningHaptic();
      setError("the host is offline — the record is unchanged");
    } finally {
      setBusy(false);
    }
  }, [busy, draft, shown, onClose, onSaved]);

  return (
    <Sheet open={open} onClose={onClose} title="Edit model" testID="edit-model-sheet" maxHeightFraction={0.86}>
      {shown !== null ? (
        /* R115-O — the form's generous rhythm: sections spacing.lg apart
           (the cluttered-form donts), Save busy, Cancel quiet beneath. */
        <View style={styles.editFormGap}>
          {/* modelId is IDENTITY on PATCH — read-only, shown as the mono truth. */}
          <View style={styles.fieldWrap}>
            <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
              Model id (read-only)
            </TypeCaption>
            <View style={[styles.readOnlyMono, { borderColor: tokens.borderSubtle, backgroundColor: tokens.inputBg }]}>
              <TypeMono numberOfLines={1}>{draft.modelId}</TypeMono>
            </View>
          </View>

          <ModelFormSections draft={draft} patch={patch} />

          {/* R116-j — the live preview strip: the draft's key numbers, ONE
              mono line above Save (the PC dialog's R89-C4 summary). */}
          <View style={[styles.previewStrip, { backgroundColor: tokens.subtle }]}>
            <TypeMono
              numberOfLines={1}
              style={[styles.modelIdMono, { color: tokens.textTertiary }]}
              testID="edit-model-preview"
            >
              {modelDraftPreview(draft)}
            </TypeMono>
          </View>

          {error !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {error}
            </TypeCaption>
          ) : null}
          <ChromeButton
            onPress={() => void onSave()}
            disabled={busy}
            accessibilityLabel={busy ? "Saving the model" : "Save the model"}
          >
            {busy ? "saving…" : "Save model"}
          </ChromeButton>
          <QuietButton onPress={onClose} disabled={busy}>
            Cancel
          </QuietButton>
        </View>
      ) : null}
    </Sheet>
  );
}

// ── the shared model-form sections (R116-j) ─────────────────────────────────
//
// The edit + add sheets render the SAME form — the PC's one configure
// dialog ported across both entry points (verdict #43: the full R87 field
// set — Identity, Sizing, the Pricing trio incl. cache read, the INPUT and
// OUTPUT capability chips, and the hidden toggle). The "Thinking" toggle is
// DELETED: the PC has none — "reasoning and tool use are detected
// automatically" — so the sheet never configures supportsThinking (absent
// on PATCH = the detected value keeps). Cap chips flip true ↔ false; an
// untouched null round-trips as null (unknown stays unknown — never a
// guessed boolean). Text input is locked ON (every chat model accepts
// text); text output renders ON until turned off (the chat-completions
// default). supportsTools has NO chip (detected at runtime) — it rides the
// draft for the lossless round-trip only.

function ModelFormSections({
  draft,
  patch,
}: {
  draft: ModelFormDraft;
  patch: (next: Partial<ModelFormDraft>) => void;
}) {
  const { tokens } = useTheme();
  return (
    <>
      {/* Identity — the human name + the parameter-size label. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Identity
        </TypeCaption>
        <ClayInput
          label="Display name"
          value={draft.displayName}
          onChangeText={(text) => patch({ displayName: text })}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Display name"
          caption="blank = the humanized model id"
        />
        <ClayInput
          label="Size label"
          value={draft.sizeLabel}
          onChangeText={(text) => patch({ sizeLabel: text })}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Size label"
          caption="parameter size, e.g. 70B — blank = unspecified"
        />
      </View>

      {/* Sizing — the context window + the max output budget. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Sizing
        </TypeCaption>
        <ClayInput
          label="Context window"
          mono
          value={draft.contextWindow}
          onChangeText={(text) => patch({ contextWindow: text })}
          keyboardType="number-pad"
          accessibilityLabel="Context window"
          caption="tokens — blank = unknown"
        />
        <ClayInput
          label="Max output tokens"
          mono
          value={draft.maxOutputTokens}
          onChangeText={(text) => patch({ maxOutputTokens: text })}
          keyboardType="number-pad"
          accessibilityLabel="Max output tokens"
          caption="tokens — blank = unknown"
        />
      </View>

      {/* Pricing — the USD-per-Mtok trio (cache read included). */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Pricing
        </TypeCaption>
        <ClayInput
          label="Input price / Mtok"
          mono
          value={draft.inputPricePerMtok}
          onChangeText={(text) => patch({ inputPricePerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Input price per million tokens"
          caption="USD — blank = unknown"
        />
        <ClayInput
          label="Output price / Mtok"
          mono
          value={draft.outputPricePerMtok}
          onChangeText={(text) => patch({ outputPricePerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Output price per million tokens"
          caption="USD — blank = unknown"
        />
        <ClayInput
          label="Cache read / Mtok"
          mono
          value={draft.inputPriceCachedPerMtok}
          onChangeText={(text) => patch({ inputPriceCachedPerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Cache read price per million tokens"
          caption="USD — blank = unknown"
        />
      </View>

      {/* INPUT capabilities — chip toggles; Text locked ON. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Input capabilities
        </TypeCaption>
        <View style={styles.capRow}>
          <Chip selected testID="model-cap-text-in">
            Text
          </Chip>
          <Chip
            selected={draft.supportsVision}
            onPress={() => patch({ supportsVision: !draft.supportsVision })}
            testID="model-cap-images-in"
          >
            Images
          </Chip>
          <Chip
            selected={draft.supportsVideo === true}
            onPress={() => patch({ supportsVideo: draft.supportsVideo === true ? false : true })}
            testID="model-cap-video-in"
          >
            Video
          </Chip>
          <Chip
            selected={draft.supportsPdf === true}
            onPress={() => patch({ supportsPdf: draft.supportsPdf === true ? false : true })}
            testID="model-cap-pdf-in"
          >
            PDF
          </Chip>
          <Chip
            selected={draft.supportsAudio === true}
            onPress={() => patch({ supportsAudio: draft.supportsAudio === true ? false : true })}
            testID="model-cap-audio-in"
          >
            Audio
          </Chip>
        </View>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
          text is always accepted — every chat model
        </TypeMicro>
      </View>

      {/* OUTPUT capabilities — chip toggles (text out defaults ON). */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Output capabilities
        </TypeCaption>
        <View style={styles.capRow}>
          <Chip
            selected={draft.supportsTextOutput !== false}
            onPress={() =>
              patch({ supportsTextOutput: draft.supportsTextOutput !== false ? false : true })
            }
            testID="model-cap-text-out"
          >
            Text out
          </Chip>
          <Chip
            selected={draft.supportsImageOutput === true}
            onPress={() =>
              patch({ supportsImageOutput: draft.supportsImageOutput === true ? false : true })
            }
            testID="model-cap-images-out"
          >
            Images out
          </Chip>
          <Chip
            selected={draft.supportsVideoOutput === true}
            onPress={() =>
              patch({ supportsVideoOutput: draft.supportsVideoOutput === true ? false : true })
            }
            testID="model-cap-video-out"
          >
            Video out
          </Chip>
          <Chip
            selected={draft.supportsAudioOutput === true}
            onPress={() =>
              patch({ supportsAudioOutput: draft.supportsAudioOutput === true ? false : true })
            }
            testID="model-cap-audio-out"
          >
            Audio out
          </Chip>
        </View>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
          reasoning and tool use are detected automatically
        </TypeMicro>
      </View>

      {/* Hide from the chat picker — the one behavioral toggle that stays. */}
      <View style={[styles.toggleCard, { borderColor: tokens.borderSubtle }]}>
        <View style={styles.toggleRow}>
          <View style={styles.rowText}>
            <TypeBodyStrong numberOfLines={1}>Hide from the chat picker</TypeBodyStrong>
            <TypeCaption numberOfLines={1}>hidden models stay out of pickers</TypeCaption>
          </View>
          <ClaySwitch
            value={draft.hidden}
            onValueChange={(next) => patch({ hidden: next })}
            label="Hidden toggle"
          />
        </View>
      </View>
    </>
  );
}

/** The per-field validation the model sheets share — the first malformed
 * numeric's inline message, or null when every field parses. Pure. */
function firstNumericError(draft: ModelFormDraft): string | null {
  for (const [field, raw] of [
    ["Context window", draft.contextWindow],
    ["Max output tokens", draft.maxOutputTokens],
    ["Input price", draft.inputPricePerMtok],
    ["Output price", draft.outputPricePerMtok],
    ["Cache read price", draft.inputPriceCachedPerMtok],
  ] as const) {
    const parse = parseModelNumericField(field, raw);
    if (!parse.ok) return parse.message;
  }
  return null;
}

/** The sheets' live preview strip — the draft's key numbers on ONE mono
 * line (unknown → "—", never a fabricated 0). Pure. */
function modelDraftPreview(draft: ModelFormDraft): string {
  const num = (raw: string): number | null => {
    const parse = parseModelNumericField("preview", raw);
    return parse.ok ? parse.value : null;
  };
  const tok = (v: number | null): string => (v === null ? "—" : formatTokens(v));
  const price = (v: number | null): string => (v === null ? "—" : `$${v}`);
  return [
    `ctx ${tok(num(draft.contextWindow))}`,
    `max out ${tok(num(draft.maxOutputTokens))}`,
    `in ${price(num(draft.inputPricePerMtok))}`,
    `out ${price(num(draft.outputPricePerMtok))}`,
    `cache ${price(num(draft.inputPriceCachedPerMtok))}`,
  ].join(" · ");
}

// ── the add-model sheet (from the live catalog w/ static prefill, or custom) ─

function AddModelSheet({
  open,
  providerId,
  savedModelIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  providerId: string;
  savedModelIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tokens } = useTheme();
  const [mode, setMode] = useState<"catalog" | "custom">("catalog");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ModelSummary[] | null>(null);
  const [catalogSource, setCatalogSource] = useState<"live" | "static" | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [staticCatalog, setStaticCatalog] = useState<CatalogModelEntry[]>([]);
  const [draft, setDraft] = useState<ModelFormDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The catalog loads on open: the LIVE listing first (the provider's own
  // /models — the working path the old screen used), the STATIC catalog as
  // the fallback when it fails or answers empty. The static rows ride
  // along either way — they are the prefill's pricing/context/vision source.
  const loadCatalog = useCallback(async () => {
    setEntries(null);
    setCatalogSource(null);
    setCatalogError(null);
    try {
      const [liveOutcome, staticOutcome] = await Promise.all([
        fetchProviderModels(getLinkManager(), providerId),
        fetchModelCatalog(getLinkManager()),
      ]);
      if (staticOutcome.ok) setStaticCatalog(staticOutcome.data.models);
      if (liveOutcome.ok && liveOutcome.data.models.length > 0) {
        setEntries(liveOutcome.data.models);
        setCatalogSource("live");
        mobLog("config", "add-model catalog loaded (live)", {
          providerId,
          count: liveOutcome.data.models.length,
        });
      } else if (staticOutcome.ok) {
        setEntries(catalogEntriesFromStatic(staticOutcome.data.models));
        setCatalogSource("static");
        mobLog("config", "add-model catalog loaded (static fallback)", {
          providerId,
          count: staticOutcome.data.models.length,
        });
      } else {
        // Both failed — the live error is the honest one to show.
        const message = liveOutcome.ok
          ? staticOutcome.error.message
          : liveOutcome.error.message;
        setCatalogError(message);
        mobWarn("config", "add-model catalog failed", { providerId, message });
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
    setDraft(null);
    setError(null);
    void loadCatalog();
  }, [open, loadCatalog]);

  // Saved models stay out of the pick-list (the desktop's rule — re-adding
  // is an upsert, but the list should show what's ADDABLE).
  const addable = useMemo(() => {
    if (entries === null) return null;
    return searchCatalogEntries(query, entries.filter((e) => !savedModelIds.has(e.id)));
  }, [entries, query, savedModelIds]);

  const patch = useCallback((next: Partial<ModelFormDraft>) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...next }));
  }, []);

  const pickEntry = useCallback(
    (entry: ModelSummary) => {
      void selectionHaptic();
      setDraft(catalogPrefillFor(entry, staticCatalog));
      setError(null);
    },
    [staticCatalog],
  );

  const onSave = useCallback(async () => {
    if (busy || draft === null) return;
    // R116-j: the shared per-field validation — the same message the edit
    // sheet shows, incl. the new sizing/cache fields.
    const numericError = firstNumericError(draft);
    if (numericError !== null) {
      setError(numericError);
      void warningHaptic();
      return;
    }
    const body = modelAddBody(draft);
    if (body === null) {
      setError("a model id is required");
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await addProviderModel(getLinkManager(), providerId, body);
      if (outcome.ok) {
        mobLog("config", "model added", { providerId, modelId: body.modelId });
        void successHaptic();
        onClose();
        onSaved();
      } else {
        mobWarn("config", "model add failed", {
          providerId,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "model add threw");
      void warningHaptic();
      setError("the host is offline — the model was not added");
    } finally {
      setBusy(false);
    }
  }, [busy, draft, providerId, onClose, onSaved]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a model"
      testID="add-model-sheet"
      maxHeightFraction={0.9}
    >
      <View style={styles.fieldGap}>
        {/* the two modes */}
        <View style={styles.formatRow}>
          <ModeChip selected={mode === "catalog"} onPress={() => setMode("catalog")}>
            From catalog
          </ModeChip>
          <ModeChip selected={mode === "custom"} onPress={() => setMode("custom")}>
            Custom
          </ModeChip>
        </View>

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
                        accessibilityLabel={`Prefill ${entry.name}`}
                        onPress={() => pickEntry(entry)}
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
          // Custom mode without a draft yet — the seed row opens the blank form.
          <TypeCaption style={{ color: tokens.textSecondary }} numberOfLines={1}>
            type the exact model id the provider expects.
          </TypeCaption>
        )}

        {/* the form — prefilled after a catalog tap, blank after the custom
            seed; one form serves both modes (a catalog pick can be tweaked). */}
        <View style={[styles.fieldGap, styles.formDividerTop, { borderTopColor: tokens.borderSubtle }]}>
          {draft === null ? (
            mode === "custom" ? (
              <SeedCustomDraft onSeed={() => setDraft(blankDraft())} />
            ) : (
              <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary, paddingTop: spacing.xs }}>
                tap a catalog entry to prefill the form for review
              </TypeMicro>
            )
          ) : (
            <>
              {/* R116-j: the add sheet renders the SAME form grammar as the
                  edit sheet (the PC's one configure dialog) — the catalog
                  tap prefills sizing/pricing/vision for review, every cap
                  is editable before the save. */}
              <ClayInput
                label="Model id"
                mono
                value={draft.modelId}
                onChangeText={(text) => patch({ modelId: text })}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Model id"
                caption="the exact id sent to the provider"
              />
              <ModelFormSections draft={draft} patch={patch} />
              <View style={[styles.previewStrip, { backgroundColor: tokens.subtle }]}>
                <TypeMono
                  numberOfLines={1}
                  style={[styles.modelIdMono, { color: tokens.textTertiary }]}
                  testID="add-model-preview"
                >
                  {modelDraftPreview(draft)}
                </TypeMono>
              </View>
              {error !== null ? (
                <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
                  {error}
                </TypeCaption>
              ) : null}
              <ChromeButton
                onPress={() => void onSave()}
                disabled={busy}
                accessibilityLabel={busy ? "Saving the model" : "Save the model"}
              >
                {busy ? "saving…" : "Save model"}
              </ChromeButton>
            </>
          )}
        </View>
      </View>
    </Sheet>
  );
}

/** The custom-mode seed — one tap opens the blank form (kept as its own
 * row so the catalog list stays the default surface). */
function SeedCustomDraft({ onSeed }: { onSeed: () => void }) {
  const { tokens } = useTheme();
  return (
    <PressableCard onPress={onSeed} accessibilityLabel="Start a custom model">
      <View style={styles.addRowInner}>
        <View style={[styles.addRowIcon, { backgroundColor: tokens.subtleHover }]}>
          <Plus size={16} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.addRowText}>
          <TypeBodyStrong numberOfLines={1}>Start a custom model</TypeBodyStrong>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            blank form — you type the model id
          </TypeMicro>
        </View>
      </View>
    </PressableCard>
  );
}

/** The custom-mode seed (R116-j: the full field set — text output defaults
 * ON, the chat-completions contract; every other cap starts unknown). */
function blankDraft(): ModelFormDraft {
  return {
    modelId: "",
    displayName: "",
    sizeLabel: "",
    contextWindow: "",
    maxOutputTokens: "",
    inputPricePerMtok: "",
    outputPricePerMtok: "",
    inputPriceCachedPerMtok: "",
    supportsVision: false,
    supportsTools: null,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    hidden: false,
  };
}

/** The add-model sheet's mode chip (the catalog/custom pair). */
function ModeChip({
  children,
  selected,
  onPress,
}: {
  children: React.ReactNode;
  selected: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeChip,
        {
          backgroundColor: selected ? tokens.accent : pressed ? tokens.subtleHover : tokens.pillBg,
          borderColor: selected ? tokens.accent : tokens.border,
        },
      ]}
    >
      <TypeCaption
        style={{ color: selected ? tokens.accentText : tokens.textSecondary, fontWeight: "600" }}
      >
        {children}
      </TypeCaption>
    </Pressable>
  );
}

// ── small shared pieces ─────────────────────────────────────────────────────

// ── ActionRow — the icon action button (R115-O) ─────────────────────────────
//
// The QuietButton's exact geometry (hairline outline, radius 14, 46px) with
// an ICON slot where the quiet button has text only — the header's
// Rename/Test pair and the model-actions sheet's quiet/danger pair share it.
// `busy` swaps the icon for the spinner (the label-swap idiom stays the
// caller's); tone="danger" is the destructive hue. The primary action keeps
// the house ChromeButton (text-only by design) — this row owns quiet.

function ActionRow({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  busy = false,
  tone = "neutral",
  accessibilityLabel,
}: {
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "neutral" | "danger";
  accessibilityLabel?: string;
}) {
  const { tokens } = useTheme();
  const fg = tone === "danger" ? tokens.danger : tokens.textSecondary;
  const border = tone === "danger" ? tokens.danger : tokens.borderStrong;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
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
        <Icon size={17} color={fg} strokeWidth={2.2} />
      )}
      <Text style={{ color: fg, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold }}>
        {label}
      </Text>
    </Pressable>
  );
}

function NoteLine({ note }: { note: ActionNote }) {
  const { tokens } = useTheme();
  const isError = note.kind === "error";
  return (
    <View style={styles.noteRow}>
      <StatusDot color={isError ? tokens.danger : tokens.success} />
      <TypeCaption
        style={[styles.noteText, { color: isError ? tokens.danger : tokens.success }]}
        numberOfLines={3}
      >
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

// ── ClaySwitch — the same clay switch as the preferences page, kept local ──
// (the file-set boundary; accent pill + sliding dot, the house spring).

const SWITCH_TRACK_W = 52;
const SWITCH_TRACK_H = 32;
const SWITCH_DOT = 24;
const SWITCH_PAD = 3;
const SWITCH_TRAVEL = SWITCH_TRACK_W - SWITCH_DOT - SWITCH_PAD * 2;

function ClaySwitch({
  value,
  onValueChange,
  disabled = false,
  label,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const { tokens } = useTheme();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(value ? 1 : 0, SPRING);
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [tokens.pillBg, tokens.accent]),
  }));
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * SWITCH_TRAVEL }],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={6}
      style={styles.switchTarget}
    >
      <Animated.View style={[styles.switchTrack, trackStyle, disabled ? { opacity: 0.5 } : null]}>
        <Animated.View
          style={[
            styles.switchDot,
            { backgroundColor: value ? tokens.accentText : tokens.textSecondary },
            dotStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
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
  // R116-j (verdict #40): the identity card breathes — the three single-line
  // rows get one more pixel of air between them.
  identityText: { flex: 1, gap: 4 },
  identityToggleWrap: { alignItems: "flex-end" },
  identityMono: { fontSize: 11, lineHeight: 15 },
  identityActions: { gap: spacing.md, alignItems: "flex-start" },
  identityButtons: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  actionButtonText: { fontSize: 13 },
  poolPad: { paddingVertical: spacing.xs },
  poolRule: { borderBottomWidth: StyleSheet.hairlineWidth },
  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 64,
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
  slotMasked: { fontSize: 11, lineHeight: 15 },
  slotActions: { flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  slotActionButton: { paddingHorizontal: spacing.md },
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
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: RADIUS_INPUT,
    minHeight: TOUCH_TARGET + 2,
    paddingHorizontal: spacing.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fieldGap: { gap: spacing.md },
  editFormGap: { gap: spacing.lg },
  fieldWrap: { gap: spacing.xs },
  fieldLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  formatRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  readOnlyMono: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: "center",
  },
  toggleCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: spacing.md,
    gap: spacing.md,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
  },
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
  // The shared model form's section: label + fields, breathing room inside.
  formSection: { gap: spacing.md },
  // The capability chip rows (chips wrap by design — the single-line law
  // scopes to descriptions/captions, not chip groups).
  capRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  // The one-line mono preview strip above Save.
  previewStrip: {
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
  formDividerTop: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md },
  modeChip: {
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  switchTarget: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  switchTrack: {
    width: SWITCH_TRACK_W,
    height: SWITCH_TRACK_H,
    borderRadius: SWITCH_TRACK_H / 2,
    padding: SWITCH_PAD,
    justifyContent: "center",
  },
  switchDot: {
    width: SWITCH_DOT,
    height: SWITCH_DOT,
    borderRadius: SWITCH_DOT / 2,
  },
});
