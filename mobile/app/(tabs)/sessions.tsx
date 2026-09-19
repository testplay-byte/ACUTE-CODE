/**
 * Sessions v2 (R109) — the work list: project filter chips (the owner's
 * "work with any projects as I wish" — every project one tap away), a
 * virtualized scrolling list under a pinned search + chip zone,
 * pull-to-refresh, the offline outbox footnote, and honest empty/error
 * states. Rows carry the live status badge + relative time.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { Search } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  Chip,
  ClayCard,
  PressableCard,
  TypeBody,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { getOutbox, type OutboxState } from "@/features/outbox";
import {
  fetchSessions,
  filterByProject,
  isTurnRunning,
  sessionStatusTone,
  sessionTitle,
  type SessionRow,
} from "@/features/sessions";
import { fetchProjects, type ProjectRow } from "@/features/config";
import { mobWarn } from "@/lib/log";

export default function SessionsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  // The projects browser pushes /sessions with a projectId param — the filter
  // starts on it (and follows it when the screen is already mounted).
  const params = useLocalSearchParams<{ projectId?: string }>();
  const paramProjectId =
    typeof params.projectId === "string" && params.projectId !== "" ? params.projectId : null;

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectFilter, setProjectFilter] = useState<string | null>(paramProjectId);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [outbox, setOutbox] = useState<OutboxState>({ entries: [] });

  // Load + refresh the list (connected only — the pill carries the offline truth).
  const load = useCallback(async () => {
    if (!connected) return;
    const outcome = await fetchSessions(getLinkManager(), { limit: 100 });
    if (outcome.ok) setSessions(outcome.data.sessions);
    else mobWarn("sessions", "list load failed", { status: outcome.error.status });
  }, [connected]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  useEffect(() => {
    if (!connected) return;
    void (async () => {
      const outcome = await fetchProjects(getLinkManager());
      if (outcome.ok) setProjects(outcome.data.projects);
    })();
  }, [connected]);

  // The outbox footnote — count + flush-on-connect.
  useEffect(() => {
    const store = getOutbox();
    const sync = () => setOutbox(store.getState());
    sync();
    return store.subscribe(sync);
  }, []);

  useEffect(() => {
    if (connected && outbox.entries.length > 0) {
      void getOutbox().flush(getLinkManager()).catch(() => {});
    }
  }, [connected, outbox.entries.length]);

  // A projects-row tap can land here with a fresh projectId while the screen
  // is already mounted — keep the chip selection true.
  useEffect(() => {
    if (paramProjectId !== null) setProjectFilter(paramProjectId);
  }, [paramProjectId]);

  const visible = useMemo(() => {
    if (sessions === null) return null;
    let rows = projectFilter === null ? sessions : filterByProject(sessions, projectFilter);
    const q = query.trim().toLowerCase();
    if (q !== "") {
      rows = rows.filter(
        (s) => sessionTitle(s).toLowerCase().includes(q) || (s.subRole ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [sessions, projectFilter, query]);

  const projectChips = useMemo(
    () => [{ id: null as string | null, name: "All" }, ...projects.map((p) => ({ id: p.id, name: p.name }))],
    [projects],
  );

  // The first 8 chips — plus the param-selected project's chip when it lands
  // beyond them, so the active filter is always visible as a selected chip.
  const visibleChips = useMemo(() => {
    const base = projectChips.slice(0, 8);
    if (projectFilter !== null && !base.some((chip) => chip.id === projectFilter)) {
      const match = projectChips.find((chip) => chip.id === projectFilter);
      if (match !== undefined) base.push(match);
    }
    return base;
  }, [projectChips, projectFilter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScreenScaffold title="Sessions" subtitle="every conversation, live from the desktop" scroll={false}>
      {/* The pinned zone: search + project chips + the outbox footnote */}
      <View style={styles.pinnedZone}>
        <View style={styles.searchWrap}>
          <Search size={16} color={tokens.textTertiary} strokeWidth={2.2} />
          <View style={styles.searchInputWrap}>
            <TextInput
              placeholder="search sessions…"
              placeholderTextColor={tokens.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.searchInput,
                {
                  color: tokens.text,
                  borderColor: tokens.inputBorder,
                  backgroundColor: tokens.inputBg,
                },
              ]}
            />
          </View>
        </View>

        <View style={styles.chipRow}>
          {visibleChips.map((chip) => (
            <Chip
              key={chip.id ?? "all"}
              selected={projectFilter === chip.id}
              onPress={() => setProjectFilter(chip.id)}
            >
              {chip.name}
            </Chip>
          ))}
        </View>

        {outbox.entries.length > 0 ? (
          <ClayCard bordered small>
            <View style={styles.outboxPad}>
              <TypeMicro style={{ color: tokens.warning }}>
                {outbox.entries.length} MESSAGE{outbox.entries.length === 1 ? "" : "S"} WILL SEND WHEN THE HOST RETURNS
              </TypeMicro>
            </View>
          </ClayCard>
        ) : null}
      </View>

      {/* The scrolling list */}
      {visible === null ? (
        connected ? (
          <LoadingState caption="loading sessions…" />
        ) : (
          <ErrorState
            title="host offline"
            caption="the sessions list reloads the moment the link returns — nothing is lost."
            retryLabel="retry now"
            onRetry={() => getLinkManager().retryNow()}
          />
        )
      ) : visible.length === 0 ? (
        <EmptyState
          title={query.trim() !== "" ? "no matches" : "no sessions yet"}
          caption={
            query.trim() !== ""
              ? "try a different search or clear the filter."
              : "open a project to start one, or pick up a desktop session here."
          }
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(row) => row.id}
          renderItem={({ item, index }) => <SessionRowCard row={item} index={index} />}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={tokens.accent}
              colors={[tokens.accent]}
              progressBackgroundColor={tokens.card}
            />
          }
        />
      )}
    </ScreenScaffold>
  );
}

function SessionRowCard({ row, index }: { row: SessionRow; index: number }) {
  const router = useRouter();
  const tone = sessionStatusTone(row.status);
  const running = isTurnRunning(row);
  const updatedMs = new Date(row.updatedAt).getTime();
  const updated = Number.isFinite(updatedMs) ? timeAgoShort(updatedMs) : "";

  return (
    <PressableCardLazy onPress={() => router.push(`/session/${row.id}`)} index={index}>
      <View style={styles.rowInner}>
        <View style={styles.rowMain}>
          <TypeBody numberOfLines={1} style={styles.rowTitle}>
            {sessionTitle(row)}
          </TypeBody>
          <View style={styles.rowMeta}>
            <TypeMicro>{updated}</TypeMicro>
            {row.subRole !== null && row.subRole !== "" ? (
              <TypeMicro numberOfLines={1}>· {row.subRole}</TypeMicro>
            ) : null}
          </View>
        </View>
        <Badge
          tone={running ? "running" : tone === "danger" ? "danger" : tone === "warning" ? "warning" : "neutral"}
        >
          {row.status}
        </Badge>
      </View>
    </PressableCardLazy>
  );
}

function PressableCardLazy({
  children,
  onPress,
  index,
}: {
  children: React.ReactNode;
  onPress: () => void;
  index: number;
}) {
  return (
    <PressableCard enterIndex={Math.min(index, 12)} onPress={onPress}>
      {children}
    </PressableCard>
  );
}

/** The short relative time for list rows (s/m/h/d, honest at any age). */
function timeAgoShort(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const styles = StyleSheet.create({
  pinnedZone: { padding: spacing.lg, gap: spacing.md, paddingBottom: 0 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: spacing.md },
  searchInputWrap: { flex: 1 },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    minHeight: 44,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  outboxPad: { padding: spacing.md },
  listContent: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 68,
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { fontWeight: "600" },
  rowMeta: { flexDirection: "row", gap: 4, alignItems: "center", flexWrap: "wrap" },
});
