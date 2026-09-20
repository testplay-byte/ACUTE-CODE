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
 * The kebab opens the "Session options" sheet — the session's controls,
 * one row each with its CURRENT value (Operating mode · Model · Thinking ·
 * Context, + "Stop this turn" while a turn is live). THE SHEET STATE IS
 * LIFTED HERE (R115-I): this screen owns the open sheet ("kebab" or one of
 * the composer's sheets), the composer renders every sheet's CONTENT
 * controlled through sheet/onSheetChange and reports its live control
 * values through onControlsSnapshot — the composer's control pill row is
 * deleted (chat.md §Composer: exactly three controls — attach, input,
 * send/stop). The task-mode picker is GONE from mobile (round-115 verdict).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  AndroidSoftInputModes,
  KeyboardController,
  KeyboardEvents,
  useGenericKeyboardHandler,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronLeft, ChevronRight, Ellipsis, Square } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Composer, type ComposerControlsSnapshot, type ComposerMode, type ComposerSheet } from "@/components/composer";
import { LetterAvatar } from "@/components/letter-avatar";
import { Sheet } from "@/components/sheet";
import { TranscriptItemView } from "@/components/transcript";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { FadeInUp, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { useChatPrefs, useTheme } from "@/design/theme";
import { SPRING } from "@/design/motion";
import { RADIUS_INPUT, spacing, TOUCH_TARGET } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import type { SseStream } from "@/link/connection";
import { fetchProjects, type ProjectRow } from "@/features/config";
import { modeOption } from "@/features/composer-state";
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

/** The breathing live line's one leg (ms) — the live caret's own rhythm
 * (motion.md §3: opacity 0.25↔1, 550ms each way). Local to this file, the
 * tab-bar's breathe-constants precedent. */
const LIVE_LINE_LEG_MS = 550;

/** R115-I — the session screen's open sheet: the kebab menu OR one of the
 * composer's sheets (the screen owns the state; the composer renders the
 * content). null = closed. */
type SessionSheet = "kebab" | ComposerSheet | null;

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

  // ── R115-I — the identity bar + the kebab sheet's state ──────────────────

  /** The registry's projects, fetched once per mount (cached like every
   * other screen) — the identity bar's project row. */
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  /** The open sheet (the kebab menu or one of the composer's). */
  const [sheet, setSheet] = useState<SessionSheet>(null);
  /** The composer's live control values (the kebab's Model/Thinking/Context
   * rows); the honest pre-report defaults show until the first snapshot. */
  const [controls, setControls] = useState<ComposerControlsSnapshot>({
    modelLabel: "Agent default",
    thinkingLabel: "Default",
    ctxPct: null,
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

  const onStop = useCallback(() => {
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
  // The kebab's Operating-mode row reads the same source the old pill did.
  const kebabModeLabel = modeOption(detail?.permissionMode ?? "ask").label;

  // A turn runs somewhere (own stream, own overlay, or the row's running
  // status) — the breathing line + the kebab's Stop row + the composer's
  // running mode all read this one truth.
  const turnLive = liveRunning || remoteRunning;

  // The composer's slice of the sheet state (the kebab is THIS screen's;
  // the six composer sheets pass straight through), and the referentially
  // guarded snapshot receiver (a value-identical report re-renders nothing).
  const composerSheet = sheet === "kebab" ? null : sheet;
  const setComposerSheet = useCallback((next: ComposerSheet | null): void => {
    setSheet(next);
  }, []);
  const onControlsSnapshot = useCallback((next: ComposerControlsSnapshot): void => {
    setControls((prev) =>
      prev.modelLabel === next.modelLabel &&
      prev.thinkingLabel === next.thinkingLabel &&
      prev.ctxPct === next.ctxPct
        ? prev
        : next,
    );
  }, []);

  // ── R115-K — the keyboard architecture: ONE dock, ONE expression ─────────
  // (the header comment above carries the full contract). The dock's kbHeight
  // is POSITIVE while open, 0 when closed, written by two idempotent paths.
  const insets = useSafeAreaInsets();
  const insetsBottom = insets.bottom;
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
      {/* ── THE IDENTITY BAR (R115-I — chat.md §Header): [back chevron 44px]
          · [the project's LetterAvatar 36px] · [project name over the
          session's own name] · [the kebab ⋮ 44px]. Status words are OUT — a
          running turn shows as the breathing accent line under the bar. */}
      <View style={styles.headerRow}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => router.back()}
          style={styles.headerTarget}
        >
          <ChevronLeft size={26} color={tokens.text} strokeWidth={2} />
        </Pressable>
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
          onPress={() => setSheet("kebab")}
          style={styles.headerTarget}
          testID="session-kebab"
        >
          <Ellipsis size={24} color={tokens.text} strokeWidth={2.4} />
        </Pressable>
      </View>
      {/* The live-turn indicator — the "live" badge's replacement. */}
      <LiveHeaderLine live={liveRunning || remoteRunning} />

      {/* R115-K — the dock owns the keyboard: NO KeyboardAvoidingView, NO
          offsets, NO window resize (the window is ADJUST_NOTHING while this
          screen lives). The only thing that moves is the dock's own animated
          paddingBottom (dockStyle — max(insetsBottom, kbHeight)); the whole
          composer — offline/outbox/note rows, the @-picker popup, chips, the
          input row with its attach circle — rides INSIDE it, and the inverted
          FlatList above (flex:1) reflows on its own. The list keeps
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
            sheet={composerSheet}
            onSheetChange={setComposerSheet}
            onControlsSnapshot={onControlsSnapshot}
            onPermissionModeChange={onPermissionModeChange}
            onModelChange={onModelChange}
            onSend={onSend}
            onStop={onStop}
            onQueue={onQueue}
            onDismissOutbox={() => void onDismissOutbox()}
            streaming={liveRunning || remoteRunning}
          />
        </Animated.View>
      </View>

      {/* ── THE KEBAB SHEET (R115-I — chat.md §Header): the session's
          controls, one row each with its CURRENT value right-aligned + a
          chevron; tapping a row closes this sheet and opens the composer's
          matching sub-sheet — the simplest honest handoff (both ride the
          fixed Sheet primitive, so the swap reads as one sheet trading for
          the next, the kebab's exit playing under the sub-sheet's rise).
          The rows stagger in on the house entrance grammar. */}
      <Sheet
        open={sheet === "kebab"}
        onClose={() => setSheet(null)}
        title="Session options"
        testID="session-options-sheet"
      >
        <FadeInUp index={0}>
          <KebabRow label="Operating mode" value={kebabModeLabel} onPress={() => setSheet("mode")} />
        </FadeInUp>
        <FadeInUp index={1}>
          <KebabRow label="Model" value={controls.modelLabel} onPress={() => setSheet("model")} />
        </FadeInUp>
        <FadeInUp index={2}>
          <KebabRow
            label="Thinking"
            value={controls.thinkingLabel}
            onPress={() => setSheet("thinking")}
          />
        </FadeInUp>
        <FadeInUp index={3}>
          <KebabRow
            label="Context"
            value={controls.ctxPct !== null ? `${controls.ctxPct}%` : "—"}
            onPress={() => setSheet("context")}
          />
        </FadeInUp>
        {turnLive ? (
          <FadeInUp index={4}>
            <KebabRow
              label="Stop this turn"
              danger
              onPress={() => {
                setSheet(null);
                onStop();
              }}
            />
          </FadeInUp>
        ) : null}
      </Sheet>
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
 * LetterAvatar it stands in for (36px circle, TypeBodyStrong auto-scaled)
 * but on the neutral surface — never a fabricated project color. */
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
          borderRadius: size / 2,
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

/** One kebab-sheet row — label + CURRENT value right-aligned + chevron (the
 * danger arm carries the stop affordance instead). The SheetRow geometry
 * (44px+ target, hairline border, quiet press) restated for the screen's
 * own sheet. */
function KebabRow({
  label,
  value,
  onPress,
  danger = false,
}: {
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityLabel={value !== undefined ? `${label} — ${value}` : label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.kebabRow,
        {
          backgroundColor: pressed ? tokens.subtleHover : "transparent",
          borderColor: danger ? tokens.danger : tokens.borderSubtle,
        },
      ]}
    >
      <TypeBodyStrong
        style={{ flex: 1, color: danger ? tokens.danger : tokens.text }}
        numberOfLines={1}
      >
        {label}
      </TypeBodyStrong>
      {value !== undefined ? (
        <TypeCaption style={{ color: tokens.textSecondary }} numberOfLines={1}>
          {value}
        </TypeCaption>
      ) : null}
      {danger ? (
        <Square size={13} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
      ) : (
        <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
      )}
    </Pressable>
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

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  // ── R115-I — the identity bar (the scaffold's own 56px header-row
  // geometry, restated for the bypassed chrome: 44px side targets, the
  // left-aligned two-line identity, the breathing live line under it).
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
  headerIdentity: {
    flex: 1,
    gap: 1,
  },
  liveLine: {
    height: 2,
  },
  neutralAvatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  // ── R115-I — the kebab sheet's rows (the composer SheetRow geometry).
  kebabRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET + 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
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
