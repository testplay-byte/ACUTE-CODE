/**
 * Home v4 (R115-f — the honest home) — the List archetype, header-free root
 * (docs/design-language/android/02-patterns/screen-archetypes.md §2): one
 * quiet strip per truth, rows of two text lines max, nothing that fidgets.
 * Top → bottom:
 *
 *   · THE CONNECTION ROW — one compact PressableCard (the big hero is DEAD:
 *     version / last-seen / last-failure / retry all moved out — /connect
 *     owns retry now). Dot: live=success, probing=warning+pulse,
 *     offline=danger. Word: "Live" / "Looking for the host…" / "Offline"
 *     (copy.md's pinned vocabulary). Caption: the host's word-pair name
 *     (Wave E — hostLabel IS "Confused Coconut" now), so the row reads
 *     "Live · Confused Coconut"; offline appends "· messages will queue"
 *     (one line — the old banner folded into it). Tap → /connect.
 *   · THE ACTIVITY STRIP — only while unread > 0 (bell chip + "{n} unread"
 *     + chevron → /activity; no unread → no row, no noise).
 *   · HAPPENING NOW — the heart of the round: the host's RUNNING sessions
 *     (status === "running" straight off GET /sessions — the server's field
 *     is the only truth; up to 4) as rows: project letter avatar (TILE_ROW
 *     circle, the project's own color) + sessionTitle + "{projectName} ·
 *     {sessionStatusLabel}" + the Live badge → /session/{id}. Live-refreshed
 *     off the events epochs (hello + debounced session batches + project
 *     frames — the projects.tsx pattern). Empty → the section simply
 *     doesn't render (no empty state — quiet is the honest default).
 *   · RECENT ACTIVITY — the 4-row preview (read-state dot, title, timeAgo)
 *     + "see all"; the one-liner empty state.
 *
 * DELETED FOREVER (R115-f): the Appearance section + ThemeDots (the theme
 * lives in settings now), the Quick actions 2×2 grid, the unpaired
 * Scan/Enter card (the gate routes unpaired users to /connect as their
 * landing — home renders the one-liner card for the deep-link case only).
 */

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, ChevronRight, FolderGit2, MonitorSmartphone } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { LetterAvatar } from "@/components/letter-avatar";
import { timeAgo } from "@/components/host-card";
import {
  Badge,
  ClayCard,
  PressableCard,
  SectionHeader,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing, TILE_ROW } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useActivityFeed, useUnread } from "@/features/activity";
import { useEventsEpoch } from "@/features/events";
import { fetchProjects, type ProjectRow } from "@/features/config";
import {
  fetchSessions,
  sessionStatusLabel,
  sessionTitle,
  type SessionRow,
} from "@/features/sessions";
import { mobLog, mobWarn } from "@/lib/log";

/** The fold the sessions route serves (the same limit projects.tsx folds). */
const SESSION_FOLD_LIMIT = 200;

/** How many running sessions "Happening now" renders. */
const RUNNING_PREVIEW = 4;

/** How many notification rows the recent preview renders. */
const RECENT_PREVIEW = 4;

export default function HomeScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host } = useLink();
  const { state: activityState } = useActivityFeed();
  const unread = useUnread();
  const [, setTick] = useState(0);

  // ── the world: projects (identity) + sessions (what's running) ──
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [sessionRows, setSessionRows] = useState<SessionRow[] | null>(null);

  // ── the live epochs (the projects.tsx pattern): hello (the resync), a
  // debounced session-frame batch, or a project frame moves these — the
  // refetch effect below keys on them. ──
  const sessionsEpoch = useEventsEpoch("sessions");
  const projectsEpoch = useEventsEpoch("projects");
  // The MOUNT values — the refetch fires only when an epoch moves PAST its
  // mount value (the mount loads above own the first fetch).
  const mountEpochs = useRef({ sessions: sessionsEpoch, projects: projectsEpoch });

  // The honest relative clock — 30s (the recent rows' "5m ago").
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // The project registry — the letter avatars' colors + the caption names.
  // Failure stays quiet: identity is decoration here, never a failure state
  // (the connection row owns the link's truth).
  const loadProjects = useCallback(async () => {
    try {
      const outcome = await fetchProjects(getLinkManager());
      if (outcome.ok) {
        setProjects(outcome.data.projects);
        mobLog("home", "projects loaded", { count: outcome.data.projects.length });
      } else {
        mobWarn("home", "projects unavailable", { status: outcome.error.status });
      }
    } catch {
      mobWarn("home", "projects threw");
    }
  }, []);

  // The session fold — the same quiet 200 projects.tsx rides; a session
  // shows as "running" ONLY through the server's own status field.
  const loadSessions = useCallback(async () => {
    try {
      const outcome = await fetchSessions(getLinkManager(), { limit: SESSION_FOLD_LIMIT });
      if (outcome.ok) {
        setSessionRows(outcome.data.sessions);
        mobLog("home", "session fold loaded", { sessions: outcome.data.sessions.length });
      } else {
        mobWarn("home", "session fold unavailable", { status: outcome.error.status });
      }
    } catch {
      mobWarn("home", "session fold threw");
    }
  }, []);

  // Load on mount + every (re)connect.
  useEffect(() => {
    if (status !== "connected") return; // unpaired/offline stay quiet — the row carries it
    void loadProjects();
    void loadSessions();
  }, [status, loadProjects, loadSessions]);

  // R115-f: the live refetch — a hello (the resync sweep), a project frame,
  // or a debounced session-frame batch landed AFTER this screen mounted.
  useEffect(() => {
    if (sessionsEpoch === mountEpochs.current.sessions && projectsEpoch === mountEpochs.current.projects) return;
    if (status !== "connected") return;
    void loadProjects();
    void loadSessions();
  }, [sessionsEpoch, projectsEpoch, status, loadProjects, loadSessions]);

  const connected = status === "connected";
  const probing = status === "probing";
  const offline = !connected && !probing;

  // "Happening now" — the server's status field is the ONLY truth.
  const running = useMemo(
    () => (sessionRows ?? []).filter((row) => row.status === "running").slice(0, RUNNING_PREVIEW),
    [sessionRows],
  );
  const projectById = useMemo(() => {
    const map = new Map<string, ProjectRow>();
    for (const project of projects ?? []) map.set(project.id, project);
    return map;
  }, [projects]);

  // The connection row's pinned vocabulary (copy.md): the word + the
  // word-pair name read as one line — "Live · Confused Coconut".
  const statusWord = connected ? "Live" : probing ? "Looking for the host…" : "Offline";

  return (
    <ScreenScaffold title="ACUTE" chrome={false}>
      {host === null ? (
        // ── unpaired: the honest one-liner (the gate normally lands these
        //     users on /connect before home ever renders — this card is the
        //     deep-link case). One line, one destination. ──
        <PressableCard
          onPress={() => router.push("/connect")}
          accessibilityLabel="No desktop linked — open the connect screen"
          testID="home-unpaired"
        >
          <View style={styles.unpairedInner}>
            <MonitorSmartphone size={20} color={tokens.textTertiary} strokeWidth={2.2} />
            <TypeBodyStrong>No desktop linked</TypeBodyStrong>
            <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
          </View>
        </PressableCard>
      ) : (
        <>
          {/* ── the connection row — the whole link truth in one compact
              strip; tap → the connect hub (which owns retry). ── */}
          <PressableCard
            onPress={() => router.push("/connect")}
            enterIndex={0}
            accessibilityLabel={`${statusWord}, ${host.hostLabel}${offline ? ", messages will queue" : ""} — open connection settings`}
            testID="home-status"
          >
            <View style={styles.stripInner}>
              <StatusDot
                color={connected ? tokens.success : probing ? tokens.warning : tokens.danger}
                pulse={probing}
              />
              <View style={styles.stripText}>
                <TypeBodyStrong numberOfLines={1}>{statusWord}</TypeBodyStrong>
                <TypeCaption numberOfLines={1} style={styles.stripMeta}>
                  {`· ${host.hostLabel}${offline ? " · messages will queue" : ""}`}
                </TypeCaption>
              </View>
              <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
            </View>
          </PressableCard>

          {/* ── the activity strip — visible ONLY while something is unread
              (no unread → no row, no noise). ── */}
          {unread > 0 ? (
            <PressableCard
              onPress={() => router.push("/activity")}
              enterIndex={1}
              accessibilityLabel={`Activity, ${unread} unread notification${unread === 1 ? "" : "s"}`}
              testID="home-activity-strip"
            >
              <View style={styles.stripInner}>
                <View style={[styles.bellChip, { backgroundColor: tokens.subtleHover }]}>
                  <Bell size={17} color={tokens.accent} strokeWidth={2.2} />
                  <View
                    style={[styles.bellDot, { backgroundColor: tokens.accent }]}
                    accessibilityLabel={`${unread} unread`}
                  />
                </View>
                <View style={styles.stripText}>
                  <TypeBodyStrong numberOfLines={1}>Activity</TypeBodyStrong>
                  <TypeCaption numberOfLines={1} style={styles.stripMeta}>
                    {`· ${unread} unread`}
                  </TypeCaption>
                </View>
                <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
              </View>
            </PressableCard>
          ) : null}

          {/* ── "Happening now" — the host's running sessions; the section
              simply doesn't render when nothing runs (no empty state). ── */}
          {running.length > 0 ? (
            <>
              <SectionHeader>Happening now</SectionHeader>
              {running.map((row, i) => {
                const project =
                  row.projectId !== null ? (projectById.get(row.projectId) ?? null) : null;
                const title = sessionTitle(row);
                return (
                  <PressableCard
                    key={row.id}
                    onPress={() => router.push(`/session/${row.id}`)}
                    enterIndex={2 + i}
                    accessibilityLabel={`Session ${title}, ${sessionStatusLabel(row.status)}${project !== null ? `, ${project.name}` : ""}`}
                    testID={`home-running-${row.id}`}
                  >
                    <View style={styles.runInner}>
                      {project !== null ? (
                        <LetterAvatar label={project.name} color={project.color} />
                      ) : (
                        // No project (or not in the registry fold) — the
                        // honest neutral identity, never a guessed letter.
                        <View style={[styles.neutralTile, { backgroundColor: tokens.subtleHover }]}>
                          <FolderGit2 size={20} color={tokens.textTertiary} strokeWidth={2.2} />
                        </View>
                      )}
                      <View style={styles.runText}>
                        <TypeBodyStrong numberOfLines={1}>{title}</TypeBodyStrong>
                        <TypeCaption numberOfLines={1}>
                          {project !== null
                            ? `${project.name} · ${sessionStatusLabel(row.status)}`
                            : sessionStatusLabel(row.status)}
                        </TypeCaption>
                      </View>
                      <Badge tone="running">Live</Badge>
                    </View>
                  </PressableCard>
                );
              })}
            </>
          ) : null}

          {/* ── the recent activity preview ── */}
          <SectionHeader action="see all" onAction={() => router.push("/activity")}>
            Recent activity
          </SectionHeader>
          {activityState.latest.length === 0 ? (
            <ClayCard>
              <View style={styles.emptyPad}>
                <TypeCaption>
                  {connected
                    ? "Nothing yet — approvals and finished tasks land here live."
                    : "Nothing yet — activity lands when the host is back."}
                </TypeCaption>
              </View>
            </ClayCard>
          ) : (
            <ClayCard>
              <View style={styles.recentPad}>
                {activityState.latest.slice(0, RECENT_PREVIEW).map((n, i) => {
                  const ts = new Date(n.ts).getTime();
                  return (
                    <View key={n.id} style={styles.recentRow} testID={`home-recent-${i}`}>
                      <StatusDot
                        color={n.read === 0 ? tokens.accent : tokens.textTertiary}
                        size={7}
                      />
                      <View style={styles.recentText}>
                        <TypeCaption numberOfLines={1}>{n.title}</TypeCaption>
                        <TypeMicro numberOfLines={1}>
                          {Number.isNaN(ts) ? "" : timeAgo(ts)}
                        </TypeMicro>
                      </View>
                    </View>
                  );
                })}
              </View>
            </ClayCard>
          )}
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  // The compact strip row (connection + activity): one line, 52px min.
  stripInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  // The word + "· meta" cluster — no gap: the caption's own "· " lead is
  // the separator, so the line reads "Live · Confused Coconut".
  stripText: {
    flexDirection: "row",
    alignItems: "baseline",
    flex: 1,
    minWidth: 0,
  },
  stripMeta: { flexShrink: 1 },
  bellChip: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  bellDot: {
    position: "absolute",
    top: -1,
    right: -1,
    minWidth: 10,
    height: 10,
    borderRadius: 5,
  },
  // The running-session row: [identity 40] [label + one meta line] [badge].
  runInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 64,
  },
  runText: { flex: 1, gap: 2 },
  neutralTile: {
    width: TILE_ROW,
    height: TILE_ROW,
    borderRadius: TILE_ROW / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  recentPad: { padding: spacing.md, gap: spacing.md },
  recentRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  recentText: { flex: 1, gap: 1 },
  emptyPad: { padding: spacing.lg },
  unpairedInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    minHeight: 64,
  },
});
