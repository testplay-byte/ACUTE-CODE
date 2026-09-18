/**
 * Notifications — the sidecar's persisted notification history (GET
 * /notifications — the same rows the desktop's bell carries): a grouped,
 * quiet feed with type badges + relative timestamps, grouped by day
 * (Today / Yesterday / the date). Unread rows wear the accent dot; "Mark
 * all read" posts the route's own read-all. Pull-to-refresh throughout.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Bell } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { Badge, TypeBody, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_CARD, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { timeAgo } from "@/components/host-card";
import { apiJson } from "@/features/api";

interface NotificationRow {
  id: string;
  ts: string;
  kind: string;
  title: string;
  body: string | null;
  sessionId: string | null;
  projectId: string | null;
  read: 0 | 1;
}

const KIND_LABELS: Record<string, string> = {
  task_complete: "task done",
  task_failed: "task failed",
  permission_request: "permission",
  subagent_queued: "sub-agent",
  subagent_running: "sub-agent",
  subagent_complete: "sub-agent",
  subagent_failed: "sub-agent",
};

const KIND_TONES: Record<string, "neutral" | "accent" | "danger"> = {
  task_complete: "neutral",
  task_failed: "danger",
  permission_request: "accent",
};

/** Day-group label — Today / Yesterday / the honest date. */
function dayLabel(tsMs: number, now: number): string {
  const date = new Date(tsMs);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString();
}

export default function NotificationsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // The calm minute-tick keeps the relative timestamps honest.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const link = getLinkManager();
    try {
      const outcome = await apiJson<{ notifications: NotificationRow[]; unread: number }>(
        link,
        "/notifications?limit=100",
      );
      if (outcome.ok) {
        setRows(Array.isArray(outcome.data.notifications) ? outcome.data.notifications : []);
        setUnread(outcome.data.unread ?? 0);
        setError(null);
      } else {
        setError(outcome.error.message);
      }
    } catch {
      setError("the host is offline — retrying");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (status === "connected") {
      void load();
    }
  }, [status, load]);

  const markAllRead = useCallback(() => {
    void apiJson<{ ok: boolean; cleared: number }>(getLinkManager(), "/notifications/read-all", {
      method: "POST",
      bodyText: "{}",
    })
      .then((outcome) => {
        if (outcome.ok) void load();
      })
      .catch(() => {
        // transport loss — the pull-to-refresh owns the retry
      });
  }, [load]);

  /** Group rows by day (newest first — the route's own order). */
  const groups = useMemo(() => {
    if (rows === null) return [];
    const byDay: Array<{ label: string; rows: NotificationRow[] }> = [];
    for (const row of rows) {
      const tsMs = Date.parse(row.ts);
      const label = Number.isNaN(tsMs) ? "" : dayLabel(tsMs, now);
      const last = byDay[byDay.length - 1];
      if (last !== undefined && last.label === label) {
        last.rows.push(row);
      } else {
        byDay.push({ label: label === "" ? "history" : label, rows: [row] });
      }
    }
    return byDay;
  }, [rows, now]);

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
      tintColor={tokens.textTertiary}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  return (
    <ScreenScaffold
      title="Alerts"
      back={false}
      refreshControl={refreshControl}
    >
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see alerts." />
      ) : loading ? (
        <LoadingState caption="Loading alerts…" />
      ) : error !== null && rows === null ? (
        <ErrorState title="Couldn't load alerts" caption={error} />
      ) : groups.length === 0 ? (
        <EmptyState
          Icon={Bell}
          title="All quiet."
          caption="task completions, failures and permission requests land here"
        />
      ) : (
        <View style={styles.groups}>
          {unread > 0 && (
            <Pressable
              accessibilityLabel={`Mark all ${unread} notifications read`}
              accessibilityRole="button"
              onPress={markAllRead}
              style={({ pressed }) => [
                styles.markAllRow,
                {
                  backgroundColor: pressed ? tokens.subtleHover : tokens.subtle,
                  borderColor: tokens.borderSubtle,
                },
              ]}
            >
              <TypeCaption style={{ color: tokens.accent, fontWeight: "600" }}>
                {`${unread} unread — mark all read`}
              </TypeCaption>
            </Pressable>
          )}
          {groups.map((group) => (
            <View key={group.label} style={styles.group}>
              <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
                {group.label.toUpperCase()}
              </TypeCaption>
              {group.rows.map((row) => (
                <NotificationCard key={row.id} row={row} now={now} />
              ))}
            </View>
          ))}
        </View>
      )}
    </ScreenScaffold>
  );
}

function NotificationCard({ row, now }: { row: NotificationRow; now: number }) {
  const { tokens } = useTheme();
  const tsMs = Date.parse(row.ts);
  const when = Number.isNaN(tsMs) ? "" : timeAgo(tsMs, now);
  const tone = KIND_TONES[row.kind] ?? "neutral";
  return (
    <View
      accessibilityLabel={`${KIND_LABELS[row.kind] ?? row.kind}: ${row.title}`}
      style={[
        styles.card,
        { backgroundColor: tokens.card, borderColor: row.read === 1 ? tokens.border : tokens.accent },
      ]}
    >
      <View style={styles.head}>
        <Badge tone={tone}>{KIND_LABELS[row.kind] ?? row.kind}</Badge>
        <View style={{ flex: 1 }} />
        {row.read === 0 && <View style={[styles.unreadDot, { backgroundColor: tokens.accent }]} />}
        <TypeCaption style={{ color: tokens.textTertiary }}>{when}</TypeCaption>
      </View>
      <TypeBody style={{ color: tokens.text, fontWeight: "600" }} numberOfLines={2}>
        {row.title}
      </TypeBody>
      {row.body !== null && row.body !== "" && (
        <TypeCaption style={{ color: tokens.textSecondary }} numberOfLines={3}>
          {row.body}
        </TypeCaption>
      )}
      {row.sessionId !== null && (
        <TypeCaption style={{ color: tokens.textTertiary }}>
          {`session ${row.sessionId.slice(0, 12)}`}
        </TypeCaption>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  groups: {
    gap: spacing.lg,
  },
  group: {
    gap: spacing.md,
  },
  card: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  markAllRow: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md,
    minHeight: 44,
  },
});
