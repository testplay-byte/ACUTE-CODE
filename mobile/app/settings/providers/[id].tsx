/**
 * The provider detail/editor — the owner's "configure the models and
 * providers" page: the identity card (name, kind, base URL) with a live
 * "Test connection", the EDIT form (name, base URL, enabled — PATCH with
 * the busy state and the honest failure caption), the API KEY section
 * (write-only: set a new key, NEVER a reveal — it lands in the desktop
 * keyring), and the MODELS list (the live catalog; each row expands into
 * its configured record with editable displayName / contextWindow /
 * hidden, saved via PATCH /models/:id).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronDown, ChevronUp, FlaskConical } from "lucide-react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
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
import { spacing } from "@/design/tokens";
import { SPRING } from "@/design/motion";
import { warningHaptic } from "@/design/haptics";
import {
  fetchConfiguredModels,
  fetchProviderModels,
  fetchProviders,
  setProviderKey,
  testProvider,
  updateModel,
  updateProvider,
  type ModelRecord,
  type ModelSummary,
  type ProviderRow,
} from "@/features/config";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** The one-line truth under every action (saved / not saved). */
interface ActionNote {
  kind: "saved" | "error";
  text: string;
}

/** The editable subset of a configured model record. */
interface ModelDraft {
  displayName: string;
  contextWindow: string;
  hidden: boolean;
}

export default function ProviderDetailScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";
  const { id } = useLocalSearchParams<{ id: string }>();

  const [provider, setProvider] = useState<ProviderRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [modelsCached, setModelsCached] = useState(false);
  const [configured, setConfigured] = useState<ModelRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The edit form (hydrated once, on the first provider read).
  const formHydrated = useRef(false);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editNote, setEditNote] = useState<ActionNote | null>(null);

  // The API key (write-only, never a reveal).
  const [keyInput, setKeyInput] = useState("");
  const [settingKey, setSettingKey] = useState(false);
  const [keyNote, setKeyNote] = useState<ActionNote | null>(null);

  // The test connection line.
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<ActionNote | null>(null);

  // The models section: one expanded row, per-model drafts, one save note.
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [modelNote, setModelNote] = useState<{ modelId: string } & ActionNote | null>(null);

  const load = useCallback(async () => {
    if (!connected || typeof id !== "string") return;
    setLoading(true);
    const sender = getLinkManager();
    try {
      const [providersOutcome, modelsOutcome, configuredOutcome] = await Promise.all([
        fetchProviders(sender),
        fetchProviderModels(sender, id),
        fetchConfiguredModels(sender),
      ]);
      let firstError: string | null = null;
      if (providersOutcome.ok) {
        const row = providersOutcome.data.providers.find((p) => p.id === id) ?? null;
        setProvider(row);
        setNotFound(row === null);
        if (row !== null && !formHydrated.current) {
          formHydrated.current = true;
          setEditName(row.name);
          setEditBaseUrl(row.baseUrl);
          setEditEnabled(row.enabled);
        }
      } else {
        firstError = `providers: ${providersOutcome.error.message}`;
      }
      if (modelsOutcome.ok) {
        setModels(modelsOutcome.data.models);
        setModelsCached(modelsOutcome.data.cached);
      } else {
        firstError = firstError ?? `models: ${modelsOutcome.error.message}`;
      }
      if (configuredOutcome.ok) {
        setConfigured(configuredOutcome.data.models);
      } else {
        firstError = firstError ?? `configured models: ${configuredOutcome.error.message}`;
      }
      setLoadError(firstError);
      if (firstError !== null) {
        mobWarn("config", "provider detail load partially failed", { id, firstError });
        warningHaptic();
      } else {
        mobLog("config", "provider detail loaded", {
          id,
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
  }, [connected, id]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // The configured records for THIS provider, keyed by modelId.
  const configuredByModelId = useMemo(() => {
    const map = new Map<string, ModelRecord>();
    if (configured !== null && typeof id === "string") {
      for (const record of configured) {
        if (record.providerId === id) map.set(record.modelId, record);
      }
    }
    return map;
  }, [configured, id]);

  // ── the edit form save ───────────────────────────────────────────────────
  async function saveEdit(): Promise<void> {
    if (provider === null) return;
    const name = editName.trim();
    const baseUrl = editBaseUrl.trim();
    if (name === "") {
      setEditNote({ kind: "error", text: "name cannot be empty" });
      return;
    }
    setSavingEdit(true);
    setEditNote(null);
    try {
      const outcome = await updateProvider(getLinkManager(), provider.id, {
        name,
        baseUrl,
        enabled: editEnabled,
      });
      if (outcome.ok) {
        setProvider(outcome.data);
        setEditNote({ kind: "saved", text: "saved on the desktop" });
        mobLog("config", "provider updated", { id: provider.id });
      } else {
        setEditNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "provider PATCH failed", {
          id: provider.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      setEditNote({ kind: "error", text: "the host dropped while saving — nothing was changed" });
      mobWarn("config", "provider PATCH transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingEdit(false);
    }
  }

  // ── the API key (write-only) ─────────────────────────────────────────────
  async function saveKey(): Promise<void> {
    if (provider === null) return;
    const value = keyInput.trim();
    if (value === "") return;
    setSettingKey(true);
    setKeyNote(null);
    try {
      const outcome = await setProviderKey(getLinkManager(), provider.id, value);
      if (outcome.ok) {
        setKeyInput("");
        setKeyNote({ kind: "saved", text: "key set — stored in the desktop keyring" });
        mobLog("config", "provider key set", { id: provider.id });
        // The hasKey/keyCount line is the desktop's truth — re-read it.
        const refreshed = await fetchProviders(getLinkManager());
        if (refreshed.ok) {
          const row = refreshed.data.providers.find((p) => p.id === provider.id);
          if (row !== undefined) setProvider(row);
        }
      } else {
        setKeyNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "provider key PUT failed", {
          id: provider.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      setKeyNote({ kind: "error", text: "the host dropped while setting the key — try again" });
      mobWarn("config", "provider key PUT transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSettingKey(false);
    }
  }

  // ── the test connection ──────────────────────────────────────────────────
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
      setTestNote({ kind: "error", text: "the host dropped during the test" });
      mobWarn("config", "provider test transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  // ── the models section ───────────────────────────────────────────────────
  function toggleModel(model: ModelSummary): void {
    if (expandedModelId === model.id) {
      setExpandedModelId(null);
      return;
    }
    const record = configuredByModelId.get(model.id) ?? null;
    setDrafts((prev) => ({
      ...prev,
      [model.id]: {
        displayName: record?.displayName ?? "",
        contextWindow:
          record?.contextWindow !== null && record?.contextWindow !== undefined
            ? String(record.contextWindow)
            : "",
        hidden: record?.hidden ?? false,
      },
    }));
    setExpandedModelId(model.id);
    setModelNote(null);
  }

  function patchDraft(modelId: string, patch: Partial<ModelDraft>): void {
    setDrafts((prev) => {
      const current = prev[modelId];
      if (current === undefined) return prev;
      return { ...prev, [modelId]: { ...current, ...patch } };
    });
  }

  async function saveModel(model: ModelSummary): Promise<void> {
    const draft = drafts[model.id];
    const record = configuredByModelId.get(model.id);
    if (draft === undefined || record === undefined) return;
    const trimmedWindow = draft.contextWindow.trim();
    const contextWindow = trimmedWindow === "" ? null : Number(trimmedWindow);
    if (
      contextWindow !== null &&
      (!Number.isFinite(contextWindow) || !Number.isInteger(contextWindow) || contextWindow <= 0)
    ) {
      setModelNote({
        modelId: model.id,
        kind: "error",
        text: "context window must be a whole number of tokens (or blank for unknown)",
      });
      return;
    }
    setSavingModelId(model.id);
    setModelNote(null);
    try {
      const displayName = draft.displayName.trim();
      const body: { displayName?: string; contextWindow?: number | null; hidden?: boolean } = {
        hidden: draft.hidden,
      };
      if (displayName !== "") body.displayName = displayName;
      // Null (blank) clears to unknown — the desktop's PATCH contract.
      body.contextWindow = contextWindow;
      const outcome = await updateModel(getLinkManager(), record.id, body);
      if (outcome.ok) {
        setModelNote({ modelId: model.id, kind: "saved", text: "saved on the desktop" });
        mobLog("config", "model record updated", { id: record.id, modelId: model.id });
        // Keep the configured list honest with what the desktop now holds.
        const refreshed = await fetchConfiguredModels(getLinkManager());
        if (refreshed.ok) setConfigured(refreshed.data.models);
      } else {
        setModelNote({ modelId: model.id, kind: "error", text: outcome.error.message });
        mobWarn("config", "model PATCH failed", {
          id: record.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      setModelNote({
        modelId: model.id,
        kind: "error",
        text: "the host dropped while saving — the record is unchanged",
      });
      mobWarn("config", "model PATCH transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingModelId(null);
    }
  }

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
        <LoadingState caption="loading the provider…" />
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
          {/* ── the identity card + the live test ── */}
          <ClayCard elevated>
            <View style={styles.identityPad}>
              <View style={styles.identityHead}>
                <View style={[styles.identityIcon, { backgroundColor: tokens.subtleHover }]}>
                  <FlaskConical size={22} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <View style={styles.identityText}>
                  <TypeBodyStrong>{provider.name}</TypeBodyStrong>
                  <TypeMono numberOfLines={1} style={styles.identityMono}>
                    {provider.baseUrl}
                  </TypeMono>
                  <TypeMicro>
                    {provider.apiFormat !== undefined && provider.apiFormat !== ""
                      ? `${provider.kind} · ${provider.apiFormat}`
                      : provider.kind}
                    {provider.hasKey
                      ? provider.keyCount > 1
                        ? ` · key set (${provider.keyCount} pooled)`
                        : " · key set"
                      : " · no key yet"}
                  </TypeMicro>
                </View>
                <Badge tone={provider.enabled ? "success" : "neutral"}>
                  {provider.enabled ? "enabled" : "off"}
                </Badge>
              </View>
              <View style={styles.identityActions}>
                <QuietButton onPress={() => void runTest()} disabled={testing}>
                  {testing ? "testing…" : "Test connection"}
                </QuietButton>
                {testNote !== null ? (
                  <View style={styles.noteRow}>
                    <StatusDot color={testNote.kind === "error" ? tokens.danger : tokens.success} />
                    <TypeCaption
                      style={[
                        styles.noteText,
                        { color: testNote.kind === "error" ? tokens.danger : tokens.success },
                      ]}
                      numberOfLines={3}
                    >
                      {testNote.text}
                    </TypeCaption>
                  </View>
                ) : null}
              </View>
            </View>
          </ClayCard>

          {/* ── the edit form ── */}
          <SectionHeader>Edit</SectionHeader>
          <ClayCard>
            <View style={styles.formPad}>
              <ClayInput
                label="Name"
                value={editName}
                onChangeText={setEditName}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Provider name"
              />
              <ClayInput
                label="Base URL"
                mono
                value={editBaseUrl}
                onChangeText={setEditBaseUrl}
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="url"
                accessibilityLabel="Provider base URL"
                caption="the http(s) endpoint the desktop calls"
              />
              <View style={styles.toggleRow}>
                <View style={styles.rowText}>
                  <TypeBodyStrong>Enabled</TypeBodyStrong>
                  <TypeCaption>disabled providers are skipped entirely</TypeCaption>
                </View>
                <ClaySwitch
                  value={editEnabled}
                  onValueChange={setEditEnabled}
                  label="Provider enabled toggle"
                />
              </View>
              <ChromeButton
                onPress={() => void saveEdit()}
                busy={savingEdit}
                accessibilityLabel="Save provider changes"
              >
                Save changes
              </ChromeButton>
              {editNote !== null ? <NoteLine note={editNote} /> : null}
            </View>
          </ClayCard>

          {/* ── the API key (write-only — never a reveal) ── */}
          <SectionHeader>API key</SectionHeader>
          <ClayCard>
            <View style={styles.formPad}>
              <ClayInput
                label="New API key"
                mono
                value={keyInput}
                onChangeText={setKeyInput}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                accessibilityLabel="New API key"
                caption="write-only from this phone — the value lands in the desktop's keyring and is never shown back"
              />
              <ChromeButton
                onPress={() => void saveKey()}
                busy={settingKey}
                disabled={keyInput.trim() === ""}
                accessibilityLabel="Set the API key"
              >
                Set key
              </ChromeButton>
              {keyNote !== null ? <NoteLine note={keyNote} /> : null}
            </View>
          </ClayCard>

          {/* ── the models ── */}
          <SectionHeader>
            {`Models${models !== null ? ` (${models.length})` : ""}`}
          </SectionHeader>
          {models === null ? (
            <LoadingState caption="loading the provider's models…" />
          ) : models.length === 0 ? (
            <ClayCard>
              <View style={styles.emptyPad}>
                <TypeCaption>
                  the catalog is empty — the desktop could not list models from this provider
                  {loadError !== null ? ` (${loadError})` : ""}
                </TypeCaption>
              </View>
            </ClayCard>
          ) : (
            <ClayCard>
              <View style={styles.modelsPad}>
                <TypeMicro>
                  {modelsCached ? "CACHED CATALOG — PULL TO REFRESH" : "LIVE CATALOG FROM THE PROVIDER"}
                </TypeMicro>
                {models.map((model) => {
                  const record = configuredByModelId.get(model.id) ?? null;
                  const expanded = expandedModelId === model.id;
                  const draft = drafts[model.id];
                  const note = modelNote !== null && modelNote.modelId === model.id ? modelNote : null;
                  return (
                    <View key={model.id} style={styles.modelBlock}>
                      <PressableCard
                        onPress={() => toggleModel(model)}
                        accessibilityLabel={`Model ${model.name}${record !== null ? ", configured" : ", not configured"}`}
                      >
                        <View style={styles.modelRowInner}>
                          <View style={styles.rowText}>
                            <View style={styles.rowTitleLine}>
                              <TypeBodyStrong numberOfLines={1} style={styles.rowTitle}>
                                {model.name}
                              </TypeBodyStrong>
                              {model.reasoningSupport === true ? (
                                <Badge tone="accent">reasoning</Badge>
                              ) : null}
                              {record !== null && record.hidden ? (
                                <Badge tone="neutral">hidden</Badge>
                              ) : null}
                            </View>
                            <TypeMono numberOfLines={1} style={styles.modelIdMono}>
                              {model.id}
                            </TypeMono>
                          </View>
                          {expanded ? (
                            <ChevronUp size={18} color={tokens.textTertiary} strokeWidth={2.2} />
                          ) : (
                            <ChevronDown size={18} color={tokens.textTertiary} strokeWidth={2.2} />
                          )}
                        </View>
                      </PressableCard>

                      {expanded ? (
                        <View style={styles.modelExpand}>
                          {record === null ? (
                            <TypeCaption style={styles.notConfigured}>
                              no configured record on the desktop yet — add the model from the
                              desktop's models tab, then its name, context window, and hidden flag
                              become editable here.
                            </TypeCaption>
                          ) : draft === undefined ? null : (
                            <>
                              <TypeMicro>CONFIGURED RECORD · {record.id}</TypeMicro>
                              <ClayInput
                                label="Display name"
                                value={draft.displayName}
                                onChangeText={(text) => patchDraft(model.id, { displayName: text })}
                                autoCapitalize="none"
                                autoCorrect={false}
                                accessibilityLabel={`Display name for ${model.name}`}
                                caption="blank keeps the stored name"
                              />
                              <ClayInput
                                label="Context window"
                                mono
                                value={draft.contextWindow}
                                onChangeText={(text) => patchDraft(model.id, { contextWindow: text })}
                                keyboardType="number-pad"
                                accessibilityLabel={`Context window for ${model.name}`}
                                caption="tokens — blank clears to unknown"
                              />
                              <View style={styles.toggleRow}>
                                <View style={styles.rowText}>
                                  <TypeBodyStrong>Hidden</TypeBodyStrong>
                                  <TypeCaption>hidden models stay out of pickers</TypeCaption>
                                </View>
                                <ClaySwitch
                                  value={draft.hidden}
                                  onValueChange={(next) => patchDraft(model.id, { hidden: next })}
                                  label={`Hidden toggle for ${model.name}`}
                                />
                              </View>
                              <ChromeButton
                                onPress={() => void saveModel(model)}
                                busy={savingModelId === model.id}
                                accessibilityLabel={`Save ${model.name} configuration`}
                              >
                                Save model
                              </ChromeButton>
                              {note !== null ? <NoteLine note={note} /> : null}
                            </>
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </ClayCard>
          )}

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
    </ScreenScaffold>
  );
}

// ── small shared pieces ─────────────────────────────────────────────────────

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
  identityText: { flex: 1, gap: 3 },
  identityMono: { fontSize: 11, lineHeight: 15 },
  identityActions: { gap: spacing.md, alignItems: "flex-start" },
  formPad: { padding: spacing.lg, gap: spacing.md },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
  },
  rowText: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowTitle: { flexShrink: 1 },
  modelsPad: { padding: spacing.lg, gap: spacing.md },
  modelBlock: { gap: spacing.sm },
  modelRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 64,
  },
  modelIdMono: { fontSize: 11, lineHeight: 15 },
  modelExpand: { padding: spacing.md, gap: spacing.md },
  notConfigured: { lineHeight: 18 },
  emptyPad: { padding: spacing.lg },
  noteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noteText: { flex: 1 },
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
