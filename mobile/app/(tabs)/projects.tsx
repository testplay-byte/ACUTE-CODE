/**
 * Projects v3 (R113-e) — the registry AS THE TAB (the sessions tab merged
 * into it — the owner: "If I click on any one of the projects, it leads me
 * to the sessions screen" was the wrong shape; now a row opens the project's
 * OWN detail screen, app/project/[id].tsx). Rows carry the project's color
 * dot, name, mono root path, the session count, and a live pulse when any
 * of the project's sessions is running; the per-row Plus starts a new
 * single-agent session in the project and drops straight into its
 * transcript. The NEW PROJECT affordance finally wires the dead
 * createProject client (a bottom sheet: name + root path — the server
 * validates the folder exists on disk; honest inline errors otherwise).
 *
 * LIVE (R113-e): the events store drives the reloads — hello (the resync)
 * and the debounced session-frame batches bump the epochs this screen keys
 * its refetches on, so a project created on the PC appears here the moment
 * it exists and the counts/dots follow every turn.
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { FolderGit2, Plus } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { EmptyState, ErrorState, SkeletonList } from "@/components/list-state";
import {
  ChromeButton,
  PressableCard,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, TOUCH_TARGET, fontFamily, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useEventsEpoch } from "@/features/events";
import {
  createProject,
  createSession,
  fetchAgents,
  fetchProjects,
  newProjectBody,
  type ProjectRow,
} from "@/features/config";
import { countProjectSessions, fetchSessions } from "@/features/sessions";
import { mobLog, mobWarn } from "@/lib/log";

export default function ProjectsTab() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionCounts, setSessionCounts] = useState<Record<string, { total: number; running: number }>>({});
  /** The default "New session" agent (first non-template, fallback any). */
  const [agentId, setAgentId] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // The new-project sheet (R113-e: the dead createProject client, wired).
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectRoot, setNewProjectRoot] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);

  // ── the live epochs (R113-e): hello + debounced session batches + project
  // frames all move these — the refetch rides the effect below, keyed on them.
  const sessionsEpoch = useEventsEpoch("sessions");
  const projectsEpoch = useEventsEpoch("projects");
  // The MOUNT values — the refetch fires only when an epoch moves PAST its
  // mount value (the mount loads above own the first fetch; frames that
  // landed before this screen opened are already folded into them).
  const mountEpochs = useRef({ sessions: sessionsEpoch, projects: projectsEpoch });

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

  // The session counts — a quiet client fold of the recent 200 (the sessions
  // route has no projectId filter server-side). Failure stays quiet.
  const loadCounts = useCallback(async () => {
    try {
      const outcome = await fetchSessions(getLinkManager(), { limit: 200 });
      if (!outcome.ok) {
        mobWarn("projects", "session counts unavailable", { status: outcome.error.status });
        return;
      }
      setSessionCounts(countProjectSessions(outcome.data.sessions));
      mobLog("projects", "session counts folded", { sessions: outcome.data.sessions.length });
    } catch {
      // quiet — counts are decoration, never a failure state
    }
  }, []);

  // Load on mount + every (re)connect + every live epoch move.
  useEffect(() => {
    if (status === "connected") {
      void load();
    } else if (status === "unpaired") {
      // stays quiet — the render branch carries the truth
    }
  }, [status, load]);

  useEffect(() => {
    if (status !== "connected") return;
    void loadCounts();
  }, [status, loadCounts]);

  // R113-e: the live refetch — a hello (the resync), a project frame, or a
  // debounced session-frame batch landed AFTER this screen mounted.
  useEffect(() => {
    if (sessionsEpoch === mountEpochs.current.sessions && projectsEpoch === mountEpochs.current.projects) return;
    if (status !== "connected") return;
    void load();
    void loadCounts();
  }, [sessionsEpoch, projectsEpoch, status, load, loadCounts]);

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

  // ── the new-project sheet's create (the dead client, finally wired) ──────

  const onCreateProject = useCallback(async () => {
    if (newProjectBusy) return;
    const body = newProjectBody(newProjectName, newProjectRoot);
    if (body === null) {
      setNewProjectError("a name and an absolute folder path are both required");
      void warningHaptic();
      return;
    }
    setNewProjectBusy(true);
    setNewProjectError(null);
    try {
      const outcome = await createProject(getLinkManager(), body);
      if (outcome.ok) {
        mobLog("projects", "project created", { id: outcome.data.id, name: body.name });
        void successHaptic();
        setNewProjectOpen(false);
        setNewProjectName("");
        setNewProjectRoot("");
        // The row lands with the reload (the server also broadcasts a
        // project frame — every device's registry refreshes).
        void load();
      } else {
        mobWarn("projects", "project create failed", {
          status: outcome.error.status,
          code: outcome.error.code,
        });
        void warningHaptic();
        // The route names the field (missing name / folder doesn't exist / a
        // project already uses the folder) — surface it inline, honestly.
        setNewProjectError(outcome.error.message);
      }
    } catch {
      mobWarn("projects", "project create threw");
      void warningHaptic();
      setNewProjectError("the host is offline — the project was not created");
    } finally {
      setNewProjectBusy(false);
    }
  }, [newProjectBusy, newProjectName, newProjectRoot, load]);

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
    <ScreenScaffold
      title="Projects"
      refreshControl={refreshControl}
      right={
        <Pressable
          accessibilityLabel="New project"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => setNewProjectOpen(true)}
          style={({ pressed }) => [
            styles.newProjectButton,
            { backgroundColor: pressed ? tokens.subtleHover : tokens.subtle, borderColor: tokens.borderSubtle },
          ]}
        >
          <Plus size={20} color={tokens.accent} strokeWidth={2.2} />
        </Pressable>
      }
    >
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
          caption="tap + to register a folder from the desktop, or create one there — it appears here the moment it exists."
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
              stats={sessionCounts[project.id]}
              creating={creatingId === project.id}
              onOpen={() => router.push(`/project/${project.id}`)}
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

      {/* ── the new-project sheet (createProject, finally wired) ── */}
      <Sheet
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        title="New project"
        testID="new-project-sheet"
      >
        <View style={styles.fieldGap}>
          <View style={styles.fieldWrap}>
            <TypeCaption style={styles.fieldLabel}>Name</TypeCaption>
            <TextInput
              accessibilityLabel="Project name"
              placeholder="acute-code"
              placeholderTextColor={tokens.textTertiary}
              value={newProjectName}
              onChangeText={setNewProjectName}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.fieldInput,
                { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
              ]}
            />
          </View>
          <View style={styles.fieldWrap}>
            <TypeCaption style={styles.fieldLabel}>Root folder (on the desktop)</TypeCaption>
            <TextInput
              accessibilityLabel="Project root folder path"
              placeholder="/home/z/repos/acute-code"
              placeholderTextColor={tokens.textTertiary}
              value={newProjectRoot}
              onChangeText={setNewProjectRoot}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              style={[
                styles.fieldInput,
                styles.fieldMono,
                { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
              ]}
            />
            <TypeMicro style={{ color: tokens.textTertiary }}>
              an absolute path — the folder must exist on the host
            </TypeMicro>
          </View>
          {newProjectError !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {newProjectError}
            </TypeCaption>
          ) : null}
          <ChromeButton
            onPress={() => void onCreateProject()}
            disabled={newProjectBusy}
            accessibilityLabel={newProjectBusy ? "Creating the project" : "Create the project"}
          >
            {newProjectBusy ? "creating…" : "Create the project"}
          </ChromeButton>
        </View>
      </Sheet>
    </ScreenScaffold>
  );
}

// ── the row ──────────────────────────────────────────────────────────────────

function ProjectRowCard({
  project,
  index,
  stats,
  creating,
  onOpen,
  onCreate,
}: {
  project: ProjectRow;
  index: number;
  stats: { total: number; running: number } | undefined;
  creating: boolean;
  onOpen: () => void;
  onCreate: () => void;
}) {
  const { tokens } = useTheme();
  const running = stats?.running ?? 0;
  return (
    <PressableCard onPress={onOpen} enterIndex={Math.min(index, 12)} accessibilityLabel={`Project ${project.name}`}>
      <View style={styles.rowInner}>
        <View style={[styles.dot, { backgroundColor: project.color }]} />
        <View style={styles.rowMain}>
          <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
          <TypeMono numberOfLines={1} style={styles.rootPath}>
            {project.rootPath}
          </TypeMono>
          <View style={styles.metaRow}>
            {running > 0 ? (
              // The live pulse — a turn is running in this project right now
              // (the events store keeps the fold fresh).
              <StatusDot color={tokens.accent} pulse size={7} />
            ) : null}
            {stats !== undefined ? (
              <TypeMicro>
                {running > 0
                  ? `${running} running · ${stats.total} session${stats.total === 1 ? "" : "s"}`
                  : `${stats.total} session${stats.total === 1 ? "" : "s"}`}
              </TypeMicro>
            ) : null}
          </View>
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
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  newButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  newProjectButton: {
    width: TOUCH_TARGET,
    height: 44,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  createErrorRow: { paddingHorizontal: spacing.xs },
  footer: { textAlign: "center", paddingTop: spacing.sm },
  fieldGap: { gap: spacing.md, paddingTop: spacing.xs },
  fieldWrap: { gap: 6 },
  fieldLabel: { paddingLeft: spacing.xs },
  fieldInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 15,
    minHeight: 44,
  },
  fieldMono: { fontFamily: fontFamily.mono },
});
