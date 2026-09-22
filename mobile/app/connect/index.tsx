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
 * Host linked (R116-f — the owner's verdict #23): a proper CONNECTION page.
 * The hero card leads with WHO — the desktop's word-pair name BIG — over the
 * pinned status vocabulary ("Live" / "Looking for the host…" / "Offline",
 * one line) and the honest "last seen {timeAgo}" micro line. Below it ONE
 * "This connection" section holds the two management rows, each ONE
 * measured line (donts #1/#31 — the option-body essays are dead; the
 * desktop-revokes detail lives on the host details page's disconnect
 * alert). Navigation targets + the retry behavior are byte-identical to the
 * pre-R116-f branch. The hub is a ROOT screen — after onboarding (and after
 * every replace() landing) there is nothing behind it, so the back chevron
 * only renders when the root stack can actually pop (e.g. pushed from the
 * connection pill inside the tabs).
 *
 * R117-g2 (round-117-elevation.md §2.2): the management rows' option chips
 * are ClayIconChips — the accentTint fill + clayRim hairline + the
 * accentDeep glyph replace the bare glyph boxes (the §1.5 ghost-chip kill).
 *
 * R118-B (spec §2.5) — the DESKTOPS switcher: above "This connection" a
 * "Desktops" section lists EVERY stored host (the multi-host store landed
 * this round) — one row per desktop (ClayIconChip Monitor 40 + the
 * word-pair name + "paired {timeAgo}"), the ACTIVE one carrying the
 * success Badge, every other one an ArrowLeftRight that switches the live
 * link (teardown + fresh probe — a 20dp ActivityIndicator rides the row
 * while the switch probes). The scan row's copy turns honest for the
 * multi-host world: pairing ADDS a desktop to this phone (re-pairing a
 * known machine refreshes its slot in place).
 */

import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
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
  ArrowLeftRight,
  Monitor,
  RefreshCw,
  ScanLine,
  Smartphone,
  Unplug,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import {
  Badge,
  ChromeButton,
  ClayCard,
  ClayIconChip,
  FadeInUp,
  PressableCard,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
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
import type { StoredHost } from "@/link/connection";

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
            // round-117-elevation §2.3: the phone chip is "you" — the accent
            // tint + the deep glyph; the desktop chip stays card-colored.
            backgroundColor: tokens.accentTint,
            borderTopColor: tokens.clayTopEdge,
            borderColor: tokens.clayRim,
            borderWidth: StyleSheet.hairlineWidth,
            boxShadow: tokens.clayShadow2,
          },
          phoneStyle,
        ]}
      >
        <Smartphone size={20} color={tokens.accentDeep} strokeWidth={2.2} />
      </Animated.View>
    </View>
  );
}

export default function ConnectHubScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { link, status, host, live, lastSeen } = useLink();
  const [, setTick] = useState(0);

  // R118-B — the stored desktops (the switcher's rows). Reload on every
  // focus: pairing on the scanner / disconnecting on the host page both
  // change the list while this hub sits beneath them in the stack.
  const [hosts, setHosts] = useState<StoredHost[]>([]);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void link.listHosts().then((list) => {
        if (alive) setHosts(list);
      });
      return () => {
        alive = false;
      };
    }, [link]),
  );

  // The switch's trying state: the tapped row spins while its fresh probe
  // runs, then settles (the row re-reads as the active host).
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  useEffect(() => {
    if (switchingId !== null && status !== "probing") setSwitchingId(null);
  }, [status, switchingId]);

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
  // The store's ACTIVE desktop (the manager's host) — the switcher's badge
  // truth; while unpaired the hero branch above owns the screen instead.
  const activeId = host?.machineId ?? null;

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

  // ── host linked (R116-f): the CONNECTION page — the hero grammar + the
  //     one "This connection" section. ──
  return (
    <ScreenScaffold title="Connect" back={canPopRoot} noPill>
      {/* The hero: WHO — the word-pair name BIG — over the pinned status
          vocabulary (single line) + the honest last-seen micro line. The
          retry behavior is byte-identical: one quiet icon button, only
          while the link isn't live. */}
      <ClayCard elevated>
        <View style={styles.heroPad}>
          <View style={styles.heroTop}>
            <TypeDisplay numberOfLines={1} style={styles.heroName} testID="hub-host-name">
              {host.hostLabel}
            </TypeDisplay>
            {!connected ? (
              <QuietButton onPress={() => getLinkManager().retryNow()} tone="neutral">
                <RefreshCw size={16} color={tokens.textSecondary} strokeWidth={2.2} />
              </QuietButton>
            ) : null}
          </View>
          <View style={styles.heroStatus}>
            <StatusDot
              color={
                connected ? tokens.success : status === "probing" ? tokens.warning : tokens.danger
              }
              pulse={status === "probing"}
            />
            <TypeBodyStrong numberOfLines={1}>
              {connected ? "Live" : status === "probing" ? "Looking for the host…" : "Offline"}
            </TypeBodyStrong>
          </View>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {`last seen ${lastSeen === null ? "never" : timeAgo(lastSeen)}${
              live !== null ? ` · desktop v${live.version}` : ""
            }`}
          </TypeMicro>
        </View>
      </ClayCard>

      {/* ── R118-B — the DESKTOPS switcher: every stored host one row. The
          ACTIVE desktop carries the success Badge (its tap opens the
          details page); every other one carries the switch glyph — tap and
          the live link tears down and re-probes onto that desktop, a 20dp
          spinner riding the row for the probe's duration. The section
          renders only once the list resolves (no header-with-no-rows flash
          on first mount). ── */}
      {hosts.length > 0 ? (
        <>
          <SectionHeader>Desktops</SectionHeader>
          {hosts.map((stored, i) => {
            const isActive = stored.machineId === activeId;
            const switching = switchingId === stored.machineId && status === "probing";
            return (
              <PressableCard
                key={stored.machineId}
                enterIndex={i}
                onPress={
                  isActive
                    ? () => router.push("/settings/host")
                    : () => {
                        setSwitchingId(stored.machineId);
                        void link.switchHost(stored.machineId);
                      }
                }
                accessibilityLabel={
                  isActive
                    ? `${stored.hostLabel}, active desktop — open connection details`
                    : `${stored.hostLabel}, paired ${timeAgo(stored.pairedAt)} — switch the link to this desktop`
                }
                testID={`hub-host-${i}`}
              >
                <View style={styles.hostRowInner}>
                  <ClayIconChip icon={Monitor} iconSize={20} size={40} />
                  <View style={styles.hostRowText}>
                    <TypeBodyStrong numberOfLines={1}>{stored.hostLabel}</TypeBodyStrong>
                    <TypeCaption numberOfLines={1}>{`paired ${timeAgo(stored.pairedAt)}`}</TypeCaption>
                  </View>
                  {switching ? (
                    <ActivityIndicator size="small" />
                  ) : isActive ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <ArrowLeftRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
                  )}
                </View>
              </PressableCard>
            );
          })}
        </>
      ) : null}

      {/* The one management section — both rows, ONE measured line each. */}
      <SectionHeader>This connection</SectionHeader>
      <PressableCard onPress={() => router.push("/settings/host")}>
        <OptionRow
          icon={Unplug}
          title="Manage this connection"
          body="Details, diagnostics, and the disconnect."
        />
      </PressableCard>
      <PressableCard
        onPress={() => router.push("/connect/scan")}
        accessibilityLabel="Scan to add another desktop"
      >
        <OptionRow
          icon={ScanLine}
          title="Scan a new pairing code"
          body="Adds a desktop to this phone."
        />
      </PressableCard>
    </ScreenScaffold>
  );
}

function OptionRow({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <View style={styles.optionInner}>
      {/* R117-g2 — the ClayIconChip (48, r 16): the tinted container replaces
          the bare glyph box; the chip owns the accentDeep color. */}
      <ClayIconChip icon={Icon} iconSize={22} size={48} />
      <View style={styles.optionText}>
        <TypeBody numberOfLines={1}>{title}</TypeBody>
        {/* The single-line law (donts #1/#31): one measured line, never an
            essay — the revoked-desktop detail lives on the host page. */}
        <TypeCaption numberOfLines={1} style={styles.optionBody}>
          {body}
        </TypeCaption>
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
  // The host-linked hero (R116-f): the word-pair name BIG + the pinned
  // status line + the last-seen micro line.
  heroPad: { padding: spacing.lg, gap: spacing.sm },
  heroTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  heroName: { flex: 1 },
  heroStatus: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  optionInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  optionText: { flex: 1, gap: 2 },
  optionBody: { lineHeight: 18 },
  // R118-B — the Desktops switcher's row: [Monitor chip 40 + name/paired
  // caption] with the trailing state (the Active badge / the switch glyph /
  // the switch probe's 20dp spinner).
  hostRowInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  hostRowText: { flex: 1, gap: 2 },
});
