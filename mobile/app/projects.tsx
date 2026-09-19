/**
 * Projects v2 (R109-c) — the registry browser (pushed from home). Rows carry
 * the project's own color dot, name, mono root path, and the session count
 * (a client-side fold of fetchSessions(limit 200) — there is NO server-side
 * projectId filter, and a count failure stays quiet, counts just don't show).
 * Tapping a row opens the Sessions tab with that project's filter selected;
 * the per-row Plus starts a new single-agent session in the project (first
 * non-template agent, fallback any) and drops straight into its transcript.
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { FolderGit2, Plus } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, SkeletonList } from "@/components/list-state";
import { PressableCard, TypeBodyStrong, TypeCaption, TypeMicro, TypeMono } from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, TOUCH_TARGET, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { createSession, fetchAgents, fetchProjects, type ProjectRow } from "@/features/config";
import { fetchSessions } from "@/features/sessions";
import { mobLog, mobWarn } from "@/lib/log";

export default function ProjectsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  /** The default "New session" agent (first non-template, fallback any). */
  const [agentId, setAgentId] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const outcome = await fetchProjects(getLinkManager());
      if (outcome.ok) {
        setProjects(outcome.data.projects);
        setError(null);
        mobLog("projects", "loaded", { count: outcome.data.projects.length });
      } else {
        setError(outcome.error.message);
        mobWarn("projects", "load failed", { status: outcome.error.status, code: outcome.error.code });
      }
    } catch {
      setError("the host is offline — the list will load when it returns");
      mobWarn("projects", "load threw");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Load on mount + every (re)connect.
  useEffect(() => {
    if (status === "connected") {
      void load();
    } else if (status === "unpaired") {
      // stays quiet — the render branch carries the truth
    }
  }, [status, load]);

  // The session counts — a quiet client fold of the recent 200 (the sessions
  // route has no projectId filter server-side). Failure stays quiet.
  const loadCounts = useCallback(async () => {
    try {
      const outcome = await fetchSessions(getLinkManager(), { limit: 200 });
      if (!outcome.ok) {
        mobWarn("projects", "session counts unavailable", { status: outcome.error.status });
        return;
      }
      const counts: Record<string, number> = {};
      for (const session of outcome.data.sessions) {
        if (session.projectId !== null) {
          counts[session.projectId] = (counts[session.projectId] ?? 0) + 1;
        }
      }
      setSessionCounts(counts);
      mobLog("projects", "session counts folded", { sessions: outcome.data.sessions.length });
    } catch {
      // quiet — counts are decoration, never a failure state
    }
  }, []);

  useEffect(() => {
    if (status !== "connected") return;
    void loadCounts();
  }, [status, loadCounts]);

  // The default agent for "New session" — first non-template, fallback any.
  useEffect(() => {
    if (status !== "connected") return;
    void (async () => {
      try {
        const outcome = await fetchAgents(getLinkManager());
        if (!outcome.ok) {
          mobWarn("projects", "agents unavailable", { status: outcome.error.status });
          return;
        }
        const agents = outcome.data.agents;
        const pick = agents.find((a) => !a.isTemplate) ?? agents[0];
        setAgentId(pick !== undefined ? pick.id : null);
        mobLog("projects", "default agent resolved", { agentId: pick?.id ?? "none", agents: agents.length });
      } catch {
        // quiet — the create action reports honestly when tapped
      }
    })();
  }, [status]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadCounts()]);
    setRefreshing(false);
  }, [load, loadCounts]);

  const visibleProjects = useMemo(() => projects ?? [], [projects]);

  const onCreateSession = useCallback(
    async (project: ProjectRow) => {
      if (creatingId !== null) return;
      setCreateError(null);
      if (agentId === null) {
        setCreateError("no agent is configured on the host — add one in the desktop's agents page first");
        void warningHaptic();
        mobWarn("projects", "create blocked — no agent");
        return;
      }
      setCreatingId(project.id);
      try {
        const outcome = await createSession(getLinkManager(), {
          mode: "single",
          agentId,
          projectId: project.id,
        });
        if (outcome.ok) {
          mobLog("projects", "session created", { id: outcome.data.id, projectId: project.id, agentId });
          void successHaptic();
          router.push(`/session/${outcome.data.id}`);
        } else {
          mobWarn("projects", "create failed", { status: outcome.error.status, code: outcome.error.code });
          void warningHaptic();
          setCreateError(outcome.error.message);
        }
      } catch {
        mobWarn("projects", "create threw");
        void warningHaptic();
        setCreateError("the host is offline — the session was not created");
      } finally {
        setCreatingId(null);
      }
    },
    [agentId, creatingId, router],
  );

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
    <ScreenScaffold title="Projects" subtitle="the registry, live from the desktop" back refreshControl={refreshControl}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to browse the project registry." />
      ) : projects === null && !connected ? (
        status === "probing" ? (
          <SkeletonList rows={4} rowHeight={72} />
        ) : (
          <ErrorState
            title="host offline"
            caption="the registry reloads the moment the link returns."
            retryLabel="retry now"
            onRetry={() => getLinkManager().retryNow()}
          />
        )
      ) : projects === null ? (
        <SkeletonList rows={4} rowHeight={72} />
      ) : error !== null && projects.length === 0 ? (
        <ErrorState title="Couldn't load projects" caption={error} retryLabel="try again" onRetry={() => void load()} />
      ) : projects.length === 0 ? (
        <EmptyState
          Icon={FolderGit2}
          title="No projects yet."
          caption="create one on the desktop — it appears here the moment it exists."
        />
      ) : (
        <>
          {error !== null ? (
            <TypeCaption style={{ color: tokens.warning }}>{`last refresh failed — ${error}`}</TypeCaption>
          ) : null}
          {visibleProjects.map((project, index) => (
            <ProjectRowCard
              key={project.id}
              project={project}
              index={index}
              count={sessionCounts[project.id]}
              creating={creatingId === project.id}
              onOpen={() =>
                router.push({ pathname: "/sessions", params: { projectId: project.id } })
              }
              onCreate={() => void onCreateSession(project)}
            />
          ))}
          {createError !== null ? (
            <View style={styles.createErrorRow}>
              <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
                {createError}
              </TypeCaption>
            </View>
          ) : null}
          <TypeMicro style={[styles.footer, { color: tokens.textTertiary }]}>
            session counts fold the host's 200 most recent sessions
          </TypeMicro>
        </>
      )}
    </ScreenScaffold>
  );
}

// ── the row ──────────────────────────────────────────────────────────────────

function ProjectRowCard({
  project,
  index,
  count,
  creating,
  onOpen,
  onCreate,
}: {
  project: ProjectRow;
  index: number;
  count: number | undefined;
  creating: boolean;
  onOpen: () => void;
  onCreate: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <PressableCard onPress={onOpen} enterIndex={Math.min(index, 12)} accessibilityLabel={`Project ${project.name}`}>
      <View style={styles.rowInner}>
        <View style={[styles.dot, { backgroundColor: project.color }]} />
        <View style={styles.rowMain}>
          <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
          <TypeMono numberOfLines={1} style={styles.rootPath}>
            {project.rootPath}
          </TypeMono>
          {count !== undefined ? (
            <TypeMicro>{`${count} session${count === 1 ? "" : "s"}`}</TypeMicro>
          ) : null}
        </View>
        <Pressable
          accessibilityLabel={`Start a new session in ${project.name}`}
          accessibilityRole="button"
          accessibilityState={creating ? { disabled: true, busy: true } : undefined}
          disabled={creating}
          onPress={onCreate}
          hitSlop={4}
          style={({ pressed }) => [
            styles.newButton,
            { backgroundColor: pressed ? tokens.subtleHover : tokens.subtle, borderColor: tokens.borderSubtle },
          ]}
        >
          {creating ? (
            <ActivityIndicator size="small" color={tokens.accent} />
          ) : (
            <Plus size={20} color={tokens.accent} strokeWidth={2.2} />
          )}
        </Pressable>
      </View>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 68,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowMain: { flex: 1, gap: 3 },
  rootPath: { fontSize: 12 },
  newButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  createErrorRow: { paddingHorizontal: spacing.xs },
  footer: { textAlign: "center", paddingTop: spacing.sm },
});
