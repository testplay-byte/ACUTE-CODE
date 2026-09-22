/**
 * The wizard's welcome step — the brand moment: the app's name, what it is
 * (the COMPANION for the desktop agent — "remote" is banned, copy.md), and
 * the three things it does, each in one line.
 *
 * R115 (the clay-language redesign): the hero animates — the logo tile
 * enters at scale 0.9→1 on the house spring and then floats gently (±4px,
 * ~2.4s — the ONE sanctioned continuous idle animation), the title and
 * tagline fade-in-up, the cards stagger in, and the footer essay is
 * DELETED: the gap between the cards and the flat CTA is intentional
 * breathing room, not a slot waiting to be filled.
 *
 * R116-c (the single-line law + the raised CTA): every line on the screen
 * clamps to ONE line — the tagline, the card titles, the card captions
 * (donts #31; the tail ellipsis is the fallback, wrapping is a defect) —
 * and the CTA gains presence (56 tall, RADIUS_BAR pill, a trailing
 * ArrowRight; clayShadow2 only, never glow) and moves UP: it rides
 * directly under the cards instead of space-between-pinning to the
 * footer, so hero + cards + CTA read as one column and the space below
 * breathes.
 *
 * R117-g2 (round-117-elevation.md §2.2): the feature rows' identity chips
 * are ClayIconChips — the accentTint fill + clayRim hairline + the
 * accentDeep glyph replace the old subtleHover ghost rectangles (§1.5).
 */

import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { ArrowRight, Bell, MessageSquareText, ShieldCheck, Smartphone } from "lucide-react-native";
import {
  ChromeButton,
  ClayIconChip,
  FadeInUp,
  PressableCard,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeDisplay,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import {
  RADIUS_BAR,
  RADIUS_TILE,
  TILE_HERO,
  TYPE_BODY,
  fontFamily,
  spacing,
} from "@/design/tokens";
import {
  ENTRANCE_SCALE_FROM,
  IDLE_FLOAT_DELTA,
  IDLE_FLOAT_LEG_MS,
  SPRING,
} from "@/design/motion";

/** The stagger ladder: hero tile 0 → title 1 → tagline 2 → cards 3–5 → CTA 6. */
const CARD_STAGGER_START = 3;
const CTA_STAGGER = 6;

export default function WelcomeScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();

  const rows = [
    {
      icon: MessageSquareText,
      title: "Work from anywhere",
      body: "Every project and session, live.",
    },
    {
      icon: ShieldCheck,
      title: "Approve from your pocket",
      body: "Permission asks, one tap to answer.",
    },
    {
      icon: Bell,
      title: "Know the moment it matters",
      body: "Finished tasks and failures, live.",
    },
  ];

  // The hero moment: entrance scale 0.9→1 on the house spring, then the
  // gentle idle float (motion.md §4.1 — down 1200ms, back 1200ms, forever,
  // the one resting animation the design language sanctions).
  const entrance = useSharedValue(0);
  const float = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      entrance.value = 1;
      return;
    }
    entrance.value = withSpring(1, SPRING);
    float.value = withRepeat(
      withSequence(
        withTiming(-IDLE_FLOAT_DELTA, { duration: IDLE_FLOAT_LEG_MS }),
        withTiming(0, { duration: IDLE_FLOAT_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [reduced, entrance, float]);

  const tileStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: ENTRANCE_SCALE_FROM + entrance.value * (1 - ENTRANCE_SCALE_FROM) },
      { translateY: float.value },
    ],
  }));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        <View style={styles.hero}>
          <Animated.View
            accessibilityLabel="ACUTE logo"
            style={[
              styles.logoTile,
              {
                // round-117-elevation §2.3: the brand moment — the tile sits in
                // the accent tint with the warm rim; the glyph in the deep accent.
                backgroundColor: tokens.accentTint,
                borderTopColor: tokens.clayTopEdge,
                borderColor: tokens.clayRim,
                borderWidth: StyleSheet.hairlineWidth,
                boxShadow: tokens.clayShadow2,
              },
              tileStyle,
            ]}
          >
            <Smartphone size={32} color={tokens.accentDeep} strokeWidth={2.2} />
          </Animated.View>
          <FadeInUp index={1}>
            <TypeDisplay style={styles.title}>ACUTE</TypeDisplay>
          </FadeInUp>
          <FadeInUp index={2}>
            <TypeBody style={[styles.tagline, { color: tokens.textTertiary }]} numberOfLines={1}>
              The companion for your desktop agent.
            </TypeBody>
          </FadeInUp>
        </View>

        <View style={styles.rows}>
          {rows.map((row, i) => {
            const Icon = row.icon;
            return (
              <PressableCard key={row.title} enterIndex={CARD_STAGGER_START + i}>
                <View style={styles.rowInner}>
                  {/* R117-g2 — the feature rows' ClayIconChip (40, r 14): the
                      accentTint container replaces the subtleHover ghost. */}
                  <ClayIconChip icon={Icon} iconSize={20} />
                  <View style={styles.rowText}>
                    <TypeBodyStrong numberOfLines={1}>{row.title}</TypeBodyStrong>
                    <TypeCaption numberOfLines={1}>{row.body}</TypeCaption>
                  </View>
                </View>
              </PressableCard>
            );
          })}
        </View>

        {/* R115: the "YOUR DESKTOP DOES ALL THE WORK…" kicker is deleted —
            and R116-c raised the CTA: it rides directly under the cards
            (the raised grammar), so hero + cards + CTA are one column and
            the remaining space breathes below (no footer pinning). */}
        <FadeInUp index={CTA_STAGGER} style={styles.ctaWrap}>
          <ChromeButton
            flat
            testID="welcome-get-started"
            onPress={() => router.push("/onboarding/permissions")}
            style={styles.cta}
            accessibilityLabel="Get started"
          >
            {/* The label row: text + trailing arrow, one 8px gutter. The
                inner Text copies ChromeButton's label recipe verbatim —
                styles do not inherit across the inline View boundary. */}
            <View style={styles.ctaRow}>
              <Text style={[styles.ctaLabel, { color: tokens.accentText }]}>Get started</Text>
              <ArrowRight size={20} color={tokens.accentText} strokeWidth={2.2} />
            </View>
          </ChromeButton>
        </FadeInUp>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, paddingBottom: spacing.xl },
  hero: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xxxl },
  logoTile: {
    width: TILE_HERO,
    height: TILE_HERO,
    borderRadius: RADIUS_TILE,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: { letterSpacing: 1.5 },
  // 320: the tagline's honest one-line budget at TypeBody on a 360dp screen
  // (the string measures ~300px — the 260 cap was a wrap defect, donts #31).
  tagline: { textAlign: "center", maxWidth: 320 },
  rows: { gap: spacing.md, marginTop: spacing.xxl },
  rowInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  rowText: { flex: 1, gap: spacing.xs },
  ctaWrap: { marginTop: spacing.xl },
  cta: { minHeight: 56, borderRadius: RADIUS_BAR },
  ctaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  ctaLabel: { fontSize: TYPE_BODY, fontFamily: fontFamily.bold, letterSpacing: 0.2 },
});
