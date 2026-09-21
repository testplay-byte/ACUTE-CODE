/**
 * The connection hub (R109: "There should be an option to add a connection
 * and after doing that it should lead to a new page where the user can
 * input the values manually or he can configure them as such").
 *
 * R115-D — the UNPAIRED branch is the Minimal-Center archetype
 * (screen-archetypes.md §1 / onboarding.md "Post-wizard Connect screen"):
 * the animated desktop↔phone SVG moment + the two options via the shared
 * PairOptionsPair. No back chevron, no notification bell, no header — as a
 * root screen it is chrome-free (the wizard's welcome/permissions idiom).
 *
 * R116-c — the unpaired branch becomes the BROKEN-LINK moment (the owner's
 * verdict #5): "Currently not connected" over the drifting pair — the two
 * clay chips drift ±4px apart and back on a calm ~2.8s loop while the dashed
 * link's middle gap widens in sync, one shared progress value driving all of
 * it (motion.md §4.9), the stroke subdued tertiary to read "no link" — and
 * the TWO option cards are replaced by ONE primary "Connect to PC" button
 * (donts #39) raised directly under the hero, opening the scanner. Manual
 * entry lives inside the scanner now, not on this screen.
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
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  ScanLine,
  Smartphone,
  Unplug,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import {
  ChromeButton,
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
import {
  RADIUS_BAR,
  RADIUS_CHIP,
  RADIUS_TILE,
  TILE_HERO,
  TILE_OPTION,
  TYPE_BODY,
  fontFamily,
  spacing,
} from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";

/** The dashed link line's pattern: 8 on, 8 off. */
const DASH = 8;
const GAP = 8;
/** The line's span between the two chips. */
const LINK_SPAN = spacing.xxxl * 2;

/** The broken-link drift (motion.md §4.9): the two chips drift ±4px apart
 * and back on a calm ~2.8s loop while the dashed line's middle gap widens
 * in sync — ONE shared progress value (0→1→0) drives every moving part. */
const DRIFT_PX = 4;
/** One leg of the drift loop (ms): out 1400, back 1400 (~2.8s period). */
const DRIFT_LEG_MS = 1400;
/** The dashed line's center gap at rest → at full drift (px): a normal dash
 * gap grows to a clearly-broken void. */
const LINK_GAP_MIN = 8;
const LINK_GAP_MAX = 24;

/** The reanimated-driven SVG line (x1/x2 ride a shared value). */
const AnimatedLine = Animated.createAnimatedComponent(Line);

/**
 * The broken-link hero — two clay chips (desktop + this phone) facing each
 * other across a dashed link that reads as BROKEN (motion.md §4.9): the
 * chips drift apart and back while the two dash segments' middle gap
 * widens and closes in sync, all on one shared drift value, sine-eased so
 * it surges and rests. The stroke is the subdued tertiary tone, never the
 * accent — there is no link. Reduced motion holds the static broken pose
 * (gap wide, chips apart).
 */
function ConnectPairHero() {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const drift = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      drift.value = 1;
      return;
    }
    drift.value = withRepeat(
      withSequence(
        withTiming(1, { duration: DRIFT_LEG_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: DRIFT_LEG_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
  }, [reduced, drift]);

  // One shared progress value → the chips' ±4px drift…
  const desktopStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -DRIFT_PX * drift.value }],
  }));
  const phoneStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: DRIFT_PX * drift.value }],
  }));
  // …and the widening middle gap: each dash segment yields half the gap's
  // travel (8px → 24px between them) — pure arithmetic on the shared value.
  const leftProps = useAnimatedProps(() => ({
    x2: LINK_SPAN / 2 - LINK_GAP_MIN / 2 - (drift.value * (LINK_GAP_MAX - LINK_GAP_MIN)) / 2,
  }));
  const rightProps = useAnimatedProps(() => ({
    x1: LINK_SPAN / 2 + LINK_GAP_MIN / 2 + (drift.value * (LINK_GAP_MAX - LINK_GAP_MIN)) / 2,
  }));

  return (
    <View style={styles.heroPair} accessibilityLabel="A desktop and this phone, not connected">
      <Animated.View
        style={[
          styles.heroChipDesktop,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
          desktopStyle,
        ]}
      >
        <Monitor size={28} color={tokens.accent} strokeWidth={2.2} />
      </Animated.View>
      <Svg width={LINK_SPAN} height={spacing.md}>
        <AnimatedLine
          x1={0}
          y1={spacing.md / 2}
          x2={LINK_SPAN / 2 - LINK_GAP_MIN / 2}
          y2={spacing.md / 2}
          stroke={tokens.textTertiary}
          strokeWidth={2}
          strokeDasharray={`${DASH} ${GAP}`}
          strokeLinecap="round"
          animatedProps={leftProps}
        />
        <AnimatedLine
          x1={LINK_SPAN / 2 + LINK_GAP_MIN / 2}
          y1={spacing.md / 2}
          x2={LINK_SPAN}
          y2={spacing.md / 2}
          stroke={tokens.textTertiary}
          strokeWidth={2}
          strokeDasharray={`${DASH} ${GAP}`}
          strokeLinecap="round"
          animatedProps={rightProps}
        />
      </Svg>
      <Animated.View
        style={[
          styles.heroChipPhone,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
          phoneStyle,
        ]}
      >
        <Smartphone size={20} color={tokens.accent} strokeWidth={2.2} />
      </Animated.View>
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
    // ── no host yet: the BROKEN-LINK moment + ONE primary action (R116-c) ──
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
        <View style={styles.centerBody}>
          <View style={styles.spacerTop} />
          <View style={styles.hero}>
            <FadeInUp index={0}>
              <ConnectPairHero />
            </FadeInUp>
            <FadeInUp index={1}>
              <TypeDisplay style={styles.title}>Currently not connected</TypeDisplay>
            </FadeInUp>
            <FadeInUp index={2}>
              <TypeCaption style={[styles.tagline, { color: tokens.textTertiary }]} numberOfLines={1}>
                Pair with your desktop to begin.
              </TypeCaption>
            </FadeInUp>
          </View>
          {/* The ONE primary button (donts #39 — two option cards where one
              button carries the intent is a reject), raised directly under
              the hero on the welcome grammar; manual entry lives inside the
              scanner, not here. */}
          <FadeInUp index={3} style={styles.ctaWrap}>
            <ChromeButton
              flat
              testID="hub-connect"
              onPress={() => router.push("/connect/scan")}
              style={styles.cta}
              accessibilityLabel="Connect to PC"
            >
              {/* The label row: leading scanner glyph + text, one 8px gutter.
                  The inner Text copies ChromeButton's label recipe verbatim —
                  styles do not inherit across the inline View boundary. */}
              <View style={styles.ctaRow}>
                <ScanLine size={20} color={tokens.accentText} strokeWidth={2.2} />
                <Text style={[styles.ctaLabel, { color: tokens.accentText }]}>Connect to PC</Text>
              </View>
            </ChromeButton>
          </FadeInUp>
          <View style={styles.spacerBottom} />
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
  // (the Minimal-Center archetype); the CTA rides directly under the hero
  // (R116-c's raised grammar) and the rest breathes below.
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
  tagline: { textAlign: "center" },
  bottomBreath: { height: spacing.xxl },
  ctaWrap: { marginTop: spacing.xl },
  cta: { minHeight: 56, borderRadius: RADIUS_BAR },
  ctaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  ctaLabel: { fontSize: TYPE_BODY, fontFamily: fontFamily.bold, letterSpacing: 0.2 },
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
