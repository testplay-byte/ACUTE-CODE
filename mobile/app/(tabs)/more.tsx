/**
 * More — the FIFTH tab (R115-g, the round-115 pinned decision): the hub the
 * settings tab became — a summary + the entries, NOT a settings list (the
 * List archetype, header-free root). Top → bottom:
 *
 *   · THE CONNECTION CARD — home's compact live-status row grammar: the
 *     dot (live/probing/offline) + the pinned word ("Live" / "Looking for
 *     the host…" / "Offline") + the one caption line — the word-pair name
 *     + "· desktop v{x}" — → the connection page (/settings/host).
 *     Unpaired (the deep-link case; the gate lands these users on
 *     /connect) renders the honest "No desktop linked" one-liner instead.
 *   · THE ACTIVITY ROW — always present (unlike home's unread-gated
 *     strip): the bell chip + "Activity" + the unread caption → /activity.
 *   · THE SETTINGS ENTRY — the hub's main job, the PROMINENT row: the 44px
 *     Settings2 chip + the one-line inventory caption → /settings (the
 *     management hub, now a PUSHED screen in the settings stack).
 *   · THE ABOUT CARD — app identity: "ACUTE companion" + the version badge
 *     + the one-line role + the setup-wizard replay.
 *
 * Every row staggers in (PressableCard enterIndex / FadeInUp — motion.md §2).
 */

import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import { Bell, ChevronRight, Info, MonitorSmartphone, Settings2 } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Badge,
  ClayCard,
  FadeInUp,
  PressableCard,
  QuietButton,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { useUnread } from "@/features/activity";
import { resetOnboarding } from "@/features/onboarding";
import { mobLog } from "@/lib/log";

/** The version the about card shows — the BUILD's own app.json version
 * (embedded by expo-constants), falling back to the R109 release number. */
const APP_VERSION = Constants.expoConfig?.version ?? "0.105.0";

export default function MoreScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live } = useLink();
  const unread = useUnread();

  useEffect(() => {
    mobLog("more", "hub opened", { status });
  }, [status]);

  const connected = status === "connected";
  const probing = status === "probing";

  // The connection row's pinned vocabulary (copy.md): "Live" / "Looking
  // for the host…" / "Offline" — the caption's own "· " leads read the
  // whole line as "Live · Confused Coconut · desktop v0.108.0".
  const statusWord = connected ? "Live" : probing ? "Looking for the host…" : "Offline";

  return (
    <ScreenScaffold title="More" chrome={false}>
      {/* ── the connection card — the whole link truth in one compact
          strip; tap → the connection page (which owns retry). ── */}
      {host === null ? (
        <PressableCard
          onPress={() => router.push("/connect")}
          enterIndex={0}
          accessibilityLabel="No desktop linked — open the connect screen"
          testID="more-connection"
        >
          <View style={styles.unpairedInner}>
            <MonitorSmartphone size={20} color={tokens.textTertiary} strokeWidth={2.2} />
            <TypeBodyStrong>No desktop linked</TypeBodyStrong>
            <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
          </View>
        </PressableCard>
      ) : (
        <PressableCard
          onPress={() => router.push("/settings/host")}
          enterIndex={0}
          accessibilityLabel={`${statusWord}, ${host.hostLabel} — open connection settings`}
          testID="more-connection"
        >
          <View style={styles.stripInner}>
            <StatusDot
              color={connected ? tokens.success : probing ? tokens.warning : tokens.danger}
              pulse={probing}
            />
            <View style={styles.stripText}>
              <TypeBodyStrong numberOfLines={1}>{statusWord}</TypeBodyStrong>
              <TypeCaption numberOfLines={1} style={styles.stripMeta}>
                {`· ${host.hostLabel}${live !== null ? ` · desktop v${live.version}` : ""}`}
              </TypeCaption>
            </View>
            <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
          </View>
        </PressableCard>
      )}

      {/* ── the activity row — always present here (home's strip is
          unread-gated; the hub keeps the entry), unread only in the
          caption + the accent dot on the bell chip. ── */}
      <PressableCard
        onPress={() => router.push("/activity")}
        enterIndex={1}
        accessibilityLabel={`Activity${unread > 0 ? `, ${unread} unread notification${unread === 1 ? "" : "s"}` : ""}`}
        testID="more-activity"
      >
        <View style={styles.stripInner}>
          <View style={[styles.bellChip, { backgroundColor: tokens.subtleHover }]}>
            <Bell size={17} color={tokens.accent} strokeWidth={2.2} />
            {unread > 0 ? (
              <View
                style={[styles.bellDot, { backgroundColor: tokens.accent }]}
                accessibilityLabel={`${unread} unread`}
              />
            ) : null}
          </View>
          <View style={styles.stripText}>
            <TypeBodyStrong numberOfLines={1}>Activity</TypeBodyStrong>
            <TypeCaption numberOfLines={1} style={styles.stripMeta}>
              {unread > 0 ? `· ${unread} unread` : "· all caught up"}
            </TypeCaption>
          </View>
          <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>

      {/* ── the settings entry — the hub's main job: the PROMINENT row
          pushing the management hub (the moved settings screen). ── */}
      <PressableCard
        onPress={() => router.push("/settings")}
        enterIndex={2}
        accessibilityLabel="Open settings"
        testID="more-settings"
      >
        <View style={styles.settingsInner}>
          <View style={[styles.settingsIcon, { backgroundColor: tokens.subtleHover }]}>
            <Settings2 size={22} color={tokens.accent} strokeWidth={2.2} />
          </View>
          <View style={styles.settingsText}>
            <TypeBodyStrong>Settings</TypeBodyStrong>
            <TypeCaption>Appearance, providers, agents, preferences</TypeCaption>
          </View>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>

      {/* ── about: app identity + the wizard replay ── */}
      <FadeInUp index={3}>
        <ClayCard testID="more-about">
          <View style={styles.aboutPad}>
            <View style={styles.aboutHead}>
              <View style={[styles.aboutIcon, { backgroundColor: tokens.subtleHover }]}>
                <Info size={20} color={tokens.accent} strokeWidth={2.2} />
              </View>
              <View style={styles.aboutHeadText}>
                <TypeBodyStrong>ACUTE companion</TypeBodyStrong>
              </View>
              <Badge tone="neutral">v{APP_VERSION}</Badge>
            </View>
            <TypeBody>A view + input medium for the desktop agent.</TypeBody>
            <QuietButton onPress={() => onReplayWizard(router)}>Replay the setup wizard</QuietButton>
          </View>
        </ClayCard>
      </FadeInUp>
    </ScreenScaffold>
  );
}

/** The wizard replay: clear the onboarding flag, land on the welcome page. */
function onReplayWizard(router: ReturnType<typeof useRouter>): void {
  mobLog("more", "wizard replay requested");
  void resetOnboarding().then(() => {
    router.replace("/onboarding/welcome");
  });
}

const styles = StyleSheet.create({
  // The compact strip rows (connection + activity — home's grammar): one
  // line, 52px min.
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
  // The prominent settings row: [identity 44] [label + one meta line]
  // [chevron] — taller than the strips (the hub's main job).
  settingsInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 76,
  },
  settingsIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsText: { flex: 1, gap: 3 },
  aboutPad: { padding: spacing.lg, gap: spacing.md },
  aboutHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  aboutIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  aboutHeadText: { flex: 1, gap: 2 },
  unpairedInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    minHeight: 64,
  },
});
