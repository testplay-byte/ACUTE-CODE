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
 * activity) shape the transcript; the keyboard leg guarantees adjustResize
 * + one animated inset pipeline (useReanimatedKeyboardAnimation).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Composer, type ComposerMode } from "@/components/composer";
import { TranscriptItemView } from "@/components/transcript";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { Badge, TypeCaption } from "@/design/primitives";
import { useChatPrefs, useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import type { SseStream } from "@/link/connection";
import {
  abandonLiveTurn,
  applyLiveFrame,
  applySessionMetaPatch,
  beginLiveTurn,
  foldSessionEvents,
  fetchSessionDetail,
  openTurnStream,
  parseStreamFrame,
  patchSessionActiveMode,
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
  shortModelId,
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
          // The header badge + subtitle + the poll's trigger flip LIVE (a
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
          // truth (the composer pill, the mode chips, the header subtitle
          // all read the detail row). The debounced rehydrate below stays
          // the truth-backstop, exactly like every other session frame.
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

  /** PATCH /sessions/:id {activeMode} — the task-mode picker (validated
   * against the same resolver GET /projects/:id/modes serves). */
  const onActiveModeChange = useCallback(
    (activeMode: string | null) => {
      void patchSessionActiveMode(getLinkManager(), sessionId, activeMode)
        .then((outcome) => {
          if (outcome.ok) {
            setDetail((prev) => (prev === null ? prev : { ...prev, ...outcome.data }));
          } else {
            setError(`couldn't set the task mode: ${outcome.error.message}`);
          }
        })
        .catch(() => {
          setError("couldn't set the task mode — the host is offline");
        });
    },
    [sessionId],
  );

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

  // R114-d — the keyboard truth, ONE animated pipeline: the library's
  // reanimated keyboard values (which also GUARANTEE Android's adjustResize
  // soft-input mode for this screen's lifetime — useReanimatedKeyboardAnimation
  // calls useResizeMode internally; nothing else in the app guaranteed it, the
  // one gap that could leave the composer flat under the keys on
  // edge-to-edge Android). The composer's bottom inset fades OUT as the
  // keyboard rises past the gesture bar — max(insets.bottom + kb, 0), kb
  // negative — on the SAME UI-thread clock the KeyboardAvoidingView's
  // padding animates on: no JS-thread swap racing the lift, no dead strip,
  // no bounce on close. `keyboard.height` is NEGATIVE while open (the
  // library's convention), so closed → insets.bottom, open → 0.
  const keyboard = useReanimatedKeyboardAnimation();
  const insets = useSafeAreaInsets();
  const insetsBottom = insets.bottom;
  const composerInsetStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insetsBottom + keyboard.height.value, 0),
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
    <ScreenScaffold
      title={detail !== null ? sessionTitle(detail) : "Session"}
      subtitle={
        detail !== null
          ? // R114-d — status · mode · model (the owner: "I don't see which
            // model was being used in the chat itself" — the header names
            // the effective pair: the session's selectedModel, else the live
            // turn's resolved model, else nothing). Long ids shorten through
            // shortModelId so the one-line subtitle never wraps.
            [
              detail.status === "running" ? "a turn is live" : sessionStatusLabel(detail.status),
              detail.mode,
              ...(detail.selectedModel !== null
                ? [shortModelId(detail.selectedModel.model)]
                : live !== null && live.model !== null
                  ? [shortModelId(live.model)]
                  : []),
            ].join(" · ")
          : undefined
      }
      scroll={false}
      back
      bottomInset={0}
      keyboardAware={false}
      right={
        detail !== null ? (
          <Badge tone={detail.status === "running" ? "running" : detail.status === "failed" ? "danger" : "neutral"}>
            {/* R114-c — the HUMAN label (queued reads "open", completed
                "done", cancelled "stopped"); running keeps its live word. */}
            {detail.status === "running" ? "live" : sessionStatusLabel(detail.status)}
          </Badge>
        ) : null
      }
    >
      {/* The keyboard-aware body — react-native-keyboard-controller's view
          (the REAL Android fix: behavior padding works with edge-to-edge).
          The whole composer — control row, chips, input — rides INSIDE it,
          so the padding lifts every row clear of the keyboard while the
          inverted FlatList scrolls above them. R114-d: the composer's own
          bottom inset animates on the SAME pipeline (composerInsetStyle) and
          the hook guarantees adjustResize — the two gaps that could leave the
          field or the control row under the keys. The list keeps
          keyboardShouldPersistTaps="handled" so a control-pill tap while the
          keys are up never dismiss-focus-then-refocus jarringly. */}
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
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
        <Animated.View
          style={[styles.composerWrap, { backgroundColor: tokens.bg }, composerInsetStyle]}
        >
          <Composer
            mode={composerMode}
            outboxCount={outboxEntries.length}
            sessionId={sessionId}
            projectId={detail?.projectId ?? null}
            permissionMode={detail?.permissionMode ?? "ask"}
            activeMode={detail?.activeMode ?? null}
            selectedModel={detail?.selectedModel ?? null}
            onPermissionModeChange={onPermissionModeChange}
            onActiveModeChange={onActiveModeChange}
            onModelChange={onModelChange}
            onSend={onSend}
            onStop={onStop}
            onQueue={onQueue}
            onDismissOutbox={() => void onDismissOutbox()}
            streaming={liveRunning || remoteRunning}
          />
        </Animated.View>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

function ItemSeparator() {
  return <View style={{ height: spacing.md }} />;
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
