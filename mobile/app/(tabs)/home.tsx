/**
 * Home v2 (R109; R113-e — the tabs merge + the compact header) — the
 * dashboard-front door: the live host hero (status, retry, last-seen — the
 * clay centerpiece, now the screen's first element), the quick-action grid
 * (approvals with its live badge, projects — the sessions card folded into
 * it when the sessions tab died), the recent activity preview, and the
 * theme dots. Unpaired → the honest "link a device" card. Everything clay;
 * nothing glow.
 */

import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import {
  FolderGit2,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import { ThemeDots } from "@/components/theme-picker";
import {
  ClayCard,
  PressableCard,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeTitle,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { useActivityFeed } from "@/features/activity";

export default function HomeScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live, lastSeen, lastFailure } = useLink();
  const { state: activityState } = useActivityFeed();
  const [, setTick] = useState(0);

  // The honest relative clock — 30s.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const connected = status === "connected";
  const offline = status === "offline";

  // R113-e: the tabs merge — the Sessions card's destination became the
  // Projects tab; folded with the old Projects card (two cards pointing at
  // one tab is noise). Approvals keeps its badge + the hero carries the
  // rest.
  const quickActions = [
    {
      icon: ShieldCheck,
      label: "Approvals",
      caption: "the pocket brake pedal",
      route: "/approvals" as const,
      tone: "accent" as const,
    },
    {
      icon: FolderGit2,
      label: "Projects",
      caption: "the registry & its sessions",
      route: "/projects" as const,
      tone: "neutral" as const,
    },
  ];

  return (
    <ScreenScaffold title="ACUTE">
      {host === null ? (
        // ── unpaired: the honest first card ──
        <ClayCard elevated>
          <View style={styles.unpairedPad}>
            <View style={[styles.unpairedIcon, { backgroundColor: tokens.subtleHover }]}>
              <MonitorSmartphone size={26} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <View style={styles.unpairedText}>
              <TypeTitle>No host linked yet</TypeTitle>
              <TypeCaption style={styles.unpairedBody}>
                Pair with the desktop once — scan its QR code or type the values — and this phone
                remembers it for months.
              </TypeCaption>
            </View>
          </View>
          <View style={styles.unpairedActions}>
            <QuietButton onPress={() => router.push("/connect/scan")}>Scan the QR code</QuietButton>
            <QuietButton onPress={() => router.push("/connect/manual")}>Enter manually</QuietButton>
          </View>
        </ClayCard>
      ) : (
        // ── the host hero ──
        <ClayCard elevated>
          <View style={styles.heroPad}>
            <View style={styles.heroRow}>
              <View style={[styles.heroIcon, { backgroundColor: tokens.subtleHover }]}>
                <MonitorSmartphone size={24} color={tokens.accent} strokeWidth={2.2} />
              </View>
              <View style={styles.heroText}>
                <TypeBodyStrong style={styles.heroLabel}>{host.hostLabel}</TypeBodyStrong>
                <View style={styles.heroStatusRow}>
                  <StatusDot
                    color={
                      connected ? tokens.success : offline ? tokens.warning : tokens.accent
                    }
                    pulse={!connected}
                  />
                  <TypeCaption
                    style={{
                      color: connected
                        ? tokens.success
                        : offline
                          ? tokens.warning
                          : tokens.textSecondary,
                    }}
                  >
                    {connected
                      ? `connected · desktop v${live?.version ?? "?"}`
                      : status === "probing"
                        ? "looking for the host…"
                        : "host offline — retrying"}
                  </TypeCaption>
                </View>
              </View>
              {!connected ? (
                <QuietButton onPress={() => getLinkManager().retryNow()}>
                  <View style={styles.retryRow}>
                    <RefreshCw size={15} color={tokens.textSecondary} strokeWidth={2.2} />
                  </View>
                </QuietButton>
              ) : null}
            </View>
            <TypeCaption style={styles.heroMeta}>
              last seen {lastSeen === null ? "never" : timeAgo(lastSeen)}
              {offline && lastFailure !== null ? ` · ${lastFailure.message}` : ""}
            </TypeCaption>
          </View>
        </ClayCard>
      )}

      {/* ── the quick-action grid ── */}
      <SectionHeader>Quick actions</SectionHeader>
      <View style={styles.quickGrid}>
        {quickActions.map((action, i) => {
          const Icon = action.icon;
          return (
            <PressableCard
              key={action.label}
              elevated={i === 0}
              enterIndex={i}
              onPress={() => router.push(action.route as never)}
              style={styles.quickCard}
              accessibilityLabel={action.label}
            >
              <View style={styles.quickInner}>
                <View style={[styles.quickIcon, { backgroundColor: tokens.subtleHover }]}>
                  <Icon size={22} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <TypeBodyStrong>{action.label}</TypeBodyStrong>
                <TypeMicro>{action.caption}</TypeMicro>
              </View>
            </PressableCard>
          );
        })}
      </View>

      {/* ── the recent activity preview ── */}
      <SectionHeader action="see all" onAction={() => router.push("/activity")}>
        Recent activity
      </SectionHeader>
      {activityState.latest.length === 0 ? (
        <ClayCard>
          <View style={styles.activityPad}>
            <TypeCaption>
              {connected
                ? "nothing yet — approvals, finished tasks, and failures land here live"
                : "connect to the host to see live activity"}
            </TypeCaption>
          </View>
        </ClayCard>
      ) : (
        <ClayCard>
          <View style={styles.activityPad}>
            {activityState.latest.slice(0, 4).map((n) => (
              <View key={n.id} style={styles.activityRow}>
                <StatusDot
                  color={n.read === 0 ? tokens.accent : tokens.textTertiary}
                  size={7}
                />
                <View style={styles.activityText}>
                  <TypeCaption numberOfLines={1}>{n.title}</TypeCaption>
                  <TypeMicro numberOfLines={1}>
                    {timeAgo(new Date(n.ts).getTime())} ago
                  </TypeMicro>
                </View>
              </View>
            ))}
          </View>
        </ClayCard>
      )}

      {/* ── the theme dots ── */}
      <SectionHeader>Appearance</SectionHeader>
      <ClayCard>
        <View style={styles.themePad}>
          <ThemeDots />
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  unpairedPad: { padding: spacing.lg, gap: spacing.md, flexDirection: "row", alignItems: "center" },
  unpairedIcon: {
    width: 56,
    height: 56,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  unpairedText: { flex: 1, gap: 2 },
  unpairedBody: { lineHeight: 18 },
  unpairedActions: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  heroPad: { padding: spacing.lg, gap: spacing.md },
  heroRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  heroText: { flex: 1, gap: 3 },
  heroLabel: { fontSize: 16 },
  heroStatusRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  retryRow: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  heroMeta: {},
  quickGrid: { flexDirection: "row", gap: spacing.md },
  quickCard: { flex: 1 },
  quickInner: { padding: spacing.md, gap: spacing.sm, alignItems: "flex-start" },
  quickIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  activityPad: { padding: spacing.md, gap: spacing.md },
  activityRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  activityText: { flex: 1 },
  themePad: { padding: spacing.md },
});
