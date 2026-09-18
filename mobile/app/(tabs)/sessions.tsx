/**
 * Sessions — the recent conversation list (v1: the recent list, grouped
 * simply; the sessions route has NO server-side projectId filter, so the
 * projects tab's drill-in filters the fetched rows client-side). Rows show
 * title / status / relative last-activity; tapping pushes the session's
 * transcript (app/session/[id].tsx — outside the tabs). While here and
 * connected, the outbox flushes (messages composed offline post in order).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { Badge, PressableCard, TypeBody, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { timeAgo } from "@/components/host-card";
import {
  fetchSessions,
  filterByProject,
  sessionStatusTone,
  sessionTitle,
  type SessionRow,
} from "@/features/sessions";
import { getOutbox } from "@/features/outbox";

const STATUS_LABELS: Record<string, string> = {
  running: "running",
  queued: "open",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export default function SessionsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [outboxCount, setOutboxCount] = useState(0);

  // The projects tab passes ?projectId= to drill into one project's sessions.
  const params = useLocalSearchParams<{ projectId?: string }>();
  const projectId =
    typeof params.projectId === "string" && params.projectId.trim() !== ""
      ? params.projectId
      : null;

  const load = useCallback(async () => {
    const link = getLinkManager();
    try {
      const outcome = await fetchSessions(link, { limit: 100 });
      if (outcome.ok) {
        setSessions(outcome.data.sessions);
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
      // The outbox flush rides every connected landing on this screen.
      void getOutbox()
        .flush(getLinkManager())
        .then((result) => {
          setOutboxCount(getOutbox().getState().entries.length);
          if (result.delivered > 0) void load();
        })
        .catch(() => {
          // the flush's own transport failures are honest keeps — the next
          // connected wake retries
        });
    }
  }, [status, load]);

  useEffect(() => {
    const outbox = getOutbox();
    const unsubscribe = outbox.subscribe(() => {
      setOutboxCount(outbox.getState().entries.length);
    });
    setOutboxCount(outbox.getState().entries.length);
    return unsubscribe;
  }, []);

  const visible = useMemo(
    () => (sessions === null ? [] : filterByProject(sessions, projectId)),
    [sessions, projectId],
  );

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
      title={projectId === null ? "Sessions" : "Project sessions"}
      back={projectId !== null}
      refreshControl={refreshControl}
    >
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see sessions." />
      ) : loading ? (
        <LoadingState caption="Loading sessions…" />
      ) : error !== null && sessions === null ? (
        <ErrorState title="Couldn't load sessions" caption={error} />
      ) : visible.length === 0 ? (
        <EmptyState
          Icon={MessageSquare}
          title={projectId === null ? "No sessions yet." : "No sessions in this project."}
          caption="conversations you start on the desktop or here appear in this list"
        />
      ) : (
        <View style={styles.list}>
          {visible.map((session, index) => (
            <SessionRowCard
              key={session.id}
              session={session}
              enterIndex={index}
              onOpen={() => router.push(`/session/${session.id}`)}
            />
          ))}
          {outboxCount > 0 && (
            <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center", paddingTop: spacing.sm }}>
              {outboxCount} offline message{outboxCount === 1 ? "" : "s"} waiting for the host
            </TypeCaption>
          )}
        </View>
      )}
    </ScreenScaffold>
  );
}

function SessionRowCard({
  session,
  enterIndex,
  onOpen,
}: {
  session: SessionRow;
  enterIndex: number;
  onOpen: () => void;
}) {
  const { tokens } = useTheme();
  const tone = sessionStatusTone(session.status);
  const toneColor =
    tone === "success"
      ? tokens.success
      : tone === "warning"
        ? tokens.warning
        : tone === "danger"
          ? tokens.danger
          : tokens.textTertiary;
  const updated = timeAgo(Date.parse(session.updatedAt) || Date.now());
  return (
    <PressableCard
      accessibilityLabel={`Open session: ${sessionTitle(session)}`}
      enterIndex={enterIndex}
      onPress={onOpen}
    >
      <View style={styles.rowInner}>
        <View style={{ flex: 1, gap: 2 }}>
          <TypeBody style={{ color: tokens.text, fontWeight: "600" }} numberOfLines={1}>
            {sessionTitle(session)}
          </TypeBody>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            {`updated ${updated}${session.subRole !== null ? ` · ${session.subRole}` : ""}`}
          </TypeCaption>
        </View>
        <Badge tone={tone === "danger" ? "danger" : tone === "warning" ? "accent" : "neutral"}>
          {STATUS_LABELS[session.status] ?? session.status}
        </Badge>
        <View style={[styles.dot, { backgroundColor: toneColor }]} />
      </View>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.md,
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
