/**
 * Composer v3 (R113-c) — the session screen's sticky bottom in the clay
 * language: ONE growing TextInput (max ~5 lines) + the SEND button as the
 * sanctioned chrome CTA, PLUS the owner's full PC-chat control surface:
 *
 *   · the CONTROL ROW under the input — [+] attach · operating mode ·
 *     context meter · model · thinking level (horizontally scrollable,
 *     44px targets, clay pills — the desktop toolbar's one-row contract);
 *   · ATTACHMENTS: "+" opens the attach sheet (pick a file from the device
 *     through expo-document-picker, or choose from the project's own files)
 *     and typing "@" quick-picks project files exactly like the desktop;
 *     chips (name · size · X) ride the send as the wire's attachments array,
 *     with picked binaries uploaded through POST /attachments/upload at send
 *     time (the desktop's R67-A pipeline);
 *   · MODE: the desktop's exact per-session PATCH (full/ask/plan) + the
 *     task-mode picker (GET /projects/:id/modes → activeMode);
 *   · MODEL (R114-d — THE HONEST LADDER): the local per-send override →
 *     the session's server-side selectedModel → the context report's
 *     effective model → "Auto" only when NOTHING is known. A pick writes
 *     BOTH tiers: the per-send override (persisted per session, rides the
 *     send) AND PATCH /sessions/:id {model} (the server-side truth — the
 *     desktop + every other phone see the flip live through the meta
 *     frame); "Auto (session default)" clears both back to the agent
 *     default. The configured-models sheet lists the same rows;
 *   · THINKING: the desktop's exact level vocabulary + model-aware menu
 *     (detected reasoning ladders); rides the send as thinkingLevel;
 *   · CONTEXT: the meter pill (pressure-colored ring + %) fed by
 *     GET /sessions/:id/context (2.5s live cadence while a turn runs) with
 *     the full breakdown sheet (per-slice estimates, the provider's own
 *     last-request numbers, cache + lifetime totals).
 *
 * While a turn runs, Send becomes Stop (+ Queue); while the link is offline,
 * Send lands the message in the outbox (overrides ride the flush). The
 * outbox chip keeps its DISMISS affordance. Keyboard-aware via the screen's
 * KeyboardAvoidingView; touch targets ≥ 44px; the send haptic.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle } from "react-native-svg";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { ArrowUp, Bot, Brain, Check, ChevronDown, Cpu, FileText, ListPlus, Plus, Search, Square, X, Zap } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Badge, ClayCard, TypeBodyStrong, TypeCaption, TypeMono } from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { Sheet } from "@/components/sheet";
import {
  pressTint,
  RADIUS_INPUT,
  RADIUS_PILL,
  RADIUS_ROUND,
  fontFamily,
  spacing,
  TOUCH_TARGET,
  TYPE_BODY,
  TYPE_CAPTION,
  TYPE_MICRO,
} from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { mobWarn } from "@/lib/log";
import type { SendOverrides } from "@/features/sessions";
import {
  fetchConfiguredModels,
  fetchProviders,
  type ModelRecord,
  type ProviderRow,
} from "@/features/config";
import {
  attachmentFromRead,
  detectAtToken,
  fetchProjectModes,
  fetchProjectTree,
  filterProjectFiles,
  flattenTreeFiles,
  formatAttachmentSize,
  MAX_ATTACHMENTS,
  readAttachmentFiles,
  stageAttachments,
  stripAtToken,
  toMessageAttachment,
  uploadAttachmentBytes,
  type ComposerAttachment,
  type ProjectModeRow,
} from "@/features/attachments";
import {
  contextPercent,
  contextPressure,
  contextWindowSourceCaption,
  fetchSessionContext,
  formatTokens,
  formatUsd,
  type SessionContextReport,
} from "@/features/context-meter";
import {
  MODE_OPTIONS,
  modeOption,
  thinkingMenuSpec,
  thinkingOption,
  displayThinkingLevel,
  type ModelOverride,
  type ThinkingLevel,
} from "@/features/composer-state";
import {
  loadLastUsedModel,
  loadModelOverride,
  loadThinkingLevel,
  saveLastUsedModel,
  saveModelOverride,
  saveThinkingLevel,
} from "@/features/composer-prefs";

export type ComposerMode = "compose" | "running" | "offline";

export interface ComposerProps {
  mode: ComposerMode;
  /** The pending outbox entries for THIS session (the dim chip). */
  outboxCount: number;
  sessionId: string;
  projectId: string | null;
  /** The session row's CURRENT operating mode (full|ask|plan). */
  permissionMode: string;
  /** The session row's CURRENT task mode id (null = none). */
  activeMode: string | null;
  /** R114-d — the session row's SERVER-SIDE selected model (the tier between
   * the per-send override and the agent row; null = follow the agent
   * default). The pill's honest label when no local override is set. */
  selectedModel: { providerId: string; model: string } | null;
  /** PATCH /sessions/:id/permissions — the screen owns the round-trip. */
  onPermissionModeChange: (mode: "full" | "ask" | "plan") => void;
  /** PATCH /sessions/:id {activeMode} — the screen owns the round-trip. */
  onActiveModeChange: (modeId: string | null) => void;
  /** R114-d — PATCH /sessions/:id {model} — the session's server-side selected
   * model (the cross-device truth; the other devices see the flip live via
   * the meta frame). The screen owns the round-trip. */
  onModelChange?: (model: { providerId: string; model: string } | null) => void;
  /** Fires with the text + the assembled per-send overrides (R113-c). */
  onSend: (content: string, overrides: SendOverrides) => void;
  onStop: () => void;
  onQueue: (content: string, overrides: SendOverrides) => void;
  /** Dismiss the queued offline messages for this session (the X on the chip). */
  onDismissOutbox?: () => void;
  /** True while a turn runs — the context meter's live poll cadence. */
  streaming: boolean;
}

/** The attach-sheet binary sniff window (the desktop's 8KB NUL sniff). */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** The attachment text head cap (the backend's 128KB server-side cap). */
const ATTACHMENT_TEXT_CAP = 131_072;
/** The picked-binary byte ceiling (POST /attachments/upload's 8MB gate). */
const MAX_BINARY_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type SheetKind = "attach" | "files" | "mode" | "model" | "thinking" | "context" | null;

export function Composer({
  mode,
  outboxCount,
  sessionId,
  projectId,
  permissionMode,
  activeMode,
  selectedModel,
  onPermissionModeChange,
  onActiveModeChange,
  onModelChange,
  onSend,
  onStop,
  onQueue,
  onDismissOutbox,
  streaming,
}: ComposerProps) {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [atToken, setAtToken] = useState<{ at: number; end: number; query: string } | null>(null);
  const caretRef = useRef(0);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [note, setNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // The per-session send controls (persisted per session, desktop parity).
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("default");
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(null);

  // The fetched control-row data (cached per mount; honest failure captions).
  const [models, setModels] = useState<ModelRecord[] | null>(null);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [modes, setModes] = useState<ProjectModeRow[] | null>(null);
  const [treeFiles, setTreeFiles] = useState<string[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [contextReport, setContextReport] = useState<SessionContextReport | null>(null);

  // Hydrate the per-session controls once per session (staged chips, the
  // @ picker's tree, and the per-session picks reset with the session too —
  // a file staged for A never rides into B, and a tree fetched for A's
  // project never quick-picks inside B's).
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    setAttachments([]);
    setAtToken(null);
    setTreeFiles(null);
    setThinkingLevel("default");
    setModelOverride(null);
    void loadThinkingLevel(sessionId).then(setThinkingLevel);
    void loadModelOverride(sessionId).then((saved) => {
      setModelOverride(saved);
      if (saved === null) void loadLastUsedModel().then(setModelOverride);
    });
  }, [sessionId]);
  useEffect(() => {
    void loadThinkingLevel(sessionId).then(setThinkingLevel);
    void loadModelOverride(sessionId).then((saved) => {
      setModelOverride(saved);
      if (saved === null) void loadLastUsedModel().then(setModelOverride);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── the fetched data (connected-only, best-effort, honest on failure) ────

  useEffect(() => {
    if (!connected) return;
    const sender = getLinkManager();
    void fetchConfiguredModels(sender).then((outcome) => {
      if (outcome.ok) setModels(outcome.data.models);
    });
    void fetchProviders(sender).then((outcome) => {
      if (outcome.ok) setProviders(outcome.data.providers);
    });
    if (projectId !== null) {
      void fetchProjectModes(sender, projectId).then((outcome) => {
        if (outcome.ok) setModes(outcome.data.modes);
      });
    }
  }, [connected, projectId]);

  const loadTree = useCallback(() => {
    if (treeFiles !== null || projectId === null || !connected) return;
    void fetchProjectTree(getLinkManager(), projectId).then((outcome) => {
      if (outcome.ok) setTreeFiles(flattenTreeFiles(outcome.data.tree));
    });
  }, [treeFiles, projectId, connected]);

  // The context meter: one shot on open + on override change, and the
  // desktop's live cadence (2.5s) while a turn streams.
  const refreshContext = useCallback(() => {
    if (!connected || sessionId === "") return;
    void fetchSessionContext(getLinkManager(), sessionId, {
      ...(modelOverride !== null
        ? { model: modelOverride.model, providerId: modelOverride.providerId }
        : {}),
    })
      .then((outcome) => {
        if (outcome.ok) setContextReport(outcome.data);
      })
      .catch(() => {
        /* transport — the link manager owns the offline truth */
      });
  }, [connected, sessionId, modelOverride]);
  useEffect(() => {
    refreshContext();
  }, [refreshContext]);
  useEffect(() => {
    if (!streaming || !connected) return;
    const timer = setInterval(refreshContext, 2_500);
    return () => clearInterval(timer);
  }, [streaming, connected, refreshContext]);

  // ── the effective pair + the model-aware thinking spec (R95-E parity) ────

  const effectiveModel = modelOverride?.model ?? contextReport?.model ?? null;
  const effectiveProviderId = modelOverride?.providerId ?? contextReport?.providerId ?? null;
  const reasoningSupport = useMemo(() => {
    if (models === null || effectiveModel === null || effectiveProviderId === null) return null;
    const row = models.find(
      (m) => m.providerId === effectiveProviderId && m.modelId === effectiveModel,
    );
    return row?.reasoningSupport ?? null;
  }, [models, effectiveModel, effectiveProviderId]);
  const thinkingSpec = useMemo(() => thinkingMenuSpec(reasoningSupport), [reasoningSupport]);
  const displayedThinkingLevel = displayThinkingLevel(thinkingLevel, thinkingSpec.options);

  const providerName = useCallback(
    (providerId: string): string =>
      providers?.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  // ── attachments ────────────────────────────────────────────────────────────

  /** Stage chips from a server-side read (the desktop's attachPaths). */
  const attachPaths = useCallback(
    async (paths: string[], source: ComposerAttachment["source"]): Promise<void> => {
      if (projectId === null || !connected || paths.length === 0) return;
      const capacity = MAX_ATTACHMENTS - attachments.length;
      if (capacity <= 0) {
        setNote(`At most ${MAX_ATTACHMENTS} files per message.`);
        void warningHaptic();
        return;
      }
      const chosen = paths.slice(0, capacity);
      const outcome = await readAttachmentFiles(getLinkManager(), chosen, projectId).catch(() => null);
      if (outcome === null || !outcome.ok) {
        setNote("couldn't read the file from the desktop");
        return;
      }
      const chips = outcome.data.files
        .map((r) => ({ r, chip: attachmentFromRead(r, source) }))
        .filter((x): x is { r: typeof x.r; chip: ComposerAttachment } => x.chip !== null);
      if (chips.length > 0) setAttachments((prev) => stageAttachments(prev, chips.map((c) => c.chip)));
      const failed = outcome.data.files.filter((r) => r.error !== undefined);
      if (failed.length > 0) {
        setNote(
          failed.length === 1
            ? `couldn't read ${failed[0]?.name}`
            : `${failed.length} files could not be read`,
        );
      }
    },
    [attachments.length, projectId, connected],
  );

  /** Pick ONE file from the device (expo-document-picker) and stage it the
   * desktop's dropped-file way: NUL-sniff → text head, or binary bytes for
   * the send-time upload. */
  const pickDeviceFile = useCallback(async (): Promise<void> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;
      if (attachments.length >= MAX_ATTACHMENTS) {
        setNote(`At most ${MAX_ATTACHMENTS} files per message.`);
        return;
      }
      const file = new File(asset.uri);
      const name = asset.name || "attachment";
      const size = asset.size ?? 0;
      const bytes = await file.bytes();
      const sniff = bytes.subarray(0, BINARY_SNIFF_BYTES);
      let binary = false;
      for (let i = 0; i < sniff.length; i++) {
        if (sniff[i] === 0) {
          binary = true;
          break;
        }
      }
      if (binary) {
        if (size > MAX_BINARY_ATTACHMENT_BYTES) {
          setNote(`${name} is above the 8MB attachment limit`);
          return;
        }
        const dataBase64 = await file.base64();
        setAttachments((prev) =>
          stageAttachments(prev, [
            {
              id: `${name}:${size}:${asset.lastModified ?? 0}`,
              name,
              size,
              text: null,
              truncated: false,
              source: "picker",
              dataBase64,
            },
          ]),
        );
        return;
      }
      const text = (await file.text()).slice(0, ATTACHMENT_TEXT_CAP);
      setAttachments((prev) =>
        stageAttachments(prev, [
          {
            id: `${name}:${size}:${asset.lastModified ?? 0}`,
            name,
            size,
            text,
            truncated: size > ATTACHMENT_TEXT_CAP,
            source: "picker",
          },
        ]),
      );
    } catch (err) {
      mobWarn("composer", "document picker failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      setNote("couldn't read the picked file");
    }
  }, [attachments.length]);

  /** The @ quick-picker's live matches (the desktop's filter). */
  const atMatches = useMemo(
    () => (atToken !== null && treeFiles !== null ? filterProjectFiles(treeFiles, atToken.query) : []),
    [atToken, treeFiles],
  );

  const pickAtMention = useCallback(
    (path: string): void => {
      if (atToken === null) return;
      const next = stripAtToken(draft, atToken);
      setDraft(next);
      setAtToken(null);
      void attachPaths([path], "at");
    },
    [atToken, draft, attachPaths],
  );

  const onDraftChange = useCallback(
    (value: string): void => {
      setDraft(value);
      setNote(null);
      const token = detectAtToken(value, caretRef.current);
      if (token !== null && treeFiles === null) loadTree();
      setAtToken(token);
    },
    [treeFiles, loadTree],
  );

  // ── send assembly (the desktop's sendStaged pipeline, mirrored) ──────────

  const overridesFor = useCallback(
    (staged: ComposerAttachment[]): SendOverrides => ({
      ...(modelOverride !== null
        ? { model: modelOverride.model, providerId: modelOverride.providerId }
        : {}),
      ...(thinkingLevel !== "default" ? { thinkingLevel } : {}),
      ...(staged.length > 0 ? { attachments: staged.map(toMessageAttachment) } : {}),
    }),
    [modelOverride, thinkingLevel],
  );

  /** Upload every un-persisted binary chip (≤8MB) through the R67-A route;
   * failures keep the desktop's honest fallback (path-less ride + note). */
  const uploadStaged = useCallback(
    async (staged: ComposerAttachment[]): Promise<ComposerAttachment[]> => {
      if (projectId === null || !connected) return staged;
      return Promise.all(
        staged.map(async (chip): Promise<ComposerAttachment> => {
          if (chip.dataBase64 === null || chip.dataBase64 === undefined || chip.path !== undefined) {
            return chip;
          }
          try {
            const saved = await uploadAttachmentBytes(
              getLinkManager(),
              projectId,
              chip.name,
              chip.dataBase64,
            );
            if (saved.ok) {
              return { ...chip, path: saved.data.path, size: saved.data.size };
            }
            setNote(`${chip.name} could not be uploaded — it rides as a name only`);
            return { ...chip, dataBase64: null };
          } catch {
            setNote(`${chip.name} could not be uploaded — it rides as a name only`);
            return { ...chip, dataBase64: null };
          }
        }),
      );
    },
    [projectId, connected],
  );

  const canSend = draft.trim() !== "" || attachments.length > 0;
  const running = mode === "running";

  const sendNow = useCallback(async (): Promise<void> => {
    if (!canSend || uploading) return;
    const content = draft;
    setUploading(true);
    try {
      // OFFLINE: the upload route is unreachable, so a picked binary rides
      // as a NAME-ONLY chip (the bytes cannot persist in the queue — honest
      // degradation, surfaced so the owner never wonders where the file
      // went). Text heads ride intact.
      const staged = mode === "offline" ? attachments : await uploadStaged(attachments);
      if (mode === "offline" && staged.some((chip) => chip.dataBase64 != null && chip.path === undefined)) {
        setNote("host offline — picked binary files will send as name-only mentions");
      }
      setDraft("");
      setInputHeight(null);
      setAtToken(null);
      setAttachments([]);
      void successHaptic();
      onSend(content, overridesFor(staged));
    } finally {
      setUploading(false);
    }
  }, [canSend, uploading, draft, mode, attachments, uploadStaged, onSend, overridesFor]);

  const queueNow = useCallback(async (): Promise<void> => {
    if (!canSend || uploading) return;
    const content = draft;
    setUploading(true);
    try {
      const staged = await uploadStaged(attachments);
      setDraft("");
      setInputHeight(null);
      setAtToken(null);
      setAttachments([]);
      onQueue(content, overridesFor(staged));
    } finally {
      setUploading(false);
    }
  }, [canSend, uploading, draft, attachments, uploadStaged, onQueue, overridesFor]);

  // ── control-row state setters (persist per session, desktop parity) ──────

  const pickThinking = useCallback(
    (level: ThinkingLevel): void => {
      setThinkingLevel(level);
      void saveThinkingLevel(sessionId, level);
    },
    [sessionId],
  );

  const pickModel = useCallback(
    (override: ModelOverride | null): void => {
      setModelOverride(override);
      void saveModelOverride(sessionId, override);
      if (override !== null) void saveLastUsedModel(override);
      // R114-d — the pick is ALSO the session's server-side selected model
      // (PATCH /sessions/:id {model}): the other devices see the flip live
      // through the meta frame — the "Auto pill showed Auto while PC had a
      // model selected" divergence dies at the source. null = clear both
      // tiers back to the agent default.
      if (onModelChange !== undefined) onModelChange(override);
      setSheet(null);
    },
    [sessionId, onModelChange],
  );

  // ── render ────────────────────────────────────────────────────────────────

  const modeLabel = modeOption(permissionMode).label;
  // R114-d — THE HONEST MODEL LADDER: the local per-send override → the
  // session's server-side selectedModel → the context report's effective
  // model → only when NOTHING is known, "Auto" (the owner: "the Auto pill
  // showed Auto while PC had a model selected"). Every tier shortens through
  // shortModelLabel so long ids stay one pill.
  const modelLabel =
    modelOverride !== null
      ? shortModelLabel(modelOverride.model, models)
      : selectedModel !== null
        ? shortModelLabel(selectedModel.model, models)
        : contextReport !== null && contextReport.model.trim() !== ""
          ? shortModelLabel(contextReport.model, models)
          : "Auto";
  const thinkingLabel = thinkingSpec.unsupported ? "Off" : thinkingOption(displayedThinkingLevel).label;
  const ctxPct = contextReport !== null ? contextPercent(contextReport.usedTokens, contextReport.contextWindow) : null;
  const ctxPressure = contextReport !== null ? contextPressure(contextReport.usedTokens, contextReport.contextWindow) : "unknown";

  return (
    <View style={[styles.root, { borderTopColor: tokens.borderSubtle }]}>
      {mode === "offline" && outboxCount === 0 && (
        <View style={styles.chipRow}>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            host offline — messages will send when the host returns
          </TypeCaption>
        </View>
      )}
      {outboxCount > 0 && (
        <View style={styles.chipRow}>
          <View style={[styles.chip, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}>
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {outboxCount} message{outboxCount === 1 ? "" : "s"} will send when the host returns
            </TypeCaption>
            {onDismissOutbox !== undefined ? (
              <Pressable
                accessibilityLabel="Dismiss the queued offline messages"
                accessibilityRole="button"
                hitSlop={8}
                onPress={onDismissOutbox}
                style={styles.chipX}
              >
                <X size={13} color={tokens.textTertiary} strokeWidth={2.4} />
              </Pressable>
            ) : null}
          </View>
        </View>
      )}
      {note !== null && (
        <View style={styles.chipRow}>
          <TypeCaption style={{ color: tokens.warning }} numberOfLines={2}>
            {note}
          </TypeCaption>
        </View>
      )}

      {/* The @ quick-picker — a compact popup ABOVE the input (the desktop's
          popup-over-the-caret pattern, restated for the phone's column). */}
      {atToken !== null && atMatches.length > 0 && (
        <View style={[styles.atPicker, { backgroundColor: tokens.card, borderColor: tokens.border, borderTopColor: tokens.clayTopEdge }]}>
          <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.md, paddingTop: spacing.xs }}>
            project files
          </TypeCaption>
          <ScrollView style={{ maxHeight: 176 }} keyboardShouldPersistTaps="handled">
            {atMatches.map((path) => (
              <Pressable
                key={path}
                accessibilityLabel={`Attach ${path}`}
                accessibilityRole="button"
                onPress={() => pickAtMention(path)}
                style={({ pressed }) => [
                  styles.atRow,
                  { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
                ]}
              >
                <FileText size={13} color={tokens.textSecondary} strokeWidth={2} />
                <TypeMono style={{ color: tokens.text, flex: 1 }} numberOfLines={1}>
                  {path}
                </TypeMono>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Staged attachment chips (cleared on send). */}
      {attachments.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.attachRow} contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.md }}>
          {attachments.map((chip) => (
            <View
              key={chip.id}
              accessibilityLabel={`Attachment ${chip.name}`}
              style={[
                styles.attachChip,
                {
                  backgroundColor: tokens.card,
                  borderColor: tokens.border,
                  borderTopColor: tokens.clayTopEdge,
                },
              ]}
            >
              <FileText size={12} color={tokens.textSecondary} strokeWidth={2} />
              <View style={{ maxWidth: 148 }}>
                <TypeCaption style={{ color: tokens.text }} numberOfLines={1}>
                  {chip.name}
                </TypeCaption>
                {chip.size > 0 ? (
                  <TypeCaption style={{ color: tokens.textTertiary, fontSize: TYPE_MICRO - 0.5 }}>
                    {formatAttachmentSize(chip.size)}
                    {chip.text === null ? " · binary" : ""}
                  </TypeCaption>
                ) : null}
              </View>
              <Pressable
                accessibilityLabel={`Remove ${chip.name}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setAttachments((prev) => prev.filter((a) => a.id !== chip.id))}
                style={styles.chipX}
              >
                <X size={13} color={tokens.textTertiary} strokeWidth={2.4} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Message the agent"
          accessibilityHint={
            running
              ? "A turn is running — queue behind it or stop it"
              : mode === "offline"
                ? "The host is offline — the message will be sent when it returns"
                : "Send this message to the agent on the desktop"
          }
          multiline
          value={draft}
          onChangeText={onDraftChange}
          onSelectionChange={(event) => {
            caretRef.current = event.nativeEvent.selection.end;
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onContentSizeChange={(event) => {
            const height = event.nativeEvent.contentSize.height;
            setInputHeight(Math.min(height, MAX_INPUT_HEIGHT));
          }}
          placeholder={running ? "Queue a message behind the running turn…" : "Message the agent…"}
          placeholderTextColor={tokens.textTertiary}
          style={[
            styles.input,
            {
              backgroundColor: tokens.card,
              borderColor: focused ? tokens.accent : tokens.inputBorder,
              borderTopColor: tokens.clayTopEdge,
              color: tokens.text,
              fontFamily: fontFamily.medium,
            },
            inputHeight !== null ? { height: inputHeight + 16 } : null,
          ]}
        />
        {running ? (
          <View style={styles.runningButtons}>
            <Pressable
              accessibilityLabel="Queue this message behind the running turn"
              accessibilityRole="button"
              accessibilityState={canSend ? undefined : { disabled: true }}
              disabled={!canSend}
              onPress={() => void queueNow()}
              style={({ pressed }) => [
                styles.queueButton,
                {
                  backgroundColor: tokens.card,
                  borderTopColor: tokens.clayTopEdge,
                  borderColor: pressed ? pressTint(tokens.card, tokens.isDark) : tokens.borderStrong,
                  opacity: canSend ? 1 : 0.45,
                },
              ]}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={tokens.textSecondary} />
              ) : (
                <ListPlus size={TYPE_BODY + 3} color={tokens.textSecondary} strokeWidth={2} />
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="Stop the running turn"
              accessibilityRole="button"
              onPress={onStop}
              style={({ pressed }) => [
                styles.stopButton,
                {
                  borderColor: tokens.danger,
                  backgroundColor: pressed ? pressTint(tokens.card, tokens.isDark) : "transparent",
                },
              ]}
            >
              <Square size={TYPE_BODY - 2} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
              <Text style={[styles.stopLabel, { color: tokens.danger }]}>Stop</Text>
            </Pressable>
          </View>
        ) : (
          // The send CTA — the sanctioned chrome circle (§2.2): accent fill
          // + the quiet vertical sheen, one glint, never a mirror.
          <Pressable
            accessibilityLabel={mode === "offline" ? "Save the message to send later" : "Send the message"}
            accessibilityRole="button"
            accessibilityState={canSend ? undefined : { disabled: true }}
            disabled={!canSend}
            onPress={() => void sendNow()}
            style={({ pressed }) => [
              styles.sendButton,
              {
                backgroundColor: canSend ? tokens.accent : tokens.subtleHover,
                transform: [{ scale: pressed && canSend ? 0.96 : 1 }],
              },
            ]}
          >
            {canSend ? (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <LinearGradient
                  colors={[tokens.sheenTop, tokens.sheenBottom]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={styles.sendSheen}
                />
              </View>
            ) : null}
            {uploading ? (
              <ActivityIndicator size="small" color={canSend ? tokens.accentText : tokens.textTertiary} />
            ) : (
              <ArrowUp size={TYPE_BODY + 6} color={canSend ? tokens.accentText : tokens.textTertiary} strokeWidth={2.4} />
            )}
          </Pressable>
        )}
      </View>

      {/* THE CONTROL ROW — the desktop toolbar's one-row contract, clay pills. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.controlRow}
        contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.md }}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Composer tools"
      >
        <ControlPill
          label=""
          icon={<Plus size={14} color={tokens.accent} strokeWidth={2.4} />}
          accessibilityLabel="Attach a file or choose one from the project"
          onPress={() => {
            setSheet("attach");
            loadTree();
          }}
        />
        <ControlPill
          label={modeLabel}
          icon={<Zap size={13} color={tokens.accent} strokeWidth={2.2} />}
          accessibilityLabel={`Operating mode: ${modeLabel}`}
          chevron
          onPress={() => setSheet("mode")}
        />
        <ControlPill
          label={ctxPct !== null ? `${ctxPct}%` : "ctx"}
          icon={<ContextRing pct={ctxPct ?? 0} pressure={ctxPressure} />}
          accessibilityLabel={
            contextReport !== null
              ? `Context usage ${ctxPct}% of ${formatTokens(contextReport.contextWindow)} tokens`
              : "Context usage"
          }
          chevron
          onPress={() => {
            refreshContext();
            setSheet("context");
          }}
        />
        <ControlPill
          label={modelLabel}
          icon={<Cpu size={13} color={tokens.accent} strokeWidth={2.2} />}
          accessibilityLabel={`Model: ${modelLabel}`}
          chevron
          onPress={() => setSheet("model")}
        />
        <ControlPill
          label={thinkingLabel}
          icon={<Brain size={13} color={thinkingSpec.unsupported ? tokens.textTertiary : tokens.accent} strokeWidth={2.2} />}
          accessibilityLabel={`Thinking level: ${thinkingLabel}`}
          disabled={thinkingSpec.unsupported}
          chevron={!thinkingSpec.unsupported}
          onPress={() => setSheet("thinking")}
        />
      </ScrollView>

      {/* ── the sheets ─────────────────────────────────────────────────────── */}

      <Sheet open={sheet === "attach"} onClose={() => setSheet(null)} title="Add context">
        <SheetRow
          icon={<Plus size={15} color={tokens.accent} strokeWidth={2.3} />}
          title="Attach a file"
          caption="Pick any file from this device — images ride to the agent's project"
          onPress={() => {
            setSheet(null);
            void pickDeviceFile();
          }}
        />
        <SheetRow
          icon={<FileText size={15} color={tokens.accent} strokeWidth={2.3} />}
          title="Choose from project…"
          caption={projectId === null ? "this session has no project" : "the project's own files"}
          disabled={projectId === null}
          onPress={() => {
            setFileQuery("");
            setSheet("files");
            loadTree();
          }}
        />
        <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
          typing “@” in the message quick-picks project files too
        </TypeCaption>
      </Sheet>

      <Sheet open={sheet === "files"} onClose={() => setSheet(null)} title="Choose from project">
        <View style={[styles.fileSearch, { backgroundColor: tokens.inputBg, borderColor: tokens.inputBorder }]}>
          <Search size={14} color={tokens.textTertiary} strokeWidth={2.2} />
          <TextInput
            accessibilityLabel="Search project files"
            value={fileQuery}
            onChangeText={setFileQuery}
            placeholder="search files…"
            placeholderTextColor={tokens.textTertiary}
            style={{ flex: 1, color: tokens.text, fontFamily: fontFamily.medium, paddingVertical: 0 }}
          />
        </View>
        {treeFiles === null ? (
          <View style={styles.sheetBusy}>
            <ActivityIndicator size="small" color={tokens.accent} />
            <TypeCaption style={{ color: tokens.textTertiary }}>loading the project tree…</TypeCaption>
          </View>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {filterProjectFiles(treeFiles, fileQuery, 60).map((path) => (
              <Pressable
                key={path}
                accessibilityLabel={`Attach ${path}`}
                accessibilityRole="button"
                onPress={() => {
                  setSheet(null);
                  void attachPaths([path], "project");
                }}
                style={({ pressed }) => [
                  styles.atRow,
                  { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
                ]}
              >
                <FileText size={13} color={tokens.textSecondary} strokeWidth={2} />
                <TypeMono style={{ color: tokens.text, flex: 1 }} numberOfLines={1}>
                  {path}
                </TypeMono>
              </Pressable>
            ))}
            {filterProjectFiles(treeFiles, fileQuery, 60).length === 0 && (
              <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs, paddingVertical: spacing.md }}>
                no files match
              </TypeCaption>
            )}
          </ScrollView>
        )}
      </Sheet>

      <Sheet open={sheet === "mode"} onClose={() => setSheet(null)} title="Operating mode">
        {MODE_OPTIONS.map((option) => (
          <SheetRow
            key={option.id}
            icon={<Zap size={15} color={option.id === permissionMode ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
            title={option.label}
            caption={option.description}
            selected={option.id === permissionMode}
            onPress={() => {
              if (option.id !== permissionMode) onPermissionModeChange(option.id);
              setSheet(null);
            }}
          />
        ))}
        {projectId !== null && modes !== null && modes.length > 0 && (
          <>
            <View style={{ height: spacing.sm }} />
            <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
              task mode — the agent's working posture
            </TypeCaption>
            <SheetRow
              icon={<Bot size={15} color={activeMode === null ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
              title="None"
              caption="no task mode pinned — the agent picks its own posture"
              selected={activeMode === null}
              onPress={() => {
                if (activeMode !== null) onActiveModeChange(null);
                setSheet(null);
              }}
            />
            {modes.map((m) => (
              <SheetRow
                key={m.id}
                icon={<Bot size={15} color={activeMode === m.id ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
                title={m.name}
                caption={m.description}
                selected={activeMode === m.id}
                onPress={() => {
                  if (activeMode !== m.id) onActiveModeChange(m.id);
                  setSheet(null);
                }}
              />
            ))}
          </>
        )}
      </Sheet>

      <Sheet open={sheet === "model"} onClose={() => setSheet(null)} title="Model">
        <SheetRow
          icon={<Cpu size={15} color={modelOverride === null && selectedModel === null ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
          title="Auto (session default)"
          caption={
            selectedModel === null
              ? "the session agent's own model"
              : "clears the session's selected model back to the agent default"
          }
          selected={modelOverride === null && selectedModel === null}
          onPress={() => pickModel(null)}
        />
        {models === null ? (
          <View style={styles.sheetBusy}>
            <ActivityIndicator size="small" color={tokens.accent} />
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {connected ? "loading the configured models…" : "the host is offline"}
            </TypeCaption>
          </View>
        ) : (
          models
            .filter((m) => !m.hidden)
            .map((m) => (
              <SheetRow
                key={m.id}
                icon={<Cpu size={15} color={isModelInPlay(modelOverride, selectedModel, m) ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
                title={m.displayName ?? m.modelId}
                caption={`${providerName(m.providerId)}${m.contextWindow !== null ? ` · ${formatTokens(m.contextWindow)} ctx` : ""}`}
                selected={isModelInPlay(modelOverride, selectedModel, m)}
                onPress={() => pickModel({ model: m.modelId, providerId: m.providerId })}
              />
            ))
        )}
      </Sheet>

      <Sheet open={sheet === "thinking"} onClose={() => setSheet(null)} title="Thinking level">
        {thinkingSpec.unsupported ? (
          <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
            this model does not support reasoning
          </TypeCaption>
        ) : (
          <>
            {thinkingSpec.options.map((option) => (
              <SheetRow
                key={option.id}
                icon={<Brain size={15} color={option.id === displayedThinkingLevel ? tokens.accent : tokens.textSecondary} strokeWidth={2.3} />}
                title={option.label}
                caption={
                  option.description +
                  (option.id === thinkingSpec.defaultRow && option.id !== "default"
                    ? " · the model's default"
                    : "")
                }
                selected={option.id === displayedThinkingLevel}
                onPress={() => {
                  pickThinking(option.id);
                  setSheet(null);
                }}
              />
            ))}
            {thinkingSpec.note !== null && (
              <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
                {thinkingSpec.note}
              </TypeCaption>
            )}
          </>
        )}
      </Sheet>

      <Sheet open={sheet === "context"} onClose={() => setSheet(null)} title="Context usage">
        {contextReport === null ? (
          <View style={styles.sheetBusy}>
            <ActivityIndicator size="small" color={tokens.accent} />
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {connected ? "reading the meter…" : "the host is offline"}
            </TypeCaption>
          </View>
        ) : (
          <ContextBreakdown report={contextReport} />
        )}
      </Sheet>
    </View>
  );
}

// ── the control pill + the context ring ─────────────────────────────────────

function ControlPill({
  label,
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  chevron = false,
}: {
  label: string;
  icon: React.ReactNode;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  chevron?: boolean;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.controlPill,
        {
          backgroundColor: pressed ? tokens.subtleHover : tokens.pillBg,
          borderColor: tokens.border,
          opacity: disabled ? 0.55 : 1,
        },
      ]}
    >
      {icon}
      {label !== "" && (
        <Text style={{ color: tokens.textSecondary, fontSize: TYPE_CAPTION, fontFamily: fontFamily.semibold }} numberOfLines={1}>
          {label}
        </Text>
      )}
      {chevron ? <ChevronDown size={11} color={tokens.textTertiary} strokeWidth={2.2} /> : null}
    </Pressable>
  );
}

/** The meter's tiny ring — a 20px SVG donut, pressure-colored like the
 * desktop's (accent → amber at 60% → danger past 85%). */
function ContextRing({ pct, pressure }: { pct: number; pressure: string }) {
  const { tokens } = useTheme();
  const color =
    pressure === "danger"
      ? tokens.danger
      : pressure === "filling"
        ? tokens.warning
        : pressure === "comfortable"
          ? tokens.accent
          : tokens.borderStrong;
  const size = 16;
  const stroke = 2.4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={tokens.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </View>
  );
}

// ── sheet rows + the context breakdown ──────────────────────────────────────

function SheetRow({
  icon,
  title,
  caption,
  selected = false,
  disabled = false,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  caption?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityLabel={caption !== undefined ? `${title} — ${caption}` : title}
      accessibilityRole="button"
      accessibilityState={{
        selected,
        ...(disabled ? { disabled: true } : {}),
      }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetRow,
        {
          backgroundColor: pressed ? tokens.subtleHover : "transparent",
          borderColor: selected ? tokens.accent : tokens.borderSubtle,
          opacity: disabled ? 0.55 : 1,
        },
      ]}
    >
      {icon}
      <View style={{ flex: 1, gap: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Text style={{ color: tokens.text, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold, flex: 1 }} numberOfLines={1}>
            {title}
          </Text>
          {selected ? <Check size={14} color={tokens.accent} strokeWidth={2.6} /> : null}
        </View>
        {caption !== undefined ? (
          <Text style={{ color: tokens.textTertiary, fontSize: TYPE_CAPTION - 1, fontFamily: fontFamily.regular }} numberOfLines={2}>
            {caption}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The full context breakdown — the desktop donut popover's sections, restated
 * as the phone's sheet (every number labeled estimate vs provider-measured). */
function ContextBreakdown({ report }: { report: SessionContextReport }) {
  const { tokens } = useTheme();
  const pct = contextPercent(report.usedTokens, report.contextWindow);
  const pressure = contextPressure(report.usedTokens, report.contextWindow);
  const barColor =
    pressure === "danger" ? tokens.danger : pressure === "filling" ? tokens.warning : tokens.accent;
  const slices: Array<[string, number]> = [
    ["messages", report.breakdown.messages],
    ["system prompt", report.breakdown.systemPrompt],
    ["tools + schemas", report.breakdown.systemTools],
    ["memory", report.breakdown.memory],
    ["meta (index + rules)", report.breakdown.meta],
    ["mcp tools", report.breakdown.mcpTools],
  ];
  return (
    <View style={{ gap: spacing.md }}>
      <ClayCard small style={{ padding: spacing.md, gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
          <TypeBodyStrong style={{ color: tokens.text }}>{pct}%</TypeBodyStrong>
          <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
            {formatTokens(report.usedTokens)} of {formatTokens(report.contextWindow)} ·{" "}
            {formatTokens(report.available)} available
          </TypeCaption>
        </View>
        <View style={[styles.meterTrack, { backgroundColor: tokens.subtle }]}>
          <View style={[styles.meterFill, { width: `${pct}%`, backgroundColor: barColor }]} />
        </View>
        <TypeCaption style={{ color: tokens.textTertiary, fontSize: TYPE_MICRO }}>
          {report.usedTokensBasis} · window: {formatTokens(report.contextWindow)} (
          {contextWindowSourceCaption(report.contextWindowSource)}) · max out{" "}
          {formatTokens(report.maxOutputTokens)}
        </TypeCaption>
        <TypeMono style={{ color: tokens.textTertiary, fontSize: 10.5 }} numberOfLines={1}>
          {report.model} · {report.providerId}
        </TypeMono>
      </ClayCard>

      <View style={{ gap: spacing.xs }}>
        {slices
          .filter(([, value]) => value > 0)
          .map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm, paddingHorizontal: spacing.xs }}>
              <TypeCaption style={{ color: tokens.textSecondary, flex: 1 }} numberOfLines={1}>
                {label}
              </TypeCaption>
              <TypeMono style={{ color: tokens.textTertiary, fontSize: 11 }}>{formatTokens(value)}</TypeMono>
            </View>
          ))}
      </View>

      {report.actual !== null && (
        <View style={{ gap: spacing.xs }}>
          <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
            provider-measured, last request
          </TypeCaption>
          <View style={{ flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.xs }}>
            <Badge tone="accent">↑ {formatTokens(report.actual.inputTokens)}</Badge>
            <Badge tone="neutral">↓ {formatTokens(report.actual.outputTokens)}</Badge>
            {report.actual.cachedInputTokens !== null && (
              <Badge tone="success">cached {formatTokens(report.actual.cachedInputTokens)}</Badge>
            )}
          </View>
        </View>
      )}

      {report.compaction !== undefined && (
        <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
          context compacted — {report.compaction.droppedMessages} messages summarized (~
          {formatTokens(report.compaction.tokensSaved)} tokens saved)
        </TypeCaption>
      )}

      <View style={{ gap: spacing.xs }}>
        <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
          session totals (main + sub-agents)
        </TypeCaption>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingHorizontal: spacing.xs }}>
          <Badge tone="neutral">↑ {formatTokens(report.usage.combined.inputTokens)}</Badge>
          <Badge tone="neutral">↓ {formatTokens(report.usage.combined.outputTokens)}</Badge>
          <Badge tone="neutral">{report.usage.combined.requests} turns</Badge>
          <Badge tone="neutral">{formatUsd(report.usage.combined.costUsd)}</Badge>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingHorizontal: spacing.xs }}>
          <Badge tone="accent">main {formatUsd(report.usage.main.costUsd)}</Badge>
          <Badge tone="warning">sub-agents {formatUsd(report.usage.subagents.costUsd)}</Badge>
        </View>
        {report.cache.hitRate !== null && (
          <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }}>
            cache hit rate {Math.round(report.cache.hitRate * 100)}%
          </TypeCaption>
        )}
      </View>
    </View>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MAX_INPUT_HEIGHT = 5 * 21 + 16; // ~5 lines at 21pt line height + padding

/** The model pill's compact label — the display name when one exists, else a
 * shortened model id (the desktop's graduated shrink, phone-sized). */
function shortModelLabel(modelId: string, models: ModelRecord[] | null): string {
  const row = models?.find((m) => m.modelId === modelId);
  if (row !== undefined && row.displayName !== null && row.displayName.trim() !== "") {
    return row.displayName.trim().slice(0, 18);
  }
  const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  return bare.length > 20 ? `${bare.slice(0, 19)}…` : bare;
}

function isModelSelected(override: ModelOverride | null, m: ModelRecord): boolean {
  return override !== null && override.model === m.modelId && override.providerId === m.providerId;
}

/** R114-d — the model row's "in play" truth: the local override when set,
 * else the session's SERVER-side selectedModel (the row the other devices
 * see). The sheet marks the tier that actually answers the next send. */
function isModelInPlay(
  override: ModelOverride | null,
  selectedModel: { providerId: string; model: string } | null,
  m: ModelRecord,
): boolean {
  if (override !== null) return isModelSelected(override, m);
  return selectedModel !== null && selectedModel.model === m.modelId && selectedModel.providerId === m.providerId;
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    gap: spacing.sm,
  },
  chipRow: {
    alignItems: "center",
  },
  chip: {
    borderRadius: RADIUS_ROUND,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  chipX: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  atPicker: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
    boxShadow: "0px 2px 10px rgba(42,32,24,0.12)",
  },
  atRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
  },
  attachRow: {
    flexGrow: 0,
  },
  attachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: 6,
    boxShadow: "0px 1px 2px rgba(42,32,24,0.08)",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: TYPE_BODY,
    lineHeight: 21,
    minHeight: 50,
  },
  sendButton: {
    width: 50,
    height: 50,
    borderRadius: RADIUS_ROUND,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  sendSheen: {
    flex: 1,
    height: "60%",
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
  },
  runningButtons: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  queueButton: {
    width: 50,
    height: 50,
    borderRadius: RADIUS_ROUND,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    height: 50,
    paddingHorizontal: spacing.md,
    borderRadius: RADIUS_ROUND,
    borderWidth: 1,
    justifyContent: "center",
  },
  stopLabel: {
    fontSize: TYPE_CAPTION + 2,
    fontFamily: fontFamily.semibold,
  },
  controlRow: {
    flexGrow: 0,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs + 1,
    minHeight: TOUCH_TARGET,
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET + 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  sheetBusy: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.xs,
  },
  fileSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  meterTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  meterFill: {
    height: "100%",
    borderRadius: 3,
  },
});
