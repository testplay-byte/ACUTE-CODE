/**
 * Activity v3 (R109-c, R116-f) — the notifications history (pushed from
 * the bell). The feed is LIVE: useActivityFeed rides the activity store,
 * which the streaming controller (GET /notifications/stream SSE) pushes
 * into — rows appear at the top the moment the desktop publishes them, no
 * refresh needed. Pull-to-refresh re-reads GET /notifications for the
 * honest page.
 *
 * Rows group by calendar day (Today / Yesterday / date captions). Unread =
 * the accent dot + "new" + full-ink title; read = quiet. Tapping a row
 * marks it read (optimistic, fire-and-forget) and pushes its session
 * transcript when the notification carries one.
 *
 * R116-f (§1.4 — the mark-all-read desync): "Mark all read" now tells the
 * truth — the call is disabled-aware while in flight, a failure (HTTP error
 * OR a thrown transport failure) shows ONE warning note that clears itself
 * after ~3s, and the button disappears only because the store's unread is
 * genuinely 0 (the store reconciles the ring, so the count and the rows
 * can never disagree).
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { BellOff } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  PressableCard,
  QuietButton,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { getActivityStore, useActivityFeed, type NotificationRow } from "@/features/activity";
import { timeAgo } from "@/components/host-card";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

// ── the kind badge vocabulary ────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  task: "task",
  approval: "approval",
  session: "session",
  error: "error",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function kindTone(kind: string): "danger" | "accent" | "neutral" {
  if (kind === "error") return "danger";
  if (kind === "approval") return "accent";
  return "neutral";
}

/** How long the mark-all-read failure note stays up (ms) — the manual-paste
 * note's ~3s idiom (R116-d2), the clock resetting per attempt. */
const MARK_FAIL_NOTE_MS = 3_000;

// ── the day grouping (calendar-local) ────────────────────────────────────────

interface DayGroup {
  key: string;
  label: string;
  items: NotificationRow[];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayGroupLabel(ts: string, nowMs: number): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "earlier";
  const days = Math.round((startOfDay(nowMs) - startOfDay(t)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── the screen ───────────────────────────────────────────────────────────────

export default function ActivityScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";
  const feed = useActivityFeed();
  const { state } = feed;

  // useActivityFeed returns fresh closures every render — hold the latest in
  // a ref so mount/refresh callbacks stay stable (no re-subscribe loops).
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });

  const [refreshing, setRefreshing] = useState(false);
  const [booted, setBooted] = useState(false);

  // The mark-all-read leg (R116-f §1.4): in-flight awareness + the honest
  // failure note. failSeq is a counter (not a boolean) so a REPEATED failure
  // restarts the auto-clear clock — the effect below re-arms per bump.
  const [marking, setMarking] = useState(false);
  const [failSeq, setFailSeq] = useState(0);

  useEffect(() => {
    if (failSeq === 0) return;
    const t = setTimeout(() => setFailSeq(0), MARK_FAIL_NOTE_MS);
    return () => clearTimeout(t);
  }, [failSeq]);

  // The first page read — the store may already hold the live stream's rows.
  useEffect(() => {
    void feedRef.current
      .refresh()
      .then(() => {
        setBooted(true);
        mobLog("activity-screen", "page loaded", { rows: getActivityStore().getState().latest.length });
      })
      .catch(() => setBooted(true));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await feedRef.current.refresh();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onMarkAllRead = useCallback(() => {
    if (marking) return;
    setMarking(true);
    // R116-f §1.4: BOTH failure shapes are honest to the user — an HTTP
    // error answers {ok:false}, a dead transport REJECTS (apiJson propagates
    // NetError). Either way one warning note shows and clears itself; the
    // store is only touched on success, so the button disappears strictly
    // because unread is genuinely 0.
    void feedRef.current
      .markAllRead()
      .then((ok) => {
        if (ok) {
          mobLog("activity-screen", "all marked read");
        } else {
          mobWarn("activity-screen", "mark all read failed");
          setFailSeq((n) => n + 1);
        }
      })
      .catch(() => {
        mobWarn("activity-screen", "mark all read threw");
        setFailSeq((n) => n + 1);
      })
      .finally(() => setMarking(false));
  }, [marking]);

  const onTap = useCallback((n: NotificationRow) => {
    if (n.read === 0) {
      // Optimistic: the row reads-read instantly; the POST rides behind it
      // (the store's markRead is idempotent when the response lands).
      getActivityStore().markRead(n.id);
      void feedRef.current
        .markRead(n.id)
        .then((ok) => {
          if (!ok) mobWarn("activity-screen", "mark read failed", { id: n.id });
        })
        .catch(() => {});
    }
    if (n.sessionId !== null && n.sessionId !== "") {
      router.push(`/session/${n.sessionId}`);
    }
  }, [router]);

  const groups = useMemo<DayGroup[]>(() => {
    const nowMs = Date.now();
    const out: DayGroup[] = [];
    const byKey = new Map<string, DayGroup>();
    for (const n of state.latest) {
      const t = new Date(n.ts).getTime();
      const key = Number.isNaN(t) ? "unknown" : String(startOfDay(t));
      let group = byKey.get(key);
      if (group === undefined) {
        group = { key, label: dayGroupLabel(n.ts, nowMs), items: [] };
        byKey.set(key, group);
        out.push(group);
      }
      group.items.push(n);
    }
    return out;
  }, [state.latest]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      tintColor={tokens.accent}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  return (
    <ScreenScaffold title="Activity" subtitle="the live notification history" back refreshControl={refreshControl}>
      {state.unread > 0 ? (
        <View style={styles.unreadRow}>
          <View style={styles.liveCluster}>
            {state.streamLive ? <StatusDot color={tokens.success} size={6} /> : null}
            <TypeMicro
              style={{
                color: state.streamLive ? tokens.success : tokens.textSecondary,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {`${state.unread} unread${state.streamLive ? " · live" : ""}`}
            </TypeMicro>
          </View>
          <QuietButton onPress={onMarkAllRead} disabled={marking}>
            Mark all read
          </QuietButton>
        </View>
      ) : null}

      {/* The honest failure note (R116-f §1.4): one warning line + dot,
          clearing itself after ~3s. */}
      {failSeq > 0 ? (
        <View style={styles.failNote} testID="activity-mark-fail">
          <StatusDot color={tokens.warning} size={7} />
          <TypeCaption numberOfLines={1} style={{ color: tokens.warning }}>
            Couldn't reach the desktop — try again.
          </TypeCaption>
        </View>
      ) : null}

      {!booted ? (
        <LoadingState caption="loading activity…" />
      ) : status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see live activity." />
      ) : state.latest.length === 0 && !connected ? (
        <ErrorState
          title="host offline"
          caption="the feed catches up the moment the link returns."
          retryLabel="retry now"
          onRetry={() => getLinkManager().retryNow()}
        />
      ) : state.latest.length === 0 ? (
        <EmptyState
          Icon={BellOff}
          title="Nothing here yet."
          caption="approvals, finished tasks, and failures land here live the moment they happen."
        />
      ) : (
        groups.map((group) => (
          <View key={group.key} style={styles.group}>
            <TypeMicro style={[styles.groupLabel, { color: tokens.textTertiary }]}>{group.label}</TypeMicro>
            {group.items.map((n, index) => (
              <NotificationCard key={n.id} n={n} index={index} onTap={onTap} />
            ))}
          </View>
        ))
      )}
    </ScreenScaffold>
  );
}

// ── the row ──────────────────────────────────────────────────────────────────

function NotificationCard({ n, index, onTap }: { n: NotificationRow; index: number; onTap: (n: NotificationRow) => void }) {
  const { tokens } = useTheme();
  const unread = n.read === 0;
  const ts = new Date(n.ts).getTime();
  const when = Number.isNaN(ts) ? "" : timeAgo(ts);

  return (
    <PressableCard
      onPress={() => onTap(n)}
      enterIndex={Math.min(index, 12)}
      accessibilityLabel={`${kindLabel(n.kind)}: ${n.title}${unread ? ", unread" : ""}`}
    >
      <View style={styles.rowPad}>
        <View style={styles.rowHead}>
          <Badge tone={kindTone(n.kind)}>{kindLabel(n.kind)}</Badge>
          <View style={styles.rowHeadSpacer} />
          {unread ? (
            <View style={styles.newCluster}>
              <StatusDot color={tokens.accent} size={7} />
              <TypeMicro style={{ color: tokens.accent }}>new</TypeMicro>
            </View>
          ) : null}
        </View>
        <TypeBodyStrong numberOfLines={2} style={{ color: unread ? tokens.text : tokens.textSecondary }}>
          {n.title}
        </TypeBodyStrong>
        {n.body !== "" ? (
          <TypeCaption numberOfLines={3} style={{ color: tokens.textTertiary }}>
            {n.body}
          </TypeCaption>
        ) : null}
        <View style={styles.rowMeta}>
          {n.sessionId !== null && n.sessionId !== "" ? (
            <TypeMicro numberOfLines={1}>{`session ${n.sessionId.slice(0, 12)}`}</TypeMicro>
          ) : null}
          {when !== "" ? <TypeMicro>{when}</TypeMicro> : null}
        </View>
      </View>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  unreadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  liveCluster: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2 },
  failNote: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, paddingVertical: spacing.xs },
  group: { gap: spacing.md },
  groupLabel: { textTransform: "uppercase", letterSpacing: 0.8, paddingHorizontal: spacing.xs },
  rowPad: { padding: spacing.lg, gap: spacing.sm, minHeight: 68 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowHeadSpacer: { flex: 1 },
  newCluster: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 1 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
});
