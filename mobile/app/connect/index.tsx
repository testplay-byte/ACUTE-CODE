/**
 * The connection hub (R109: "There should be an option to add a connection
 * and after doing that it should lead to a new page where the user can
 * input the values manually or he can configure them as such").
 *
 * R115-D — the UNPAIRED branch is the Minimal-Center archetype
 * (screen-archetypes.md §1 / onboarding.md "Post-wizard Connect screen"):
 * the animated desktop↔phone SVG moment (the ONE infinite-but-calm pulse,
 * motion.md §4.3) + the two options via the shared PairOptionsPair. No back
 * chevron, no notification bell, no header — as a root screen it is
 * chrome-free (the wizard's welcome/permissions idiom).
 *
 * Host linked → the current connection (identity + live status + retry),
 * "pair a different desktop" (scan again replaces the link), and the
 * disconnect action lives in the host-management page it links to. The hub
 * is a ROOT screen — after onboarding (and after every replace() landing)
 * there is nothing behind it, so the back chevron only renders when the
 * root stack can actually pop (e.g. pushed from the connection pill inside
 * the tabs).
 */

import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  Keyboard,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  ScanLine,
  Smartphone,
  Unplug,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import { PairOptionsPair } from "@/components/pair-options";
import {
  ClayCard,
  FadeInUp,
  PressableCard,
  QuietButton,
  TypeBody,
  TypeCaption,
  TypeDisplay,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { LINK_LOOP_MS } from "@/design/motion";
import {
  RADIUS_CHIP,
  RADIUS_TILE,
  TILE_HERO,
  TILE_OPTION,
  spacing,
} from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";

/** The dashed link line's pattern: 8 on, 8 off (the offset travels by exactly
 *  one period per loop — a seamless wrap, never a visible seam). */
const DASH = 8;
const GAP = 8;
const DASH_PERIOD = DASH + GAP;
/** The line's span between the two chips. */
const LINK_SPAN = spacing.xxxl * 2;

/** The reanimated-driven SVG line (strokeDashoffset rides a shared value). */
const AnimatedLine = Animated.createAnimatedComponent(Line);

/**
 * The connect hero — two clay chips (desktop + this phone) joined by the
 * traveling dashed link line: infinite but CALM (motion.md §4.3 — the dash
 * offset travels a ~1.6s loop, sine-eased so it surges and rests instead of
 * conveyor-linear; no scale thrash). Reduced motion renders the resting
 * dashed line.
 */
function ConnectPairHero() {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const dash = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      dash.value = 0;
      return;
    }
    dash.value = withRepeat(
      withTiming(-DASH_PERIOD, { duration: LINK_LOOP_MS, easing: Easing.inOut(Easing.sin) }),
      -1,
      false,
    );
  }, [reduced, dash]);

  const linkProps = useAnimatedProps(() => ({ strokeDashoffset: dash.value }));

  return (
    <View style={styles.heroPair} accessibilityLabel="A desktop and this phone, linked">
      <View
        style={[
          styles.heroChipDesktop,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
        ]}
      >
        <Monitor size={28} color={tokens.accent} strokeWidth={2.2} />
      </View>
      <Svg width={LINK_SPAN} height={spacing.md}>
        <AnimatedLine
          x1={0}
          y1={spacing.md / 2}
          x2={LINK_SPAN}
          y2={spacing.md / 2}
          stroke={tokens.accent}
          strokeWidth={2}
          strokeDasharray={`${DASH} ${GAP}`}
          strokeLinecap="round"
          opacity={0.85}
          animatedProps={linkProps}
        />
      </Svg>
      <View
        style={[
          styles.heroChipPhone,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
        ]}
      >
        <Smartphone size={20} color={tokens.accent} strokeWidth={2.2} />
      </View>
    </View>
  );
}

export default function ConnectHubScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live, lastSeen } = useLink();
  const [, setTick] = useState(0);

  // R110 #4: the hub is the ROOT of the connect flow — the chevron only
  // makes sense when the ROOT stack can pop (pushed from the tabs' pill).
  // As the post-onboarding landing screen there is nothing to go back to.
  const canPopRoot = router.canGoBack();

  // The honest relative "last seen" — a 30s tick while a host exists.
  useEffect(() => {
    if (host === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [host]);

  const connected = status === "connected";

  if (host === null) {
    // ── no host yet: Minimal-Center — the animated pair + the two options ──
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
        <View style={styles.centerBody}>
          <View style={styles.spacerTop} />
          <View style={styles.hero}>
            <FadeInUp index={0}>
              <ConnectPairHero />
            </FadeInUp>
            <FadeInUp index={1}>
              <TypeDisplay style={styles.title}>Connect to PC</TypeDisplay>
            </FadeInUp>
          </View>
          <View style={styles.spacerBottom} />
          <PairOptionsPair
            start={2}
            options={[
              {
                icon: ScanLine,
                label: "Scan the QR code",
                description: "From the desktop's Link a device screen.",
                onPress: () => router.push("/connect/scan"),
                testID: "hub-scan",
              },
              {
                icon: Keyboard,
                label: "Enter the values manually",
                description: "Address and PIN, no camera needed.",
                onPress: () => router.push("/connect/manual"),
                testID: "hub-manual",
              },
            ]}
          />
          <View style={styles.bottomBreath} />
        </View>
      </SafeAreaView>
    );
  }

  // ── host linked: the current connection + the management paths ──
  return (
    <ScreenScaffold title="Connect" back={canPopRoot} noPill>
      <ClayCard elevated>
        <View style={styles.cardPad}>
          <View style={styles.hostRow}>
            <View style={[styles.hostIcon, { backgroundColor: tokens.subtleHover }]}>
              <MonitorSmartphone size={22} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <View style={styles.hostText}>
              <TypeBody>{host.hostLabel}</TypeBody>
              <TypeCaption>
                {connected
                  ? `connected · desktop v${live?.version ?? "?"}`
                  : status === "probing"
                    ? "looking for the host…"
                    : "host offline — retrying"}
              </TypeCaption>
            </View>
            {!connected ? (
              <QuietButton onPress={() => getLinkManager().retryNow()} tone="neutral">
                <RefreshCw size={16} color={tokens.textSecondary} strokeWidth={2.2} />
              </QuietButton>
            ) : null}
          </View>
          <TypeCaption style={styles.lastSeen}>
            last seen {lastSeen === null ? "never" : timeAgo(lastSeen)} · paired{" "}
            {timeAgo(host.pairedAt)} ago
          </TypeCaption>
        </View>
      </ClayCard>

      <PressableCard onPress={() => router.push("/settings/host")}>
        <OptionRow
          icon={<Unplug size={22} color={tokens.textSecondary} strokeWidth={2.2} />}
          title="Manage this connection"
          body="Identity, addresses, diagnostics, replay the wizard, or disconnect completely."
        />
      </PressableCard>

      <TypeMicro style={styles.kicker}>PAIR A DIFFERENT DESKTOP</TypeMicro>
      <PressableCard
        onPress={() => router.push("/connect/scan")}
        accessibilityLabel="Scan to pair a different desktop"
      >
        <OptionRow
          icon={<ScanLine size={22} color={tokens.accent} strokeWidth={2.2} />}
          title="Scan a new pairing code"
          body="Replaces this link — the desktop keeps its own list, revoke this phone there if you leave it."
        />
      </PressableCard>
    </ScreenScaffold>
  );
}

function OptionRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <View style={styles.optionInner}>
      <View style={styles.optionIcon}>{icon}</View>
      <View style={styles.optionText}>
        <TypeBody>{title}</TypeBody>
        <TypeCaption style={styles.optionBody}>{body}</TypeCaption>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centerBody: { flex: 1, padding: spacing.lg },
  // The 0.9/1 flex spacers hold the hero slightly ABOVE the vertical middle
  // (the Minimal-Center archetype); the options sit below the middle line.
  spacerTop: { flex: 0.9 },
  spacerBottom: { flex: 1 },
  hero: { alignItems: "center", gap: spacing.xl },
  heroPair: { flexDirection: "row", alignItems: "center" },
  heroChipDesktop: {
    width: TILE_HERO,
    height: TILE_HERO,
    borderRadius: RADIUS_TILE,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  heroChipPhone: {
    width: TILE_OPTION,
    height: TILE_OPTION,
    borderRadius: RADIUS_CHIP,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { textAlign: "center" },
  bottomBreath: { height: spacing.xxl },
  cardPad: { padding: spacing.lg, gap: spacing.md },
  optionInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1, gap: 2 },
  optionBody: { lineHeight: 18 },
  hostRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  hostIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  hostText: { flex: 1, gap: 2 },
  lastSeen: { marginTop: spacing.xs },
  kicker: { marginTop: spacing.xs },
});
