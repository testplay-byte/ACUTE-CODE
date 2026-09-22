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
 * subtitle. STATUS WORDS ARE OUT OF THE HEADER — a running turn shows as
 * the thin 2px accent line BREATHING under the bar (reanimated opacity
 * pulse, the live caret's rhythm).
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
 * padding) with the hairline borderSubtle separator at its bottom edge, and
 * LiveHeaderLine moved INSIDE it, absolutely positioned over that edge (the
 * breathing bar replaces the hairline while a turn runs). The back chip is
 * the shared QuietIconButton (ArrowLeft 22, the 40px circle — the chevron
 * "bracket" is retired). The kebab's menu is now a LEVEL STATE MACHINE
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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  AndroidSoftInputModes,
  KeyboardController,
  KeyboardEvents,
  useGenericKeyboardHandler,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, Check, ChevronRight, Ellipsis } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Composer, menuLevelRendersRootRows, nextOpenModelProvider, type ComposerControlsSnapshot, type ComposerMode, type ComposerSheet, type MenuModelRow, type MenuModelSection } from "@/components/composer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { HeaderDropdown, MAIN_LEVEL_KEY, type HeaderDropdownItem } from "@/components/header-dropdown";
import { LetterAvatar } from "@/components/letter-avatar";
import { TranscriptItemView } from "@/components/transcript";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { QuietIconButton, TypeBodyStrong, TypeCaption, TypeMicro, TypeMono } from "@/design/primitives";
import { useChatPrefs, useTheme } from "@/design/theme";
import { DISCLOSURE_FADE_MS, SPRING } from "@/design/motion";
import { spacing, TOUCH_TARGET } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import type { SseStream } from "@/link/connection";
import { fetchProjects, type ProjectRow } from "@/features/config";
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
  postStop,
  rebaseRemoteTurn,
  reduceRemoteTurnFrame,
  sessionStatusFromWire,
  sessionStatusLabel,
  sessionTitle,
  thinkingPlaceholderVisible,
  type AttachmentView,
  type LiveTurn,
  type SessionDetailWire,
  type SessionStatus,
  type SendOverrides,
  type TranscriptItem,
} from "@/features/sessions";
import { foldToolActivity } from "@/features/chat-prefs";
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

/** The breathing live line's one leg (ms) — the live caret's own rhythm
 * (motion.md §3: opacity 0.25↔1, 550ms each way). Local to this file, the
 * tab-bar's breathe-constants precedent. */
const LIVE_LINE_LEG_MS = 550;

/** R118-D §2.2 — the Model level's scroll cap (the provider sections scroll
 * INSIDE the panel; contentMaxHeight rides HeaderDropdown). */
const MODEL_LEVEL_MAX_HEIGHT = 360;
/** R118-D §2.2 — the Context level's scroll cap (the read-only readout). */
const CONTEXT_LEVEL_MAX_HEIGHT = 320;

/** R115-I → R118-D — the session screen's open COMPOSER sheet, NARROWED to
 * the attach pair (the kebab's rows no longer open sheets — the menu renders
 * their levels in place). null = closed. */
type SessionSheet = ComposerSheet | null;

/** R118-D — the kebab menu's LEVEL state machine: null = closed, "main" =
 *  the four control rows + the conditional Stop, and one level per control
 *  (rendered inside the anchored panel through HeaderDropdown's sub-level
 *  grammar — back chevron + title row + content). */
type SessionMenu = null | "main" | "mode" | "model" | "thinking" | "context";

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
          // The breathing live line + the poll's trigger flip LIVE (a
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

  // R114-d — the chat prefs drive the transcript's rendering here (the hook
  // is reactive: a flip in Settings → Appearance re-renders this memo).
  const prefs = useChatPrefs();

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
    // R114-d — the THINKING PLACEHOLDER: while the live turn streams with
    // no assistant content yet, the animated card sits exactly where the
    // assistant message will appear (the list's tail). The first real
    // delta retires it (thinkingPlaceholderVisible flips false).
    if (live !== null && thinkingPlaceholderVisible(live)) {
      items = [...items, { kind: "thinking", key: "live-thinking", model: live.model }];
    }
    // R114-d — toolActivity=hidden folds consecutive tool runs into one
    // quiet meta line per turn (chat-prefs.ts — the other prefs the item
    // components read themselves through useChatPrefs).
    return foldToolActivity(items, prefs.toolActivity);
  }, [live, baseItems, outboxEntries, prefs.toolActivity]);

  const composerMode: ComposerMode =
    status !== "connected" ? "offline" : liveRunning || remoteRunning ? "running" : "compose";

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
  // status) — the breathing line + the dropdown's Stop row + the composer's
  // running mode all read this one truth.
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
   *  two-step never survives a dismissal). */
  const closeMenu = useCallback((): void => {
    setMenu(null);
    setStopArmed(false);
  }, []);

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
  const dockStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insetsBottom, kbHeight.value),
  }));

  const data = useMemo(() => [...displayItems].reverse(), [displayItems]);

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
          separator at its bottom edge. LiveHeaderLine moved INSIDE, pinned
          absolutely over that edge — the breathing bar replaces the hairline
          while a turn runs (its rhythm byte-frozen). THE IDENTITY BAR itself
          (R115-I — chat.md §Header): [back circle 40px] · [the project's
          LetterAvatar 36px] · [project name over the session's own name] ·
          [the kebab ⋮ 44px]. Status words are OUT. */}
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
          {project !== null ? (
            <LetterAvatar label={project.name} color={project.color} size={36} testID="session-header-avatar" />
          ) : (
            <NeutralAvatar label={headerFallbackLetter} />
          )}
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
        {/* The live-turn indicator — the "live" badge's replacement, now
            ABSOLUTELY positioned over the column's bottom edge (on top of
            the hairline separator). */}
        <LiveHeaderLine live={turnLive} />
      </View>

      {/* R115-K — the dock owns the keyboard: NO KeyboardAvoidingView, NO
          offsets, NO window resize (the window is ADJUST_NOTHING while this
          screen lives). The only thing that moves is the dock's own animated
          paddingBottom (dockStyle — max(insetsBottom, kbHeight)); the whole
          composer — offline/outbox/note rows, the @-picker popup, chips, the
          R119-B single-tier input bar with its attach circle BESIDE the
          input — rides INSIDE it, and the inverted FlatList above (flex:1)
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
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => (
              <TranscriptItemView
                item={item}
                onApprovalDecide={() => router.navigate("/approvals")}
                onAnswerQuestion={onAnswerQuestion}
                subagentLive={live?.subagentLive}
                onRetryError={
                  item.kind === "error" ? () => onRetryFailedTurn(item.key) : undefined
                }
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
            menu === "model" ? MODEL_LEVEL_MAX_HEIGHT : menu === "context" ? CONTEXT_LEVEL_MAX_HEIGHT : undefined
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

/** The live-turn indicator — the "live" Badge's replacement (R115-I): a
 * thin 2px accent line under the identity bar, BREATHING while a turn runs
 * (motion.md §3's live-caret rhythm: opacity 0.25↔1, 550ms each way;
 * reduced motion snaps it solid — motion.md §5 — and it springs out when
 * the turn settles). The 2px height is constant so nothing below ever
 * shifts when the state flips. */
function LiveHeaderLine({ live }: { live: boolean }) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (!live) {
      opacity.value = withSpring(0, SPRING);
      return;
    }
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: LIVE_LINE_LEG_MS }),
        withTiming(0.25, { duration: LIVE_LINE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [live, reduced, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, opacity.value)),
  }));

  return <Animated.View style={[styles.liveLine, style, { backgroundColor: tokens.accent }]} />;
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
  // column above, the live line pinned to that column's own bottom edge).
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
  /** R118-D §2.1 — the live line rides INSIDE the chrome column, pinned
   *  absolutely over its bottom edge — the breathing bar REPLACES the
   *  hairline separator while a turn runs (2px constant so nothing below
   *  ever shifts when the state flips). */
  liveLine: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
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
