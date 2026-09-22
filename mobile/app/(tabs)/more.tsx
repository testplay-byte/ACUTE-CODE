/**
 * More — the FIFTH tab (R115-g, the round-115 pinned decision; R116-h —
 * verdict #26's redo): the QUIET hub. The connection/live-status card, the
 * Activity row, and the setup-wizard replay are DEAD (the connection hub
 * owns the link's whole surface now — R116-f; activity reaches through the
 * tab-root bell + its own screen; the wizard never replays). Top → bottom:
 *
 *   · THE ABOUT CARD — app identity: the Info tile + "ACUTE companion" +
 *     the version Badge + the build line (mono machine truth:
 *     "v{version} · expo {SDK}") + the one-line role.
 *   · THE STATS CARD — the owner's "simple clean stats": Projects /
 *     Sessions / Running now as quiet label-left / mono-number-right rows.
 *     ONE parallel load (fetchProjects + fetchSessions's 200 fold — home's
 *     own idioms) on focus + the sessions epoch; "—" while loading; the
 *     card hides entirely while unpaired/offline or after a failed load
 *     (never fabricated counts — the connect hub carries that truth).
 *   · THE SETTINGS ENTRY — the hub's main job, the PROMINENT row: the 44px
 *     Settings2 chip + the one-line inventory caption → /settings (the
 *     management hub, a PUSHED screen in the settings stack).
 *
 * Every row staggers in (PressableCard enterIndex / FadeInUp — motion.md §2).
 *
 * R117-g2 (round-117-elevation.md §2.2): the about + settings identity
 * chips are ClayIconChips — the accentTint fill + clayRim hairline + the
 * accentDeep glyph replace the subtleHover ghost rectangles (§1.5).
 */

import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import { ChevronRight, Info, Settings2 } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Badge,
  ClayCard,
  ClayIconChip,
  FadeInUp,
  PressableCard,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMono,
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
  const { status } = useLink();

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

  return (
    <ScreenScaffold title="More" chrome={false}>
      {/* ── about: app identity — the name, the badge, the build line, the
          one-line role (R116-h: grown from the old name + badge pair). ── */}
      <FadeInUp index={0}>
        <ClayCard testID="more-about">
          <View style={styles.aboutPad}>
            <View style={styles.aboutHead}>
              {/* R117-g2 — the ClayIconChip (44, r 15) replaces the ghost. */}
              <ClayIconChip icon={Info} iconSize={20} size={44} />
              <View style={styles.aboutHeadText}>
                <TypeBodyStrong numberOfLines={1}>ACUTE companion</TypeBodyStrong>
              </View>
              <Badge tone="neutral">v{APP_VERSION}</Badge>
            </View>
            <TypeMono numberOfLines={1}>{`v${APP_VERSION} · expo ${EXPO_TAG}`}</TypeMono>
            <TypeBody numberOfLines={1}>A view + input medium for the agent.</TypeBody>
          </View>
        </ClayCard>
      </FadeInUp>

      {/* ── the simple-stats card — three quiet rows, labels left, the
          counts right in mono; hidden entirely while unpaired/offline. ── */}
      {showStats ? (
        <FadeInUp index={1}>
          <ClayCard testID="more-stats">
            <View style={styles.statsPad}>
              <StatRow label="Projects" value={stats === null ? "—" : String(stats.projects)} />
              <StatRow label="Sessions" value={stats === null ? "—" : String(stats.sessions)} />
              <StatRow label="Running now" value={stats === null ? "—" : String(stats.running)} last />
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
 *  unpaired load hides the whole card instead of inventing a number. */
function StatRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const { tokens } = useTheme();
  return (
    <View
      accessibilityLabel={`${label}: ${value}`}
      style={[
        styles.statsRow,
        last ? null : [styles.statsRowDivider, { borderBottomColor: tokens.borderSubtle }],
      ]}
    >
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
  aboutPad: { padding: spacing.lg, gap: spacing.md },
  aboutHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  aboutHeadText: { flex: 1, gap: 2 },
  // The stats card: quiet single-line rows, hairline dividers between.
  statsPad: { padding: spacing.lg },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  statsRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  statsValue: { fontSize: 14 },
});
