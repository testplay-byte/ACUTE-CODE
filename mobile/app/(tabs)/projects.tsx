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
 * THE NEW PROJECT ACTION (R118-E §2C1 — the centered CTA law): the
 * list's bottom AND the empty state both carry the self-sized centered
 * ChromeButton (minWidth PAGE_CTA_MIN_W) — the old half-width outlined
 * NewProjectActionRow is DELETED. Its sheet asks ONE question
 * (components.md): WHICH FOLDER — the Name field and the Color swatches
 * are DEAD (donts #18: never ask for derivable data — the name is the
 * folder's basename, the color is the server's own). The folder browser
 * (breadcrumbs + the dirs list + the home cap: the server pins parent
 * null AT the user's home dir, and the client hides Up whenever parent
 * === null) + the CREATE-FOLDER first row (R118-E §2D: FolderPlus
 * "Create a folder here" → the inline mono namer with Check/X circles →
 * create → AUTO-SELECT the new folder, one tap from "create" to
 * "selected") + the collapsed "Type a path instead" disclosure for
 * power users (the manual path rides ClayInput mono — the R118-A field
 * law — and the keyboard-aware sheet rides the IME). Once "Use this
 * folder" is tapped: the FULL path as a mono chip + "Select another
 * folder" (the centered quiet escape) + the separate "Create the project"
 * centered primary. The old "tap a project to expand…" footnote is
 * DELETED (copy.md — the affordance teaches itself).
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
 *
 * R118-E §2C2 — THE SESSIONS WELL + ROWS: the well is the recessed surface
 * (surfaceWell + the hairline clayRim, RADIUS_INPUT, sm margins,
 * paddingVertical xs, gap 0 — the DIVIDERS own the rhythm) and the rows
 * carry the model NAME (cleanModelName of the session's selectedModel) in
 * the meta line; the 1dp inset dividers ride the STRONG recipe (the
 * dashboard's recessed-well spelling — one spelling everywhere).
 *
 * ROUND-120 (R120-P — the owner's §G list polish, items 24-27): item 24 —
 * "Type a path instead" is the sheet's OPTION-ROW family now (Keyboard 16 +
 * the accentDeep label + the subtle press fill — "Create a folder here"'s
 * own grammar, a real 46dp bordered target, never a bare text micro-line).
 * Item 25 — every session row carries the ClayIconChip identity glyph on
 * the left (MessageSquare 17, the house tinted chip — the row reads as a
 * SESSION before its first line is parsed). Item 26 — the New session CTA
 * owns its own TIER: the R118-B strong inset rule breaks it out of the row
 * rhythm, md over / sm under. Item 27 — the ODD session rows carry the
 * resting `subtle` wash (4% ink, a step below the subtleHover press tier)
 * so consecutive sessions stay distinguishable. (Item 23 — the sheet
 * ANIMATIONS — rides the shared Sheet primitive; Track S owns this round's
 * sheet-motion retune and the projects flow inherits it at merge.)
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
  Check,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderGit2,
  FolderPlus,
  Keyboard,
  MessageSquare,
  X,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { LetterAvatar } from "@/components/letter-avatar";
import { EmptyState, ErrorState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  ClayIconChip,
  ClayInput,
  Hairline,
  PressableCard,
  QuietButton,
  SegmentedControl,
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
import {
  fontFamily,
  PAGE_CTA_MIN_W,
  RADIUS_INPUT,
  SHEET_CTA_MIN_W,
  spacing,
  TOUCH_TARGET,
} from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useEventsEpoch } from "@/features/events";
import { timeAgoShort } from "@/lib/time-ago";
import {
  cleanModelName,
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
  createFsFolder,
  fetchFsBrowse,
  folderNameValid,
  loadDefaultProjectDir,
  nextBrowseAfterCreate,
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
              §2) — R118-E §2C1: the self-sized centered CTA (the house
              grammar, the same law as every page CTA). */}
          <ChromeButton
            onPress={() => setNewProjectOpen(true)}
            accessibilityLabel="New project"
            testID="projects-new-project"
            style={styles.pageCta}
          >
            New project
          </ChromeButton>
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
          <ChromeButton
            onPress={() => setNewProjectOpen(true)}
            accessibilityLabel="New project"
            testID="projects-new-project"
            style={styles.pageCta}
          >
            New project
          </ChromeButton>
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

      {/* ── the inline session expansion (R114-c) — R118-E §2C2: the fold
          is the RECESSED WELL (surfaceWell + the hairline clayRim,
          RADIUS_INPUT, sm margins, paddingVertical xs, gap 0 — the 1dp
          inset dividers own the rows' rhythm) floating inside the card,
          closed by the centered New-session CTA. ── */}
      <Accordion open={expanded}>
        <View style={[styles.sessionsWell, { backgroundColor: tokens.surfaceWell, borderColor: tokens.clayRim }]}>
          {visible.length === 0 ? (
            <View style={styles.sessionsEmpty}>
              <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
                no sessions yet — start one below
              </TypeCaption>
            </View>
          ) : (
            visible.map((row, index) => (
              <View key={row.id}>
                {/* The 1dp inset divider between rows — the STRONG recipe
                    (borderStrong, inset md — the dashboard's recessed-well
                    spelling; one spelling everywhere). */}
                {index > 0 ? <Hairline strong inset={spacing.md} /> : null}
                <SessionRow row={row} shaded={index % 2 === 1} onOpen={() => onOpenSession(row)} />
              </View>
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
          {/* ── ROUND-120 (why): ── the owner's item 26 — "The New Session
              button needs more separation from the session list": the R118-B
              STRONG inset rule is the visible TIER BREAK between the
              session rows and the well's closing action (the divider law's
              own "visible break between tiers" arm — the CTA is not a row),
              and the CTA's own margins grew with it (md above, sm below —
              the closing action finally reads as its own group, not the
              last row's tailgater). */}
          <Hairline strong inset={spacing.md} />
          {/* R118-E §2C3 — the well's closing action is the centered CTA
              (the tinted full-width row is deleted; same grammar as every
              page CTA, minWidth 200). */}
          <ChromeButton
            onPress={onNewSession}
            accessibilityLabel={`Start a new session in ${project.name}`}
            testID="new-session-row"
            style={styles.wellCta}
          >
            New session
          </ChromeButton>
        </View>
      </Accordion>
    </PressableCard>
  );
}

// ── the compact session row (inside the expansion) ──────────────────────────

function SessionRow({
  row,
  shaded,
  onOpen,
}: {
  row: SessionRow;
  /** ── ROUND-120 (why): ── the owner's item 27 — "Each session row gets a
   *  slight shade/tint so consecutive sessions are distinguishable": the
   *  ODD rows carry the resting `subtle` wash (4% ink — a step BELOW the
   *  subtleHover press tier, so pressing a tinted row still reads). */
  shaded: boolean;
  onOpen: () => void;
}) {
  const { tokens } = useTheme();
  const tone = sessionStatusTone(row.status);
  const running = isTurnRunning(row);
  const label = sessionStatusLabel(row.status);
  const updatedMs = new Date(row.updatedAt).getTime();
  const updated = Number.isFinite(updatedMs) ? timeAgoShort(updatedMs) : "";
  // R118-E §2C2 — the meta line finally says WHICH MODEL: the session's
  // selected-model NAME (cleanModelName — never the raw id), then the time
  // (+ the sub-role) in tertiary. A session following the agent default
  // shows the time only, honestly (no invented model).
  const modelName = row.selectedModel !== null ? cleanModelName(row.selectedModel.model) : null;
  const subRole = row.subRole !== null && row.subRole !== "" ? row.subRole : null;
  const rest = [updated, subRole].filter((part) => part !== "").join(" · ");

  return (
    <Pressable
      accessibilityLabel={`Session ${sessionTitle(row)}, ${label}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.sessionRow,
        // subtleHover — a step ABOVE both the well's surfaceWell tint and
        // the R120-P alternating shade, so the pressed row still reads on
        // the recessed surface (R116-k).
        {
          backgroundColor: pressed
            ? tokens.subtleHover
            : shaded
              ? tokens.subtle
              : "transparent",
        },
      ]}
    >
      {/* ── ROUND-120 (why): ── the owner's item 25 — "Each session row gets
          an icon on the left": the ClayIconChip — the house identity chip
          for list rows (round-117-elevation §2.2: accentTint fill + clayRim
          hairline + clayShadowSm, the accentDeep glyph) — carrying the
          chat/session glyph. The row reads as a SESSION before its first
          line is parsed. */}
      <ClayIconChip icon={MessageSquare} iconSize={17} />
      <View style={styles.sessionMain}>
        <TypeBody numberOfLines={1} style={styles.sessionTitle}>
          {sessionTitle(row)}
        </TypeBody>
        <View style={styles.sessionMeta}>
          {running ? <StatusDot color={tokens.running} pulse size={6} /> : null}
          {modelName !== null ? (
            <TypeMicro numberOfLines={1} style={{ color: tokens.textSecondary }}>
              {modelName}
            </TypeMicro>
          ) : null}
          {rest !== "" ? (
            <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
              {`${modelName !== null ? " · " : ""}${rest}`}
            </TypeMicro>
          ) : null}
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
  // R118-E §2D — the CREATE-FOLDER state: `creating` = the inline namer is
  // open in the folder list's first row; `createName`/`createBusy`/
  // `createError` are the namer's own truth. Reset on every browse
  // navigation + sheet open (a stale namer must never follow the user into
  // another directory).
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const resetCreateState = useCallback(() => {
    setCreating(false);
    setCreateName("");
    setCreateBusy(false);
    setCreateError(null);
  }, []);

  // Blank path = the SERVER's home directory — the browse's fallback
  // start (the remembered default, when one is stored, seeds ahead of it).
  const browseTo = useCallback(
    async (path?: string) => {
      resetCreateState();
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
    },
    [resetCreateState],
  );

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
  // browse re-seeds from the predetermined start (R118-E: the namer's state
  // dies with it).
  useEffect(() => {
    if (!open) return;
    setRoot(null);
    setManual(false);
    setManualPath("");
    setBrowse(null);
    setBrowseError(null);
    setError(null);
    resetCreateState();
    void seedBrowse();
  }, [open, seedBrowse, resetCreateState]);

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

  // ── R118-E §2D — CREATE + SELECT: one tap from "create" to "selected".
  // folderNameValid pre-refuses (the route enforces the same rules); a 201
  // answers the success haptic, flips the sheet to the SELECTED state on
  // the REPLY's path, plants the new entry in the listing optimistically
  // (dirs-first alphabetical), and re-browses the parent in the background
  // so a fast "Select another folder" tap lands on the reconciled truth.
  const onCreateFolder = useCallback(async () => {
    if (createBusy || browse === null) return;
    const check = folderNameValid(createName);
    if (!check.ok) {
      setCreateError(check.message);
      void warningHaptic();
      return;
    }
    const parentPath = browse.path;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const outcome = await createFsFolder(getLinkManager(), parentPath, check.name);
      if (outcome.ok) {
        mobLog("fs-browse", "folder created", { path: outcome.data.path });
        void successHaptic();
        setBrowse((prev) => (prev === null ? prev : nextBrowseAfterCreate(prev, outcome.data)));
        setCreating(false);
        setCreateName("");
        selectFolder(outcome.data.path);
        void browseTo(parentPath);
        return;
      }
      // The honest one-line errors — the namer renders each verbatim.
      if (outcome.error.status === 409) {
        setCreateError("a folder with that name already exists");
      } else if (outcome.error.status === 404) {
        // The parent exists by construction (we are browsing it) — a 404
        // here is the ROUTE itself missing: an older desktop build.
        setCreateError("this desktop's build lacks folder creation — update it, or type the path instead");
        mobWarn("fs-browse", "mkdir route missing (older sidecar?)", { status: 404 });
      } else {
        setCreateError(outcome.error.message);
      }
      void warningHaptic();
      mobWarn("fs-browse", "mkdir failed", {
        status: outcome.error.status,
        code: outcome.error.code,
      });
    } catch {
      setCreateError("the host is offline — the folder was not created");
      void warningHaptic();
      mobWarn("fs-browse", "mkdir threw");
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, browse, createName, selectFolder, browseTo]);

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
        // block) + the centered quiet escape + the separate centered
        // primary (R118-A's CTA law) ──
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
            style={styles.sheetQuiet}
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
            style={styles.sheetCta}
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
              ) : (
                <>
                  {/* R118-E §2D — the CREATE-FOLDER first row, rendered
                      whenever the browse loaded (including the empty
                      state): collapsed it is the 46px affordance; tapped it
                      EXPANDS IN PLACE into the inline mono namer (no sheet)
                      with the Check/X circle pair; the hairline separates it
                      from the dirs below. */}
                  {browse !== null ? (
                    creating ? (
                      <View style={styles.createNamerZone}>
                        <View style={styles.createNamerRow}>
                          <TextInput
                            accessibilityLabel="New folder name"
                            placeholder="folder name"
                            placeholderTextColor={tokens.textTertiary}
                            value={createName}
                            onChangeText={setCreateName}
                            autoFocus
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="done"
                            onSubmitEditing={() => void onCreateFolder()}
                            style={[
                              styles.namerInput,
                              {
                                color: tokens.text,
                                borderColor: tokens.inputBorder,
                                backgroundColor: tokens.inputBg,
                                fontFamily: fontFamily.mono,
                              },
                            ]}
                          />
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={createBusy ? "Creating the folder" : "Create the folder"}
                            accessibilityState={{ disabled: createBusy }}
                            disabled={createBusy}
                            onPress={() => void onCreateFolder()}
                            testID="new-project-create-folder-confirm"
                            style={({ pressed }) => [
                              styles.namerConfirm,
                              { backgroundColor: pressed ? tokens.accent : tokens.accentDeep },
                            ]}
                          >
                            {createBusy ? (
                              <ActivityIndicator size="small" color={tokens.accentText} />
                            ) : (
                              <Check size={18} color={tokens.accentText} strokeWidth={2.4} />
                            )}
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Cancel creating a folder"
                            disabled={createBusy}
                            onPress={() => {
                              void selectionHaptic();
                              setCreating(false);
                              setCreateName("");
                              setCreateError(null);
                            }}
                            testID="new-project-create-folder-cancel"
                            style={({ pressed }) => [
                              styles.namerCancel,
                              { backgroundColor: pressed ? tokens.subtleHover : tokens.subtle },
                            ]}
                          >
                            <X size={16} color={tokens.textSecondary} strokeWidth={2.4} />
                          </Pressable>
                        </View>
                        {createError !== null ? (
                          <TypeCaption numberOfLines={1} style={{ color: tokens.danger }}>
                            {createError}
                          </TypeCaption>
                        ) : null}
                      </View>
                    ) : (
                      <View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Create a folder inside ${
                            crumbs.length > 0 ? crumbs[crumbs.length - 1]!.label : browse.path
                          }`}
                          onPress={() => {
                            void selectionHaptic();
                            setCreating(true);
                            setCreateError(null);
                          }}
                          testID="new-project-create-folder"
                          style={({ pressed }) => [
                            styles.createRow,
                            { backgroundColor: pressed ? tokens.subtle : "transparent" },
                          ]}
                        >
                          <FolderPlus size={16} color={tokens.accentDeep} strokeWidth={2.2} />
                          <TypeBody numberOfLines={1} style={[styles.createRowLabel, { color: tokens.accentDeep }]}>
                            Create a folder here
                          </TypeBody>
                        </Pressable>
                      </View>
                    )
                  ) : null}
                  <Hairline />
                  {dirs.length === 0 ? (
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
                </>
              )}
            </View>
            {browse?.truncated === true ? (
              <TypeMicro style={{ color: tokens.textTertiary }}>
                showing the first 400 entries
              </TypeMicro>
            ) : null}

            {/* the confirm — locks the current browse path in (R118-E
                §2E: the centered ChromeButton CTA; the keyboard-aware
                sheet rides the IME) */}
            <ChromeButton
              onPress={() => {
                if (browse !== null) selectFolder(browse.path);
              }}
              disabled={browse === null}
              accessibilityLabel="Use this folder as the project root"
              testID="new-project-use-folder"
              style={styles.sheetCta}
            >
              Use this folder
            </ChromeButton>
          </View>

          {/* the power-user escape hatch — collapsed by default, ONE line
              when open; the keyboard's return key commits the path. The
              manual field rides ClayInput mono (R118-A's field law: label +
              input, NO caption — the focus ring comes with it).
              ── ROUND-120 (why): ── the owner's item 24 — "'Type a path
              instead' reads like plain dead text — highlight it as a real
              option": the affordance is the sheet's own OPTION-ROW family
              (the "Create a folder here" grammar — icon + accentDeep label
              + the subtle press fill), the Keyboard glyph the house already
              uses for "type it in instead" (the connect flow's manual
              pairing). A real bordered target at 46dp, never a bare text
              micro-line. */}
          <View style={styles.fieldWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: manual }}
              onPress={() => setManual((prev) => !prev)}
              testID="new-project-manual-toggle"
              style={({ pressed }) => [
                styles.pathOptionRow,
                {
                  backgroundColor: pressed ? tokens.subtle : "transparent",
                  borderColor: tokens.borderSubtle,
                },
              ]}
            >
              <Keyboard size={16} color={tokens.accentDeep} strokeWidth={2.2} />
              <TypeBody numberOfLines={1} style={[styles.pathOptionLabel, { color: tokens.accentDeep }]}>
                {manual ? "Hide the path field" : "Type a path instead"}
              </TypeBody>
            </Pressable>
            {manual ? (
              <ClayInput
                label="Folder path"
                mono
                accessibilityLabel="Project root folder path"
                placeholder={browse?.path ?? "/home/z/repos/acute-code"}
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
              />
            ) : null}
          </View>
        </View>
      )}
    </Sheet>
  );
}

// ── the New Session sheet (optional name + the operating mode) ──────────────

/** The operating modes' copy — the session screen's ModeSwitcher
 *  semantics. R118-A: the full names ride the a11y labels of the
 *  SegmentedControl's three-on-one-line options; the caption under the
 *  row is GONE. */
const SESSION_MODES: ReadonlyArray<{
  id: "full" | "ask" | "plan";
  label: string;
  accessibilityLabel: string;
}> = [
  { id: "full", label: "Full", accessibilityLabel: "Full — runs without asking" },
  { id: "ask", label: "Ask", accessibilityLabel: "Ask — asks before acting" },
  { id: "plan", label: "Plan", accessibilityLabel: "Plan — writes a plan first" },
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

        {/* R118-A — the house field: ClayInput with label, NO caption (the
            placeholder carries the auto-title truth). */}
        <ClayInput
          label="Name"
          accessibilityLabel="Session name"
          placeholder="auto-titled from the first message"
          value={name}
          onChangeText={setName}
          autoCapitalize="sentences"
          autoCorrect
        />

        <View style={styles.fieldWrap}>
          <TypeCaption style={styles.fieldLabel}>Operating mode</TypeCaption>
          {/* R118-A — the mode selector is the shared SegmentedControl
              (Full/Ask/Plan on one line; the a11y labels carry the
              semantics the old caption spelled out). */}
          <SegmentedControl
            options={SESSION_MODES}
            selectedId={mode}
            onSelect={(id) => {
              void selectionHaptic();
              setMode(id);
            }}
            testID="new-session-mode"
          />
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
          style={styles.sheetCta}
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

  /** R118-E §2C1 — the page-level CTA law: centered, self-sized, minWidth
   *  200 (supersedes the half-width outlined NewProjectActionRow). */
  pageCta: { alignSelf: "center", minWidth: PAGE_CTA_MIN_W },
  /** R118-E §2C3 → R120-P — the same CTA grammar inside the sessions well:
   *  the owner's item 26 ("the New Session button needs more separation
   *  from the session list") grows the margins around the R118-B strong
   *  TIER BREAK above it — md over the rule, sm under the button, its own
   *  visual group. */
  wellCta: { alignSelf: "center", minWidth: PAGE_CTA_MIN_W, marginTop: spacing.md, marginBottom: spacing.sm },
  /** R118-A — the sheet CTA law: centered, self-sized, minWidth 200; the
   *  quiet escape centers beneath at its natural width. */
  sheetCta: { alignSelf: "center", minWidth: SHEET_CTA_MIN_W },
  sheetQuiet: { alignSelf: "center" },

  // ── the accordion (R115-h: overflow ONLY — no static height) ──
  accordionClip: { overflow: "hidden" },
  /** The ABSOLUTE measurement child — natural height at any clip height. */
  accordionMeasure: { position: "absolute", top: 0, left: 0, right: 0 },
  /** R118-E §2C2 — the fold's RECESSED WELL: surfaceWell + the hairline
   *  clayRim frame (inline token pair), RADIUS_INPUT corners, sm margins
   *  so the frame floats inside the card (the project row above keeps its
   *  own card identity), paddingVertical xs and gap 0 — the 1dp inset
   *  dividers between the rows own the rhythm. */
  sessionsWell: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
  },
  sessionsEmpty: { padding: spacing.md },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm + 2,
    minHeight: 52,
  },
  sessionMain: { flex: 1, gap: 2 },
  sessionTitle: { fontWeight: "600", fontSize: 14 },
  sessionMeta: { flexDirection: "row", gap: 4, alignItems: "center", flexWrap: "wrap" },
  /** R118-E §2C2 — the "+N more" reveal aligns with the rows above it
   *  (paddingLeft md, like the rows). */
  moreRow: {
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: "center",
  },

  // ── the shared sheet fields (the New Session sheet + the manual path) ──
  fieldGap: { gap: spacing.md, paddingTop: spacing.xs },
  fieldWrap: { gap: 6 },
  fieldLabel: { paddingLeft: spacing.xs },
  /** ── ROUND-120 (why): ── the owner's item 24 — the manual-path escape
   *  as the sheet's OPTION-ROW family ("Create a folder here"'s own
   *  grammar): 46 tall, hairline-bordered, RADIUS_INPUT corners so the
   *  affordance floats as its own chip-row target (a REAL option, never
   *  dead text). */
  pathOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 46,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pathOptionLabel: { fontSize: 14 },

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

  // ── R118-E §2D — the create-folder first row + the inline namer ──
  /** The collapsed affordance: 46 tall, FolderPlus 16 + TypeBody 14, both
   *  accentDeep (the inline token pair); a hairline separates it from the
   *  dirs below. */
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  createRowLabel: { fontSize: 14 },
  /** The inline namer: mono TextInput flex 1 (13px mono, the fieldInput
   *  surface, radius 14, minHeight 44) + the Check circle 36 (accentDeep)
   *  + the X quiet circle 36 (subtle); the error line sits under it. */
  createNamerZone: { gap: spacing.xs, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  createNamerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  namerInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 13,
    minHeight: 44,
  },
  namerConfirm: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  namerCancel: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── the New Session sheet ──
  sheetProjectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    paddingLeft: spacing.xs,
  },
  sheetProjectText: { flex: 1, gap: 2 },
});
