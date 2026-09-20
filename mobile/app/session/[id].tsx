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
 * The phone renders + taps. NOTHING is processed here (§4's ceiling).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Composer, type ComposerMode } from "@/components/composer";
import { TranscriptItemView } from "@/components/transcript";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { Badge, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import type { SseStream } from "@/link/connection";
import {
  abandonLiveTurn,
  applyLiveFrame,
  beginLiveTurn,
  foldSessionEvents,
  fetchSessionDetail,
  openTurnStream,
  parseStreamFrame,
  patchSessionActiveMode,
  patchSessionPermissions,
  postQueue,
  postResolveQuestion,
  postStop,
  sessionTitle,
  type AttachmentView,
  type LiveTurn,
  type SessionDetailWire,
  type SendOverrides,
  type TranscriptItem,
} from "@/features/sessions";
import { getOutbox, outboxForSession, type OutboxEntry } from "@/features/outbox";
import { mobLog, mobWarn } from "@/lib/log";

/** The calm poll while a desktop-side turn runs (no live stream to watch). */
const RUNNING_POLL_MS = 3_000;

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

  const setLiveState = useCallback((next: LiveTurn | null): void => {
    liveRef.current = next;
    setLive(next);
  }, []);

  // ── the truth: rehydrate from the persisted event log ─────────────────────

  const rehydrate = useCallback(async () => {
    if (sessionId === "") return;
    const link = getLinkManager();
    try {
      const outcome = await fetchSessionDetail(link, sessionId);
      if (outcome.ok) {
        setDetail(outcome.data);
        setBaseItems(foldSessionEvents(outcome.data.events));
        setError(null);
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
  }, [sessionId]);

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

  // ── the calm poll while a desktop-side turn runs ──────────────────────────

  useEffect(() => {
    if (!appActive) return;
    if (streamRef.current !== null) return; // we hold the live stream
    if (detail === null || detail.status !== "running") return;
    const timer = setInterval(() => {
      if (streamRef.current === null) void rehydrate();
    }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [appActive, detail, rehydrate]);

  // ── the live stream ────────────────────────────────────────────────────────

  const closeStream = useCallback(() => {
    streamClosedRef.current = true;
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const rehydrateAfterTurn = useCallback(() => {
    void rehydrate().then(() => {
      // The truth landed — drop the live overlay (one paint, no flash).
      setLiveState(null);
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

  // ── render ─────────────────────────────────────────────────────────────────

  const displayItems = useMemo<TranscriptItem[]>(() => {
    if (live !== null) return live.items;
    const pending: TranscriptItem[] = outboxEntries.map((entry) => ({
      kind: "user",
      key: entry.id,
      content: entry.content,
      queued: true,
      attachments: entry.overrides?.attachments ?? null,
    }));
    return [...baseItems, ...pending];
  }, [live, baseItems, outboxEntries]);

  const composerMode: ComposerMode =
    status !== "connected" ? "offline" : liveRunning || remoteRunning ? "running" : "compose";

  // The composer's bottom inset: the SAFE AREA while the keyboard is closed,
  // 0 while it's open (the keyboard already covers the gesture bar — a
  // standing inset would hold the composer a dead strip above the keys).
  // useKeyboardState is react-native-keyboard-controller's own JS-thread
  // truth, so the swap never races the KAV's animated padding.
  const keyboard = useKeyboardState();
  const insets = useSafeAreaInsets();
  const composerBottomInset = keyboard.isVisible ? 0 : insets.bottom;

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
      subtitle={detail !== null ? `${detail.status === "running" ? "a turn is live" : detail.status} · ${detail.mode}` : undefined}
      scroll={false}
      back
      bottomInset={0}
      keyboardAware={false}
      right={
        detail !== null ? (
          <Badge tone={detail.status === "running" ? "running" : detail.status === "failed" ? "danger" : "neutral"}>
            {detail.status === "running" ? "live" : detail.status === "queued" ? "open" : detail.status}
          </Badge>
        ) : null
      }
    >
      {/* The keyboard-aware body — react-native-keyboard-controller's view
          (the REAL Android fix: behavior padding works with edge-to-edge).
          The whole composer — control row, chips, input — rides INSIDE it,
          so the padding lifts every row clear of the keyboard while the
          inverted FlatList scrolls above them. */}
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
        <View
          style={[styles.composerWrap, { backgroundColor: tokens.bg, paddingBottom: composerBottomInset }]}
        >
          <Composer
            mode={composerMode}
            outboxCount={outboxEntries.length}
            sessionId={sessionId}
            projectId={detail?.projectId ?? null}
            permissionMode={detail?.permissionMode ?? "ask"}
            activeMode={detail?.activeMode ?? null}
            onPermissionModeChange={onPermissionModeChange}
            onActiveModeChange={onActiveModeChange}
            onSend={onSend}
            onStop={onStop}
            onQueue={onQueue}
            onDismissOutbox={() => void onDismissOutbox()}
            streaming={liveRunning || remoteRunning}
          />
        </View>
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
