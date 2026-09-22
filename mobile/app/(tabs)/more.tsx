/**
 * More — the FIFTH tab (R115-g, the round-115 pinned decision; R116-h —
 * verdict #26's redo): the QUIET hub. The connection/live-status card, the
 * Activity row, and the setup-wizard replay are DEAD (the connection hub
 * owns the link's whole surface now — R116-f; activity reaches through the
 * tab-root bell + its own screen; the wizard never replays). Top → bottom:
 *
 *   · THE CONNECTION HERO (R118-B, spec §2.4) — ONE PressableCard elevated
 *     → /connect carrying the app's three truths that used to scatter
 *     across home's status row + the settings connection row + this about
 *     card: the WHO (ClayIconChip Monitor 48 + the host's word-pair name,
 *     "No desktop linked" when unpaired + the chevron), the STATUS
 *     (StatusDot 10 + the pinned vocabulary word in home's deep status hue
 *     + "· desktop v{version}" — or "· ACUTE companion"), and the identity
 *     micro line ("ACUTE companion · v{APP_VERSION} · expo {EXPO_TAG}").
 *     The version Badge + the build line + the role line are DEAD. The
 *     unpaired hero: danger dot + "Offline · tap to pair".
 *   · THE STATS CARD — the owner's "simple clean stats": Projects /
 *     Sessions / Running now as quiet label-left / mono-number-right rows,
 *     knit by the R118-B STRONG Hairline dividers (1dp borderStrong — the
 *     visible clay divider, the same recipe as home's recent rows). ONE
 *     parallel load (fetchProjects + fetchSessions's 200 fold — home's own
 *     idioms) on focus + the sessions epoch; "—" while loading; the card
 *     hides entirely while unpaired/offline or after a failed load (never
 *     fabricated counts — the connect hub carries that truth).
 *   · THE SETTINGS ENTRY — the hub's main job, the PROMINENT row: the 44px
 *     Settings2 chip + the one-line inventory caption → /settings (the
 *     management hub, a PUSHED screen in the settings stack).
 *
 * Every row staggers in (PressableCard enterIndex / FadeInUp — motion.md §2).
 */

import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import { ChevronRight, Monitor, Settings2 } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  ClayCard,
  ClayIconChip,
  FadeInUp,
  Hairline,
  PressableCard,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useEventsEpoch } from "@/features/events";
import { fetchProjects } from "@/features/config";
import { fetchSessions } from "@/features/sessions";
import { mobLog, mobWarn } from "@/lib/log";

/** The version the about card shows — the BUILD's own app.json version
 * (embedded by expo-constants), falling back to the R109 release number. */
const APP_VERSION = Constants.expoConfig?.version ?? "0.105.0";

/** The Expo leg of the build line — Constants' honest offer: the Expo Go
 * version when running inside Go, null in dev-client/standalone builds
 * (where the pinned SDK is the truth — package.json's expo ~57). */
const EXPO_TAG = Constants.expoVersion ?? "SDK 57";

/** The session fold the stats load rides (the same 200 home + projects
 * ride — "Running now" only ever needs the recent sessions). */
const SESSION_FOLD_LIMIT = 200;

/** The one-shot stats payload — three honest counts, nothing derived. */
interface HubStats {
  projects: number;
  sessions: number;
  running: number;
}

export default function MoreScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live } = useLink();

  // ── the world's counts — null while loading (the honest "—"); a failed
  // or unpaired load hides the card entirely instead. ──
  const [stats, setStats] = useState<HubStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);

  // ── the live leg (home's pattern): a debounced session-frame batch moves
  // the sessions epoch — the running count follows it while this hub is
  // mounted. The MOUNT value guards the first fetch (focus owns it). ──
  const sessionsEpoch = useEventsEpoch("sessions");
  const mountEpoch = useRef(sessionsEpoch);

  useEffect(() => {
    mobLog("more", "hub opened", { status });
  }, [status]);

  // ONE parallel load — projects (registry length) + sessions (the route's
  // own `total`, plus the fold for the running filter). Failures are values
  // AND throws here: either way the card goes quiet (never a fake zero).
  const loadStats = useCallback(async () => {
    try {
      const [projectsOutcome, sessionsOutcome] = await Promise.all([
        fetchProjects(getLinkManager()),
        fetchSessions(getLinkManager(), { limit: SESSION_FOLD_LIMIT }),
      ]);
      if (!projectsOutcome.ok || !sessionsOutcome.ok) {
        setStatsFailed(true);
        mobWarn("more", "stats unavailable", {
          projects: projectsOutcome.ok ? "ok" : projectsOutcome.error.status,
          sessions: sessionsOutcome.ok ? "ok" : sessionsOutcome.error.status,
        });
        return;
      }
      const next: HubStats = {
        projects: projectsOutcome.data.projects.length,
        sessions: sessionsOutcome.data.total,
        running: sessionsOutcome.data.sessions.filter((row) => row.status === "running").length,
      };
      setStatsFailed(false);
      setStats(next);
      mobLog("more", "stats loaded", {
        projects: next.projects,
        sessions: next.sessions,
        running: next.running,
      });
    } catch {
      setStatsFailed(true);
      mobWarn("more", "stats threw");
    }
  }, []);

  // Load on (re)focus — every visit refreshes, and a status flip while
  // focused (the reconnect) re-runs the callback through its deps.
  useFocusEffect(
    useCallback(() => {
      if (status !== "connected") return; // unpaired/offline stay quiet — /connect owns it
      void loadStats();
    }, [status, loadStats]),
  );

  // Refetch when a session batch landed after mount (home's live pattern).
  useEffect(() => {
    if (sessionsEpoch === mountEpoch.current) return;
    if (status !== "connected") return;
    void loadStats();
  }, [sessionsEpoch, status, loadStats]);

  // The stats card renders ONLY while connected and not failed — the
  // honest "—" covers the in-flight first load.
  const showStats = status === "connected" && !statsFailed;

  // ── the hero's truth (R118-B §2.4): the pinned vocabulary + home's deep
  // status hues — the hero is the app's status surface now. Unpaired reads
  // as its own honest pose (danger dot + "Offline · tap to pair"). ──
  const connected = status === "connected";
  const probing = status === "probing";
  const isDark = tokens.isDark;
  const statusWord = connected ? "Live" : probing ? "Looking for the host…" : "Offline";
  const statusHue = connected
    ? isDark
      ? "#4ADE80"
      : "#15803D"
    : probing
      ? isDark
        ? "#FBBF24"
        : "#B45309"
      : isDark
        ? "#F87171"
        : "#DC2626";
  const statusDotHue = connected
    ? tokens.success
    : probing
      ? tokens.warning
      : tokens.danger;
  const statusCaption =
    host === null ? "· ACUTE companion" : live !== null ? `· desktop v${live.version}` : "· ACUTE companion";

  return (
    <ScreenScaffold title="More" chrome={false}>
      {/* ── the connection hero (R118-B §2.4): the WHO + the status + the
          app identity on ONE elevated card, tap → the connect hub. The
          version Badge, the build line, and the role line are DEAD. ── */}
      <PressableCard
        elevated
        onPress={() => router.push("/connect")}
        enterIndex={0}
        accessibilityLabel={
          host === null
            ? "No desktop linked, offline — open the connect screen"
            : `${host.hostLabel}, ${statusWord}${connected ? "" : ", messages will queue"} — open the connect screen`
        }
        testID="more-hero"
      >
        <View style={styles.heroPad}>
          {/* Row 1 — the WHO: the desktop's chip + word-pair name. */}
          <View style={styles.heroTop}>
            <ClayIconChip icon={Monitor} iconSize={22} size={48} />
            <TypeTitle numberOfLines={1} style={styles.heroName}>
              {host === null ? "No desktop linked" : host.hostLabel}
            </TypeTitle>
            <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
          </View>
          {/* Row 2 — the status: the deep-hue word + the version caption
              (home's statusHue recipe; unpaired = danger + "tap to pair"). */}
          <View style={styles.heroStatus}>
            <StatusDot color={host === null ? tokens.danger : statusDotHue} pulse={probing} size={10} />
            <TypeBodyStrong numberOfLines={1} style={[styles.heroStatusWord, { color: statusHue }]}>
              {host === null ? "Offline" : statusWord}
            </TypeBodyStrong>
            <TypeCaption numberOfLines={1} style={styles.heroStatusMeta}>
              {host === null ? "· tap to pair" : statusCaption}
            </TypeCaption>
          </View>
          {/* Row 3 — the app identity micro line (the badge + build line's
              one-line replacement; the role line is dead). */}
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {`ACUTE companion · v${APP_VERSION} · expo ${EXPO_TAG}`}
          </TypeMicro>
        </View>
      </PressableCard>

      {/* ── the simple-stats card — three quiet rows, labels left, the
          counts right in mono; hidden entirely while unpaired/offline. ── */}
      {showStats ? (
        <FadeInUp index={1}>
          <ClayCard testID="more-stats">
            <View style={styles.statsPad}>
              <StatRow label="Projects" value={stats === null ? "—" : String(stats.projects)} />
              <Hairline strong inset={spacing.md} />
              <StatRow label="Sessions" value={stats === null ? "—" : String(stats.sessions)} />
              <Hairline strong inset={spacing.md} />
              <StatRow label="Running now" value={stats === null ? "—" : String(stats.running)} />
            </View>
          </ClayCard>
        </FadeInUp>
      ) : null}

      {/* ── the settings entry — the hub's main job: the PROMINENT row
          pushing the management hub (the moved settings screen). ── */}
      <PressableCard
        onPress={() => router.push("/settings")}
        enterIndex={2}
        accessibilityLabel="Open settings"
        testID="more-settings"
      >
        <View style={styles.settingsInner}>
          {/* R117-g2 — the ClayIconChip (44, r 15) replaces the ghost. */}
          <ClayIconChip icon={Settings2} iconSize={22} size={44} />
          <View style={styles.settingsText}>
            <TypeBodyStrong numberOfLines={1}>Settings</TypeBodyStrong>
            <TypeCaption numberOfLines={1}>Appearance, providers, agents</TypeCaption>
          </View>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>
    </ScreenScaffold>
  );
}

/** One quiet stats row — the label left, the count right in the mono face
 *  (machine truth). "—" is the honest in-flight placeholder; a failed or
 *  unpaired load hides the whole card instead of inventing a number. The
 *  R118-B strong Hairline (1dp borderStrong, inset spacing.md) knits the
 *  rows — the old borderSubtle hairline divider was arithmetically
 *  invisible (0.06 ink at 0.33dp). */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View accessibilityLabel={`${label}: ${value}`} style={styles.statsRow}>
      <TypeBodyStrong numberOfLines={1}>{label}</TypeBodyStrong>
      <TypeMono numberOfLines={1} style={styles.statsValue}>
        {value}
      </TypeMono>
    </View>
  );
}

const styles = StyleSheet.create({
  // The prominent settings row: [identity 44] [label + one meta line]
  // [chevron] — taller than the strips (the hub's main job).
  settingsInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 76,
  },
  settingsText: { flex: 1, gap: 3 },
  // The connection hero (R118-B §2.4): [chip 48 + name + chevron] over the
  // status line over the identity micro line.
  heroPad: { padding: spacing.lg, gap: spacing.sm },
  heroTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  heroName: { flex: 1 },
  heroStatus: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  heroStatusWord: { letterSpacing: 0.1 },
  heroStatusMeta: { flexShrink: 1 },
  // The stats card: quiet single-line rows knit by the strong dividers
  // (inset spacing.md, rendered by the caller between the rows).
  statsPad: { padding: spacing.lg },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  statsValue: { fontSize: 14 },
});
