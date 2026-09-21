/**
 * Projects v5 (R115-h — the round-115 projects tab, rebuilt per
 * docs/design-language/android/; R116-k — the owner's v0.109.0 walkthrough
 * fixes): the registry AS THE List archetype.
 *
 * THE ROW (components.md's row anatomy): [LetterAvatar 40 — the project's
 * own color + first letter on a ROUNDED-SQUARE clay tile (R116-k: the
 * circle is retired)] [TypeBodyStrong name + ONE meta line — the smart
 * root path (shortRootPath: mono 12, the trailing project-name segment
 * dropped, "…/"-shed to a 22-char budget, ellipsizeMode "head" so any
 * residual overflow dots the FRONT — the tail, the part that identifies
 * the folder, survives)] [trailing: the session-count Badge ("3"; "{n}
 * running" in the running tone while a turn runs) — and NOTHING else: the
 * chevron is DEAD (R116-k, verdict #44), the whole row Pressable is the
 * expand affordance (donts #3: never a chevron AND an action button on
 * one row)].
 *
 * THE ACCORDION (R114-c's inline expansion, FIXED R115-h — donts #10, the
 * "dead measurement pattern"): the clip View carries overflow:hidden ONLY
 * (the old static height: 0 made Yoga clamp the relative auto-height
 * child to 0 — onLayout reported 0 forever, the spring target stayed 0,
 * the fold never opened). The measurement child is ABSOLUTE (top/left/
 * right 0), so it sizes to its NATURAL height even while the parent clips
 * at 0 — the measured height is always real, and it lives in a SHARED
 * VALUE the open-toggle effect reads fresh: a re-measure while open (the
 * "+N more" reveal, a live refetch landing new rows) re-springs the panel
 * to the new height. One row open at a time. THE SESSIONS WELL (R116-k,
 * verdicts #48/#49/#50/#51): the fold is its own INSET REGION — a
 * subtle-tinted, hairline-bordered RADIUS_INPUT panel inside the card
 * (the project row above keeps its own card identity) — with the session
 * rows FLUSH LEFT (the FOLD_INDENT is dead), xs gaps between them, the
 * "open" status Badge suppressed (running/done/stopped/failed still
 * badge), the "+N more" reveal, and the "New session" quiet action button
 * (the wave-J add-action grammar) closing the well.
 *
 * THE NEW PROJECT ACTION (screen-archetypes §2): at the list's BOTTOM,
 * half width (48%), CENTERED (donts #40 — bottom actions never left-hug),
 * FolderPlus + "New project" — no description, no chevron, the quiet
 * outline. Its sheet asks ONE question (components.md):
 * WHICH FOLDER — the Name field and the Color swatches are DEAD (donts
 * #18: never ask for derivable data — the name is the folder's basename,
 * the color is the server's own). The folder browser (breadcrumbs + the
 * dirs list + the home cap: the server pins parent null AT the user's
 * home dir, and the client hides Up whenever parent === null) + the
 * collapsed "Type a path instead" disclosure for power users. Once "Use
 * this folder" is tapped: the FULL path as a mono chip + "Select another
 * folder" (back to browsing) + the separate "Create the project" primary.
 * The old "tap a project to expand…" footnote is DELETED (copy.md — the
 * affordance teaches itself).
 *
 * THE DEFAULT FOLDER (R116-k, verdict #52): every open starts from a
 * REMEMBERED default — the last successfully-created project's parent dir
 * (AsyncStorage "acute.default-project-dir"; the server home when none
 * is stored or the stored dir went stale) — and every open RESETS the
 * browse state: a cancelled sheet never reopens wherever the user left
 * off.
 *
 * LIVE (R113-e): the events store drives the reloads — hello (the resync)
 * and the debounced session-frame batches bump the epochs this screen keys
 * its refetches on, so a project created on the PC appears here the moment
 * it exists and the count badges follow every turn.
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
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  ChevronRight,
  ChevronUp,
  Folder,
  FolderGit2,
  FolderPlus,
  Plus,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { LetterAvatar } from "@/components/letter-avatar";
import { EmptyState, ErrorState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  Chip,
  PressableCard,
  QuietButton,
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
import { RADIUS_INPUT, TOUCH_TARGET, fontFamily, mixHex, spacing } from "@/design/tokens";
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
import {
  breadcrumbSegments,
  clearDefaultProjectDir,
  fetchFsBrowse,
  loadDefaultProjectDir,
  parentDirOf,
  saveDefaultProjectDir,
  shortRootPath,
  type FsBrowseReply,
} from "@/features/fs-browse";
import { mobLog, mobWarn } from "@/lib/log";

/** The client-side fold limit (the sessions route has NO server-side
 * projectId filter — the phone folds the recent list itself). */
const SESSION_FOLD_LIMIT = 200;

/** How many sessions the accordion renders before the "+N more" reveal. */
const EXPAND_PREVIEW = 8;

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
  // count badges and the accordion's rows (failure stays quiet: decoration,
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
          <EmptyState
            Icon={FolderGit2}
            title="No projects yet."
            caption="Pick a folder on the desktop to begin."
          />
          {/* The New action lives at the list's BOTTOM (screen-archetypes
              §2) — half width, quiet, no description, no chevron. */}
          <NewProjectActionRow onPress={() => setNewProjectOpen(true)} />
        </>
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
              sessions={sessionsByProject[project.id] ?? []}
              expanded={expanded !== null && expanded.id === project.id}
              full={expanded !== null && expanded.id === project.id && expanded.full}
              onToggle={() => toggleExpand(project.id)}
              onRevealAll={() => revealAll(project.id)}
              onNewSession={() => setSessionSheetProject(project)}
              onOpenSession={(row) => router.push(`/session/${row.id}`)}
            />
          ))}
          <NewProjectActionRow onPress={() => setNewProjectOpen(true)} />
        </>
      )}

      {/* ── the New Project sheet: ONE question — which folder ── */}
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

// ── the New Project action (the list's bottom — half width, quiet) ─────────

function NewProjectActionRow({ onPress }: { onPress: () => void }) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityLabel="New project"
      accessibilityRole="button"
      testID="projects-new-project"
      onPress={onPress}
      style={({ pressed }) => [
        styles.newProjectAction,
        {
          borderColor: pressed ? tokens.borderStrong : tokens.border,
          backgroundColor: pressed ? tokens.subtle : "transparent",
        },
      ]}
    >
      <FolderPlus size={20} color={tokens.accent} strokeWidth={2.2} />
      <TypeBodyStrong style={{ color: tokens.textSecondary }}>New project</TypeBodyStrong>
    </Pressable>
  );
}

// ── the accordion (the house spring on height + opacity) ───────────────────

/**
 * The inline expansion — height + opacity under the ONE spring.
 *
 * R115-h — THE YOGA FIX (donts #10): the clip View carries overflow:hidden
 * ONLY (no static height — it raced the animated value AND made Yoga clamp
 * the relative auto-height child to 0, so onLayout reported 0 forever and
 * the spring target never left 0). The measurement child is ABSOLUTE
 * (top/left/right 0): it lays out at its NATURAL height even while the
 * parent clips at 0, so the measured height is always the real number.
 * The content stays mounted (always measured) — a live refetch while open
 * re-measures and re-springs to the fresh height, and the "+N more"
 * reveal lands the same way.
 */
function Accordion({ open, children }: { open: boolean; children: React.ReactNode }) {
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);
  // The measured natural height — a SHARED VALUE so the toggle effect
  // reads the FRESH number whenever it fires.
  const contentHeight = useSharedValue(0);

  useEffect(() => {
    height.value = withSpring(open ? contentHeight.value : 0, SPRING);
    opacity.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, height, opacity, contentHeight]);

  const style = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured <= 0) return;
    contentHeight.value = measured;
    // An OPEN panel whose content re-measured springs to the new height;
    // a CLOSED one just records it for the next toggle.
    if (open) height.value = withSpring(measured, SPRING);
  };

  return (
    <Animated.View style={[styles.accordionClip, style]}>
      {/* The ABSOLUTE measurement child — auto height at any clip height
          (collapsable={false} keeps RN from folding it out of the tree). */}
      <View collapsable={false} onLayout={onLayout} style={styles.accordionMeasure}>
        {children}
      </View>
    </Animated.View>
  );
}

// ── the project row (identity + the inline session expansion) ──────────────

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
  // The New-session button's accent tint — wave-J's add-action idiom (the
  // accent softened onto the card surface; a full-strength accent border
  // on a full-width row would shout).
  const newSessionTint = mixHex(tokens.accent, tokens.card, 0.55);

  const visible = full ? sessions : sessions.slice(0, EXPAND_PREVIEW);
  const hidden = sessions.length - visible.length;

  return (
    <PressableCard
      onPress={onToggle}
      enterIndex={Math.min(index, 12)}
      accessibilityLabel={`Project ${project.name}${stats !== undefined ? `, ${stats.total} session${stats.total === 1 ? "" : "s"}` : ""}${running > 0 ? `, ${running} running` : ""}${expanded ? ", tap to collapse" : ", tap to expand"}`}
      accessibilityState={{ expanded }}
    >
      <View style={styles.rowInner}>
        <LetterAvatar label={project.name} color={project.color} />
        <View style={styles.rowMain}>
          <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
          {/* The path line orients by its TAIL — ellipsizeMode "head" dots
              the FRONT on residual overflow (R116-k, verdict #46: the bare
              numberOfLines default clamped the END, cutting the part that
              identifies the folder). TypeMono's prop surface carries no
              ellipsizeMode, so the mono line renders as a raw Text wearing
              TypeMono's token styling at 12px. */}
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            style={[styles.rootPath, { color: tokens.monoText, fontFamily: fontFamily.mono }]}
          >
            {shortRootPath(project.rootPath, project.name)}
          </Text>
        </View>
        {stats !== undefined ? (
          // The session count as a compact Badge — "3", or "{n} running"
          // in the running tone while a turn runs (the events store keeps
          // the fold live). Never a text line; never a second affordance —
          // and no chevron beside it (R116-k, verdict #44: the whole row
          // Pressable is the expand affordance).
          <Badge tone={running > 0 ? "running" : "neutral"} style={styles.countBadge}>
            {running > 0 ? `${running} running` : `${stats.total}`}
          </Badge>
        ) : null}
      </View>

      {/* ── the inline session expansion (R114-c) — R116-k: the fold is
          its own INSET REGION (a subtle-tinted, hairline-bordered panel
          floating inside the card), not a bare top border on the card's
          tail. ── */}
      <Accordion open={expanded}>
        <View
          style={[styles.sessionsWell, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}
        >
          {visible.length === 0 ? (
            <View style={styles.sessionsEmpty}>
              <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
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
              <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                +{hidden} more sessions
              </TypeMicro>
            </Pressable>
          ) : null}
          {/* The well's closing action (R116-k, verdict #51): a proper
              quiet BUTTON — full-width, the wave-J add-action's outlined
              accent tint + press grammar (scale + tint), separated from
              the session rows above. */}
          <Pressable
            accessibilityLabel={`Start a new session in ${project.name}`}
            accessibilityRole="button"
            onPress={onNewSession}
            testID="new-session-row"
            style={({ pressed }) => [
              styles.newSessionRow,
              {
                borderColor: pressed ? tokens.accent : newSessionTint,
                backgroundColor: pressed ? tokens.subtleHover : "transparent",
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            <Plus size={16} color={tokens.accent} strokeWidth={2.4} />
            <TypeBodyStrong numberOfLines={1} style={{ color: tokens.accent }}>
              New session
            </TypeBodyStrong>
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
  const label = sessionStatusLabel(row.status);
  const updatedMs = new Date(row.updatedAt).getTime();
  const updated = Number.isFinite(updatedMs) ? timeAgoShort(updatedMs) : "";

  return (
    <Pressable
      accessibilityLabel={`Session ${sessionTitle(row)}, ${label}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.sessionRow,
        // subtleHover — a step ABOVE the well's subtle tint, so the pressed
        // row still reads on the tinted surface (R116-k).
        { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
      ]}
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
      {/* The status Badge only when it says something (R116-k, verdict
          #49): an OPEN session carries its title + time — a badge there
          would read as decoration; running/done/stopped/failed still
          badge (with the live dot when a turn runs). */}
      {label === "open" ? null : <Badge tone={running ? "running" : tone}>{label}</Badge>}
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

// ── the New Project sheet (ONE question: which folder) ──────────────────────

/** The project name DERIVED from the chosen folder — its basename
 * (components.md: "Derived data is derived, never asked"). */
function folderBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter((part) => part !== "");
  return parts.length > 0 ? (parts[parts.length - 1] as string) : normalized;
}

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
  // The ONE question: WHICH FOLDER. `root` null = browsing; a string = the
  // selected folder. The name is the folder's basename (derived, never
  // asked); the color is the server's own (never asked).
  const [root, setRoot] = useState<string | null>(null);
  // The power-user escape hatch — collapsed by default, ONE line when open.
  const [manual, setManual] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [browse, setBrowse] = useState<FsBrowseReply | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Blank path = the SERVER's home directory — the browse's fallback
  // start (the remembered default, when one is stored, seeds ahead of it).
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

  // The predetermined start (R116-k, verdict #52): the REMEMBERED default
  // dir — the last successfully-created project's parent — with the server
  // home as the fallback when none is stored; a STALE remembered dir
  // (moved or deleted on the desktop) forgets itself and falls back home
  // too, so the sheet is never trapped at a dead path.
  const seedBrowse = useCallback(async () => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const stored = await loadDefaultProjectDir();
      if (stored !== null) {
        const outcome = await fetchFsBrowse(getLinkManager(), stored);
        if (outcome.ok) {
          setBrowse(outcome.data);
          mobLog("fs-browse", "seeded from the remembered default", {
            path: outcome.data.path,
            entries: outcome.data.entries.length,
          });
          return;
        }
        mobWarn("fs-browse", "default dir stale — falling back to the home browse", {
          status: outcome.error.status,
        });
        void clearDefaultProjectDir();
      }
      await browseTo();
    } catch {
      setBrowseError("the host is offline — browsing resumes when it returns");
      mobWarn("fs-browse", "threw");
    } finally {
      setBrowseLoading(false);
    }
  }, [browseTo]);

  // Every open starts FRESH (R116-k): the full browse state resets — a
  // cancelled sheet never reopens wherever the user left off — and the
  // browse re-seeds from the predetermined start.
  useEffect(() => {
    if (!open) return;
    setRoot(null);
    setManual(false);
    setManualPath("");
    setBrowse(null);
    setBrowseError(null);
    setError(null);
    void seedBrowse();
  }, [open, seedBrowse]);

  // The folder list — dirs only (this is a FOLDER picker; the route already
  // sorts dirs first, each alphabetical).
  const dirs = useMemo(() => browse?.entries.filter((entry) => entry.dir) ?? [], [browse]);
  const crumbs = useMemo(() => (browse === null ? [] : breadcrumbSegments(browse.path)), [browse]);

  // The selection commit — shared by "Use this folder" and the manual path's
  // return key. Selecting collapses the manual disclosure (answered).
  const selectFolder = useCallback((path: string) => {
    void selectionHaptic();
    setRoot(path);
    setManual(false);
  }, []);

  const onCreate = useCallback(async () => {
    if (busy || root === null) return;
    const trimmedRoot = root.trim();
    // The name is DERIVED from the folder; the color rides unset (the
    // server picks its own) — neither is ever asked.
    const body = newProjectBody(folderBasename(trimmedRoot), trimmedRoot);
    if (body === null) {
      setError("an absolute folder path is required");
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
        // Remember the created project's PARENT dir as the next sheet's
        // predetermined start (R116-k) — best-effort; a path with no
        // parent (a bare root) simply doesn't store.
        const parent = parentDirOf(outcome.data.rootPath);
        if (parent !== null) void saveDefaultProjectDir(parent);
        // The next open's reset + re-seed owns the browse state now.
        onCreated();
      } else {
        mobWarn("projects", "project create failed", {
          status: outcome.error.status,
          code: outcome.error.code,
        });
        void warningHaptic();
        // The route names the field (the folder doesn't exist / a project
        // already uses it) — surface it inline, honestly.
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("projects", "project create threw");
      void warningHaptic();
      setError("the host is offline — the project was not created");
    } finally {
      setBusy(false);
    }
  }, [busy, root, onCreated]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New project"
      testID="new-project-sheet"
      maxHeightFraction={0.86}
    >
      {root !== null ? (
        // ── the SELECTED state: the FULL path as a mono chip (its own
        // block) + "Select another folder" + the separate primary ──
        <View style={styles.fieldGap}>
          <View style={[styles.chosenRoot, { borderColor: tokens.borderSubtle, backgroundColor: tokens.inputBg }]}>
            <TypeMono numberOfLines={2} style={styles.chosenRootText}>
              {root}
            </TypeMono>
          </View>
          <QuietButton
            onPress={() => {
              void selectionHaptic();
              setRoot(null);
            }}
            testID="new-project-select-another"
          >
            Select another folder
          </QuietButton>
          {error !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {error}
            </TypeCaption>
          ) : null}
          <ChromeButton
            onPress={() => void onCreate()}
            disabled={busy}
            accessibilityLabel={busy ? "Creating the project" : "Create the project"}
            testID="new-project-create"
          >
            {busy ? "creating…" : "Create the project"}
          </ChromeButton>
        </View>
      ) : (
        // ── the BROWSE state: breadcrumbs + the dirs list + the confirm ──
        <View style={styles.fieldGap}>
          <View style={styles.browserWrap}>
            {/* the breadcrumb row — the current path, every crumb tappable;
                the Up affordance hides at the navigation cap (parent null —
                the server pins it AT the user's home dir, never past) */}
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
                    no subfolders here — use this folder
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
                if (browse !== null) selectFolder(browse.path);
              }}
              testID="new-project-use-folder"
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
          </View>

          {/* the power-user escape hatch — collapsed by default, ONE line
              when open; the keyboard's return key commits the path */}
          <View style={styles.fieldWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: manual }}
              onPress={() => setManual((prev) => !prev)}
              hitSlop={8}
              testID="new-project-manual-toggle"
            >
              <TypeMicro style={{ color: tokens.accent }}>
                {manual ? "Hide the path field" : "Type a path instead"}
              </TypeMicro>
            </Pressable>
            {manual ? (
              <TextInput
                accessibilityLabel="Project root folder path"
                placeholder={browse?.path ?? "/home/z/repos/acute-code"}
                placeholderTextColor={tokens.textTertiary}
                value={manualPath}
                onChangeText={setManualPath}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                returnKeyType="done"
                onSubmitEditing={() => {
                  const trimmed = manualPath.trim();
                  if (trimmed !== "") selectFolder(trimmed);
                }}
                style={[
                  styles.fieldInput,
                  styles.fieldMono,
                  { color: tokens.text, borderColor: tokens.inputBorder, backgroundColor: tokens.inputBg },
                ]}
              />
            ) : null}
          </View>
        </View>
      )}
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
          // The context row — the project's letter avatar (donts #15: the
          // colored dot is retired) + name + the smart path.
          <View style={styles.sheetProjectRow}>
            <LetterAvatar label={project.name} color={project.color} size={36} />
            <View style={styles.sheetProjectText}>
              <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
              <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
                {shortRootPath(project.rootPath, project.name)}
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
  // ── the project row: [avatar 40] [label + ONE meta line] [badge] ──
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 68,
  },
  rowMain: { flex: 1, gap: 3 },
  /** The mono-12 path line — a raw Text (TypeMono's prop surface carries
   * no ellipsizeMode) wearing TypeMono's token styling at 12px; the color
   * + mono family ride the inline token pair. */
  rootPath: { fontSize: 12, lineHeight: 19 },
  countBadge: { alignSelf: "center" },

  // ── the New Project action (the list's bottom — half width, CENTERED) ──
  newProjectAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    width: "48%",
    alignSelf: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    minHeight: TOUCH_TARGET + 2,
    paddingHorizontal: spacing.lg,
  },

  // ── the accordion (R115-h: overflow ONLY — no static height) ──
  accordionClip: { overflow: "hidden" },
  /** The ABSOLUTE measurement child — natural height at any clip height. */
  accordionMeasure: { position: "absolute", top: 0, left: 0, right: 0 },
  /** The fold's INSET REGION (R116-k, verdict #48): its own surface — the
   * subtle tint + hairline borderSubtle frame (inline token pair),
   * RADIUS_INPUT corners, sm margins so the frame floats inside the card
   * (the project row above keeps its own card identity), sm inner padding
   * + xs gaps so the rows breathe. */
  sessionsWell: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  sessionsEmpty: { padding: spacing.md },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    // FLUSH LEFT (R116-k, verdict #50) — no paddingLeft: the rows sit at
    // the well's edge; only the right side pads.
    paddingRight: spacing.lg,
    minHeight: 48,
  },
  sessionMain: { flex: 1, gap: 2 },
  sessionTitle: { fontWeight: "600", fontSize: 14 },
  sessionMeta: { flexDirection: "row", gap: 4, alignItems: "center", flexWrap: "wrap" },
  moreRow: {
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  /** The well's New-session BUTTON (R116-k, verdict #51): full-width,
   * 48px, RADIUS_INPUT, the accent-tinted outline (wave-J's add-action
   * grammar) — the tint + pressed colors ride the inline token pair, xs
   * top margin separates it from the session rows. */
  newSessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },

  // ── the shared sheet fields (the New Session sheet + the manual path) ──
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
