/**
 * Session v3 (R113-c) — the transcript + live stream + composer
 * (LINKING-PROTOCOL §3), now a REAL REPLICA of the PC chat (the owner's
 * directive): every send carries the composer's per-send overrides
 * (model/providerId/thinkingLevel/attachments — openTurnStream, the queue
 * route, and the outbox flush all ride the SAME body), the question cards
 * answer through POST /agent-questions/:id/resolve, the operating/task modes
 * PATCH per-session exactly like the desktop, and the composer (control row
 * + chips included) clears the keyboard with the bottom safe-area inset
 * applied while it's closed:
 *
 *   · the transcript: GET /sessions/:id's persisted event log, folded into
 *     the chat — complete even if the phone was offline all day;
 *   · the live stream: Send opens POST /sessions/:id/messages/stream and
 *     every frame renders AS IT LANDS, formatted, with the pulsing caret
 *     while the agent writes (tool calls, thinking, retries — all live);
 *   · the R42 guarantee: the turn SURVIVES a closed stream. Backgrounding
 *     drops the stream (AppState) and rehydrates on return; while a
 *     desktop-side turn runs (status "running"), a calm 3s poll keeps the
 *     transcript honest — the transcript is the truth;
 *   · the composer: Send / Stop / Queue (the queue route's 409
 *     NO_LIVE_TURN falls back to an ordinary send), offline sends land in
 *     the outbox (flushed in order when the link returns — overrides ride
 *     the flush), and the chip can be dismissed entry-by-entry.
 *
 * ROUND-113 (R113-e — the phone GOES LIVE): the screen subscribes to the
 * events stream (features/events.ts, the backend's GET /api/v1/events/stream):
 *   · a turn started on the PC streams HERE through the SAME applyLiveFrame
 *     reducer (the remote mirror — thinking, caret, tool-running, queue
 *     chips all render; the initiator guard keeps the phone's OWN stream
 *     authoritative so its turns never double);
 *   · session frames for THIS id rehydrate on an 800ms debounce, and status
 *     frames flip the header badge + the calm poll's trigger LIVE (the
 *     stale-status bug — nothing used to tell the phone a PC turn started);
 *   · a remote mirror ALSO engages the calm 3s poll (frames can blip while
 *     the turn keeps running server-side — the poll is the fallback); a
 *     rehydrate under a live mirror REBASES it (the persisted truth folds
 *     under the streamed tail) instead of freezing the overlay.
 *
 * The phone renders + taps. NOTHING is processed here (§4's ceiling).
 *
 * ROUND-114 (R114-d — the honest transcript): turn.started opens the remote
 * mirror INSTANTLY (the user bubble renders off the frame's own text + the
 * resolved model labels the header, the placeholder, and the live assistant
 * cards); meta frames (mode / task posture / selectedModel) apply to the
 * detail row IN PLACE — instant label flips, the debounced rehydrate as the
 * truth backstop; the composer's model pick PATCHes the session's
 * server-side selected model (the cross-device truth); the thinking
 * placeholder + the chat prefs (density / text size / timestamps / tool
 * activity) shape the transcript.
 *
 * ROUND-115 (R115-K — the keyboard architecture: ONE dock, ONE expression):
 * the screen's keyboard handling is now a SINGLE deterministic mechanism —
 * the composer dock. What's gone, and why (three stacked mechanisms used to
 * fight = version roulette: the owner still saw the keys covering the input):
 *   · KeyboardAvoidingView REMOVED — its behavior="padding" math is
 *     parent-frame-relative and under-reports on inset (edge-to-edge)
 *     devices, so its lift fought the other two mechanisms;
 *   · useReanimatedKeyboardAnimation REMOVED — it implicitly calls
 *     useResizeMode() (ADJUST_RESIZE), a deprecated no-op on API 35
 *     edge-to-edge that still mutates the window on ≤ API 34 (the roulette:
 *     double-lift on old devices, uncovered input on new ones);
 *   · the window goes ADJUST_NOTHING for this screen's lifetime
 *     (KeyboardController.setInputMode on mount) — the window never resizes
 *     or pans, while the IME WindowInsetsAnimation events still stream
 *     (they're inset-driven, not resize-driven). On unmount
 *     KeyboardController.setDefaultMode() restores the manifest-declared
 *     mode — the exact restore useResizeMode used to perform, so every
 *     other screen keeps its pre-R115-K behavior.
 * THE DOCK (the Animated.View wrapping <Composer>) owns the keyboard through
 * ONE expression: paddingBottom = max(insetsBottom, kbHeight). Closed → the
 * gesture-bar inset; open → the full keyboard height; ONE smooth UI-thread
 * rise; the inverted FlatList above reflows on its own; NO extra
 * padding/offsets anywhere else in the tree. kbHeight (positive while open,
 * 0 closed) is fed by TWO idempotent paths — defensive, because the
 * reanimated worklet path may be dead under Reanimated 4.5.1 and both write
 * the SAME value so whichever fires wins: (1) the UI-thread worklet
 * useGenericKeyboardHandler (chosen precisely because it does NOT touch the
 * resize mode) riding the onMove/onEnd frames, and (2) a JS-thread
 * KeyboardEvents listener synced ONLY on the animation end states
 * (didShow/didHide — the worklet path's own final values), so it can never
 * jump the dock ahead of the worklet's rising frames.
 *
 * ROUND-115 (R115-I — the WhatsApp header + the composer declutter): the
 * header is now the IDENTITY BAR (chat.md §Header) — [back chevron 44px] ·
 * [the project's LetterAvatar 36px] · [project name (TypeBodyStrong) over
 * the session's own name (TypeCaption, tertiary)] · [the kebab ⋮ menu]. It
 * renders INSIDE the body with the scaffold's chrome BYPASSED
 * (chrome={false}) — the identity bar is not the scaffold's centered-title
 * shape, and bypassing keeps every other screen's chrome byte-identical
 * (zero shared-file changes; the documented scaffold choice). The project
 * row comes from fetchProjects (cached per mount); a session with no
 * project / a project the registry no longer lists degrades honestly to a
 * neutral avatar + the session's own title with its status label as the
 * subtitle. STATUS WORDS ARE OUT OF THE HEADER — R123-W-m: the running
 * turn's tell is the AVATAR'S LIVE EDGE ring alone (AvatarLiveEdge below,
 * the glowing DP effect the owner described approvingly); the thin 2px
 * breathing accent LINE that used to sit under the bar is RETIRED at the
 * owner's explicit re-demand ("a pulsing line below it too, which I
 * explicitly told you to remove").
 *
 * ROUND-116 (R116-l — the anchored kebab dropdown + the honest couldn't-open
 * recovery): the kebab no longer opens a bottom sheet — it opens the
 * ANCHORED DROPDOWN (components.md §Dropdown menus, motion.md §4.8) below
 * the control, springing in on the house spring and dismissing on a
 * scrim-less tap-outside. The rows carry their LIVE values (Mode · Model ·
 * Thinking · Context, + "Stop this turn" while a turn is live) and each
 * routes to the composer's MATCHING sheet through the same controlled-sheet
 * API — the dropdown closes first, its 120ms exit fading under the sheet's
 * rise. THE SHEET STATE stays split (R115-I discipline): the kebab's menu is
 * its own `menuOpen` boolean now, the composer's sheets stay in `sheet`; the
 * composer renders every sheet's CONTENT controlled through
 * sheet/onSheetChange and reports its live control values through
 * onControlsSnapshot. The task-mode picker stays GONE (round-115 verdict).
 *
 * Also R116-l: while the screen sits in the couldn't-open state
 * (detail === null && error !== null), a quiet 5s poll rehydrates — the
 * "Retrying automatically…" micro line under the error card is the owner's
 * proof the screen is not dead — and the back chevron gains the CHIP grammar
 * (donts #41: 44px target, subtle fill, hairline border, RADIUS_CHIP).
 *
 * ROUND-117 (R117-d2 — the mobile multi-agent parity leg): the transcript's
 * live sub-agent map rides down to the cards (live?.subagentLive → the
 * SubAgentCard's live rule + last-activity line + Stop/Retry affordances —
 * the applyLiveFrame reducer owns every mutation), and the error cards' Retry
 * is a screen-owned callback (onRetryFailedTurn): the failed turn's user
 * message — the last user item BEFORE the error card in chat order — re-sends
 * through the normal send path (onSend), exactly the PC panel's binding. A
 * live turn refuses honestly at the tap (the stream route's own 409 would
 * say it later; the quiet error line says it now).
 *
 * ROUND-118 (R118-D — the session chrome + the delivery states): the
 * identity bar gains its CHROME COLUMN — a surfaceHeader-filled wrapper
 * pulled up through the status-bar inset (negative margin + compensating
 * padding) with the hairline borderSubtle separator at its bottom edge.
 * (R123-W-m: the LiveHeaderLine that used to sit absolutely over that
 * edge is RETIRED — the owner's explicit re-demand; the separator is the
 * plain hairline again in every state.) The back chip is the shared
 * QuietIconButton (ArrowLeft 22, the 40px circle — the chevron "bracket"
 * is retired). The kebab's menu is now a LEVEL STATE MACHINE
 * (null/main/mode/model/thinking/context) rendered IN the anchored panel
 * through HeaderDropdown's sub-level grammar: picks APPLY AND RETURN to
 * main (the feedback loop closes where the owner looks); Context stays
 * read-only at its own level. Both stop affordances confirm: the menu's
 * Stop row arms ("Stop this turn" → "Do you want to stop?") before it
 * fires, and the composer's stop button opens the centered ConfirmDialog
 * (this screen's stopTurn owns the POST either way).
 *
 * ROUND-119 (R119-B — the session chrome rework): the kebab's MODEL level
 * gains its EXPLICIT menuItems branch (the R118-D ternary had none, so the
 * root rows trailed the model list — the owner's exact report) and its
 * sections collapse into the PROVIDER ACCORDION (one provider open at a
 * time, the open section resetting with the menu's own lifecycle); the
 * dropdown's LEVEL SWAPS animate now (the directional 12dp slide lives
 * INSIDE HeaderDropdown — this screen just passes `level`); and the
 * composer dock rides the R119-B single-tier bar (see composer.tsx — the
 * paperclip is the input's row peer, not an in-bar overlay).
 *
 * ROUND-119 (R119-A — the §N center-section rethink): the transcript's
 * center is ONE VISUAL TURN PER EXCHANGE. The displayItems memo keeps its
 * live/settled item streams (the fold + the live reducer are untouched —
 * the ITEM MODEL is the same) but now ends in the QUEUED-AFTER-TURN LAW
 * (orderDisplayItems — a still-queued row renders after the in-progress
 * turn, never above it) and a GROUPING memo (groupDisplayRows — runs of
 * consecutive assistant/thinking/tool items become ONE TurnBlock; every
 * interactive/terminal kind stays its own row). The synthetic thinking
 * marker survives (thinkingPlaceholderVisible's honesty rules unchanged)
 * but renders as the turn's own breathing rail line, not a card; the
 * toolActivity pref applies to the turn's SEPARATED elements (see
 * transcript.tsx — R129-M).
 *
 * ROUND-120 (R120-P — the composer's edge + the kebab's Task list): the
 * owner's §H item 28 — the composer "rides the device edge — no bottom
 * spacing" — lands in THE DOCK EXPRESSION: paddingBottom =
 * max(insetsBottom, kbHeight) + COMPOSER_EDGE_BEAT (the safe-area inset
 * PLUS the house's 8dp beat, so the flat case (no inset) still breathes
 * and the home-indicator case never kisses the bar). Item 33 — "The kebab
 * menu gains a separator + 'Task list' option at the bottom" — the root
 * level carries the strong-rule separator row (HeaderDropdown's
 * `separator` flag) over a live-valued "Task list — {done}/{total}" row,
 * and the TASKS level renders the session's todo list IN THE PANEL (the
 * same menu family), CHECKABLE through POST /sessions/:id/todo (the R88
 * owner-write route — source "user", so the agent sees the edit): a tap
 * optimistically flips the row (toggleTodoAt), the POST carries the whole
 * list, and the fold catches up through the todo-updated frame (a live
 * turn) or the rehydrate (none). The data source is the display item
 * stream's ONE todo card — the same list the transcript's TodoCard shows.
 *
 * ROUND-120 (R120-CM — the center's finish, §1 items 40-42 + §2 Track C-M's
 * processing indicators): the transcript-side work lives in
 * transcript.tsx/turn-block.ts/sessions.ts (the honest tool rows live AND
 * folded, the tool-frame association + the mid-turn twin dedupe, the
 * collapsed rail's tool hints, the markdown ladder). THIS screen's own
 * piece: the header avatar wears the LIVE EDGE (AvatarLiveEdge below) —
 * while a turn runs (turnLive — the one truth the avatar's live edge, the
 * Stop row, and the composer's running mode already read) a subtle 2dp
 * accent ring breathes on the delivery-edge rhythm over the avatar's
 * box; at rest nothing renders and the layout never shifts. The sent
 * message keeps its delivery rungs (transcript.tsx, pinned); the
 * TurnBlock's own live rail breath is untouched (R119-A anatomy).
 *
 * ROUND-123 (R123-W-m — the mobile transcript redesign, the screen's own
 * piece): THE BREATHING HEADER LINE IS RETIRED — the owner: "there was a
 * glowing effect around the display picture, but apparently there was a
 * pulsing line below it too, which I explicitly told you to remove". The
 * AvatarLiveEdge ring (the glow he described approvingly) STAYS as the
 * running turn's one chrome tell; the LiveHeaderLine component, its render
 * site, and its style are deleted (nothing else ever read them — the
 * stop-row/composer/avatar truths are their own sources). The transcript's
 * own changes (images above the text, the well's default-open, the web
 * families' honest rows) live in transcript.tsx + turn-block.ts +
 * streaming-args.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import {
  AndroidSoftInputModes,
  KeyboardController,
  KeyboardEvents,
  useGenericKeyboardHandler,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, Check, ChevronRight, Ellipsis, X } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Composer, menuLevelRendersRootRows, nextOpenModelProvider, type ComposerControlsSnapshot, type ComposerMode, type ComposerSheet, type MenuModelRow, type MenuModelSection } from "@/components/composer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HeaderDropdown, MAIN_LEVEL_KEY, type HeaderDropdownItem } from "@/components/header-dropdown";
import { LetterAvatar } from "@/components/letter-avatar";
import {
  DELIVERY_EDGE_HIGH,
  DELIVERY_EDGE_LOW,
  DELIVERY_EDGE_STATIC,
  TranscriptRowView,
  type AttachmentImageResolver,
} from "@/components/transcript";
// R125-D — the transcript's scroll anchor (the anti-runaway pin; see the
// module's header for the full coordinate-space rationale).
import { TRANSCRIPT_SCROLL_ANCHOR } from "@/components/transcript-scroll";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { QuietIconButton, TypeBodyStrong, TypeCaption, TypeMicro, TypeMono } from "@/design/primitives";
import { warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { DISCLOSURE_FADE_MS } from "@/design/motion";
import { mixHex, spacing, TOUCH_TARGET, fontFamily, TYPE_CAPTION } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import type { SseStream } from "@/link/connection";
import { fetchProjects, type ProjectRow } from "@/features/config";
// R121-c (the pixels round): the image-attachment display-bytes fetch —
// the resolver the transcript's thumbnails ride. The cache-file write (the
// RN-touching half the feature module's header pins to the screen) rides
// expo-file-system HERE — screens are not unit-tested; the pure half is.
import { File, Paths } from "expo-file-system";
import {
  attachmentCacheFileName,
  fetchAttachmentImageBase64,
} from "@/features/attachments";
import { CLASSIC_THINKING_OPTIONS, MODE_OPTIONS, modeOption } from "@/features/composer-state";
import { contextPercent, contextPressure, formatTokens, type SessionContextReport } from "@/features/context-meter";
import {
  abandonLiveTurn,
  applyLiveFrame,
  applySessionMetaPatch,
  beginLiveTurn,
  foldSessionEvents,
  fetchSessionDetail,
  openTurnStream,
  parseStreamFrame,
  patchSessionPermissions,
  patchSessionSelectedModel,
  postQueue,
  postResolveQuestion,
  postSessionTodo,
  postStop,
  rebaseRemoteTurn,
  reduceRemoteTurnFrame,
  sessionStatusFromWire,
  sessionStatusLabel,
  sessionTitle,
  thinkingPlaceholderVisible,
  toggleTodoAt,
  type AttachmentView,
  type LiveTurn,
  type SessionDetailWire,
  type SessionStatus,
  type SendOverrides,
  type TodoItemView,
  type TranscriptItem,
} from "@/features/sessions";
import { groupDisplayRows, orderDisplayItems, type DisplayRow } from "@/features/turn-block";
import { getEventsStore, turnFrameRecord, type EventsFrame } from "@/features/events";
import { getOutbox, outboxForSession, type OutboxEntry } from "@/features/outbox";
import { mobLog, mobWarn } from "@/lib/log";

/** The calm poll while a desktop-side turn runs (no live stream to watch). */
const RUNNING_POLL_MS = 3_000;

/** The remote session-frame rehydrate debounce (R113-e): a streaming turn
 * appends log rows continuously — one trailing refetch after the burst. */
const REMOTE_REHYDRATE_MS = 800;

/** R116-l — the couldn't-open auto-retry's quiet cadence (owner verdict #53:
 * "Retrying" must actually retry; the link's own backoff ladder probes the
 * transport, so rehydrate is the screen's whole job here). */
const AUTO_RETRY_MS = 5_000;

/** The avatar's breathing live-edge ring's one leg (ms) — the live caret's
 * own rhythm (motion.md §3: 550ms each way). R123-W-m: this cadence was the
 * retired LiveHeaderLine's own constant too; the line is gone (the owner's
 * explicit re-demand) and the AVATAR RING — the glow he kept — is its one
 * remaining consumer. Local to this file, the tab-bar's breathe-constants
 * precedent. */
const LIVE_LINE_LEG_MS = 550;

/** R118-D §2.2 — the Model level's scroll cap (the provider sections scroll
 * INSIDE the panel; contentMaxHeight rides HeaderDropdown). */
const MODEL_LEVEL_MAX_HEIGHT = 360;
/** R118-D §2.2 — the Context level's scroll cap (the read-only readout). */
const CONTEXT_LEVEL_MAX_HEIGHT = 320;
/** ── ROUND-120 (why): ── the owner's item 33 — the Task list level's scroll
 *  cap (up to 30 todos ride the panel's own scroll; the R88 route's own
 *  ceiling). */
const TASK_LEVEL_MAX_HEIGHT = 320;
/** ── ROUND-120 (why): ── the owner's item 28 — "the composer rides the
 *  device edge — add a proper bottom inset": the house beat ADDED to the
 *  dock expression's max(insetsBottom, kbHeight). The flat case (a device
 *  reporting no bottom inset) still gets the beat alone; the home-indicator
 *  case gets inset + beat — the composer never kisses the edge or the bar. */
const COMPOSER_EDGE_BEAT = spacing.sm;

/** R115-I → R118-D — the session screen's open COMPOSER sheet, NARROWED to
 * the attach pair (the kebab's rows no longer open sheets — the menu renders
 * their levels in place). null = closed. */
type SessionSheet = ComposerSheet | null;

/** R118-D — the kebab menu's LEVEL state machine: null = closed, "main" =
 *  the four control rows + the conditional Stop, and one level per control
 *  (rendered inside the anchored panel through HeaderDropdown's sub-level
 *  grammar — back chevron + title row + content). R120-P adds "tasks" —
 *  the session's todo list (the owner's item 33). */
type SessionMenu = null | "main" | "mode" | "model" | "thinking" | "context" | "tasks";

export default function SessionScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const params = useLocalSearchParams<{ id?: string }>();
  const sessionId = typeof params.id === "string" ? params.id : "";

  const [detail, setDetail] = useState<SessionDetailWire | null>(null);
  const [baseItems, setBaseItems] = useState<TranscriptItem[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [outboxEntries, setOutboxEntries] = useState<OutboxEntry[]>([]);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");

  // ── R115-I/R118-D — the identity bar + the kebab menu's state ──────────

  /** The registry's projects, fetched once per mount (cached like every
   *  other screen) — the identity bar's project row. */
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  /** The open composer sheet — R118-D: the attach PAIR only (the paperclip
   *  + the attach sheet's own transition open them). */
  const [sheet, setSheet] = useState<SessionSheet>(null);
  /** R118-D — the kebab menu's LEVEL state machine (replaces menuOpen): null
   *  = closed; the levels render inside the anchored panel. */
  const [menu, setMenu] = useState<SessionMenu>(null);
  /** R118-D — the two-step stop's armed flag: the main level's Stop row flips
   *  its label IN PLACE ("Stop this turn" → "Do you want to stop?") before
   *  the second tap fires. Resets on menu close + when the turn dies. */
  const [stopArmed, setStopArmed] = useState(false);
  /** R118-D — the composer's stop confirmation (the centered ConfirmDialog);
   *  the kebab's armed row needs no dialog — its two-step IS the confirm. */
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  // ── ROUND-120 (why): ── the owner's item 33 — the kebab's Task list, with
  // CHECKABLE rows (the R88 owner-write route exists). The OPTIMISTIC list
  // the moment a tap flips a row (null = show the fold's own truth); it
  // clears when the fold catches up (the todo-updated frame or the
  // post-write rehydrate) and on every menu close — a failed write reverts
  // it with the honest error caption.
  const [todoOverride, setTodoOverride] = useState<TodoItemView[] | null>(null);
  const [todoBusy, setTodoBusy] = useState(false);
  const [todoError, setTodoError] = useState<string | null>(null);
  /** The composer's live control values (the menu's rows + levels render
   *  these); the honest pre-report defaults show until the first snapshot —
   *  the model ladder's floor is "—" (R116-l: the "Agent default" rung is
   *  retired, donts #36), the thinking options default to the classic four
   *  (the pre-snapshot model is unknown). */
  const [controls, setControls] = useState<ComposerControlsSnapshot>({
    modelLabel: "—",
    thinkingLabel: "Default",
    ctxPct: null,
    modelSections: null,
    thinkingOptions: CLASSIC_THINKING_OPTIONS,
    thinkingUnsupported: false,
    thinkingSelected: "default",
    contextReport: null,
    pickModel: () => {},
    pickThinking: () => {},
  });

  const streamRef = useRef<SseStream | null>(null);
  const streamClosedRef = useRef(false);
  /** The live turn's ref mirror — SSE frames apply SYNCHRONOUSLY against it
   * (React updaters may defer; the terminal decision must not). */
  const liveRef = useRef<LiveTurn | null>(null);
  /** R113-e: the base transcript's ref mirror (a fresh remote mirror opens
   * over it synchronously — the state version renders a beat later). */
  const baseItemsRef = useRef<TranscriptItem[]>([]);
  /** True while the live overlay mirrors a REMOTE turn (another device's —
   * the events stream feeds it; the rebase math reads the split point). */
  const remoteRef = useRef(false);
  /** The base length the remote mirror was last rebased onto. */
  const remoteBaseCountRef = useRef(0);

  const setLiveState = useCallback((next: LiveTurn | null): void => {
    liveRef.current = next;
    setLive(next);
  }, []);

  // ── the truth: rehydrate from the persisted event log ─────────────────────

  /**
   * R113-e: settle the live overlay after a rehydrate fetch landed. A
   * REMOTE mirror rebases onto the fresh truth (the persisted user card +
   * appended rows fold UNDER the streamed tail) — or drops when the server
   * says the turn is over (a terminal frame missed while backgrounded);
   * an ABANDONED own overlay (its stream died mid-turn) also drops — the
   * truth owns the render, exactly the R42 guarantee.
   */
  const settleLiveAfterFetch = useCallback(
    (status: SessionStatus, items: TranscriptItem[]): void => {
      const live = liveRef.current;
      if (live === null) return;
      if (remoteRef.current) {
        if (status === "running") {
          setLiveState(rebaseRemoteTurn(live, items, remoteBaseCountRef.current));
          remoteBaseCountRef.current = items.length;
        } else {
          mobLog("events", "remote mirror settled — truth wins", { status });
          remoteRef.current = false;
          setLiveState(null);
        }
        return;
      }
      if (live.phase === "idle" && live.terminal === null && streamRef.current === null) {
        // An abandoned own turn — the truth owns the render (R42).
        setLiveState(null);
      }
    },
    [setLiveState],
  );

  const rehydrate = useCallback(async () => {
    if (sessionId === "") return;
    const link = getLinkManager();
    try {
      const outcome = await fetchSessionDetail(link, sessionId);
      if (outcome.ok) {
        const items = foldSessionEvents(outcome.data.events);
        setDetail(outcome.data);
        setBaseItems(items);
        baseItemsRef.current = items;
        setError(null);
        settleLiveAfterFetch(outcome.data.status, items);
      } else if (outcome.error.status === 404) {
        setError("this session no longer exists on the desktop");
      } else {
        setError(outcome.error.message);
      }
    } catch {
      setError("the host is offline — retrying");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId, settleLiveAfterFetch]);

  useEffect(() => {
    if (status === "connected") {
      void rehydrate();
      void getOutbox()
        .flush(getLinkManager())
        .then((result) => {
          if (result.delivered > 0) void rehydrate();
        })
        .catch(() => {});
    }
  }, [status, rehydrate]);

  // R115-I — the identity bar's project row: fetchProjects once per mount
  // while the link is up (cached like every other screen). A miss (offline,
  // or a project the registry no longer lists) degrades honestly to the
  // neutral avatar + the session's own title — never a fabricated identity.
  useEffect(() => {
    if (status !== "connected") return;
    void fetchProjects(getLinkManager()).then((outcome) => {
      if (outcome.ok) setProjects(outcome.data.projects);
    });
  }, [status]);

  // Outbox chips: the entries queued for THIS session.
  useEffect(() => {
    const outbox = getOutbox();
    const sync = () => setOutboxEntries(outboxForSession(outbox.getState(), sessionId));
    const unsubscribe = outbox.subscribe(sync);
    sync();
    return unsubscribe;
  }, [sessionId]);

  // ── AppState discipline (the R42 reconnect rule) ──────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      setAppActive(active);
      if (!active) {
        // Drop the stream — the turn survives on the desktop; the transcript
        // is the truth and rehydrating on return never misses anything.
        mobLog("stream", "app backgrounded — stream dropped (R42)");
        streamClosedRef.current = true;
        streamRef.current?.close();
        streamRef.current = null;
        if (liveRef.current !== null) setLiveState(abandonLiveTurn(liveRef.current));
      } else {
        mobLog("stream", "app foregrounded — rehydrating");
        void rehydrate();
      }
    });
    return () => sub.remove();
  }, [rehydrate, setLiveState]);

  // ── the calm poll while a turn runs somewhere ────────────────────────────

  useEffect(() => {
    if (!appActive) return;
    if (streamRef.current !== null) return; // we hold the live stream
    // R113-e: the poll engages when the session is running OR any live
    // overlay is up — a status frame for a PC-started turn flips detail
    // LIVE now (the stale-status bug: nothing used to tell the phone), and
    // a remote mirror is exactly the "a turn runs server-side" truth the
    // poll watches. The poll is the FALLBACK — frames can blip.
    const watching = (detail !== null && detail.status === "running") || live !== null;
    if (!watching) return;
    const timer = setInterval(() => {
      if (streamRef.current === null) void rehydrate();
    }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [appActive, detail, live, rehydrate]);

  // ── R116-l — the couldn't-open AUTO-RETRY (owner verdict #53) ─────────────
  // While the screen sits in the couldn't-open state (detail === null &&
  // error !== null), a quiet 5s poll calls rehydrate() — the "Retrying
  // automatically…" micro line under the error card is the visible half.
  // rehydrate is the screen's WHOLE job here: the link manager's own backoff
  // ladder keeps probing the transport, and a recovered host flips the state
  // to the transcript (setError(null) + setDetail clear this interval on the
  // next render); unmount and the error-clear both stop it. No retryNow() of
  // our own — the ladder already owns the probe cadence.

  useEffect(() => {
    if (detail !== null || error === null) return;
    const timer = setInterval(() => {
      void rehydrate();
    }, AUTO_RETRY_MS);
    return () => clearInterval(timer);
  }, [detail, error, rehydrate]);

  // ── the events subscription (R113-e — the phone goes live) ────────────────

  /** One mirrored turn frame for THIS session (the events stream's
   * {type:"turn"} frames — the PC's turn streams live on the phone). */
  const onRemoteTurnFrame = useCallback(
    (raw: unknown): void => {
      const record = turnFrameRecord(raw);
      if (record === null) return; // malformed mirror — never a guess
      const result = reduceRemoteTurnFrame({
        live: liveRef.current,
        remote: remoteRef.current,
        ownStream: streamRef.current !== null,
        baseItems: baseItemsRef.current,
        frame: record,
        now: Date.now(),
      });
      if (result === null) return; // our own stream renders this frame
      if (result.began) {
        mobLog("events", "remote mirror opened", { sessionId });
        remoteRef.current = true;
        remoteBaseCountRef.current = baseItemsRef.current.length;
        // R114-d: turn.started's own text renders the user bubble NOW — no
        // immediate refetch needed for it. The truth still lands promptly:
        // the message.user append fires a session {kind:"event"} frame the
        // 800ms debounced rehydrate below picks up, the calm 3s poll watches
        // the rest, and rebaseRemoteTurn drops the mirrored card when the
        // persisted row arrives (no doubling).
      }
      setLiveState(result.turn);
      if (result.terminal) {
        // done / stopped / error — the turn is over; the truth owns the render.
        mobLog("events", "remote turn terminal", { sessionId, terminal: result.turn.terminal });
        void rehydrate().then(() => {
          // Clear only if the overlay is STILL the terminal mirror — the
          // desktop's retire-cancel discipline (scheduleRemoteRetire): a NEW
          // remote turn may open while this fetch is in flight, and its
          // frames own the overlay now (clearing them would kill a live
          // mirror; its own terminal path will settle it).
          if (remoteRef.current && liveRef.current !== null && liveRef.current.terminal !== null) {
            remoteRef.current = false;
            setLiveState(null);
          }
        });
      }
    },
    [sessionId, rehydrate, setLiveState],
  );

  useEffect(() => {
    if (sessionId === "") return;
    const store = getEventsStore();
    let rehydrateTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRehydrate = (): void => {
      if (rehydrateTimer !== undefined) clearTimeout(rehydrateTimer);
      rehydrateTimer = setTimeout(() => {
        rehydrateTimer = undefined;
        void rehydrate();
      }, REMOTE_REHYDRATE_MS);
    };
    const onFrame = (frame: EventsFrame): void => {
      if (frame.type === "session" && frame.sessionId === sessionId) {
        if (frame.kind === "status") {
          // The avatar's live-edge ring + the poll's trigger flip LIVE (a
          // PC-started turn now tells the phone the moment it starts).
          const nextStatus = sessionStatusFromWire(frame.status);
          if (nextStatus !== null) {
            setDetail((prev) =>
              prev !== null && prev.status !== nextStatus ? { ...prev, status: nextStatus } : prev,
            );
          }
        }
        if (frame.kind === "meta") {
          // R114-d — a PREFERENCE flip (mode / task posture / selected model)
          // applies IN PLACE, instant, no debounce: the frame IS the new
          // truth (the kebab's rows + the composer's sheets read the detail
          // row; the honest fallback identity also reads its status). The
          // debounced rehydrate below stays the truth-backstop, exactly like
          // every other session frame.
          setDetail((prev) =>
            prev !== null
              ? applySessionMetaPatch(prev, {
                  ...(frame.permissionMode !== undefined
                    ? { permissionMode: frame.permissionMode }
                    : {}),
                  ...(frame.activeMode !== undefined ? { activeMode: frame.activeMode } : {}),
                  ...(frame.selectedModel !== undefined ? { selectedModel: frame.selectedModel } : {}),
                })
              : prev,
          );
        }
        scheduleRehydrate();
        return;
      }
      if (frame.type === "turn" && frame.sessionId === sessionId) {
        onRemoteTurnFrame(frame.frame);
      }
    };
    const unsubscribe = store.subscribeFrames(onFrame);
    return () => {
      unsubscribe();
      if (rehydrateTimer !== undefined) clearTimeout(rehydrateTimer);
    };
  }, [sessionId, rehydrate, onRemoteTurnFrame]);

  // ── the live stream ────────────────────────────────────────────────────────

  const closeStream = useCallback(() => {
    streamClosedRef.current = true;
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const rehydrateAfterTurn = useCallback(() => {
    void rehydrate().then(() => {
      // The truth landed — drop the live overlay (one paint, no flash),
      // UNLESS a NEW remote mirror opened during the fetch (a queued turn
      // starting on another device inside this window) — its frames own the
      // overlay now and its own terminal path will settle it.
      if (liveRef.current !== null && liveRef.current.terminal !== null && !remoteRef.current) {
        setLiveState(null);
      }
    });
  }, [rehydrate, setLiveState]);

  const openStream = useCallback(
    (content: string, overrides: SendOverrides) => {
      const link = getLinkManager();
      let stream: SseStream;
      try {
        // R113-c: the composer's per-send overrides ride the SAME body the
        // desktop composer assembles (model/providerId/thinkingLevel/
        // attachments — sendBody in features/sessions.ts).
        stream = openTurnStream(link, sessionId, content, overrides);
      } catch {
        // The link dropped between the tap and the socket — the outbox owns it
        // (the overrides ride the flush).
        void getOutbox().enqueue(sessionId, content, overrides);
        return;
      }
      mobLog("stream", "opened", { sessionId });
      streamClosedRef.current = false;
      streamRef.current = stream;
      // An own stream is now authoritative — any stale remote mirror is
      // done (the initiator guard ignores mirrored frames while it runs).
      remoteRef.current = false;
      setLiveState(
        beginLiveTurn(baseItems, content, Date.now(), overrideAttachmentViews(overrides)),
      );
      stream.addEventListener("data", (ev) => {
        const frame = parseStreamFrame(ev.data);
        if (frame === null) return;
        const prev = liveRef.current;
        if (prev === null) return;
        const next = applyLiveFrame(prev, frame, Date.now());
        setLiveState(next);
        if (next.terminal !== null) {
          // done / stopped / error — the turn is over; the truth owns the render.
          mobLog("stream", "terminal frame", { type: String(frame.type) });
          closeStream();
          rehydrateAfterTurn();
        }
      });
      stream.addEventListener("error", (err) => {
        closeStream();
        if (err.kind === "http") {
          // The host refused before streaming (validation / unknown session) —
          // honest error, the draft's fate is visible in the message.
          mobWarn("stream", "http refusal", { message: err.message });
          setError(`the host refused the message: ${err.message}`);
          setLiveState(null);
          void rehydrate();
        } else {
          // Transport loss mid-turn: the turn survives (R42) — rehydrate and
          // let the calm poll keep watching it. The message is not re-sent.
          mobWarn("stream", "transport loss mid-turn — rehydrating (R42)", { kind: err.kind });
          if (liveRef.current !== null) setLiveState(abandonLiveTurn(liveRef.current));
          void rehydrate();
        }
      });
      stream.addEventListener("close", () => {
        if (streamClosedRef.current) return; // our own close — already handled
        // The stream ended without a terminal frame — ambiguous, the truth wins.
        mobLog("stream", "closed without terminal — truth wins");
        streamRef.current = null;
        if (liveRef.current !== null) setLiveState(abandonLiveTurn(liveRef.current));
        void rehydrate();
      });
    },
    [sessionId, baseItems, closeStream, rehydrateAfterTurn, rehydrate, setLiveState],
  );

  // ── composer actions ───────────────────────────────────────────────────────

  const remoteRunning = detail !== null && detail.status === "running";
  const liveRunning = live !== null && (live.phase === "streaming" || live.phase === "stopping");

  const onSend = useCallback(
    (content: string, overrides: SendOverrides) => {
      if (status !== "connected") {
        void getOutbox().enqueue(sessionId, content, overrides);
        return;
      }
      openStream(content, overrides);
    },
    [status, sessionId, openStream],
  );

  // R118-D — the STOP TURN (renamed from onStop): the same POST + phase
  // flip + rehydrate ladder as ever; BOTH affordances route here — the
  // composer's button (through the ConfirmDialog) and the kebab's armed
  // two-step row (its label flip IS the confirmation, no dialog).
  const stopTurn = useCallback(() => {
    if (liveRef.current !== null) {
      setLiveState({ ...liveRef.current, phase: "stopping" });
    }
    void postStop(getLinkManager(), sessionId)
      .then(() => rehydrate())
      .catch(() => {
        // transport loss — the calm poll + foreground wake own the recovery
      });
    if (streamRef.current === null) {
      // A desktop-side turn (no stream of ours) — the stop frame never comes
      // to us; rehydrate shortly so the settled status shows.
      setTimeout(() => void rehydrate(), 600);
    }
  }, [sessionId, rehydrate, setLiveState]);

  const onQueue = useCallback(
    (content: string, overrides: SendOverrides) => {
      void postQueue(getLinkManager(), sessionId, content, overrides)
        .then((outcome) => {
          if (outcome.ok) {
            void rehydrate(); // the queued chip rides the folded log
            return;
          }
          if (outcome.error.code === "NO_LIVE_TURN") {
            // The turn ended between tap and POST — the honest fallback.
            openStream(content, overrides);
            return;
          }
          setError(`couldn't queue the message: ${outcome.error.message}`);
        })
        .catch(() => {
          void getOutbox().enqueue(sessionId, content, overrides);
        });
    },
    [sessionId, rehydrate, openStream],
  );

  const onDismissOutbox = useCallback(async () => {
    const outbox = getOutbox();
    for (const entry of outboxEntries) {
      await outbox.remove(entry.id);
    }
    mobLog("outbox", "entries dismissed", { count: outboxEntries.length, sessionId });
  }, [outboxEntries, sessionId]);

  // ── the ask_user answers (R113-c — the desktop QuestionCard's POST) ──────

  /** Resolve one question card: 200 settles the card (the stream's own
   * agent-question.resolved frame confirms it), 404 = already timed out —
   * the card's own state is the fallback either way. */
  const onAnswerQuestion = useCallback(
    async (questionId: string, answers: string[], sources: Array<"option" | "custom">): Promise<boolean> => {
      try {
        const outcome = await postResolveQuestion(getLinkManager(), questionId, answers, sources);
        return outcome.ok;
      } catch {
        return false; // transport — the card stays answerable
      }
    },
    [],
  );

  // ── the composer's per-session settings (PATCH round-trips) ─────────────

  /** PATCH /sessions/:id/permissions — the desktop ModeSwitcher's exact
   * per-session round-trip (applies to the NEXT turn). */
  const onPermissionModeChange = useCallback(
    (permissionMode: "full" | "ask" | "plan") => {
      void patchSessionPermissions(getLinkManager(), sessionId, permissionMode)
        .then((outcome) => {
          if (outcome.ok) {
            setDetail((prev) => (prev === null ? outcome.data : { ...prev, ...outcome.data }));
          } else {
            setError(`couldn't switch the mode: ${outcome.error.message}`);
          }
        })
        .catch(() => {
          setError("couldn't switch the mode — the host is offline");
        });
    },
    [sessionId],
  );

  // R115-I — the task-mode PATCH round-trip is gone WITH the task-mode
  // picker (the round-115 verdict: mobile shows only the three operating
  // modes). The meta frame still applies the row's activeMode in place —
  // the desktop keeps its picker; the phone just doesn't render one.

  /** PATCH /sessions/:id {model} — R114-d: the composer's model pick is ALSO
   * the session's server-side selected model (the cross-device truth — the
   * desktop + every other phone see the flip through the meta frame; the
   * response is the fresh row). A failure surfaces honestly; the LOCAL
   * per-send override the composer saved still rides the next send either
   * way. */
  const onModelChange = useCallback(
    (model: { providerId: string; model: string } | null) => {
      void patchSessionSelectedModel(getLinkManager(), sessionId, model)
        .then((outcome) => {
          if (outcome.ok) {
            setDetail((prev) => (prev === null ? prev : { ...prev, ...outcome.data }));
          } else {
            setError(`couldn't set the model: ${outcome.error.message}`);
          }
        })
        .catch(() => {
          setError("couldn't set the model — the host is offline");
        });
    },
    [sessionId],
  );

  // ── render ─────────────────────────────────────────────────────────────────

  // R119-A — THE CENTER: one visual TURN per exchange. The memo builds the
  // ordered ITEM stream (live tail or the settled fold + the outbox rows;
  // the synthetic thinking marker while the live turn streams with no
  // content — thinkingPlaceholderVisible's honesty rules unchanged), then
  // the QUEUED-AFTER-TURN LAW re-positions every still-queued row AFTER it
  // (never above the processing section), then the grouping memo below
  // partitions it into turn blocks + the standalone cards. The chat prefs
  // (density / text size / timestamps / toolActivity) are read by the
  // TurnBlock + the item cards themselves through useChatPrefs — reactive,
  // exactly as before; the screen no longer folds tool runs here (the
  // toolActivity pref applies to the turn's SEPARATED elements now —
  // R129-M).
  const displayItems = useMemo<TranscriptItem[]>(() => {
    let items: TranscriptItem[];
    if (live !== null) {
      items = live.items;
    } else {
      const pending: TranscriptItem[] = outboxEntries.map((entry) => ({
        kind: "user",
        key: entry.id,
        content: entry.content,
        queued: true,
        attachments: entry.overrides?.attachments ?? null,
        ts: null,
        // R116-m — the outbox row's rung: the message waits on THIS phone
        // for the link (the clock glyph rides the queued badge).
        status: "sending",
      }));
      items = [...baseItems, ...pending];
    }
    // R114-d → R119-A — the THINKING MARKER: while the live turn streams
    // with no assistant content yet, the synthetic item rides exactly where
    // the turn's block will render. The FIRST real delta retires it
    // (thinkingPlaceholderVisible flips false — the marker is gone and the
    // grouping hands the block to the real items). The standalone
    // placeholder CARD is retired: the grouping consumes the marker as the
    // TurnBlock's own pending, breathing rail state.
    if (live !== null && thinkingPlaceholderVisible(live)) {
      items = [...items, { kind: "thinking", key: "live-thinking", model: live.model }];
    }
    // R119-A — the queued-position law (round-119 §1 item 7): still-queued
    // rows move AFTER everything else — in particular after the marker/turn
    // items — so a waiting message never renders above the currently-
    // processing section (pure + pinned: features/turn-block.ts).
    return orderDisplayItems(items);
  }, [live, baseItems, outboxEntries]);

  // The grouped rows the FlatList renders (turn blocks + standalone cards;
  // a group's key is its FIRST item's key, so inverted-list recycling
  // stays stable across frames).
  const displayRows = useMemo<DisplayRow[]>(() => groupDisplayRows(displayItems), [displayItems]);

  // ── ROUND-120 (why): ── the owner's item 33 — the kebab's Task list reads
  // the session's ONE todo card out of the display item stream (the same
  // list the transcript's TodoCard renders — the persisted fold's latest
  // snapshot or the live reducer's, whichever is in play).
  const todoItem = useMemo(() => {
    for (const item of displayItems) {
      if (item.kind === "todo") return item.todos;
    }
    return null;
  }, [displayItems]);
  const sessionTodos = todoOverride ?? todoItem;
  // The override retires the moment the fold's own truth equals it (the
  // frame/rehydrate caught up) — never a stale mirror over a fresh write.
  useEffect(() => {
    if (todoOverride === null) return;
    if (todoItem === null) return;
    if (todosEqual(todoOverride, todoItem)) setTodoOverride(null);
  }, [todoOverride, todoItem]);

  const composerMode: ComposerMode =
    status !== "connected" ? "offline" : liveRunning || remoteRunning ? "running" : "compose";

  // ── R121-c (the pixels round) — the transcript's image-bytes resolver ─────
  // Built over the link manager (the ApiSender) + the session's projectId:
  // the user bubble's image thumbnails fetch their display bytes through
  // GET /projects/:id/attachments/bytes (responseBase64), and THIS screen
  // persists them as cache files (data URIs carry an Android size ceiling;
  // a cache file does not — the raster.ts lesson). The cache name is
  // content-keyed (attachmentCacheFileName), so re-renders hit the same
  // file. Absent (no project yet) → the honest frame, byte-identical to
  // the pre-R121 render.
  const attachmentImageResolver: AttachmentImageResolver | undefined = useMemo(() => {
    if (detail?.projectId == null) return undefined;
    const projectId = detail.projectId;
    return async (a) => {
      const bytes = await fetchAttachmentImageBase64(
        getLinkManager(),
        projectId,
        a.path ?? a.name,
      );
      if (bytes.base64 === null) return null;
      try {
        const file = new File(Paths.cache, attachmentCacheFileName(a.path ?? a.name, a.size));
        file.write(bytes.base64, { encoding: "base64" });
        return file.uri;
      } catch {
        // The write failed — an honest miss (never blocks the transcript).
        return null;
      }
    };
  }, [detail?.projectId]);

  // ── R115-I — the identity bar's honest identity ladder ────────────────────

  // The project row (fetchProjects cached per mount): the session's
  // projectId against the registry — null while loading / offline / no
  // project / a project the registry no longer lists, each honest.
  const project =
    detail !== null && detail.projectId !== null && projects !== null
      ? (projects.find((p) => p.id === detail.projectId) ?? null)
      : null;
  // The bar's title/subtitle ladder: WITH a project → project name over
  // the session's own name (the project is the identity, the session is
  // the context — chat.md); WITHOUT → the session title over its status
  // label; not loaded yet → "Session" with no subtitle.
  const headerTitle = project !== null ? project.name : detail !== null ? sessionTitle(detail) : "Session";
  const headerSubtitle =
    detail === null
      ? undefined
      : project !== null
        ? sessionTitle(detail)
        : sessionStatusLabel(detail.status);
  const headerFallbackLetter =
    detail !== null ? sessionTitle(detail).trim().charAt(0).toUpperCase() : "A";
  // The dropdown's Mode row reads the same source the old pill did.
  const kebabModeLabel = modeOption(detail?.permissionMode ?? "ask").label;

  // A turn runs somewhere (own stream, own overlay, or the row's running
  // status) — the avatar's live-edge ring + the dropdown's Stop row + the
  // composer's running mode all read this one truth.
  const turnLive = liveRunning || remoteRunning;

  // ── R117-d2 — the error cards' Retry (the screen owns the re-send) ─────────

  /** The failed turn's user message: the LAST user item BEFORE the error
   * card in chat order (displayItems is oldest → newest; the inverted
   * list's `data` is the reverse — read the memo, never the list). Null
   * when no user message precedes the card — never a guess. */
  const retryContentForError = useCallback(
    (errorKey: string): string | null => {
      const idx = displayItems.findIndex((it) => it.key === errorKey);
      if (idx === -1) return null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        const it = displayItems[i];
        if (it !== undefined && it.kind === "user") return it.content;
      }
      return null;
    },
    [displayItems],
  );

  /** The error card's Retry: re-send the failed turn's user message as a NEW
   * turn through the normal send path (the PC's onRetry contract — the card
   * calls, the screen binds the message). A live turn refuses honestly at
   * the tap; an unresolvable card says so too — both through the quiet
   * error line the composer already owns. */
  const onRetryFailedTurn = useCallback(
    (errorKey: string): void => {
      if (turnLive) {
        setError("a turn is already running — retry once it finishes");
        return;
      }
      const content = retryContentForError(errorKey);
      if (content === null || content.trim() === "") {
        setError("couldn't find the message to retry");
        return;
      }
      onSend(content, {});
    },
    [turnLive, retryContentForError, onSend],
  );

  // The composer's slice of the sheet state (R118-D: `sheet` is now PURELY
  // the composer's attach pair and passes straight through), and the
  // referentially guarded snapshot receiver — R118-D's WIDENED guard:
  // scalar-compare the labels (modelLabel/thinkingLabel/ctxPct/
  // thinkingUnsupported/thinkingSelected), reference-compare the memos +
  // callbacks (modelSections/thinkingOptions/contextReport/pickModel/
  // pickThinking). A value-identical report re-renders nothing.
  const setComposerSheet = useCallback((next: ComposerSheet | null): void => {
    setSheet(next);
  }, []);
  const onControlsSnapshot = useCallback((next: ComposerControlsSnapshot): void => {
    setControls((prev) =>
      prev.modelLabel === next.modelLabel &&
      prev.thinkingLabel === next.thinkingLabel &&
      prev.ctxPct === next.ctxPct &&
      prev.thinkingUnsupported === next.thinkingUnsupported &&
      prev.thinkingSelected === next.thinkingSelected &&
      prev.modelSections === next.modelSections &&
      prev.thinkingOptions === next.thinkingOptions &&
      prev.contextReport === next.contextReport &&
      prev.pickModel === next.pickModel &&
      prev.pickThinking === next.pickThinking
        ? prev
        : next,
    );
  }, []);

  // ── R118-D — the kebab menu's level helpers ───────────────────────────

  /** Close the whole menu: level → null + the armed stop resets (the
   *  two-step never survives a dismissal). R120-P: the Task list's
   *  optimistic override + error die with the menu too — a reopened list
   *  always reads the fold's own truth. */
  const closeMenu = useCallback((): void => {
    setMenu(null);
    setStopArmed(false);
    setTodoOverride(null);
    setTodoError(null);
  }, []);

  // ── ROUND-120 (why): ── the owner's item 33 — the Task list's CHECKABLE
  // rows. A tap optimistically flips the row (toggleTodoAt — pure), the
  // POST carries the WHOLE list (the R88 route's contract), and the fold
  // catches up through the todo-updated frame (a live turn is registered)
  // or the post-write rehydrate; a failure reverts the override with the
  // honest one-line error (never a silent un-flip).
  const toggleSessionTodo = useCallback(
    (index: number): void => {
      if (sessionTodos === null || todoBusy) return;
      const next = toggleTodoAt(sessionTodos, index);
      setTodoOverride(next);
      setTodoError(null);
      setTodoBusy(true);
      void postSessionTodo(getLinkManager(), sessionId, next)
        .then((outcome) => {
          setTodoBusy(false);
          if (outcome.ok) {
            void rehydrate();
          } else {
            setTodoOverride(null);
            setTodoError("couldn't update the task list");
            void warningHaptic();
          }
        })
        .catch(() => {
          setTodoBusy(false);
          setTodoOverride(null);
          setTodoError("couldn't reach the host");
          void warningHaptic();
        });
    },
    [sessionTodos, todoBusy, sessionId, rehydrate],
  );

  /** Back to the main level (the sub-levels' back chevron). */
  const backToMain = useCallback((): void => {
    setMenu("main");
  }, []);

  // The armed stop resets when the turn dies — a stale "Do you want to
  // stop?" label over a dead turn is a lie.
  useEffect(() => {
    if (!turnLive) setStopArmed(false);
  }, [turnLive]);

  // ── R118-D — the kebab menu's LEVELS (spec §2.2) ─────────────────────────
  // The rows + children each level renders IN the anchored panel. Picks
  // APPLY AND RETURN to main (setMenu("main") — the feedback loop closes
  // where the owner will look; the 90% flow is one adjustment, the back
  // chevron remains for deliberate browsing). Context stays read-only at
  // its own level — nothing to apply, the meter is the answer.
  // R119-B — every named sub-level owns EXACTLY its own rows: the ternary
  // carries the explicit "model" branch (the R118-D shape had none, so the
  // ROOT rows fell through to the else arm and trailed the model list —
  // the owner's exact report), and the else arm itself is guarded through
  // menuLevelRendersRootRows so the root rows can ONLY ever render at the
  // root (belt + suspenders — deleting either half alone keeps the law).
  const connected = status === "connected";
  /** The mode level's selected truth — the same source the main row's value
   *  reads (the session row's CURRENT permission mode). */
  const currentMode = detail?.permissionMode ?? "ask";

  /** The level's own title (the main level keeps the panel's quiet caption). */
  const menuTitle =
    menu === "mode"
      ? "Operating mode"
      : menu === "model"
        ? "Model"
        : menu === "thinking"
          ? "Thinking level"
          : menu === "context"
            ? "Context usage"
            : menu === "tasks"
              ? "Task list"
              : "Session options";

  const menuItems: HeaderDropdownItem[] =
    menu === "mode"
      ? MODE_OPTIONS.map((option) => ({
          // Single-line law: the label alone, no descriptions (the sheet's
          // two-line rows are the sheet's grammar — a menu row is one line).
          key: `mode-${option.id}`,
          label: option.label,
          selected: option.id === currentMode,
          onPress: () => {
            if (option.id !== currentMode) onPermissionModeChange(option.id);
            setMenu("main");
          },
        }))
      : menu === "model"
        ? // R119-B — the EXPLICIT branch: the model level renders its OWN
          // content (the provider accordion rides `children`); the root
          // control rows NEVER trail the model list again.
          []
        : menu === "thinking"
          ? controls.thinkingOptions.map((option) => ({
              key: `thinking-${option.id}`,
              label: option.label,
              selected: option.id === controls.thinkingSelected,
              onPress: () => {
                controls.pickThinking(option.id);
                setMenu("main");
              },
            }))
          : menu === "context"
            ? [] // read-only — the back chevron is the way out
            : menu === "tasks"
              ? // ── ROUND-120 (why): ── the owner's item 33 — the Task list
                // renders its OWN content (the checkable rows ride
                // `children`); the root control rows never trail the list.
                []
              : menuLevelRendersRootRows(menu)
              ? [
                  {
                    key: "mode",
                    label: "Mode",
                    value: kebabModeLabel,
                    onPress: () => setMenu("mode"),
                  },
                  {
                    key: "model",
                    label: "Model",
                    value: controls.modelLabel,
                    onPress: () => setMenu("model"),
                  },
                  {
                    key: "thinking",
                    label: "Thinking",
                    value: controls.thinkingLabel,
                    onPress: () => setMenu("thinking"),
                  },
                  {
                    key: "context",
                    label: "Context",
                    value: controls.ctxPct !== null ? `${controls.ctxPct}%` : "—",
                    onPress: () => setMenu("context"),
                  },
                  // THE TWO-STEP STOP: not armed → "Stop this turn" arms IN PLACE
                  // (nothing stops); armed → the owner's copy "Do you want to
                  // stop?" — the second tap closes + resets + fires stopTurn.
                  ...(turnLive
                    ? [
                        {
                          key: "stop",
                          label: stopArmed ? "Do you want to stop?" : "Stop this turn",
                          danger: true,
                          onPress: () => {
                            if (!stopArmed) {
                              setStopArmed(true);
                              return;
                            }
                            closeMenu();
                            stopTurn();
                          },
                        },
                      ]
                    : []),
                  // ── ROUND-120 (why): ── the owner's item 33 — "The kebab menu
                  // gains a separator + 'Task list' option at the bottom":
                  // the strong inset rule (HeaderDropdown's `separator`)
                  // breaks the session's own tools out of the control tier,
                  // and the live value is the honest "done/total" count (no
                  // value when the session has no list yet — the level says
                  // so in its empty caption).
                  {
                    key: "tasks",
                    label: "Task list",
                    separator: true,
                    ...(sessionTodos !== null
                      ? {
                          value: `${sessionTodos.filter((t) => t.status === "completed").length}/${sessionTodos.length}`,
                        }
                      : {}),
                    onPress: () => setMenu("tasks"),
                  },
                ]
              : [];

  const menuChildren: React.ReactNode =
    menu === "model" ? (
      controls.modelSections === null ? (
        <View style={styles.menuBusyRow}>
          <ActivityIndicator size="small" color={tokens.accent} />
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            {connected ? "loading the configured models…" : "the host is offline"}
          </TypeCaption>
        </View>
      ) : controls.modelSections.length === 0 ? (
        <View style={styles.menuCaptionRow}>
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            no models configured on the host
          </TypeCaption>
        </View>
      ) : (
        <ModelLevelRows
          sections={controls.modelSections}
          onPick={(row) => {
            controls.pickModel(row);
            setMenu("main");
          }}
        />
      )
    ) : menu === "thinking" && controls.thinkingUnsupported ? (
      <View style={styles.menuCaptionRow}>
        <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
          this model does not support reasoning
        </TypeCaption>
      </View>
    ) : menu === "context" ? (
      controls.contextReport === null ? (
        <View style={styles.menuBusyRow}>
          <ActivityIndicator size="small" color={tokens.accent} />
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            {connected ? "reading the meter…" : "the host is offline"}
          </TypeCaption>
        </View>
      ) : (
        <ContextLevelReadout report={controls.contextReport} />
      )
    ) : menu === "tasks" ? (
      // ── ROUND-120 (why): ── the owner's item 33 — the session's Task list
      // IN THE SAME MENU FAMILY (the anchored panel's own level, the
      // back-chevron grammar every other level rides). CHECKABLE rows: the
      // R88 owner-write route exists, so a tap toggles + POSTs the whole
      // list; the honest error line + the busy guard live with the rows.
      sessionTodos === null ? (
        <View style={styles.menuCaptionRow}>
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            no tasks in this session yet
          </TypeCaption>
        </View>
      ) : (
        <TaskLevelRows todos={sessionTodos} busy={todoBusy} error={todoError} onToggle={toggleSessionTodo} />
      )
    ) : null;

  // ── R115-K — the keyboard architecture: ONE dock, ONE expression ─────────
  // (the header comment above carries the full contract). The dock's kbHeight
  // is POSITIVE while open, 0 when closed, written by two idempotent paths.
  const insets = useSafeAreaInsets();
  const insetsBottom = insets.bottom;
  // R118-D — the chrome column's status-bar strip: the negative margin that
  // pulls the surfaceHeader fill UP through the safe-area inset (with the
  // compensating paddingTop riding the inline style at the render).
  const insetsTop = insets.top;
  const kbHeight = useSharedValue(0);

  // The window mode: ADJUST_NOTHING for this screen's lifetime — the window
  // never resizes or pans; the dock owns the lift (the IME insets still
  // stream — they're inset-driven, not resize-driven). Unmount restores the
  // manifest-declared mode through setDefaultMode() — the exact restore the
  // removed useResizeMode performed, so every other screen (tab roots, the
  // KeyboardAwareScrollView forms) keeps its pre-R115-K behavior.
  useEffect(() => {
    KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
    return () => {
      KeyboardController.setDefaultMode();
    };
  }, []);

  // The UI-thread path: raw keyboard frames → the shared value. Raw events
  // carry a POSITIVE height while open (the library negates only for its own
  // useReanimatedKeyboardAnimation convention). useGenericKeyboardHandler is
  // the one hook that does NOT mutate the soft-input mode.
  useGenericKeyboardHandler(
    {
      onMove: (e) => {
        "worklet";
        kbHeight.value = e.height;
      },
      onEnd: (e) => {
        "worklet";
        kbHeight.value = e.height;
      },
    },
    [],
  );

  // The defensive JS-thread twin (the fallback probe): the library's JS
  // events synced ONLY on the animation END states — didShow/didHide carry
  // exactly the worklet path's final values, so on a healthy device the
  // write is idempotent (invisible), and on a device where the reanimated
  // worklet path is dead the dock still lands correct (one snap at animation
  // end instead of the ride). willShow is deliberately NOT synced: it fires
  // at animation START with the destination height and would jump the dock
  // ahead of the worklet's rising frames.
  useEffect(() => {
    const shown = KeyboardEvents.addListener("keyboardDidShow", (e) => {
      kbHeight.value = e.height;
    });
    const hidden = KeyboardEvents.addListener("keyboardDidHide", () => {
      kbHeight.value = 0;
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // THE DOCK EXPRESSION — the entire keyboard architecture in one line:
  // closed → max(inset, 0) = the gesture-bar inset; open → max(inset, kb) =
  // the full keyboard height. One smooth UI-thread rise; the inverted
  // FlatList above reflows on its own; nothing else offsets anything.
  // ── ROUND-120 (why): ── the owner's item 28 — "the composer rides the
  // device edge — add a proper bottom inset": the house beat (8dp) rides
  // ON TOP of the max() in BOTH states — the flat case (a device reporting
  // no bottom inset) gets the beat alone, the home-indicator case gets
  // inset + beat, and the open-keys case keeps the same breathing gap over
  // the IME. The composer itself never pads its own bottom (the dock owns
  // the keyboard architecture — R115-K's ONE-expression law).
  const dockStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insetsBottom, kbHeight.value) + COMPOSER_EDGE_BEAT,
  }));

  const data = useMemo(() => [...displayRows].reverse(), [displayRows]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void rehydrate();
      }}
      tintColor={tokens.textTertiary}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  if (sessionId === "") {
    return (
      <ScreenScaffold title="Session" back>
        <ErrorState title="No session id" caption="Open a session from the sessions list." />
      </ScreenScaffold>
    );
  }

  return (
    // R115-I — the scaffold's chrome is BYPASSED (chrome={false}): the
    // identity bar is not the scaffold's centered-title shape, and rendering
    // it here in the body keeps every other screen's chrome byte-identical
    // (zero shared-file changes). scroll={false} makes the scaffold's body a
    // plain flex:1 View — the identity bar stacks above the transcript +
    // dock exactly where the header row used to sit, inside the top
    // safe-area inset the SafeAreaView already owns.
    <ScreenScaffold title="Session" scroll={false} chrome={false}>
      {/* ── THE CHROME COLUMN (R118-D — spec §2.1): the identity bar's own
          surfaceHeader fill, pulled UP through the status-bar inset (the
          negative margin + compensating padding — the fill owns the strip
          behind the status bar too), with the hairline borderSubtle
          separator at its bottom edge — the plain hairline in EVERY state
          (R123-W-m: the breathing accent bar that used to pin over this
          edge is RETIRED at the owner's explicit re-demand; the avatar's
          live-edge ring above is the running turn's one tell). THE IDENTITY
          BAR itself (R115-I — chat.md §Header): [back circle 40px] · [the
          project's LetterAvatar 36px] · [project name over the session's
          own name] · [the kebab ⋮ 44px]. Status words are OUT. */}
      <View
        style={[
          styles.headerColumn,
          {
            marginTop: -insetsTop,
            paddingTop: insetsTop,
            backgroundColor: tokens.surfaceHeader,
            borderBottomColor: tokens.borderSubtle,
          },
        ]}
      >
        <View style={styles.headerRow}>
          {/* R118-D — the back button: the shared QuietIconButton (ArrowLeft
              22, the 40px circle — the chevron "bracket" is retired) with a
              real trailing gap (marginRight xs — 8dp total to the avatar). */}
          <View style={styles.backWrap}>
            <QuietIconButton
              icon={ArrowLeft}
              iconSize={22}
              size={40}
              onPress={() => router.back()}
              accessibilityLabel="Go back"
              testID="session-back"
            />
          </View>
          {/* R120-CM (§2 Track C-M — the processing indicators): the avatar
              wears a subtle accent EDGE while a turn is live — the
              delivery-edge rhythm, absolutely OVER the avatar so the header
              layout never shifts; at rest NOTHING renders (resting chrome
              never fidgets — motion.md §5). */}
          <View style={styles.avatarWrap}>
            {project !== null ? (
              <LetterAvatar label={project.name} color={project.color} size={AVATAR_SIZE} testID="session-header-avatar" />
            ) : (
              <NeutralAvatar label={headerFallbackLetter} />
            )}
            <AvatarLiveEdge live={turnLive} />
          </View>
          <View style={styles.headerIdentity}>
            <TypeBodyStrong numberOfLines={1} testID="session-header-title">
              {headerTitle}
            </TypeBodyStrong>
            {headerSubtitle !== undefined ? (
              <TypeCaption
                style={{ color: tokens.textTertiary }}
                numberOfLines={1}
                testID="session-header-subtitle"
              >
                {headerSubtitle}
              </TypeCaption>
            ) : null}
          </View>
          <Pressable
            accessibilityLabel="Session options"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setMenu(menu !== null ? null : "main")}
            style={styles.headerTarget}
            testID="session-kebab"
          >
            <Ellipsis size={24} color={tokens.text} strokeWidth={2.4} />
          </Pressable>
        </View>
      </View>

      {/* R115-K — the dock owns the keyboard: NO KeyboardAvoidingView, NO
          offsets, NO window resize (the window is ADJUST_NOTHING while this
          screen lives). The only thing that moves is the dock's own animated
          paddingBottom (dockStyle — max(insetsBottom, kbHeight) + the
          R120-P edge beat); the whole composer — offline/outbox/note rows,
          the @-picker popup, chips, the single-tier input bar with its
          DOCKED Add Context control inside the input's own surface — rides
          INSIDE it, and the inverted FlatList above (flex:1)
          reflows on its own. The list keeps
          keyboardShouldPersistTaps="handled" so a transcript tap while the
          keys are up never dismiss-focus-then-refocus jarringly. */}
      <View style={styles.body}>
        {loading ? (
          <View style={styles.centerWrap}>
            <LoadingState caption="loading the transcript…" />
          </View>
        ) : detail === null && error !== null ? (
          <View style={styles.centerWrap}>
            <ErrorState
              title="couldn't open the session"
              caption={error}
              retryLabel="retry now"
              onRetry={() => {
                void rehydrate();
                getLinkManager().retryNow();
              }}
            />
            {/* R116-l — the auto-retry's quiet tell (verdict #53): the 5s poll
                above is already rehydrating; the micro line says so so the
                owner never wonders whether the screen is dead. */}
            <TypeMicro
              style={{ color: tokens.textTertiary, marginTop: spacing.sm }}
              numberOfLines={1}
              testID="session-auto-retry"
            >
              Retrying automatically…
            </TypeMicro>
          </View>
        ) : data.length === 0 ? (
          <View style={styles.centerWrap}>
            <EmptyState
              title="an empty conversation"
              caption="send the first message — the desktop agent does all the work"
            />
          </View>
        ) : (
          <FlatList
            data={data}
            inverted
            keyExtractor={(row) => row.key}
            // ── ROUND-125 (R125-D — why): ── the owner's v0.117.0 device
            // verdict — "it has auto scroll functionality, which does not
            // stop." The list above is INVERTED with the data NEWEST-FIRST
            // ([...displayRows].reverse()), so a live turn's every SSE delta
            // PREPENDS/grows rows at index 0; with the plain numeric
            // contentOffset kept, each prepend yanked the viewport toward
            // the newest content and the reader could not scroll up and
            // STAY there. maintainVisibleContentPosition is RN's own
            // chat-grammar answer, in ITS coordinate space: "top" on an
            // inverted list is the VISUAL BOTTOM (the newest content) —
            // minIndexForVisible:1 pins the first row the user is actually
            // reading (index ≥ 1) whenever rows prepend at index 0, so the
            // reading position HOLDS and the scroll stops following the
            // stream once the user has scrolled away; the 80pt
            // autoscrollToTopThreshold keeps the stick-to-newest behavior
            // ONLY for the at-bottom reader (within 80pt of the newest
            // edge, new content still scrolls into view). The values are a
            // pure, jest-pinned contract — TRANSCRIPT_SCROLL_ANCHOR
            // (src/components/transcript-scroll.ts). The list's other props
            // are untouched: keyboardShouldPersistTaps stays "handled"
            // (transcript taps while the keys are up), and the RefreshControl
            // rides the same inverted edge it always did. Caveat (honest):
            // iOS applies the anchor inside UIScrollView's own layout pass,
            // while Android's MaintainVisibleScrollPositionHelper reacts to
            // UIManager layout events and adjusts the offset right AFTER the
            // layout lands — on very fast prepend bursts a settle frame is
            // possible (a one-frame shimmer, not a jump); both platforms
            // implement both fields in RN 0.86.
            maintainVisibleContentPosition={TRANSCRIPT_SCROLL_ANCHOR}
            renderItem={({ item: row }) => (
              <TranscriptRowView
                row={row}
                onApprovalDecide={() => router.navigate("/approvals")}
                onAnswerQuestion={onAnswerQuestion}
                subagentLive={live?.subagentLive}
                onRetryError={
                  row.kind === "item" && row.item.kind === "error"
                    ? () => onRetryFailedTurn(row.item.key)
                    : undefined
                }
                attachmentImageResolver={attachmentImageResolver}
              />
            )}
            ItemSeparatorComponent={ItemSeparator}
            contentContainerStyle={styles.transcriptContent}
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            refreshControl={refreshControl}
            accessibilityLabel="Conversation transcript"
          />
        )}
        {error !== null && detail !== null && (
          <View style={styles.errorLine}>
            <TypeCaption style={{ color: tokens.danger, flex: 1 }} numberOfLines={2}>
              {error}
            </TypeCaption>
          </View>
        )}
        {/* THE DOCK (R115-K) — the single keyboard mechanism: its animated
            paddingBottom (dockStyle) is max(insetsBottom, kbHeight), so the
            whole Composer column rides one UI-thread lift. */}
        <Animated.View
          style={[styles.composerWrap, { backgroundColor: tokens.bg }, dockStyle]}
        >
          <Composer
            mode={composerMode}
            outboxCount={outboxEntries.length}
            sessionId={sessionId}
            projectId={detail?.projectId ?? null}
            permissionMode={detail?.permissionMode ?? "ask"}
            selectedModel={detail?.selectedModel ?? null}
            sheet={sheet}
            onSheetChange={setComposerSheet}
            onControlsSnapshot={onControlsSnapshot}
            onPermissionModeChange={onPermissionModeChange}
            onModelChange={onModelChange}
            onSend={onSend}
            onStop={() => setStopConfirmOpen(true)}
            onQueue={onQueue}
            onDismissOutbox={() => void onDismissOutbox()}
            streaming={liveRunning || remoteRunning}
          />
        </Animated.View>
      </View>

      {/* ── THE KEBAB MENU (R116-l → R118-D → R119-B — components.md §Dropdown
          menus + the sub-level grammar): the anchored panel with its
          LEVEL STATE MACHINE — main (the four control rows + the
          conditional two-step Stop) and one level per control, rendered IN
          the panel (back chevron + title row + content). Picks APPLY AND
          RETURN to main; Context stays read-only at its level; the Model
          level renders its PROVIDER ACCORDION (one section open at a time)
          scrolling inside the panel (contentMaxHeight 360). R119-B: the
          level SWAPS animate (the directional 12dp slide — HeaderDropdown
          owns it; this screen passes `level`). The layer is the
          absolutely-positioned anchor below the identity bar,
          pointerEvents box-none so a closed/empty layer never steals a
          touch. */}
      <View pointerEvents="box-none" style={styles.menuLayer}>
        <HeaderDropdown
          open={menu !== null}
          onClose={closeMenu}
          title={menuTitle}
          onBack={menu === null || menu === "main" ? undefined : backToMain}
          testID="session-dropdown"
          contentMaxHeight={
            menu === "model"
              ? MODEL_LEVEL_MAX_HEIGHT
              : menu === "context"
                ? CONTEXT_LEVEL_MAX_HEIGHT
                : menu === "tasks"
                  ? TASK_LEVEL_MAX_HEIGHT
                  : undefined
          }
          items={menuItems}
          level={menu ?? MAIN_LEVEL_KEY}
        >
          {menuChildren}
        </HeaderDropdown>
      </View>

      {/* ── THE CENTERED STOP CONFIRM (R118-D §2.3): the composer's stop
          button opens the dialog; the kebab's armed row fires stopTurn
          directly (its two-step IS the confirmation). */}
      <ConfirmDialog
        open={stopConfirmOpen}
        title="Stop this turn?"
        body="The agent stops — finished work stays."
        confirmLabel="Stop"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          setStopConfirmOpen(false);
          stopTurn();
        }}
        onCancel={() => setStopConfirmOpen(false)}
        testID="session-stop-confirm"
      />
    </ScreenScaffold>
  );
}

function ItemSeparator() {
  return <View style={{ height: spacing.md }} />;
}

// ── R115-I — the identity bar's pieces ─────────────────────────────────────

/** R120-CM (§2 Track C-M — the processing indicators): the avatar's LIVE
 *  edge — an absolutely-positioned 2dp accent ring breathing on the
 *  DELIVERY-EDGE rhythm (mixHex(surfaceHeader, accent, 0.34) ↔ 0.62 at the
 *  house 550ms legs — the same breath the processing bubble's border rides),
 *  the static 0.55 mix under reduced motion.
 *  Alive-but-calm: NO glow, NO spinner (donts #11/#14 — an opacity breathe
 *  is the sanctioned "currently working" idiom, motion.md §4.5's grammar),
 *  and NOTHING renders at rest. The ring draws OUTSIDE the avatar's own box
 *  (top/left −3, +6 size) so the header row's layout is byte-identical in
 *  both states; pointerEvents none — it is chrome, not a control.
 *  R123-W-m: with the header's breathing LINE retired at the owner's
 *  explicit re-demand, this ring — the glowing display-picture effect he
 *  described approvingly — is the running turn's ONE chrome tell. */
const AVATAR_EDGE_INSET = 3;
const AVATAR_EDGE_WIDTH = 2;
const AVATAR_SIZE = 36;
const AVATAR_EDGE_RADIUS = Math.round((AVATAR_SIZE + 2 * AVATAR_EDGE_INSET) * 0.38);

function AvatarLiveEdge({ live }: { live: boolean }) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!live) {
      pulse.value = 0;
      return;
    }
    if (reduced) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: LIVE_LINE_LEG_MS }),
        withTiming(0, { duration: LIVE_LINE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [live, reduced, pulse]);

  const low = mixHex(tokens.surfaceHeader, tokens.accent, DELIVERY_EDGE_LOW);
  const high = mixHex(tokens.surfaceHeader, tokens.accent, DELIVERY_EDGE_HIGH);
  const steady = mixHex(tokens.surfaceHeader, tokens.accent, DELIVERY_EDGE_STATIC);
  const style = useAnimatedStyle(() => ({
    borderColor: reduced
      ? steady
      : interpolateColor(pulse.value, [0, 1], [low, high]),
  }));

  if (!live) return null;
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.avatarEdge,
        {
          borderWidth: AVATAR_EDGE_WIDTH,
          borderRadius: AVATAR_EDGE_RADIUS,
          top: -AVATAR_EDGE_INSET,
          left: -AVATAR_EDGE_INSET,
          width: AVATAR_SIZE + 2 * AVATAR_EDGE_INSET,
          height: AVATAR_SIZE + 2 * AVATAR_EDGE_INSET,
        },
        style,
      ]}
    />
  );
}

/** The honest fallback identity tile — a NEUTRAL avatar (subtle bg + the
 * session title's first letter, "A" when nothing reads) for a session with
 * no project or one the registry no longer lists. Same geometry as the
 * LetterAvatar it stands in for (36px rounded-square clay tile — R116-k,
 * the circle is retired — TypeBodyStrong auto-scaled) but on the neutral
 * surface — never a fabricated project color. */
function NeutralAvatar({ label }: { label: string }) {
  const { tokens } = useTheme();
  const size = 36;
  return (
    <View
      testID="session-header-avatar"
      // The row's own accessibility label names the session — the bare
      // letter must not double-read (the LetterAvatar's discipline).
      accessibilityElementsHidden
      style={[
        styles.neutralAvatar,
        {
          backgroundColor: tokens.subtle,
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.38),
          // The LetterAvatar's clay treatment on the neutral surface: the
          // matte top edge over the hairline rim + the small-shadow leg.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.clayTopEdge,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.border,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
    >
      <TypeBodyStrong style={{ color: tokens.textSecondary, fontSize: Math.round(size * 0.375) }}>
        {label === "" ? "A" : label}
      </TypeBodyStrong>
    </View>
  );
}

/** The display chips for a send's overrides (the optimistic user card + the
 * pending outbox rows) — the wire's MessageAttachment display fields. */
function overrideAttachmentViews(overrides: SendOverrides): AttachmentView[] | null {
  const attachments = overrides.attachments;
  if (attachments === undefined || attachments.length === 0) return null;
  const views = attachments.map((a) => ({
    name: a.name,
    ...(a.path !== undefined ? { path: a.path } : {}),
    ...(a.size !== undefined ? { size: a.size } : {}),
  }));
  return views.length > 0 ? views : null;
}

/** ── ROUND-120 (why): ── the Task list's optimistic override retires when
 *  the fold's own list equals it — content + status, item by item (the
 *  todo-updated frame's or the rehydrate's catch-up). Pure. */
function todosEqual(a: TodoItemView[], b: TodoItemView[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.content !== b[i]?.content || a[i]?.status !== b[i]?.status) return false;
  }
  return true;
}

// ── R118-D — the kebab's IN-PANEL levels (spec §2.2) ───────────────────────

/** R118-D → R119-B — the Model level's PROVIDER ACCORDION. The R118-D
 *  shape was a flat fully-expanded provider-sectioned wall (a TypeMicro
 *  header per provider + every model row always visible); the owner's
 *  verdict: "the model list itself is a flat fully-expanded
 *  provider-sectioned wall — he wants PROVIDER NAMES by default, one
 *  provider expanding at a time into its models." So: ONE row per
 *  configured provider (its display name — TypeBodyStrong — plus the
 *  right-aligned "{n} model(s)" caption and ChevronRight 16), tapping a
 *  provider expanding THAT ONE section beneath it (only one open at a
 *  time — the pure `nextOpenModelProvider` transition, exported from the
 *  composer module so the tests can pin it without rendering; tapping the
 *  open provider toggles it shut). The expanded rows are the existing
 *  model rows — shortModelLabel one-liners, the selected row carrying the
 *  accent Check and the others NOTHING (the model rows' ChevronRight is
 *  retired: inside an expanded provider the chevron says nothing the
 *  section header didn't). Tapping a model still applies-and-returns (the
 *  pick rides the snapshot's `pickModel` — apply + PATCH; the caller's
 *  onPick owns the return to main). The open-section state is LOCAL and
 *  dies with the unmount — the menu's close/back lifecycle resets it for
 *  free. The expansion itself is the cheap disclosure: a 150ms content
 *  fade-in (the house DISCLOSURE_FADE_MS); reduced motion snaps
 *  (motion.md §5); the collapse stays instant — robustness over flourish. */
function ModelLevelRows({
  sections,
  onPick,
}: {
  sections: MenuModelSection[];
  onPick: (row: MenuModelRow) => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  return (
    <View>
      {sections.map((section) => {
        const open = openProvider === section.providerId;
        const count = section.rows.length;
        return (
          <View key={section.providerId}>
            <Pressable
              testID={`session-dropdown-provider-${section.providerId}`}
              accessibilityLabel={`${section.label} — ${count} model${count === 1 ? "" : "s"}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpenProvider(nextOpenModelProvider(openProvider, section.providerId))}
              style={({ pressed }) => [
                styles.menuRow,
                { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
              ]}
            >
              <TypeBodyStrong style={{ flex: 1, color: tokens.text }} numberOfLines={1}>
                {section.label}
              </TypeBodyStrong>
              <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
                {count} model{count === 1 ? "" : "s"}
              </TypeCaption>
              <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
            </Pressable>
            {open ? (
              <Animated.View entering={reduced ? undefined : FadeIn.duration(DISCLOSURE_FADE_MS)}>
                {section.rows.map((row) => (
                  <Pressable
                    key={row.key}
                    testID={`session-dropdown-model-${row.key}`}
                    accessibilityLabel={row.label}
                    accessibilityRole="button"
                    accessibilityState={row.selected ? { selected: true } : undefined}
                    onPress={() => onPick(row)}
                    style={({ pressed }) => [
                      styles.menuRow,
                      { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
                    ]}
                  >
                    <TypeBodyStrong style={{ flex: 1, color: tokens.text }} numberOfLines={1}>
                      {row.label}
                    </TypeBodyStrong>
                    {row.selected ? <Check size={16} color={tokens.accent} strokeWidth={2.4} /> : null}
                  </Pressable>
                ))}
              </Animated.View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** The Context level's compact read-only readout (the old ContextBreakdown
 *  sheet's HEAD, cut to the panel): the percentage line, the meter (height 4,
 *  subtle track, the fill colored by contextPressure), the used/available
 *  caption, and the model · provider mono line. Nothing here applies — the
 *  level exists to be READ. */
function ContextLevelReadout({ report }: { report: SessionContextReport }) {
  const { tokens } = useTheme();
  const pct = contextPercent(report.usedTokens, report.contextWindow);
  const pressure = contextPressure(report.usedTokens, report.contextWindow);
  const barColor =
    pressure === "danger"
      ? tokens.danger
      : pressure === "filling"
        ? tokens.warning
        : tokens.accent;
  return (
    <View style={styles.contextReadout}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
        <TypeBodyStrong>{pct}%</TypeBodyStrong>
        <TypeCaption style={{ color: tokens.textSecondary, flex: 1 }} numberOfLines={1}>
          of {formatTokens(report.contextWindow)} window
        </TypeCaption>
      </View>
      <View style={[styles.contextMeterTrack, { backgroundColor: tokens.subtle }]}>
        <View style={{ height: 4, width: `${pct}%`, backgroundColor: barColor }} />
      </View>
      <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
        used {formatTokens(report.usedTokens)} · {formatTokens(report.available)} available
      </TypeCaption>
      <TypeMono style={{ color: tokens.textTertiary, fontSize: 10.5 }} numberOfLines={1}>
        {report.model} · {report.providerId}
      </TypeMono>
    </View>
  );
}

/** ── ROUND-120 (why): ── the owner's item 33 — "tapping shows the task
 *  list in the same menu family": the session's todos as the panel's
 *  CHECKABLE level. The row's checkbox is the transcript TodoCard's own
 *  glyph family restated for the panel (the owner's favorite card, frozen
 *  as-is — one spelling of "a todo" everywhere): the 15dp square r4, the
 *  success fill + white Check when done, the accent dot while the agent
 *  works it, borderStrong at rest; the content line at TYPE_CAPTION + 0.5
 *  carries the line-through on done and WRAPS (todo content is data, not
 *  copy — the single-line law governs descriptions, never a task's own
 *  words). A tap rides `toggleSessionTodo` (optimistic flip +
 *  POST /sessions/:id/todo — the R88 owner-write route, the whole list at
 *  once); the busy guard blocks rapid double-writes, and the level's
 *  footer line is the honest "done/total" count or the failure's
 *  one-liner — never both. */
function TaskLevelRows({
  todos,
  busy,
  error,
  onToggle,
}: {
  todos: TodoItemView[];
  busy: boolean;
  error: string | null;
  onToggle: (index: number) => void;
}) {
  const { tokens } = useTheme();
  const done = todos.filter((todo) => todo.status === "completed").length;
  // ── R124 (the owner: "If I click on any one of the tasks there, it
  //    automatically marks them as done or marks them as undone, which is
  //    not a good experience. It should ask for confirmation there"): a tap
  //    ARMS the row instead of toggling it — the row swaps to the confirm
  //    affordance ("Mark as done?" + Confirm/Cancel quiet buttons); Confirm
  //    fires the real toggle, Cancel (or tapping the armed row again, or
  //    arming a different row) disarms. The POST + optimistic flip + the
  //    honest error line ride the parent's onToggle unchanged. ──
  const [armedIndex, setArmedIndex] = useState<number | null>(null);
  // A list change (the fold caught up / a new todo set landed) disarms —
  // index N may point at a different row now.
  useEffect(() => {
    setArmedIndex(null);
  }, [todos]);
  const fireToggle = (i: number): void => {
    setArmedIndex(null);
    onToggle(i);
  };
  return (
    <View>
      {todos.map((todo, i) => {
        const isDone = todo.status === "completed";
        const isActive = todo.status === "in_progress";
        const armed = armedIndex === i;
        return (
          <View key={i} style={styles.taskRowWrap}>
            {!armed ? (
              <Pressable
                accessibilityLabel={`${isDone ? "Done" : isActive ? "In progress" : "Pending"}: ${todo.content}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isDone, disabled: busy }}
                disabled={busy}
                testID={`session-task-row-${i}`}
                onPress={() => setArmedIndex(i)}
                style={({ pressed }) => [
                  styles.menuRow,
                  styles.taskRow,
                  { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
                ]}
              >
                <View
                  style={[
                    styles.taskCheckbox,
                    {
                      borderColor: isDone ? tokens.success : isActive ? tokens.accent : tokens.borderStrong,
                      backgroundColor: isDone ? tokens.success : "transparent",
                    },
                  ]}
                >
                  {isDone ? (
                    <Check size={10} color="#FFFFFF" strokeWidth={3.4} />
                  ) : isActive ? (
                    <View style={[styles.taskActiveDot, { backgroundColor: tokens.accent }]} />
                  ) : null}
                </View>
                <Text
                  style={{
                    flex: 1,
                    color: isDone ? tokens.textTertiary : isActive ? tokens.text : tokens.textSecondary,
                    fontSize: TYPE_CAPTION + 0.5,
                    fontFamily: isActive ? fontFamily.semibold : fontFamily.regular,
                    lineHeight: 18,
                    textDecorationLine: isDone ? "line-through" : "none",
                  }}
                >
                  {todo.content}
                </Text>
              </Pressable>
            ) : (
              // ── the ARMED row — the R124 confirmation. The same row's
              // geometry, carrying the question + the two quiet actions
              // (Confirm fires the toggle; Cancel disarms). The checkbox
              // stays on screen so the change being confirmed is visible. ──
              <View
                testID={`session-task-row-${i}`}
                accessibilityLabel={`Confirm: ${isDone ? "mark as not done" : "mark as done"}: ${todo.content}`}
                style={[styles.menuRow, styles.taskRow, styles.taskRowArmed, { borderColor: tokens.borderStrong }]}
              >
                <View
                  style={[
                    styles.taskCheckbox,
                    {
                      borderColor: isDone ? tokens.success : isActive ? tokens.accent : tokens.borderStrong,
                      backgroundColor: isDone ? tokens.success : "transparent",
                    },
                  ]}
                >
                  {isDone ? (
                    <Check size={10} color="#FFFFFF" strokeWidth={3.4} />
                  ) : isActive ? (
                    <View style={[styles.taskActiveDot, { backgroundColor: tokens.accent }]} />
                  ) : null}
                </View>
                <Text
                  style={{
                    flex: 1,
                    color: tokens.text,
                    fontSize: TYPE_CAPTION + 0.5,
                    fontFamily: fontFamily.semibold,
                    lineHeight: 18,
                  }}
                  numberOfLines={2}
                >
                  {isDone ? "Mark as not done?" : "Mark as done?"}
                </Text>
                <Pressable
                  accessibilityLabel="Confirm the task change"
                  accessibilityRole="button"
                  disabled={busy}
                  testID={`session-task-confirm-${i}`}
                  onPress={() => fireToggle(i)}
                  style={({ pressed }) => [
                    styles.taskConfirmButton,
                    {
                      backgroundColor: pressed ? tokens.subtleHover : tokens.subtle,
                      borderColor: tokens.borderStrong,
                    },
                  ]}
                >
                  <Check size={13} color={tokens.success} strokeWidth={2.6} />
                  <TypeCaption numberOfLines={1}>Confirm</TypeCaption>
                </Pressable>
                <Pressable
                  accessibilityLabel="Cancel the task change"
                  accessibilityRole="button"
                  disabled={busy}
                  testID={`session-task-cancel-${i}`}
                  onPress={() => setArmedIndex(null)}
                  style={({ pressed }) => [
                    styles.taskConfirmButton,
                    {
                      backgroundColor: pressed ? tokens.subtleHover : "transparent",
                      borderColor: tokens.borderStrong,
                    },
                  ]}
                >
                  <X size={13} color={tokens.textTertiary} strokeWidth={2.6} />
                  <TypeCaption numberOfLines={1}>Cancel</TypeCaption>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
      <View style={styles.menuCaptionRow}>
        <TypeCaption
          style={{ color: error !== null ? tokens.danger : tokens.textTertiary }}
          numberOfLines={1}
        >
          {error !== null ? error : `${done} of ${todos.length} done`}
        </TypeCaption>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  /** R118-D §2.1 — the chrome column: the surfaceHeader fill + separator
   *  wrapper. The negative marginTop + compensating paddingTop ride the
   *  INLINE style (insetsTop is dynamic); the fill + borderSubtle colors
   *  ride the theme tokens, inline too. */
  headerColumn: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // ── R115-I — the identity bar (the scaffold's own 56px header-row
  // geometry, restated for the bypassed chrome: 44px side targets, the
  // left-aligned two-line identity — R118-D: it renders inside the chrome
  // column above; R123-W-m: the breathing live LINE that used to pin to
  // that column's bottom edge is retired — the column's hairline separator
  // is the whole bottom edge in every state).
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
  },
  headerTarget: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  /** R118-D §2.1 — the back button's wrap: marginRight xs gives the arrow a
   *  REAL trailing gap (4 + 4 = 8dp total to the avatar; the old chevron
   *  bracket sat 4dp away). The button itself is the shared QuietIconButton
   *  — the chip grammar retired with the bracket. */
  backWrap: {
    marginRight: spacing.xs,
  },
  headerIdentity: {
    flex: 1,
    gap: 1,
  },
  /** R120-CM — the avatar's fixed 36px slot: the LIVE edge draws absolutely
   *  OUTSIDE it (−3 inset), so the header row's flex layout never shifts
   *  between the resting and the live state. */
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  },
  avatarEdge: {
    position: "absolute",
  },
  neutralAvatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  /** R116-l — the kebab dropdown's anchor layer: everything below the 56px
   * identity bar, box-none so the closed (empty) layer never blocks the
   * transcript/dock beneath it — the menu panel floats at its top-right
   * (inside HeaderDropdown), the tap-outside catcher fills the rest. */
  menuLayer: {
    position: "absolute",
    top: 56,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // ── R118-D — the kebab's in-panel levels' geometry ────────────────────
  /** The Model level's option row — the DropdownRow grammar restated (the
   *  rows ride `children`; R119-B: the same shape carries the accordion's
   *  PROVIDER row — name + count caption + chevron — and its model rows). */
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  /** The busy row that migrated in from the deleted sheets (the model
   *  catalog load + the context meter's first read). */
  menuBusyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.xs,
  },
  /** A non-pressable caption row (the thinking-unsupported line, the empty
   *  catalog) — honest content, never a dead control. */
  menuCaptionRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  /** ── ROUND-120 (why): ── the Task level's CHECKABLE row — the menuRow's
   *  press geometry with the TodoCard's own flex-start alignment (a wrapping
   *  todo keeps its checkbox on the FIRST line, the card's spelling). */
  taskRow: {
    alignItems: "flex-start",
  },
  /** R124 — the task row's confirm wrapper (the row or its armed form,
  *  never both). */
  taskRowWrap: {
    width: "100%",
  },
  /** R124 — the ARMED row (the confirmation state): a bordered clay
  *  strip carrying the question + the Confirm/Cancel quiet buttons. */
  taskRowArmed: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    backgroundColor: "transparent",
  },
  /** R124 — the quiet Confirm/Cancel pills on the armed row. */
  taskConfirmButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 32,
  },
  /** The 15dp checkbox square — the transcript TodoCard's own glyph
   *  (r4, 1.5dp border, the success fill + white Check when done, the
   *  6dp accent dot while the agent works it). One spelling everywhere. */
  taskCheckbox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1.5,
  },
  taskActiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  /** The Context level's compact readout (the meter + its three lines). */
  contextReadout: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  /** The meter's track (height 4, r2 — the old sheet's own geometry). */
  contextMeterTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  centerWrap: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
  },
  transcriptContent: {
    padding: spacing.lg,
  },
  errorLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "transparent",
  },
});
