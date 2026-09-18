/**
 * Session — the transcript + live stream + composer (LINKING-PROTOCOL §3):
 *
 *   · the transcript: GET /sessions/:id's persisted event log, folded into
 *     the chat (user bubbles right, assistant + thinking, tool cards,
 *     approvals, dim meta) — complete even if the phone was offline all day;
 *   · the live stream: Send opens POST /sessions/:id/messages/stream (the
 *     manager's sse() — Bearer + pin) and every frame renders as it lands
 *     (features/sessions.ts's frame application; per-delta fade-in-up);
 *   · the R42 guarantee: the turn SURVIVES a closed stream. Backgrounding
 *     drops the stream (AppState) and rehydrates from GET /sessions/:id on
 *     return; while a desktop-side turn runs (status "running"), a calm 3s
 *     poll keeps the transcript honest — the transcript is the truth;
 *   · the composer: Send / Stop / Queue (the queue route's 409
 *     NO_LIVE_TURN falls back to an ordinary send), and offline sends land
 *     in the outbox (flushed in order when the link returns).
 *
 * The phone renders + taps. NOTHING is processed here (§4's ceiling).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
  parseStreamFrame,
  postQueue,
  postStop,
  sessionTitle,
  type LiveTurn,
  type SessionDetailWire,
  type TranscriptItem,
} from "@/features/sessions";
import { getOutbox, outboxForSession, type OutboxEntry } from "@/features/outbox";

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
        streamClosedRef.current = true;
        streamRef.current?.close();
        streamRef.current = null;
        if (liveRef.current !== null) setLiveState(abandonLiveTurn(liveRef.current));
      } else {
        void rehydrate();
      }
    });
    return () => sub.remove();
  }, [rehydrate]);

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
    (content: string) => {
      const link = getLinkManager();
      let stream: SseStream;
      try {
        stream = link.sse(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
          method: "POST",
          bodyText: JSON.stringify({ content }),
        });
      } catch {
        // The link dropped between the tap and the socket — the outbox owns it.
        void getOutbox().enqueue(sessionId, content);
        return;
      }
      streamClosedRef.current = false;
      streamRef.current = stream;
      setLiveState(beginLiveTurn(baseItems, content, Date.now()));
      stream.addEventListener("data", (ev) => {
        const frame = parseStreamFrame(ev.data);
        if (frame === null) return;
        const prev = liveRef.current;
        if (prev === null) return;
        const next = applyLiveFrame(prev, frame, Date.now());
        setLiveState(next);
        if (next.terminal !== null) {
          // done / stopped / error — the turn is over; the truth owns the render.
          closeStream();
          rehydrateAfterTurn();
        }
      });
      stream.addEventListener("error", (err) => {
        closeStream();
        if (err.kind === "http") {
          // The host refused before streaming (validation / unknown session) —
          // honest error, the draft's fate is visible in the message.
          setError(`the host refused the message: ${err.message}`);
          setLiveState(null);
          void rehydrate();
        } else {
          // Transport loss mid-turn: the turn survives (R42) — rehydrate and
          // let the calm poll keep watching it. The message is not re-sent.
          if (liveRef.current !== null) setLiveState(abandonLiveTurn(liveRef.current));
          void rehydrate();
        }
      });
      stream.addEventListener("close", () => {
        if (streamClosedRef.current) return; // our own close — already handled
        // The stream ended without a terminal frame — ambiguous, the truth wins.
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
    (content: string) => {
      if (status !== "connected") {
        void getOutbox().enqueue(sessionId, content);
        return;
      }
      openStream(content);
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
    (content: string) => {
      void postQueue(getLinkManager(), sessionId, content)
        .then((outcome) => {
          if (outcome.ok) {
            void rehydrate(); // the queued chip rides the folded log
            return;
          }
          if (outcome.error.code === "NO_LIVE_TURN") {
            // The turn ended between tap and POST — the honest fallback.
            openStream(content);
            return;
          }
          setError(`couldn't queue the message: ${outcome.error.message}`);
        })
        .catch(() => {
          void getOutbox().enqueue(sessionId, content);
        });
    },
    [sessionId, rehydrate, openStream],
  );

  // ── render ─────────────────────────────────────────────────────────────────

  const displayItems = useMemo<TranscriptItem[]>(() => {
    if (live !== null) return live.items;
    const pending: TranscriptItem[] = outboxEntries.map((entry) => ({
      kind: "user",
      key: entry.id,
      content: entry.content,
      queued: true,
    }));
    return [...baseItems, ...pending];
  }, [live, baseItems, outboxEntries]);

  const composerMode: ComposerMode =
    status !== "connected" ? "offline" : liveRunning || remoteRunning ? "running" : "compose";

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
      <ScreenScaffold title="Session">
        <ErrorState title="No session id" caption="Open a session from the sessions list." />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title={detail !== null ? sessionTitle(detail) : "Session"}
      scroll={false}
      right={
        detail !== null ? (
          <Badge tone={detail.status === "running" ? "accent" : detail.status === "failed" ? "danger" : "neutral"}>
            {detail.status === "running" ? "live" : detail.status === "queued" ? "open" : detail.status}
          </Badge>
        ) : null
      }
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.body}
        keyboardVerticalOffset={0}
      >
        {loading ? (
          <View style={styles.centerWrap}>
            <LoadingState caption="Loading the transcript…" />
          </View>
        ) : detail === null && error !== null ? (
          <View style={styles.centerWrap}>
            <ErrorState title="Couldn't open the session" caption={error} />
          </View>
        ) : data.length === 0 ? (
          <View style={styles.centerWrap}>
            <EmptyState
              title="An empty conversation."
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
        <Composer
          mode={composerMode}
          outboxCount={outboxEntries.length}
          onSend={onSend}
          onStop={onStop}
          onQueue={onQueue}
        />
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

function ItemSeparator() {
  return <View style={{ height: spacing.md }} />;
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
});
