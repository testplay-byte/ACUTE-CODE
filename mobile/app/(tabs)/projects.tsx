/**
 * Projects v4 (R113-e; R114-c — the inline accordion + the honest status
 * labels + the folder-browser New Project sheet + the New Session naming
 * sheet) — the registry AS THE TAB. A row's tap no longer pushes the
 * per-project page (the owner: "tapping a project should expand its
 * sessions below, not open a new page"): the row TOGGLES an inline
 * expansion (the house spring on height + opacity) revealing that
 * project's sessions as compact rows (title, HUMAN status badge —
 * sessionStatusLabel: queued reads "open", completed "done" — last
 * activity), a "+N more" reveal when the fold holds more than eight, and
 * a "New session" row at the end. The per-row Plus and the "New session"
 * row open the New Session sheet (optional name + the full/ask/plan
 * operating mode); app/project/[id].tsx is now a thin redirect for deep
 * links only.
 *
 * The NEW PROJECT affordance moved into the content (the header row died
 * with R114-c's chromeless roots): a compact "New project" action row at
 * the list's top. Its sheet is the reworked create: (a) name, (b) the
 * ROOT FOLDER BROWSER over GET /api/v1/system/fs/browse (breadcrumb row
 * of the current path, dirs-only list with chevrons, "Use this folder"
 * confirm — the manual absolute-path input survives behind "Type a path
 * instead"), (c) the optional color the POST /projects route truly
 * accepts (#rrggbb; the server picks its own otherwise), (d) Create with
 * the honest busy + inline errors. The server validates the folder exists
 * on disk — 400s name the field.
 *
 * LIVE (R113-e): the events store drives the reloads — hello (the resync)
 * and the debounced session-frame batches bump the epochs this screen keys
 * its refetches on, so a project created on the PC appears here the moment
 * it exists and the counts/dots follow every turn. The "{n} running" meta
 * stays live off the same fold.
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderGit2,
  FolderPlus,
  Plus,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { EmptyState, ErrorState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  Chip,
  PressableCard,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { SPRING } from "@/design/motion";
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
import {
  countProjectSessions,
  fetchSessions,
  groupProjectSessions,
  isTurnRunning,
  patchSessionPermissions,
  sessionStatusLabel,
  sessionStatusTone,
  sessionTitle,
  type SessionRow,
} from "@/features/sessions";
import { breadcrumbSegments, fetchFsBrowse, type FsBrowseReply } from "@/features/fs-browse";
import { mobLog, mobWarn } from "@/lib/log";

/** The client-side fold limit (the sessions route has NO server-side
 * projectId filter — the phone folds the recent list itself). */
const SESSION_FOLD_LIMIT = 200;

/** How many sessions the accordion renders before the "+N more" reveal. */
const EXPAND_PREVIEW = 8;

/** The preset project colors the New Project sheet offers (the POST route
 * accepts exactly a #rrggbb string; null = the server picks its own). */
const PROJECT_COLORS: ReadonlyArray<string> = [
  "#C4653F", // terracotta
  "#6F9E90", // sage
  "#B08A3C", // ochre
  "#6B7F9E", // slate
  "#8A6A8E", // plum
  "#8A6A55", // taupe
];

export default function ProjectsTab() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionCounts, setSessionCounts] = useState<Record<string, { total: number; running: number }>>({});
  /** The folded recent-session list — the counts AND the accordion's rows. */
  const [sessionRows, setSessionRows] = useState<SessionRow[] | null>(null);
  /** The default "New session" agent (first non-template, fallback any). */
  const [agentId, setAgentId] = useState<string | null>(null);

  // R114-c — the accordion's open row (one at a time; `full` = the "+N
  // more" reveal dropped the preview cap).
  const [expanded, setExpanded] = useState<{ id: string; full: boolean } | null>(null);

  // The sheets (R114-c): New Project (folder browser) + New Session.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [sessionSheetProject, setSessionSheetProject] = useState<ProjectRow | null>(null);

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

  // The session fold — one quiet fetch of the recent 200 feeding BOTH the
  // count line and the accordion's rows (failure stays quiet: decoration,
  // never a failure state).
  const loadSessions = useCallback(async () => {
    try {
      const outcome = await fetchSessions(getLinkManager(), { limit: SESSION_FOLD_LIMIT });
      if (!outcome.ok) {
        mobWarn("projects", "session fold unavailable", { status: outcome.error.status });
        return;
      }
      setSessionCounts(countProjectSessions(outcome.data.sessions));
      setSessionRows(outcome.data.sessions);
      mobLog("projects", "session fold loaded", { sessions: outcome.data.sessions.length });
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
    void loadSessions();
  }, [status, loadSessions]);

  // R113-e: the live refetch — a hello (the resync), a project frame, or a
  // debounced session-frame batch landed AFTER this screen mounted.
  useEffect(() => {
    if (sessionsEpoch === mountEpochs.current.sessions && projectsEpoch === mountEpochs.current.projects) return;
    if (status !== "connected") return;
    void load();
    void loadSessions();
  }, [sessionsEpoch, projectsEpoch, status, load, loadSessions]);

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
    await Promise.all([load(), loadSessions()]);
    setRefreshing(false);
  }, [load, loadSessions]);

  const visibleProjects = useMemo(() => projects ?? [], [projects]);

  // The accordion's per-project session groups (most-recent-first — the
  // route's own order, preserved by the pure fold).
  const sessionsByProject = useMemo(
    () => (sessionRows === null ? {} : groupProjectSessions(sessionRows)),
    [sessionRows],
  );

  const toggleExpand = useCallback((projectId: string) => {
    void selectionHaptic();
    setExpanded((prev) => (prev !== null && prev.id === projectId ? null : { id: projectId, full: false }));
  }, []);

  const revealAll = useCallback((projectId: string) => {
    setExpanded((prev) => (prev !== null && prev.id === projectId ? { id: projectId, full: true } : prev));
  }, []);

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
    <ScreenScaffold title="Projects" refreshControl={refreshControl} chrome={false}>
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
        <>
          {/* R114-c: the New Project affordance moved INTO the content (the
              header row died with the chromeless roots) — a compact action
              row at the list's top. */}
          <NewProjectActionRow onPress={() => setNewProjectOpen(true)} />
          <EmptyState
            Icon={FolderGit2}
            title="No projects yet."
            caption="tap “New project” to register a folder from the desktop, or create one there — it appears here the moment it exists."
          />
        </>
      ) : (
        <>
          {error !== null ? (
            <TypeCaption style={{ color: tokens.warning }}>{`last refresh failed — ${error}`}</TypeCaption>
          ) : null}
          <NewProjectActionRow onPress={() => setNewProjectOpen(true)} />
          {visibleProjects.map((project, index) => (
            <ProjectRowCard
              key={project.id}
              project={project}
              index={index}
              stats={sessionCounts[project.id]}
              sessions={sessionsByProject[project.id] ?? []}
              expanded={expanded !== null && expanded.id === project.id}
              full={expanded !== null && expanded.id === project.id && expanded.full}
              onToggle={() => toggleExpand(project.id)}
              onRevealAll={() => revealAll(project.id)}
              onNewSession={() => setSessionSheetProject(project)}
              onOpenSession={(row) => router.push(`/session/${row.id}`)}
            />
          ))}
          <TypeMicro style={[styles.footer, { color: tokens.textTertiary }]}>
            tap a project to expand its sessions · counts fold the host's {SESSION_FOLD_LIMIT} most recent
          </TypeMicro>
        </>
      )}

      {/* ── the New Project sheet: name + the folder browser + color ── */}
      <NewProjectSheet
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          // The row lands with the reload (the server also broadcasts a
          // project frame — every device's registry refreshes).
          setNewProjectOpen(false);
          void load();
        }}
      />

      {/* ── the New Session sheet: optional name + the operating mode ── */}
      <NewSessionSheet
        open={sessionSheetProject !== null}
        project={sessionSheetProject}
        agentId={agentId}
        onClose={() => setSessionSheetProject(null)}
      />
    </ScreenScaffold>
  );
}

// ── the New Project action row (the content-borne affordance) ───────────────

function NewProjectActionRow({ onPress }: { onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <PressableCard onPress={onPress} accessibilityLabel="New project">
      <View style={styles.actionRowInner}>
        <View style={[styles.actionIcon, { backgroundColor: tokens.subtleHover }]}>
          <FolderPlus size={20} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.actionText}>
          <TypeBodyStrong>New project</TypeBodyStrong>
          <TypeCaption numberOfLines={1}>register a folder from the desktop</TypeCaption>
        </View>
        <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

// ── the accordion (the house spring on height + opacity) ────────────────────

/**
 * The inline expansion — height + opacity under the ONE spring. The content
 * stays mounted (clipped at height 0) so its measured height is always
 * current when a toggle lands; onLayout re-syncs an OPEN panel whose rows
 * changed (a live refetch while expanded).
 */
function Accordion({ open, children }: { open: boolean; children: React.ReactNode }) {
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);
  const contentHeight = useRef(0);

  useEffect(() => {
    height.value = withSpring(open ? contentHeight.current : 0, SPRING);
    opacity.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, height, opacity]);

  const style = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    contentHeight.current = event.nativeEvent.layout.height;
    if (open) height.value = withSpring(contentHeight.current, SPRING);
  };

  return (
    <Animated.View style={[styles.accordionClip, style]}>
      <View collapsable={false} onLayout={onLayout} style={styles.accordionInner}>
        {children}
      </View>
    </Animated.View>
  );
}

// ── the project row (header + the inline session expansion) ─────────────────

function ProjectRowCard({
  project,
  index,
  stats,
  sessions,
  expanded,
  full,
  onToggle,
  onRevealAll,
  onNewSession,
  onOpenSession,
}: {
  project: ProjectRow;
  index: number;
  stats: { total: number; running: number } | undefined;
  sessions: SessionRow[];
  expanded: boolean;
  full: boolean;
  onToggle: () => void;
  onRevealAll: () => void;
  onNewSession: () => void;
  onOpenSession: (row: SessionRow) => void;
}) {
  const { tokens } = useTheme();
  const running = stats?.running ?? 0;
  const chevron = useSharedValue(0);

  useEffect(() => {
    chevron.value = withSpring(expanded ? 1 : 0, SPRING);
  }, [expanded, chevron]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevron.value * 180}deg` }],
  }));

  const visible = full ? sessions : sessions.slice(0, EXPAND_PREVIEW);
  const hidden = sessions.length - visible.length;

  return (
    <PressableCard
      onPress={onToggle}
      enterIndex={Math.min(index, 12)}
      accessibilityLabel={`Project ${project.name}${expanded ? ", expanded" : ""}`}
      accessibilityState={{ expanded }}
    >
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
        <Animated.View style={chevronStyle}>
          <ChevronDown size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </Animated.View>
        <Pressable
          accessibilityLabel={`New session in ${project.name}`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onNewSession}
          style={({ pressed }) => [
            styles.newButton,
            { backgroundColor: pressed ? tokens.subtleHover : tokens.subtle, borderColor: tokens.borderSubtle },
          ]}
        >
          <Plus size={20} color={tokens.accent} strokeWidth={2.2} />
        </Pressable>
      </View>

      {/* ── the inline session expansion (R114-c) ── */}
      <Accordion open={expanded}>
        <View style={[styles.sessionsWell, { borderTopColor: tokens.borderSubtle }]}>
          {visible.length === 0 ? (
            <View style={styles.sessionsEmpty}>
              <TypeCaption style={{ color: tokens.textTertiary }}>
                no sessions yet — start one below
              </TypeCaption>
            </View>
          ) : (
            visible.map((row) => (
              <SessionRow key={row.id} row={row} onOpen={() => onOpenSession(row)} />
            ))
          )}
          {hidden > 0 ? (
            <Pressable
              accessibilityLabel={`Show ${hidden} more sessions`}
              accessibilityRole="button"
              onPress={onRevealAll}
              style={({ pressed }) => [styles.moreRow, { opacity: pressed ? 0.6 : 1 }]}
            >
              <TypeMicro style={{ color: tokens.textTertiary }}>+{hidden} more sessions</TypeMicro>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={`Start a new session in ${project.name}`}
            accessibilityRole="button"
            onPress={onNewSession}
            style={({ pressed }) => [styles.newSessionRow, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Plus size={16} color={tokens.accent} strokeWidth={2.4} />
            <TypeBodyStrong style={{ color: tokens.accent }}>New session</TypeBodyStrong>
          </Pressable>
        </View>
      </Accordion>
    </PressableCard>
  );
}

// ── the compact session row (inside the expansion) ──────────────────────────

function SessionRow({ row, onOpen }: { row: SessionRow; onOpen: () => void }) {
  const { tokens } = useTheme();
  const tone = sessionStatusTone(row.status);
  const running = isTurnRunning(row);
  const updatedMs = new Date(row.updatedAt).getTime();
  const updated = Number.isFinite(updatedMs) ? timeAgoShort(updatedMs) : "";

  return (
    <Pressable
      accessibilityLabel={`Session ${sessionTitle(row)}, ${sessionStatusLabel(row.status)}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.sessionRow, { backgroundColor: pressed ? tokens.subtle : "transparent" }]}
    >
      <View style={styles.sessionMain}>
        <TypeBody numberOfLines={1} style={styles.sessionTitle}>
          {sessionTitle(row)}
        </TypeBody>
        <View style={styles.sessionMeta}>
          {running ? <StatusDot color={tokens.running} pulse size={6} /> : null}
          <TypeMicro numberOfLines={1}>
            {updated}
            {row.subRole !== null && row.subRole !== "" ? ` · ${row.subRole}` : ""}
          </TypeMicro>
        </View>
      </View>
      <Badge tone={running ? "running" : tone}>{sessionStatusLabel(row.status)}</Badge>
    </Pressable>
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

// ── the New Project sheet (name + folder browser + color) ───────────────────

function NewProjectSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { tokens } = useTheme();
  // (a) the name
  const [name, setName] = useState("");
  // (b) the root folder — the browser OR the manual absolute path
  const [manual, setManual] = useState(false);
  const [root, setRoot] = useState("");
  const [browse, setBrowse] = useState<FsBrowseReply | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // (c) the optional color (the POST route accepts #rrggbb; null = server's)
  const [color, setColor] = useState<string | null>(null);
  // (d) create
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Blank path = the SERVER's home directory — the browse starts there.
  const browseTo = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const outcome = await fetchFsBrowse(getLinkManager(), path);
      if (outcome.ok) {
        setBrowse(outcome.data);
        mobLog("fs-browse", "listed", { path: outcome.data.path, entries: outcome.data.entries.length });
      } else {
        setBrowseError(outcome.error.message);
        mobWarn("fs-browse", "failed", { status: outcome.error.status, code: outcome.error.code });
      }
    } catch {
      setBrowseError("the host is offline — browsing resumes when it returns");
      mobWarn("fs-browse", "threw");
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // The first open browses the server home; every open clears the stale error.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (browse === null) void browseTo();
  }, [open, browse, browseTo]);

  // The folder list — dirs only (this is a FOLDER picker; the route already
  // sorts dirs first, each alphabetical).
  const dirs = useMemo(() => browse?.entries.filter((entry) => entry.dir) ?? [], [browse]);
  const crumbs = useMemo(() => (browse === null ? [] : breadcrumbSegments(browse.path)), [browse]);

  const onCreate = useCallback(async () => {
    if (busy) return;
    const body = newProjectBody(name, root, color ?? undefined);
    if (body === null) {
      setError("a name and an absolute folder path are both required");
      void warningHaptic();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await createProject(getLinkManager(), body);
      if (outcome.ok) {
        mobLog("projects", "project created", { id: outcome.data.id, name: body.name });
        void successHaptic();
        // Reset for the next open (the browser re-browses the home dir).
        setName("");
        setRoot("");
        setColor(null);
        setBrowse(null);
        setManual(false);
        onCreated();
      } else {
        mobWarn("projects", "project create failed", {
          status: outcome.error.status,
          code: outcome.error.code,
        });
        void warningHaptic();
        // The route names the field (missing name / folder doesn't exist / a
        // project already uses the folder) — surface it inline, honestly.
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("projects", "project create threw");
      void warningHaptic();
      setError("the host is offline — the project was not created");
    } finally {
      setBusy(false);
    }
  }, [busy, name, root, color, onCreated]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New project"
      testID="new-project-sheet"
      maxHeightFraction={0.86}
    >
      <View style={styles.fieldGap}>
        {/* (a) the name */}
        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Name</TypeCaption>
          <TextInput
            accessibilityLabel="Project name"
            placeholder="acute-code"
            placeholderTextColor={tokens.textTertiary}
            value={name}
            onChangeText={setName}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.fieldInput,
              { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
            ]}
          />
        </View>

        {/* (b) the root folder — the confirmed path line, then browser/manual */}
        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Root folder (on the desktop)</TypeCaption>
          {root.trim() !== "" ? (
            <View style={[styles.chosenRoot, { borderColor: tokens.borderSubtle, backgroundColor: tokens.inputBg }]}>
              <TypeMono numberOfLines={1} style={styles.chosenRootText}>
                {root}
              </TypeMono>
            </View>
          ) : (
            <TypeMicro style={{ color: tokens.textTertiary }}>
              browse the desktop's folders, or type an absolute path
            </TypeMicro>
          )}

          {manual ? (
            <View style={styles.fieldGap}>
              <TextInput
                accessibilityLabel="Project root folder path"
                placeholder="/home/z/repos/acute-code"
                placeholderTextColor={tokens.textTertiary}
                value={root}
                onChangeText={setRoot}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                style={[
                  styles.fieldInput,
                  styles.fieldMono,
                  { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
                ]}
              />
              <Pressable accessibilityRole="button" onPress={() => setManual(false)} hitSlop={8}>
                <TypeMicro style={{ color: tokens.accent }}>Browse folders instead</TypeMicro>
              </Pressable>
            </View>
          ) : (
            <View style={styles.browserWrap}>
              {/* the breadcrumb row — the current path, every crumb tappable */}
              <View style={styles.breadcrumbRow}>
                {browse !== null && browse.parent !== null ? (
                  <Pressable
                    accessibilityLabel="Go up one folder"
                    accessibilityRole="button"
                    hitSlop={6}
                    onPress={() => void browseTo(browse.parent ?? undefined)}
                    style={[styles.upButton, { borderColor: tokens.borderSubtle }]}
                  >
                    <ChevronUp size={16} color={tokens.textSecondary} strokeWidth={2.2} />
                  </Pressable>
                ) : null}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.breadcrumbContent}
                  style={styles.breadcrumbScroll}
                >
                  {crumbs.map((crumb, i) => {
                    const isCurrent = i === crumbs.length - 1;
                    return (
                      <Pressable
                        key={crumb.path}
                        accessibilityRole="button"
                        accessibilityLabel={`Browse ${crumb.path}`}
                        onPress={() => void browseTo(crumb.path)}
                        hitSlop={4}
                        style={({ pressed }) => [
                          styles.crumb,
                          {
                            backgroundColor: isCurrent
                              ? tokens.subtleHover
                              : pressed
                                ? tokens.subtle
                                : "transparent",
                          },
                        ]}
                      >
                        <TypeMicro
                          numberOfLines={1}
                          style={{ color: isCurrent ? tokens.text : tokens.textSecondary }}
                        >
                          {crumb.label}
                        </TypeMicro>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>

              {/* the dirs-only list (a fixed-height scroller — the sheet's own
                  scroller wraps the whole form) */}
              <View
                style={[styles.dirList, { borderColor: tokens.borderSubtle, backgroundColor: tokens.inputBg }]}
                accessibilityLabel="Folder list"
              >
                {browseLoading ? (
                  <View style={styles.browserPad}>
                    <ActivityIndicator size="small" color={tokens.accent} />
                  </View>
                ) : browseError !== null ? (
                  <View style={styles.browserPad}>
                    <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
                      {browseError}
                    </TypeCaption>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void browseTo(browse?.path)}
                      hitSlop={8}
                    >
                      <TypeMicro style={{ color: tokens.accent }}>retry</TypeMicro>
                    </Pressable>
                  </View>
                ) : dirs.length === 0 ? (
                  <View style={styles.browserPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>
                      no subfolders here — use this folder or go up
                    </TypeCaption>
                  </View>
                ) : (
                  <ScrollView style={styles.dirScroll} nestedScrollEnabled>
                    {dirs.map((entry) => (
                      <Pressable
                        key={entry.path}
                        accessibilityRole="button"
                        accessibilityLabel={`Open folder ${entry.name}`}
                        onPress={() => void browseTo(entry.path)}
                        style={({ pressed }) => [
                          styles.dirRow,
                          { backgroundColor: pressed ? tokens.subtle : "transparent" },
                        ]}
                      >
                        <Folder size={16} color={tokens.accent2} strokeWidth={2.2} />
                        <TypeBody numberOfLines={1} style={styles.dirName}>
                          {entry.name}
                        </TypeBody>
                        <ChevronRight size={14} color={tokens.textTertiary} strokeWidth={2.2} />
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
              </View>
              {browse?.truncated === true ? (
                <TypeMicro style={{ color: tokens.textTertiary }}>
                  showing the first 400 entries
                </TypeMicro>
              ) : null}

              {/* the confirm — locks the current browse path in */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Use this folder as the project root"
                disabled={browse === null}
                onPress={() => {
                  void selectionHaptic();
                  if (browse !== null) setRoot(browse.path);
                }}
                style={({ pressed }) => [
                  styles.useFolderButton,
                  {
                    borderColor: pressed ? tokens.borderStrong : tokens.border,
                    backgroundColor: pressed ? tokens.subtle : "transparent",
                    opacity: browse === null ? 0.5 : 1,
                  },
                ]}
              >
                <FolderPlus size={15} color={tokens.accent} strokeWidth={2.2} />
                <TypeBodyStrong style={styles.useFolderText}>Use this folder</TypeBodyStrong>
              </Pressable>

              <Pressable accessibilityRole="button" onPress={() => setManual(true)} hitSlop={8}>
                <TypeMicro style={{ color: tokens.accent }}>Type a path instead</TypeMicro>
              </Pressable>
            </View>
          )}
        </View>

        {/* (c) the optional color — the one extra field the route accepts */}
        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Color (optional)</TypeCaption>
          <View style={styles.colorRow}>
            {PROJECT_COLORS.map((preset) => {
              const selected = color === preset;
              return (
                <Pressable
                  key={preset}
                  accessibilityRole="button"
                  accessibilityLabel={`Project color ${preset}`}
                  onPress={() => {
                    void selectionHaptic();
                    setColor(selected ? null : preset);
                  }}
                  style={[
                    styles.colorSwatch,
                    { backgroundColor: preset },
                    selected ? { borderColor: tokens.text } : null,
                  ]}
                >
                  {selected ? <Check size={13} color="#FFFFFF" strokeWidth={3} /> : null}
                </Pressable>
              );
            })}
            <TypeMicro style={[styles.colorAuto, { color: tokens.textTertiary }]}>
              {color === null ? "auto — the host picks" : "tap again for auto"}
            </TypeMicro>
          </View>
        </View>

        {/* (d) the create */}
        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onCreate()}
          disabled={busy}
          accessibilityLabel={busy ? "Creating the project" : "Create the project"}
        >
          {busy ? "creating…" : "Create the project"}
        </ChromeButton>
      </View>
    </Sheet>
  );
}

// ── the New Session sheet (optional name + the operating mode) ──────────────

/** The operating modes' copy — the session screen's ModeSwitcher semantics. */
const SESSION_MODES: ReadonlyArray<{
  id: "full" | "ask" | "plan";
  label: string;
  caption: string;
}> = [
  { id: "full", label: "Full", caption: "runs without asking" },
  { id: "ask", label: "Ask", caption: "asks before acting" },
  { id: "plan", label: "Plan", caption: "writes a plan first" },
];

function NewSessionSheet({
  open,
  project,
  agentId,
  onClose,
}: {
  open: boolean;
  project: ProjectRow | null;
  agentId: string | null;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const router = useRouter();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"full" | "ask" | "plan">("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh fields every open (an abandoned draft never haunts the next one).
  useEffect(() => {
    if (!open) return;
    setName("");
    setMode("ask");
    setError(null);
  }, [open]);

  const onCreate = useCallback(async () => {
    if (busy || project === null) return;
    setError(null);
    if (agentId === null) {
      setError("no agent is configured on the host — add one in the desktop's agents page first");
      void warningHaptic();
      mobWarn("projects", "create blocked — no agent");
      return;
    }
    setBusy(true);
    try {
      const trimmed = name.trim();
      const outcome = await createSession(getLinkManager(), {
        mode: "single",
        agentId,
        projectId: project.id,
        // An empty name = the server's auto title (from the first message).
        ...(trimmed !== "" ? { title: trimmed } : {}),
      });
      if (outcome.ok) {
        // The operating mode rides the permissions PATCH — the CREATE route
        // accepts no permission field and "ask" is the server default, so
        // only a non-ask choice PATCHes (a failed PATCH is quiet: the
        // session exists and its own mode switcher can fix it).
        if (mode !== "ask") {
          const permOutcome = await patchSessionPermissions(getLinkManager(), outcome.data.id, mode);
          if (!permOutcome.ok) {
            mobWarn("projects", "mode patch failed", { status: permOutcome.error.status });
          }
        }
        mobLog("projects", "session created", {
          id: outcome.data.id,
          projectId: project.id,
          agentId,
          mode,
          titled: trimmed !== "",
        });
        void successHaptic();
        onClose();
        router.push(`/session/${outcome.data.id}`);
      } else {
        mobWarn("projects", "create failed", { status: outcome.error.status, code: outcome.error.code });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("projects", "create threw");
      void warningHaptic();
      setError("the host is offline — the session was not created");
    } finally {
      setBusy(false);
    }
  }, [busy, project, agentId, name, mode, onClose, router]);

  return (
    <Sheet open={open} onClose={onClose} title="New session" testID="new-session-sheet">
      <View style={styles.fieldGap}>
        {project !== null ? (
          <View style={styles.sheetProjectRow}>
            <View style={[styles.dot, { backgroundColor: project.color }]} />
            <View style={styles.sheetProjectText}>
              <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
              <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                {project.rootPath}
              </TypeMicro>
            </View>
          </View>
        ) : null}

        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Name (optional)</TypeCaption>
          <TextInput
            accessibilityLabel="Session name"
            placeholder="auto-titled from the first message"
            placeholderTextColor={tokens.textTertiary}
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            autoCorrect
            style={[
              styles.fieldInput,
              { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
            ]}
          />
        </View>

        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Operating mode</TypeCaption>
          <View style={styles.modeRow}>
            {SESSION_MODES.map((m) => (
              <Chip
                key={m.id}
                testID={`new-session-mode-${m.id}`}
                selected={mode === m.id}
                onPress={() => {
                  void selectionHaptic();
                  setMode(m.id);
                }}
                style={styles.modeChip}
              >
                {m.label}
              </Chip>
            ))}
          </View>
          <TypeMicro style={{ color: tokens.textTertiary }}>
            {SESSION_MODES.find((m) => m.id === mode)?.caption ?? ""}
          </TypeMicro>
        </View>

        {error !== null ? (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {error}
          </TypeCaption>
        ) : null}
        <ChromeButton
          onPress={() => void onCreate()}
          disabled={busy}
          accessibilityLabel={busy ? "Creating the session" : "Create the session"}
        >
          {busy ? "creating…" : "Create the session"}
        </ChromeButton>
      </View>
    </Sheet>
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
  footer: { textAlign: "center", paddingTop: spacing.sm },

  // ── the New Project action row (content-borne, R114-c) ──
  actionRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 64,
  },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { flex: 1, gap: 2 },

  // ── the accordion ──
  accordionClip: { height: 0, overflow: "hidden" },
  accordionInner: {},
  sessionsWell: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: spacing.sm,
  },
  sessionsEmpty: { padding: spacing.md },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.lg + 24,
    paddingRight: spacing.lg,
    minHeight: 48,
  },
  sessionMain: { flex: 1, gap: 2 },
  sessionTitle: { fontWeight: "600", fontSize: 14 },
  sessionMeta: { flexDirection: "row", gap: 4, alignItems: "center", flexWrap: "wrap" },
  moreRow: {
    paddingLeft: spacing.lg + 24,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  newSessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.lg + 24,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm + 2,
    minHeight: 48,
  },

  // ── the shared sheet fields ──
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

  // ── the folder browser ──
  chosenRoot: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chosenRootText: { fontSize: 12 },
  browserWrap: { gap: spacing.sm },
  breadcrumbRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  upButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  breadcrumbScroll: { flex: 1 },
  breadcrumbContent: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: spacing.sm },
  crumb: {
    borderRadius: 8,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    minWidth: 28,
    alignItems: "center",
  },
  dirList: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    overflow: "hidden",
  },
  dirScroll: { maxHeight: 264 },
  dirRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  dirName: { flex: 1, fontSize: 14 },
  browserPad: { padding: spacing.lg, gap: spacing.sm, alignItems: "flex-start" },
  useFolderButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    minHeight: TOUCH_TARGET + 2,
    paddingHorizontal: spacing.lg,
  },
  useFolderText: { fontSize: 15 },

  // ── the color picker row ──
  colorRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  colorAuto: { flex: 1, minWidth: 120 },

  // ── the New Session sheet ──
  sheetProjectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    paddingLeft: spacing.xs,
  },
  sheetProjectText: { flex: 1, gap: 2 },
  modeRow: { flexDirection: "row", gap: spacing.sm },
  modeChip: { flex: 1, alignItems: "center" },
});
