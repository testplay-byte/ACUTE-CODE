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
 */

import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
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
import { Bell, MessageSquareText, ShieldCheck, Smartphone } from "lucide-react-native";
import {
  ChromeButton,
  FadeInUp,
  PressableCard,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeDisplay,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, RADIUS_TILE, TILE_HERO, TILE_ROW, spacing } from "@/design/tokens";
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
      body: "Every project and session, live from your pocket.",
    },
    {
      icon: ShieldCheck,
      title: "Approve from your pocket",
      body: "Permission asks land here, one tap to answer.",
    },
    {
      icon: Bell,
      title: "Know the moment it matters",
      body: "Finished tasks and failures arrive live.",
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
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
              tileStyle,
            ]}
          >
            <Smartphone size={30} color={tokens.accent} strokeWidth={2.2} />
          </Animated.View>
          <FadeInUp index={1}>
            <TypeDisplay style={styles.title}>ACUTE</TypeDisplay>
          </FadeInUp>
          <FadeInUp index={2}>
            <TypeBody style={[styles.tagline, { color: tokens.textTertiary }]}>
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
                  <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
                    <Icon size={20} color={tokens.accent} strokeWidth={2.2} />
                  </View>
                  <View style={styles.rowText}>
                    <TypeBodyStrong>{row.title}</TypeBodyStrong>
                    <TypeCaption>{row.body}</TypeCaption>
                  </View>
                </View>
              </PressableCard>
            );
          })}
        </View>

        {/* R115: the "YOUR DESKTOP DOES ALL THE WORK…" kicker is deleted —
            the flex space-between leaves deliberate breathing room between
            the cards and the CTA (onboarding.md screen 1). */}
        <View style={styles.footer}>
          <FadeInUp index={CTA_STAGGER}>
            <ChromeButton
              flat
              testID="welcome-get-started"
              onPress={() => router.push("/onboarding/permissions")}
            >
              Get started
            </ChromeButton>
          </FadeInUp>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.xxl, justifyContent: "space-between" },
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
  tagline: { textAlign: "center", maxWidth: 260 },
  rows: { gap: spacing.md },
  rowInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  rowIcon: {
    width: TILE_ROW,
    height: TILE_ROW,
    borderRadius: RADIUS_INPUT,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: spacing.xs },
  footer: { paddingBottom: spacing.xl },
});
