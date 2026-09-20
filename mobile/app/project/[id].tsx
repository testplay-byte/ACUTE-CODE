/**
 * Project detail (R113-e) — a project's own sessions. The owner's shape:
 * "If I click on any one of the projects, it leads me to the sessions
 * screen" was the WRONG destination (a global list with a filter param);
 * this screen is the RIGHT one — the project's row (color dot + name + mono
 * root) under the compact header, its sessions as rows (title, live status
 * badge, relative time — the old sessions tab's row patterns, reused), a
 * create-session button (the first non-template agent, fallback any — drops
 * straight into the transcript), and pull-to-refresh.
 *
 * LIVE (R113-e): the sessions list refetches when the events store's
 * sessions epoch moves — a hello (the resync) or a debounced batch of THIS
 * project's session frames (a turn starting on the PC flips the row's badge
 * the moment the batch settles). The rows tap into /session/:id, whose own
 * subscription streams the turn live.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { MessageSquarePlus } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { Badge, PressableCard, TypeBody, TypeMicro } from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, TOUCH_TARGET, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useEventsEpoch } from "@/features/events";
import { createSession, fetchAgents, fetchProject, type ProjectRow } from "@/features/config";
import {
  fetchSessions,
  filterByProject,
  isTurnRunning,
  sessionStatusTone,
  sessionTitle,
  type SessionRow,
} from "@/features/sessions";
import { mobLog, mobWarn } from "@/lib/log";

/** The client-side fold limit (the sessions route has NO server-side
 * projectId filter — the phone folds the recent list itself). */
const SESSION_FOLD_LIMIT = 200;

export default function ProjectDetailScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";
  const params = useLocalSearchParams<{ id?: string }>();
  const projectId = typeof params.id === "string" ? params.id : "";

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [projectGone, setProjectGone] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** The default "New session" agent (first non-template, fallback any). */
  const [agentId, setAgentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // R113-e: the live epoch — hello + debounced session-frame batches move it.
  const sessionsEpoch = useEventsEpoch("sessions");
  // The MOUNT value — the refetch fires only when the epoch moves PAST it
  // (the mount load above owns the first fetch).
  const mountEpoch = useRef(sessionsEpoch);

  const load = useCallback(async () => {
    if (projectId === "") return;
    try {
      const [projectOutcome, sessionsOutcome] = await Promise.all([
        fetchProject(getLinkManager(), projectId),
        fetchSessions(getLinkManager(), { limit: SESSION_FOLD_LIMIT }),
      ]);
      if (projectOutcome.ok) {
        setProject(projectOutcome.data);
        setProjectGone(false);
      } else if (projectOutcome.error.status === 404) {
        setProjectGone(true);
      } else {
        setLoadError(projectOutcome.error.message);
        mobWarn("project", "row load failed", { status: projectOutcome.error.status });
      }
      if (sessionsOutcome.ok) {
        setSessions(filterByProject(sessionsOutcome.data.sessions, projectId));
        setLoadError(null);
      } else {
        mobWarn("project", "sessions fold failed", { status: sessionsOutcome.error.status });
      }
    } catch {
      setLoadError("the host is offline — the list will load when it returns");
      mobWarn("project", "load threw");
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  // R113-e: the live refetch — the epoch moved AFTER this screen mounted (a
  // session-frame batch for THIS project, or the hello resync).
  useEffect(() => {
    if (sessionsEpoch === mountEpoch.current) return;
    if (!connected) return;
    void load();
  }, [sessionsEpoch, connected, load]);

  // The default agent for "New session" — first non-template, fallback any.
  useEffect(() => {
    if (!connected) return;
    void (async () => {
      try {
        const outcome = await fetchAgents(getLinkManager());
        if (!outcome.ok) return; // quiet — the create action reports honestly
        const agents = outcome.data.agents;
        const pick = agents.find((a) => !a.isTemplate) ?? agents[0];
        setAgentId(pick !== undefined ? pick.id : null);
      } catch {
        // quiet — same
      }
    })();
  }, [connected]);

  const visibleSessions = useMemo(() => sessions ?? [], [sessions]);
  const runningCount = useMemo(
    () => visibleSessions.filter((s) => isTurnRunning(s)).length,
    [visibleSessions],
  );

  const onCreateSession = useCallback(async () => {
    if (creating) return;
    setCreateError(null);
    if (agentId === null) {
      setCreateError("no agent is configured on the host — add one in the desktop's agents page first");
      void warningHaptic();
      return;
    }
    if (project === null) return;
    setCreating(true);
    try {
      const outcome = await createSession(getLinkManager(), {
        mode: "single",
        agentId,
        projectId: project.id,
      });
      if (outcome.ok) {
        mobLog("project", "session created", { id: outcome.data.id, projectId: project.id });
        void successHaptic();
        router.push(`/session/${outcome.data.id}`);
      } else {
        mobWarn("project", "create failed", { status: outcome.error.status, code: outcome.error.code });
        void warningHaptic();
        setCreateError(outcome.error.message);
      }
    } catch {
      mobWarn("project", "create threw");
      void warningHaptic();
      setCreateError("the host is offline — the session was not created");
    } finally {
      setCreating(false);
    }
  }, [creating, agentId, project, router]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (projectId === "") {
    return (
      <ScreenScaffold title="Project" back>
        <ErrorState title="No project id" caption="Open a project from the projects tab." />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title={project !== null ? project.name : "Project"}
      subtitle={project !== null ? project.rootPath : undefined}
      back
      refreshControl={
        connected ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.card}
          />
        ) : undefined
      }
      right={
        connected ? (
          <Pressable
            accessibilityLabel="Start a new session in this project"
            accessibilityRole="button"
            accessibilityState={creating ? { disabled: true, busy: true } : undefined}
            disabled={creating}
            hitSlop={6}
            onPress={() => void onCreateSession()}
            style={({ pressed }) => [
              styles.createButton,
              { backgroundColor: pressed ? tokens.subtleHover : tokens.subtle, borderColor: tokens.borderSubtle },
            ]}
          >
            {creating ? (
              <ActivityIndicator size="small" color={tokens.accent} />
            ) : (
              <MessageSquarePlus size={20} color={tokens.accent} strokeWidth={2.2} />
            )}
          </Pressable>
        ) : null
      }
    >
      {projectGone ? (
        <ErrorState
          title="this project no longer exists"
          caption="it was removed on the desktop — the projects tab has the live registry."
        />
      ) : !connected ? (
        <ErrorState
          title="host offline"
          caption="the project reloads the moment the link returns — nothing is lost."
          retryLabel="retry now"
          onRetry={() => getLinkManager().retryNow()}
        />
      ) : sessions === null ? (
        <LoadingState caption="loading the project's sessions…" />
      ) : loadError !== null && project === null ? (
        <ErrorState title="couldn't load the project" caption={loadError} retryLabel="try again" onRetry={() => void load()} />
      ) : (
        <>
          {project !== null ? (
            <View style={styles.projectRow}>
              <View style={[styles.dot, { backgroundColor: project.color }]} />
              <View style={styles.projectMain}>
                <TypeBody style={styles.projectName} numberOfLines={1}>
                  {project.name}
                </TypeBody>
                <TypeMicro numberOfLines={1}>{project.rootPath}</TypeMicro>
              </View>
              {runningCount > 0 ? (
                <Badge tone="running">{runningCount} running</Badge>
              ) : (
                <Badge tone="neutral">{visibleSessions.length} session{visibleSessions.length === 1 ? "" : "s"}</Badge>
              )}
            </View>
          ) : null}

          {createError !== null ? (
            <TypeMicro style={{ color: tokens.danger }} numberOfLines={3}>
              {createError}
            </TypeMicro>
          ) : null}

          {visibleSessions.length === 0 ? (
            <EmptyState
              title="no sessions yet"
              caption="tap the compose button to start one — the desktop agent does all the work."
            />
          ) : (
            <>
              {visibleSessions.map((row, index) => (
                <SessionRowCard key={row.id} row={row} index={index} />
              ))}
              <TypeMicro style={[styles.footer, { color: tokens.textTertiary }]}>
                the host's {SESSION_FOLD_LIMIT} most recent sessions, folded to this project
              </TypeMicro>
            </>
          )}
        </>
      )}
    </ScreenScaffold>
  );
}

// ── the session row (the old sessions tab's pattern, reused) ─────────────────

function SessionRowCard({ row, index }: { row: SessionRow; index: number }) {
  const router = useRouter();
  const tone = sessionStatusTone(row.status);
  const running = isTurnRunning(row);
  const updatedMs = new Date(row.updatedAt).getTime();
  const updated = Number.isFinite(updatedMs) ? timeAgoShort(updatedMs) : "";

  return (
    <PressableCard onPress={() => router.push(`/session/${row.id}`)} enterIndex={Math.min(index, 12)}>
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
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 60,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  projectMain: { flex: 1, gap: 2 },
  projectName: { fontWeight: "600" },
  createButton: {
    width: TOUCH_TARGET,
    height: 44,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
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
  footer: { textAlign: "center", paddingTop: spacing.sm },
});
