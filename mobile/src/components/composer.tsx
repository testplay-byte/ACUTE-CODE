/**
 * Composer v3 (R113-c → R115-I → R116-l → R118-D → R119-B → R120-P) — the
 * session screen's minimal dock (chat.md §Composer): EXACTLY THREE visible
 * controls — the ONE growing PILL TextInput (max ~6 lines; the PAPERCLIP
 * DOCKS INSIDE the input's own surface at its bottom-right corner — R120-P;
 * the R119-B sibling-beside circle, the R116-l in-bar overlay, and the
 * R118-D two-tier band are all superseded/deleted) · SEND (the sanctioned
 * chrome circle) / Stop + Queue while a turn runs. THE CONTROL
 * PILL ROW IS DELETED (R115-I): the operating-mode / model / thinking /
 * context controls live in the header's kebab DROPDOWN — and since R118-D
 * the dropdown renders their LEVELS IN PLACE (its own sub-panel grammar);
 * this component keeps the DATA + the picks, controlled through the props:
 *
 *   · sheet / onSheetChange — the CONTROLLED sheet state (R118-D: narrowed
 *     to "attach" | "files" — the mode/model/thinking/context SHEETS are
 *     deleted; the kebab's menu owns those levels now);
 *   · onControlsSnapshot — the v2 report the menu's levels render (the live
 *     labels + the model sections + the thinking spec + the context report
 *     + the stable pick callbacks);
 *   · ATTACHMENTS: the attach circle (R119-B — the paperclip's own 40dp
 *     quiet Pressable BESIDE the input) opens the attach sheet (pick a file
 *     from the device through expo-document-picker, or choose from the
 *     project's own files) and typing "@" quick-picks project files exactly
 *     like the desktop; chips (name · size · X) ride the send as the wire's
 *     attachments array, with picked binaries uploaded through POST
 *     /attachments/upload at send time (the desktop's R67-A pipeline);
 *   · MODE: the desktop's exact per-session PATCH (full/ask/plan) — the menu
 *     applies it through onPermissionModeChange;
 *   · MODEL (R114-d's honest ladder, R118-D's menu shape): the local
 *     per-send override → the session's server-side selectedModel → the
 *     context report's effective model → "—" only when NOTHING is known
 *     ("Auto"/"Agent default" never appear — copy.md + donts #36). A pick
 *     writes BOTH tiers: the per-send override (persisted per session,
 *     rides the send) AND PATCH /sessions/:id {model} (the server-side
 *     truth); tapping the row that's in play via the SESSION-SELECTED tier
 *     (not the override) clears both — the PATCH-null path, reachable ONLY
 *     there;
 *   · THINKING: the desktop's exact level vocabulary + model-aware menu
 *     (detected reasoning ladders); rides the send as thinkingLevel;
 *   · CONTEXT: the meter stays fed (GET /sessions/:id/context, 2.5s live
 *     cadence while a turn runs) and now reports through the snapshot —
 *     the menu's Context level renders the compact readout.
 *
 * While a turn runs, Send becomes Stop (+ Queue); while the link is offline,
 * Send lands the message in the outbox (overrides ride the flush). The
 * outbox chip keeps its DISMISS affordance. Keyboard-wise the Composer is a
 * PASSENGER of the session screen's dock (R115-K): this root View sits
 * inside the dock's Animated.View whose ONE expression — paddingBottom =
 * max(insetsBottom, kbHeight) + the R120-P edge beat — lifts EVERYTHING
 * here clear of the keys AND off the device edge.
 * R118-D adds exactly ONE keyboard behavior of its own: keyboardDidHide →
 * inputRef.blur() (the selection clear — the draft persists, the handles
 * die). Touch targets ≥ 44px; the send haptic.
 *
 * ROUND-116 (R116-l — the pill bar, chat.md §Composer amendment): the input
 * is a PILL — RADIUS_ROUND while single-line, switching to RADIUS_BAR once
 * the content grows past the 44px resting height (no radius animation — the
 * conditional reads the same height arithmetic that drives the growth).
 *
 * ROUND-118 (R118-D — the geometry pass): the growth is now NATIVE (the
 * controlled-height + flex:1 pair is deleted — the classic Android desync
 * fragility; a multiline TextInput with only min/max grows on its own and
 * scrolls past the cap): minHeight 44 + onContentSizeChange flipping the
 * `inputTall` boolean (threshold 24). The focus ring goes 1.5dp. The stop
 * button is ICON-ONLY (50×50 circle, Square 15 — the label is deleted); the
 * queue button renders ONLY when there IS something to send (the disabled
 * arm + the 0.45 opacity die). [The two-tier attach geometry this round
 * shipped — resting 52/10, tall 16/40 over a 40px ATTACH_BAND, cap 176 — is
 * SUPERSEDED by R119-B below.]
 *
 * ROUND-119 (R119-B — the SINGLE-TIER dock): the owner's v0.112.0 verdict —
 * the composer is "way too much taller in its height", and the text "would
 * be typed on the left side of the add file option, but apparently it was
 * being typed above it" (the R118 two-tier geometry put the grown text
 * full-width ABOVE the paperclip's reserved band — rejected). The bar is
 * now ONE ROW, ALWAYS: [the TextInput (flex:1 — the pill/bar, text LEFT of
 * the add-file control in EVERY state)] [the attach CIRCLE — its OWN 40dp
 * QuietIconButton-style Pressable BESIDE the input, never an overlay inside
 * it] [send | stop + queue 50dp circles], all with alignItems flex-end so
 * the circles ride the input's last line. The paperclip's absolute overlay,
 * the ATTACH_BAND reserved space, and the two-tier paddingRight/paddingBottom
 * swap are DELETED (the input's horizontal padding is the constant
 * spacing.lg), and the growth cap falls 176 → 146 (6 lines × 21 + 2 × 10 —
 * the band is gone). The pill→bar radius swap on `inputTall` STAYS, and the
 * dock's root padding tightens 8/4 → 4/2 (the resting dock was too heavy).
 *
 * ROUND-120 (R120-P — the docked Add Context control + the wrap law): the
 * owner's §H report completes the single-tier law's geometry — "The Add
 * Context control sits OUTSIDE the 'Message the Agent' area — move it
 * inside, at the far right of the input row," and the text ADAPTS AROUND
 * it: "If the text is showing above it (on the line above it), then the
 * text can show above it because above the 'Add Context' button there is
 * empty area… But if the text is shown on the same line as the 'Add
 * Context' button, then the text will be shown on the left side of it…
 * the text will never overlap with the 'Add Context' button." The control
 * DOCKS INSIDE the input's own visual surface: the inputWrap (flex:1,
 * relative) hosts the TextInput and the 40dp attach circle absolutely
 * pinned at the input's BOTTOM-RIGHT corner (right/bottom inset 4/2 —
 * centered at rest, riding the last line when tall), and the input's
 * paddingRight reserves the control's column (ATTACH_DOCK_PADDING_RIGHT =
 * inset 4 + circle 40 + gap 8 = 52) so text NEVER overlaps it — the RN
 * spelling of the wrap law (a TextInput has no per-line float, so the
 * reservation holds on EVERY line; multiline text flows in the region
 * above/left of the dock, the column over the control stays clear). The
 * row stays ONE TIER: [input+control (flex:1)][send|queue|stop 50] — no
 * reserved band, no text-above-the-band. The attach circle keeps its own
 * testID/hitSlop/quiet-circle grammar (composer-attach). ALSO this round:
 * the @-mention menu opens RELIABLY (Android fires onChangeText before
 * onSelectionChange — the stale caret never saw the fresh "@"; the
 * advancedCaret helper + the selection-change re-detect fix it, and the
 * menu now shows its busy/no-match rows instead of vanishing), the
 * attachment chips carry IMAGE THUMBNAILS (a picked image's own localUri)
 * and tapping ANY chip opens the AttachmentViewer (image → the full-screen
 * ImageViewer; text → the scrollable mono card; binary → the honest
 * name/size card), and the dock's bottom beat lives in the session
 * screen's dock expression (see [id].tsx — item 28).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { KeyboardEvents } from "react-native-keyboard-controller";
import {
  ArrowUp,
  Check,
  FileText,
  ListPlus,
  Paperclip,
  Plus,
  Search,
  Square,
  X,
} from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption, TypeMono } from "@/design/primitives";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import { Sheet } from "@/components/sheet";
import { AttachmentViewer } from "@/components/attachment-viewer";
import {
  pressTint,
  RADIUS_BAR,
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
  advancedCaret,
  attachmentFromRead,
  detectAtToken,
  fetchProjectTree,
  filterProjectFiles,
  flattenTreeFiles,
  formatAttachmentSize,
  isImageFileName,
  MAX_ATTACHMENTS,
  readAttachmentFiles,
  stageAttachments,
  stripAtToken,
  toMessageAttachment,
  uploadAttachmentBytes,
  type ComposerAttachment,
} from "@/features/attachments";
import {
  contextPercent,
  fetchSessionContext,
  type SessionContextReport,
} from "@/features/context-meter";
import {
  thinkingMenuSpec,
  thinkingOption,
  displayThinkingLevel,
  type ModelOverride,
  type ThinkingLevel,
  type ThinkingOption,
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

/** The composer's sheets — R118-D: NARROWED to the attach pair (the kebab's
 * menu renders the mode/model/thinking/context levels in place now; their
 * bottom sheets are deleted). null = closed. */
export type ComposerSheet = "attach" | "files";

/** R118-D — one model row of the menu's MODEL level (the pick's payload +
 *  the row's own label + the in-play check). */
export interface MenuModelRow {
  /** The ModelRecord's stable id (the row key). */
  key: string;
  /** The full model id — the pick's wire value. */
  model: string;
  /** The provider whose catalog the model was picked from. */
  providerId: string;
  /** The row's label (shortModelLabel — one line). */
  label: string;
  /** The three-tier in-play truth (override → session row → the report). */
  selected: boolean;
}

/** R118-D — one provider's slice of the menu's MODEL level. */
export interface MenuModelSection {
  providerId: string;
  /** The provider's display name (the registry row's name). */
  label: string;
  rows: MenuModelRow[];
}

/** R115-I → R118-D — the live control values + content the session screen's
 * kebab menu renders: the honest model ladder's short label, the
 * model-aware thinking label, the context meter's percentage (null = no
 * reading yet), plus the menu's own data (the model sections, the thinking
 * spec, the context report) and the STABLE pick callbacks — the menu owns
 * the levels, this report feeds them. */
export interface ComposerControlsSnapshot {
  modelLabel: string;
  thinkingLabel: string;
  ctxPct: number | null;
  /** R118-D — the model level's sections (null while the catalog loads). */
  modelSections: MenuModelSection[] | null;
  /** R118-D — the thinking level's rows (the model-aware menu spec). */
  thinkingOptions: readonly ThinkingOption[];
  /** R118-D — true when the model takes no reasoning parameter at all. */
  thinkingUnsupported: boolean;
  /** R118-D — the level the thinking control DISPLAYS. */
  thinkingSelected: ThinkingLevel;
  /** R118-D — the context meter's own report (the Context level's readout). */
  contextReport: SessionContextReport | null;
  /** R118-D — the model pick (apply + PATCH; the checked session-selected
   *  row clears — the callback owns that rule). */
  pickModel: (row: MenuModelRow) => void;
  /** R118-D — the thinking pick (persists per session). */
  pickThinking: (level: ThinkingLevel) => void;
}

export interface ComposerProps {
  mode: ComposerMode;
  /** The pending outbox entries for THIS session (the dim chip). */
  outboxCount: number;
  sessionId: string;
  projectId: string | null;
  /** The session row's CURRENT operating mode (full|ask|plan). R118-D:
   *  the composer no longer renders it (the mode sheet is deleted; the
   *  kebab's menu level owns the picker) — the prop SURVIVES the frozen
   *  ComposerProps surface so the screen's call site rides unchanged. */
  permissionMode: string;
  /** R114-d — the session row's SERVER-SIDE selected model (the tier between
   * the per-send override and the agent row; null = follow the agent
   * default). The honest ladder's middle tier. */
  selectedModel: { providerId: string; model: string } | null;
  /** R115-I — the CONTROLLED sheet state: which of this component's sheets
   * is open (null = none). The session screen owns the value; the kebab's
   * rows + this component's own transitions write through onSheetChange. */
  sheet: ComposerSheet | null;
  /** R115-I — the controlled sheet state's write side (opens, transitions,
   * and closes — every pick closes). */
  onSheetChange: (sheet: ComposerSheet | null) => void;
  /** R115-I — the live control values report (fires only when a value
   * actually changes; the screen's referential guard keeps it calm). */
  onControlsSnapshot?: (snapshot: ComposerControlsSnapshot) => void;
  /** PATCH /sessions/:id/permissions — the screen owns the round-trip.
   *  R118-D: same freeze as `permissionMode` above — the menu's Mode level
   *  calls the SCREEN's own handler now; the composer keeps the prop for
   *  the unchanged ComposerProps surface. */
  onPermissionModeChange: (mode: "full" | "ask" | "plan") => void;
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

export function Composer({
  mode,
  outboxCount,
  sessionId,
  projectId,
  selectedModel,
  sheet,
  onSheetChange,
  onControlsSnapshot,
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
  // R118-D — the native auto-grow: the controlled inputHeight state is
  // DELETED (the classic Android desync source); this boolean is the ONLY
  // thing onContentSizeChange still flips (the radius swap + the tall
  // text's vertical alignment read it). The input ref serves the
  // keyboardDidHide blur.
  const [inputTall, setInputTall] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [atToken, setAtToken] = useState<{ at: number; end: number; query: string } | null>(null);
  const caretRef = useRef(0);
  // ── ROUND-120 (why): ── the owner's item 31 — "Typing @ opens a results
  // menu ABOVE the input". The draft's own ref mirror: onSelectionChange
  // re-runs the @ detection with the AUTHORITATIVE caret, and it must read
  // the value the input actually holds even when the event lands before
  // the setDraft commit re-renders.
  const draftRef = useRef("");
  const [note, setNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // ── ROUND-120 (why): ── the owner's item 32 — "tapping ANY attachment
  // opens a viewer pop-up". The chip being viewed (null = closed).
  const [viewing, setViewing] = useState<ComposerAttachment | null>(null);

  // The per-session send controls (persisted per session, desktop parity).
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("default");
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(null);

  // The fetched control data (cached per mount; honest failure captions).
  const [models, setModels] = useState<ModelRecord[] | null>(null);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
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
    // Mount-only hydrate (deliberately empty deps — the per-session reset
    // effect above owns every sessionId change; the R113-c directive naming
    // react-hooks/exhaustive-deps was dropped in R116-l because the mobile
    // workspace's lint program carries no react-hooks plugin, so the unknown
    // rule reference failed the --no-ignore gate).
  }, []);

  // ── the fetched data (connected-only, best-effort, honest on failure) ────

  // R115-I — the model sheet's provider grouping + the kebab's model label
  // both read these fetches (the sheet renders the busy row until they land).
  useEffect(() => {
    if (!connected) return;
    const sender = getLinkManager();
    void fetchConfiguredModels(sender).then((outcome) => {
      if (outcome.ok) setModels(outcome.data.models);
    });
    void fetchProviders(sender).then((outcome) => {
      if (outcome.ok) setProviders(outcome.data.providers);
    });
  }, [connected]);

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

  // ── R115-I — the CONTROLLED sheets' open-time side effects ────────────────
  // The session screen owns the open sheet; this effect re-triggers the
  // attach/files sheets' own lazy load exactly the way the old pill handler
  // did (the sheets prefetch the project tree). R118-D: the context sheet
  // is deleted — the meter keeps its own live cadence below, and the menu's
  // Context level reads the report through the snapshot.
  useEffect(() => {
    if (sheet === "attach" || sheet === "files") loadTree();
  }, [sheet, loadTree]);

  // R118-D — the selection clear (the owner's item 46): when the IME hides,
  // the input BLURS — the draft persists, the text handles + selection die
  // (the R115-K listeners only wrote kbHeight before). The dock architecture
  // is untouched; this adds exactly one listener.
  useEffect(() => {
    const hidden = KeyboardEvents.addListener("keyboardDidHide", () => {
      inputRef.current?.blur();
    });
    return () => hidden.remove();
  }, []);

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

  // R115-I → R118-D — the model level's MENU shape: the provider grouping
  // (groupModelsByProvider) re-cut into flat selectable rows — label via
  // shortModelLabel, the check via the FULL three-tier in-play ladder
  // (override → session row → the context report's effective model). The
  // grouping memo fed the deleted sheet's accordion; this memo feeds the
  // kebab menu's Model level through the snapshot.
  const menuModelSections = useMemo<MenuModelSection[] | null>(() => {
    if (models === null) return null;
    return groupModelsByProvider(models, providers).map((section) => ({
      providerId: section.providerId,
      label: section.label,
      rows: section.rows.map(
        (m): MenuModelRow => ({
          key: m.id,
          model: m.modelId,
          providerId: m.providerId,
          label: shortModelLabel(m.modelId, models),
          selected: isModelInPlay(modelOverride, selectedModel, contextReport, m),
        }),
      ),
    }));
  }, [models, providers, modelOverride, selectedModel, contextReport]);

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
              // ── ROUND-120 (why): ── the owner's item 32 — image
              // attachments get "a real preview chip": the picked file's
              // OWN local URI is the one byte source the phone holds — the
              // chip's thumbnail and the viewer's large preview both draw
              // from it.
              localUri: asset.uri,
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
            localUri: asset.uri,
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

  // ── ROUND-120 (why): ── the owner's item 31 — "Typing @ opens a results
  // menu ABOVE the input, filtering as the query continues". The ONE
  // detection path both change events ride (text + selection), so the
  // token state can never diverge from the caret's truth.
  const applyAtToken = useCallback(
    (value: string, caret: number): void => {
      const token = detectAtToken(value, caret);
      if (token !== null && treeFiles === null) loadTree();
      setAtToken(token);
    },
    [treeFiles, loadTree],
  );

  const pickAtMention = useCallback(
    (path: string): void => {
      if (atToken === null) return;
      const next = stripAtToken(draft, atToken);
      draftRef.current = next;
      caretRef.current = Math.min(caretRef.current, next.length);
      setDraft(next);
      setAtToken(null);
      void selectionHaptic();
      void attachPaths([path], "at");
    },
    [atToken, draft, attachPaths],
  );

  const onDraftChange = useCallback(
    (value: string): void => {
      // Android fires onChangeText BEFORE onSelectionChange — a caret
      // captured at the last selection event trails the character just
      // typed, so a fresh "@" in an empty field read caret 0 and the menu
      // never opened. advancedCaret moves with the edit; the selection
      // event re-detects with the authoritative caret right behind it.
      const caret = advancedCaret(caretRef.current, draftRef.current, value);
      draftRef.current = value;
      caretRef.current = caret;
      setDraft(value);
      setNote(null);
      applyAtToken(value, caret);
    },
    [applyAtToken],
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
      draftRef.current = "";
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
      draftRef.current = "";
      setAtToken(null);
      setAttachments([]);
      onQueue(content, overridesFor(staged));
    } finally {
      setUploading(false);
    }
  }, [canSend, uploading, draft, attachments, uploadStaged, onQueue, overridesFor]);

  // ── the send-control setters (persist per session, desktop parity) ───────

  const pickThinking = useCallback(
    (level: ThinkingLevel): void => {
      setThinkingLevel(level);
      void saveThinkingLevel(sessionId, level);
    },
    [sessionId],
  );

  // R118-D — the menu's model pick: apply + PATCH, both tiers (the old
  // pickModel's body, with the trailing onSheetChange(null) DELETED — the
  // kebab's menu owns the levels now, and the MENU decides when to return
  // to its main level). The checked session-selected row (no override in
  // play) CLEARS the selection — the PATCH-null path, reachable ONLY there
  // (donts #36: real models only).
  const pickModel = useCallback(
    (row: MenuModelRow): void => {
      const clear = row.selected && modelOverride === null && selectedModel !== null;
      const override = clear ? null : { model: row.model, providerId: row.providerId };
      setModelOverride(override);
      void saveModelOverride(sessionId, override);
      if (override !== null) void saveLastUsedModel(override);
      // R114-d — the pick is ALSO the session's server-side selected model
      // (PATCH /sessions/:id {model}): the other devices see the flip live
      // through the meta frame.
      if (onModelChange !== undefined) onModelChange(override);
    },
    [sessionId, onModelChange, modelOverride, selectedModel],
  );

  // ── render ────────────────────────────────────────────────────────────────

  // R114-d — THE HONEST MODEL LADDER: the local per-send override → the
  // session's server-side selectedModel → the context report's effective
  // model → "—" only when NOTHING is known (R116-l: the "Agent default"
  // label rung is retired with the sheet's row — donts #36; "Auto" never
  // appears as a model state — copy.md; the owner: "the Auto pill showed
  // Auto while PC had a model selected"). Every tier shortens through
  // shortModelLabel so long ids stay one label.
  const modelLabel =
    modelOverride !== null
      ? shortModelLabel(modelOverride.model, models)
      : selectedModel !== null
        ? shortModelLabel(selectedModel.model, models)
        : contextReport !== null && contextReport.model.trim() !== ""
          ? shortModelLabel(contextReport.model, models)
          : "—";
  const thinkingLabel = thinkingSpec.unsupported ? "Off" : thinkingOption(displayedThinkingLevel).label;
  const ctxPct = contextReport !== null ? contextPercent(contextReport.usedTokens, contextReport.contextWindow) : null;

  // R116-l → R118-D — the pill→bar switch: the input is TALL once its grown
  // content passes the 24px content threshold (44px resting height − the
  // 2×10 vertical padding — the same arithmetic that used to drive the
  // controlled height). `inputTall` is the ONE boolean onContentSizeChange
  // flips; the radius swap (RADIUS_ROUND → RADIUS_BAR) and the two-tier
  // attach geometry below read it (the radius itself never animates).

  // R115-I → R118-D — the live control-values report for the session
  // screen's kebab menu (its main rows display the labels; its sub-levels
  // render the sections/spec/report and call the picks). The callback is
  // referentially guarded on the screen's side — scalar-compare the labels,
  // reference-compare the memos/callbacks — so this fires only when
  // something actually changed.
  useEffect(() => {
    if (onControlsSnapshot === undefined) return;
    onControlsSnapshot({
      modelLabel,
      thinkingLabel,
      ctxPct,
      modelSections: menuModelSections,
      thinkingOptions: thinkingSpec.options,
      thinkingUnsupported: thinkingSpec.unsupported,
      thinkingSelected: displayedThinkingLevel,
      contextReport,
      pickModel,
      pickThinking,
    });
  }, [
    onControlsSnapshot,
    modelLabel,
    thinkingLabel,
    ctxPct,
    menuModelSections,
    thinkingSpec,
    displayedThinkingLevel,
    contextReport,
    pickModel,
    pickThinking,
  ]);

  return (
    <View style={[styles.root, { borderTopColor: tokens.borderSubtle }]}>
      {mode === "offline" && outboxCount === 0 && (
        <View style={styles.chipRow}>
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            host offline — messages will send when the host returns
          </TypeCaption>
        </View>
      )}
      {outboxCount > 0 && (
        <View style={styles.chipRow}>
          <View style={[styles.chip, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}>
            <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
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
          popup-over-the-caret pattern, restated for the phone's column). It's
          a plain sibling INSIDE the dock's column (R115-K): when the keys
          rise, the dock's animated paddingBottom lifts it together with the
          input row — no offset of its own.
          ── ROUND-120 (why): ── the owner's item 31 — "Typing @ opens a
          results menu ABOVE the input, filtering as the query continues;
          tapping inserts the file reference." The menu now opens the moment
          an active @ token exists — its busy row while the tree loads, its
          quiet "no files match" line when the query has no hits — instead
          of vanishing (a menu that disappears on "@" reads as broken, the
          exact report that spawned this item). */}
      {atToken !== null && (
        <View style={[styles.atPicker, { backgroundColor: tokens.card, borderColor: tokens.border, borderTopColor: tokens.clayTopEdge, boxShadow: tokens.clayShadow2 }]}>
          <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.md, paddingTop: spacing.xs }} numberOfLines={1}>
            project files
          </TypeCaption>
          {treeFiles === null ? (
            <View style={styles.atBusy}>
              <ActivityIndicator size="small" color={tokens.accent} />
              <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
                {projectId === null
                  ? "this session has no project"
                  : connected
                    ? "loading the project tree…"
                    : "the host is offline"}
              </TypeCaption>
            </View>
          ) : atMatches.length === 0 ? (
            <View style={styles.atEmpty}>
              <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
                no files match
              </TypeCaption>
            </View>
          ) : (
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
          )}
        </View>
      )}

      {/* Staged attachment chips (cleared on send).
          ── ROUND-120 (why): ── the owner's item 32 — "images get a real
          preview chip" (a picked image's OWN localUri draws a 28dp rounded
          thumbnail in place of the glyph — project-read files keep the
          glyph: their bytes live on the host and never crossed to the
          phone) and "tapping ANY attachment opens a viewer pop-up" (the
          whole chip is the affordance; the X keeps its own nested target
          so a remove never opens the viewer). */}
      {attachments.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.attachRow} contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.md }}>
          {attachments.map((chip) => {
            const thumb =
              chip.localUri !== undefined && isImageFileName(chip.name) ? chip.localUri : null;
            return (
              <Pressable
                key={chip.id}
                accessibilityLabel={`View ${chip.name}`}
                accessibilityRole="button"
                onPress={() => setViewing(chip)}
                style={({ pressed }) => [
                  styles.attachChip,
                  {
                    backgroundColor: pressed ? tokens.subtleHover : tokens.card,
                    borderColor: tokens.border,
                    borderTopColor: tokens.clayTopEdge,
                    boxShadow: tokens.clayShadowSm,
                  },
                ]}
              >
                {thumb !== null ? (
                  <Image source={{ uri: thumb }} style={styles.attachThumb} resizeMode="cover" />
                ) : (
                  <FileText size={12} color={tokens.textSecondary} strokeWidth={2} />
                )}
                <View style={{ maxWidth: 148 }}>
                  <TypeCaption style={{ color: tokens.text }} numberOfLines={1}>
                    {chip.name}
                  </TypeCaption>
                  {chip.size > 0 ? (
                    <TypeCaption style={{ color: tokens.textTertiary, fontSize: TYPE_MICRO - 0.5 }} numberOfLines={1}>
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
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* R116-l → R118-D → R119-B → R120-P — THE SINGLE-TIER PILL BAR (chat.md
          §Composer amendment): ONE ROW, ALWAYS — [the inputWrap (flex:1 — the
          pill/bar input with the attach control DOCKED INSIDE its surface)]
          [send circle / stop+queue 50], the row's alignItems flex-end so the
          circles ride the input's last line as it grows. The input is a PILL
          (RADIUS_ROUND) while single-line and switches to the BAR radius
          (RADIUS_BAR, 28) once the content passes the 24px content threshold;
          the growth is NATIVE (no controlled height — minHeight 44 /
          maxHeight 146, a multiline TextInput with only min/max grows on its
          own and scrolls past the cap), and onContentSizeChange flips ONLY
          the inputTall boolean (the radius swap + the tall text's top
          alignment read it).
          ── ROUND-120 (why): ── the owner's items 29+30 — "The Add Context
          control sits OUTSIDE the 'Message the Agent' area — move it
          inside, at the far right of the input row," with the text
          adapting around it: same-line text flows LEFT of the control,
          text above it may occupy the empty area above it, and "the text
          will never overlap with the 'Add Context' button." The 40dp
          control is an INLINE-DOCKED element at the input's BOTTOM-RIGHT
          corner (the R119-B sibling circle superseded — it rode BESIDE the
          pill); the input's paddingRight reserves its column on every line
          (ATTACH_DOCK_PADDING_RIGHT — the RN spelling of the wrap law: a
          TextInput has no per-line float, so the never-overlap guarantee
          holds on every line and multiline text flows in the region
          above/left of the dock). The single-tier law itself STANDS: no
          reserved band under the text, no full-width text above a band —
          the control shares the LAST line. */}
      <View style={styles.row}>
        <View style={styles.inputWrap}>
          <TextInput
            ref={inputRef}
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
              // ── ROUND-120 (why): ── the authoritative caret event — the
              // @ detection re-runs HERE too (item 31), so a stale
              // onChangeText caret can never leave the menu shut.
              const caret = event.nativeEvent.selection.end;
              caretRef.current = caret;
              applyAtToken(draftRef.current, caret);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onContentSizeChange={(event) => {
              // R118-D — the ONLY survivor of the controlled-height era:
              // flip the boolean (React bails on the same value, so this
              // re-renders nothing per keystroke past the swap).
              setInputTall(event.nativeEvent.contentSize.height > INPUT_TALL_THRESHOLD);
            }}
            placeholder={running ? "Queue a message behind the running turn…" : "Message the agent…"}
            placeholderTextColor={tokens.textTertiary}
            style={[
              styles.input,
              {
                // round-117-elevation §2.2: the input sits in a SURFACE WELL
                // (not the card plane) — the dock reads as carved, not floated.
                backgroundColor: tokens.surfaceWell,
                // R118-D — the bolder focus ring: 1.5dp while focused (the
                // hairline rest stays a whisper, the focus finally reads).
                borderWidth: focused ? 1.5 : StyleSheet.hairlineWidth,
                borderColor: focused ? tokens.accent : tokens.inputBorder,
                borderTopColor: tokens.clayTopEdge,
                color: tokens.text,
                fontFamily: fontFamily.medium,
                // R120-P — the padding law's ONLY change: paddingRight
                // reserves the docked control's column (the sheet style's
                // ATTACH_DOCK_PADDING_RIGHT); paddingLeft stays spacing.lg
                // and the vertical padding stays INPUT_PADDING_Y — nothing
                // else reserves room, no band, no overlay swap.
                textAlignVertical: inputTall ? "top" : "center",
              },
              // The pill→bar switch: tall once the grown content passes
              // the threshold.
              inputTall ? styles.inputTall : null,
            ]}
          />
          {/* ── ROUND-120 (why): ── THE DOCKED ADD CONTEXT CONTROL (items
              29+30) — the paperclip's 40dp quiet circle pinned at the
              input's BOTTOM-RIGHT corner, INSIDE the input's own visual
              surface (the R119-B sibling-beside circle is superseded by
              the owner's §H report). The QuietIconButton grammar's shape
              — RADIUS_ROUND, tertiary → accent on press, transparent
              resting surface — with hitSlop 4 carrying the 44px law and
              the composer-attach testID preserved. It rides the input's
              LAST line at every height (bottom inset 2: centered at rest
              in the 44px pill, docked to the bottom-right corner when
              tall), and the input's paddingRight keeps every text line
              clear of it — never overlap. */}
          <Pressable
            accessibilityLabel="Attach a file or choose one from the project"
            accessibilityRole="button"
            hitSlop={4}
            testID="composer-attach"
            onPress={() => onSheetChange("attach")}
            style={({ pressed }) => [
              styles.attachDock,
              { backgroundColor: pressed ? tokens.subtle : "transparent" },
            ]}
          >
            {({ pressed }) => (
              <Paperclip size={19} color={pressed ? tokens.accent : tokens.textTertiary} strokeWidth={2.2} />
            )}
          </Pressable>
        </View>
        {running ? (
          <View style={styles.runningButtons}>
            {/* R118-D — the CONDITIONAL queue: renders ONLY when there is
                something to send (draft or chips) — the disabled arm + the
                0.45 opacity die (a control without content is a dead
                control; the stop circle stands alone while empty). */}
            {canSend ? (
              <Pressable
                accessibilityLabel="Queue this message behind the running turn"
                accessibilityRole="button"
                testID="composer-queue"
                onPress={() => void queueNow()}
                style={({ pressed }) => [
                  styles.queueButton,
                  {
                    backgroundColor: tokens.card,
                    borderTopColor: tokens.clayTopEdge,
                    borderColor: pressed ? pressTint(tokens.card, tokens.isDark) : tokens.borderStrong,
                  },
                ]}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={tokens.textSecondary} />
                ) : (
                  <ListPlus size={TYPE_BODY + 3} color={tokens.textSecondary} strokeWidth={2} />
                )}
              </Pressable>
            ) : null}
            {/* R118-D — the ICON-ONLY stop: a 50×50 circle, Square 15 in the
                danger hue (the "Stop" label is deleted — the glyph carries
                it; the a11y label keeps the sentence). */}
            <Pressable
              accessibilityLabel="Stop the running turn"
              accessibilityRole="button"
              testID="composer-stop"
              onPress={onStop}
              style={({ pressed }) => [
                styles.stopButton,
                {
                  borderColor: tokens.danger,
                  backgroundColor: pressed ? pressTint(tokens.card, tokens.isDark) : "transparent",
                },
              ]}
            >
              <Square size={15} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
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
            testID="composer-send"
            onPress={() => void sendNow()}
            style={({ pressed }) => [
              styles.sendButton,
              {
                // round-117-elevation §2.2: the send circle rides the DEEP accent
                // (light) / the theme's dark accent — the pill's icon in accentText.
                backgroundColor: canSend ? tokens.accentDeep : tokens.subtleHover,
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

      {/* ── the sheets (R115-I — CONTROLLED by the session screen's sheet
          state; every pick or cancel writes onSheetChange(null)). R118-D:
          the attach PAIR only — the mode/model/thinking/context sheets are
          deleted (the kebab's menu renders those levels in place). */}

      <Sheet open={sheet === "attach"} onClose={() => onSheetChange(null)} title="Add context">
        <SheetRow
          icon={<Plus size={15} color={tokens.accent} strokeWidth={2.3} />}
          title="Attach a file"
          caption="Pick any file from this device — images ride to the agent's project"
          onPress={() => {
            onSheetChange(null);
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
            onSheetChange("files");
          }}
        />
        <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs }} numberOfLines={1}>
          typing “@” in the message quick-picks project files too
        </TypeCaption>
      </Sheet>

      <Sheet open={sheet === "files"} onClose={() => onSheetChange(null)} title="Choose from project">
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
            <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
              loading the project tree…
            </TypeCaption>
          </View>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {filterProjectFiles(treeFiles, fileQuery, 60).map((path) => (
              <Pressable
                key={path}
                accessibilityLabel={`Attach ${path}`}
                accessibilityRole="button"
                onPress={() => {
                  onSheetChange(null);
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
              <TypeCaption style={{ color: tokens.textTertiary, paddingHorizontal: spacing.xs, paddingVertical: spacing.md }} numberOfLines={1}>
                no files match
              </TypeCaption>
            )}
          </ScrollView>
        )}
      </Sheet>

      {/* ── ROUND-120 (why): ── the owner's item 32 — "tapping ANY
          attachment opens a viewer pop-up — images: a large preview; text
          files: a scrollable text view; non-previewable types get a
          sensible viewer (name + size + type)." The AttachmentViewer owns
          the whole family (the image arm delegates to the full-screen
          ImageViewer the transcript already opens). */}
      <AttachmentViewer
        chip={viewing}
        onClose={() => setViewing(null)}
        testID="composer-attachment-viewer"
      />
    </View>
  );
}

// ── the model menu's provider grouping (R115-I → R118-D) ───────────────────

/** One provider's slice of the configured models (its display label — the
 * registry row's name, falling back to the provider id — plus its rows). */
export interface ModelProviderSection {
  providerId: string;
  label: string;
  rows: ModelRecord[];
}

/** The visible models bucketed by provider: sections ordered by the
 * PROVIDERS registry first, then any provider the registry didn't list in
 * first-appearance order (named by its id — honest while the provider list
 * hasn't loaded). Hidden models never appear. Pure. */
export function groupModelsByProvider(
  models: ModelRecord[],
  providers: ProviderRow[] | null,
): ModelProviderSection[] {
  const groups = new Map<string, ModelRecord[]>();
  for (const m of models) {
    if (m.hidden) continue;
    const list = groups.get(m.providerId);
    if (list !== undefined) list.push(m);
    else groups.set(m.providerId, [m]);
  }
  const sections: ModelProviderSection[] = [];
  const seen = new Set<string>();
  for (const p of providers ?? []) {
    const rows = groups.get(p.id);
    if (rows === undefined) continue;
    seen.add(p.id);
    sections.push({ providerId: p.id, label: p.name, rows });
  }
  for (const [providerId, rows] of groups) {
    if (seen.has(providerId)) continue;
    sections.push({ providerId, label: providerId, rows });
  }
  return sections;
}

/** R119-B — the Model level's ACCORDION open-section law (the owner's
 *  verdict: the model list was "a flat fully-expanded provider-sectioned
 *  wall — he wants PROVIDER NAMES by default, one provider expanding at a
 *  time into its models"). Pure state transition so jest can pin it without
 *  rendering: tapping a CLOSED provider opens it (closing whatever was
 *  open — ONE section at a time), tapping the OPEN provider toggles it
 *  shut. The state itself lives in the level rows component and dies with
 *  the unmount — the menu's close/back lifecycle resets it for free. */
export function nextOpenModelProvider(open: string | null, tapped: string): string | null {
  return open === tapped ? null : tapped;
}

/** R119-B — does this menu level render the ROOT control rows (Mode / Model
 *  / Thinking / Context + the conditional two-step Stop)? Only the main
 *  level (and the closed panel's fade-out frame) does — every named
 *  sub-level owns its own rows or children. The R118-D defect this pins:
 *  the level ternary had NO "model" branch, so the root rows fell through
 *  to the else arm and TRAILED the model list (the owner's exact report).
 *  The screen's `menuItems` ternary carries the explicit branch AND guards
 *  its else arm through this law. Pure. */
export function menuLevelRendersRootRows(level: string | null): boolean {
  return level === null || level === "main";
}

// ── sheet rows ──────────────────────────────────────

function SheetRow({
  icon,
  title,
  caption,
  selected = false,
  disabled = false,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  title: string;
  caption?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      testID={testID}
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
          <Text style={{ color: tokens.textTertiary, fontSize: TYPE_CAPTION - 1, fontFamily: fontFamily.regular }} numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** R116-l → R118-D → R119-B — the pill bar's metrics: the 44px resting
 * height, the ~10 vertical padding, and the native-growth cap. R119-B
 * re-cuts the cap for the SINGLE-TIER row: the paperclip no longer lives
 * inside the input, so the 40px ATTACH_BAND is DELETED and the cap is
 * honestly 6 lines at 21pt line height + BOTH 10px vertical paddings
 * = 146 (the R118-D two-tier 176 is gone with the band it reserved).
 * Exported for the tests (the geometry is the contract). */
const INPUT_MIN_HEIGHT = 44;
const INPUT_PADDING_Y = 10;

/** §2.4 — the input's line budget (the growth cap's line count). */
export const INPUT_MAX_LINES = 6;
/** R119-B → R120-P — the attach control's footprint: the paperclip's 40dp
 *  quiet circle. R119-B parked it BESIDE the input as a row peer; R120-P
 *  DOCKS it inside the input's own surface (the owner's §H report) — the
 *  size rides unchanged. Exported for the tests (the geometry is the
 *  contract). */
export const ATTACH_CIRCLE_SIZE = 40;
/** ── ROUND-120 (why): ── the DOCKED CONTROL law (items 29+30) — the
 *  control's inset from the input's RIGHT edge (4dp: inside the pill's
 *  surface, clear of its curved cap) and from its BOTTOM edge (2dp: the
 *  40dp circle centers in the 44px resting pill — 40 + 2×2 — and rides
 *  the last line when the input grows). */
export const ATTACH_DOCK_INSET = 4;
export const ATTACH_DOCK_BOTTOM_INSET = 2;
/** ── ROUND-120 (why): ── the WRAP LAW — the input's paddingRight reserves
 *  the docked control's column (right inset 4 + circle 40 + the text gap
 *  8 = 52): text on the control's line flows LEFT of it, text above flows
 *  in the region above/left of it, and no line can EVER overlap the
 *  control — the RN spelling of the owner's "the text will never overlap
 *  with the 'Add Context' button" (a TextInput has no per-line float, so
 *  the reservation holds on every line). */
export const ATTACH_DOCK_TEXT_GAP = spacing.sm;
export const ATTACH_DOCK_PADDING_RIGHT =
  ATTACH_DOCK_INSET + ATTACH_CIRCLE_SIZE + ATTACH_DOCK_TEXT_GAP;
/** §2.4 → R119-B — the native-growth cap: 6×21 + 2×10 = 146 (the tall
 *  input owns its full width at every height — nothing reserves a band). */
export const MAX_INPUT_HEIGHT = INPUT_MAX_LINES * 21 + INPUT_PADDING_Y * 2;
/** §2.4 — the content-height threshold that flips `inputTall` (the 44px
 *  resting height − the 2×10 vertical padding — the same arithmetic that
 *  used to drive the controlled height + the radius swap). */
export const INPUT_TALL_THRESHOLD = INPUT_MIN_HEIGHT - INPUT_PADDING_Y * 2;

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

/** R114-d → R116-l → R118-D — the model row's "in play" truth, on the FULL
 * three-tier ladder: the local override when set, else the session's
 * SERVER-side selectedModel (the row the other devices see), else the
 * CONTEXT REPORT's effective model — the PC's actual selection, so the menu
 * carries the check even when the phone never chose (donts #36: real models
 * only, the PC's pick carries the check). The report tier matches modelId
 * AND providerId when the report carries its provider, else by model
 * id/name equality. */
function isModelInPlay(
  override: ModelOverride | null,
  selectedModel: { providerId: string; model: string } | null,
  report: SessionContextReport | null,
  m: ModelRecord,
): boolean {
  if (override !== null) return isModelSelected(override, m);
  if (selectedModel !== null) {
    return selectedModel.model === m.modelId && selectedModel.providerId === m.providerId;
  }
  if (report === null) return false;
  const model = report.model.trim();
  if (model === "") return false;
  const providerId = report.providerId.trim();
  if (providerId !== "") return model === m.modelId && providerId === m.providerId;
  return (
    model === m.modelId ||
    (m.displayName !== null && m.displayName.trim() === model)
  );
}

const styles = StyleSheet.create({
  /** R119-B — the dock's RESTING padding tightened 8/4 → 4/2 (the owner's
   *  verdict: the composer was "way too much taller in its height" at rest —
   *  the two-tier band is gone and the frame around it shrinks with it; the
   *  2dp bottom is below the 4pt grid, deliberately — the hairline border
   *  already carries a visual beat below the row). */
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: 2,
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
  },
  atRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
  },
  /** ── ROUND-120 (why): ── the @ menu's busy row (the tree loading / the
   *  no-project honest caption) — the menu OPENS on "@" now instead of
   *  vanishing, so it needs its own loading/no-match states. */
  atBusy: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
  },
  /** The @ menu's quiet no-match line (one line, the single-line law). */
  atEmpty: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
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
    paddingLeft: spacing.xs + 2,
    paddingRight: spacing.xs,
    paddingVertical: 6,
  },
  /** ── ROUND-120 (why): ── the image chip's REAL thumbnail (the owner's
   *  item 32): 28dp square, RADIUS_PILL (8) corners, cover-fit — the
   *  picked file's own localUri. Non-image chips keep the FileText
   *  glyph (their bytes never crossed to the phone). */
  attachThumb: {
    width: 28,
    height: 28,
    borderRadius: RADIUS_PILL,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  /** ── ROUND-120 (why): ── THE INPUT WRAP — the row peer that owns the
   *   row's flex (the input itself carries only min/max now). It is the
   *   POSITIONED HOST of the docked Add Context control: its height IS
   *   the input's height (a column auto-sizing to the TextInput's native
   *   growth), so the control pinned to ITS bottom-right corner rides the
   *   input's own bottom-right corner at every height. */
  inputWrap: {
    flex: 1,
  },
  /** R116-l → R118-D → R119-B → R120-P — the PILL input: RADIUS_ROUND
   *   while single-line (inputTall swaps in RADIUS_BAR). R118-D — NATIVE
   *   growth: only minHeight 44 + maxHeight MAX_INPUT_HEIGHT (146) remain
   *   — a multiline TextInput with only min/max grows on its own and
   *   scrolls past the cap. R120-P — the WRAP LAW's reservation: the
   *   paddingRight is ATTACH_DOCK_PADDING_RIGHT (52 — the docked control's
   *   column) while the paddingLeft stays spacing.lg; text on the
   *   control's line flows LEFT of it and NEVER overlaps it. */
  input: {
    borderRadius: RADIUS_ROUND,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingLeft: spacing.lg,
    paddingRight: ATTACH_DOCK_PADDING_RIGHT,
    paddingTop: INPUT_PADDING_Y,
    paddingBottom: INPUT_PADDING_Y,
    fontSize: TYPE_BODY,
    lineHeight: 21,
    minHeight: INPUT_MIN_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
  },
  /** The grown input's radius — the bar (28) once the content passes the
   * resting height (a plain conditional swap; the radius never animates). */
  inputTall: {
    borderRadius: RADIUS_BAR,
  },
  /** ── ROUND-120 (why): ── THE DOCKED ADD CONTEXT CONTROL (the owner's
   *   items 29+30): the paperclip's 40dp quiet circle ABSOLUTELY pinned
   *   inside the inputWrap at the input's BOTTOM-RIGHT corner (right inset
   *   4 / bottom inset 2 — centered in the 44px resting pill, riding the
   *   last line when tall). RADIUS_ROUND at 40×40 — the QuietIconButton
   *   grammar's shape — with hitSlop 4 carrying the 44px law and the
   *   transparent resting surface tinting to `subtle` on press (the icon
   *   flips tertiary → accent inline). The input's paddingRight keeps
   *   every text line clear of the circle: never overlap. */
  attachDock: {
    position: "absolute",
    right: ATTACH_DOCK_INSET,
    bottom: ATTACH_DOCK_BOTTOM_INSET,
    width: ATTACH_CIRCLE_SIZE,
    height: ATTACH_CIRCLE_SIZE,
    borderRadius: RADIUS_ROUND,
    alignItems: "center",
    justifyContent: "center",
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
    width: 50,
    height: 50,
    borderRadius: RADIUS_ROUND,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
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
});
