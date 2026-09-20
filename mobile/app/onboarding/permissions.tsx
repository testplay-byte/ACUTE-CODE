/**
 * The wizard's permissions step — the camera ask, rendered as the
 * Minimal-Center archetype (R115): the icon tile slightly above center, the
 * title, ONE line, and the button. Nothing else — the 1-2-3 steps card and
 * the denied-mode essay are deleted (screen-archetypes.md §1).
 *
 * The granted moment is the screen's one animated sequence (motion.md §4.2):
 * the tile springs its background to success, the Camera icon crossfades to
 * Check, Skip slides out (width + opacity, then unmounts), THEN Continue
 * enters. Internet access is a normal permission Android grants silently;
 * push notifications arrive with the Firebase round.
 */

import { useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Camera, Check } from "lucide-react-native";
import { ChromeButton, FadeInUp, QuietButton, TypeBody, TypeDisplay } from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_TILE, TILE_HERO_COMPACT, getContrastText, spacing } from "@/design/tokens";
import { CROSSFADE_MS, ENTRANCE_SCALE_FROM, SPRING } from "@/design/motion";
import { mobLog } from "@/lib/log";

export default function PermissionsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [denied, setDenied] = useState(false);

  const granted = cameraPermission?.granted ?? false;

  // The granted sequence's bookkeeping: Skip collapses (width + opacity)
  // and unmounts, THEN Continue enters — skipGone is the "then" gate. (If
  // the permission is already granted at mount, there is no Skip to hide.)
  const [skipGone, setSkipGone] = useState(granted);

  async function onRequest() {
    try {
      const result = await requestCamera();
      if (result.granted) {
        setDenied(false);
        void successHaptic();
        mobLog("onboarding", "camera permission granted");
      } else {
        setDenied(true);
        void warningHaptic();
        mobLog("onboarding", "camera permission denied");
      }
    } catch (err) {
      mobLog("onboarding", "camera permission request failed", err instanceof Error ? err.message : err);
      setDenied(true);
    }
  }

  // The hero tile's entrance (scale 0.9→1 on the house spring — no idle
  // float here; the float is the welcome hero's alone).
  const entrance = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      entrance.value = 1;
      return;
    }
    entrance.value = withSpring(1, SPRING);
  }, [reduced, entrance]);

  // The granted morph: the tile background springs to success while the
  // icon crossfades (~200ms) — two values, one moment.
  const grant = useSharedValue(0);
  const iconFade = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      grant.value = granted ? 1 : 0;
      iconFade.value = granted ? 1 : 0;
      return;
    }
    grant.value = withSpring(granted ? 1 : 0, SPRING);
    iconFade.value = withTiming(granted ? 1 : 0, { duration: CROSSFADE_MS });
  }, [granted, reduced, grant, iconFade]);

  // Skip's exit: width + opacity spring to 0, unmount on settle.
  const skipExit = useSharedValue(1);
  const skipWidth = useSharedValue(0);
  useEffect(() => {
    if (!granted || skipGone) return;
    if (reduced) {
      setSkipGone(true);
      return;
    }
    skipExit.value = withSpring(0, SPRING, (finished) => {
      if (finished) runOnJS(setSkipGone)(true);
    });
  }, [granted, skipGone, reduced, skipExit]);

  // Captured token colors for the worklets (re-captured on theme change).
  const cardColor = tokens.card;
  const successColor = tokens.success;
  const topEdgeColor = tokens.clayTopEdge;

  const tileStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ENTRANCE_SCALE_FROM + entrance.value * (1 - ENTRANCE_SCALE_FROM) }],
    backgroundColor: interpolateColor(grant.value, [0, 1], [cardColor, successColor]),
    borderTopColor: interpolateColor(grant.value, [0, 1], [topEdgeColor, successColor]),
  }));
  const cameraStyle = useAnimatedStyle(() => ({ opacity: 1 - iconFade.value }));
  const checkStyle = useAnimatedStyle(() => ({ opacity: iconFade.value }));

  const skipCollapse = useAnimatedStyle(() => {
    // At rest the wrapper stretches naturally; while exiting its width
    // rides the spring down to 0 (measured once, at full width).
    if (skipExit.value >= 1) return { opacity: 1 };
    return {
      width: skipWidth.value * skipExit.value,
      opacity: skipExit.value,
      overflow: "hidden" as const,
    };
  });

  const showSkip = !granted && !skipGone;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        {/* The 0.9/1 flex spacers hold the icon+title cluster slightly
            ABOVE the vertical middle (the Minimal-Center archetype). */}
        <View style={styles.spacerTop} />
        <View style={styles.hero}>
          <Animated.View
            accessibilityLabel={granted ? "Camera permission granted" : "Camera permission"}
            style={[styles.iconTile, { boxShadow: tokens.clayShadow2 }, tileStyle]}
          >
            <Animated.View style={[styles.iconLayer, cameraStyle]} pointerEvents="none">
              <Camera size={28} color={tokens.accent} strokeWidth={2.2} />
            </Animated.View>
            <Animated.View style={[styles.iconLayer, checkStyle]} pointerEvents="none">
              <Check size={28} color={getContrastText(tokens.success)} strokeWidth={2.6} />
            </Animated.View>
          </Animated.View>
          <FadeInUp index={1}>
            <TypeDisplay style={styles.title}>Camera access</TypeDisplay>
          </FadeInUp>
          <FadeInUp index={2}>
            <TypeBody style={[styles.tagline, { color: denied ? tokens.warning : tokens.textTertiary }]}>
              {denied ? "Camera blocked — you can type the code instead." : "Scan your desktop's pairing code."}
            </TypeBody>
          </FadeInUp>
        </View>
        <View style={styles.spacerBottom} />

        <View style={styles.footer}>
          {granted ? (
            <FadeInUp active={skipGone}>
              <ChromeButton
                flat
                testID="permissions-continue"
                onPress={() => router.push("/onboarding/connect")}
              >
                Continue
              </ChromeButton>
            </FadeInUp>
          ) : (
            <FadeInUp index={3}>
              <ChromeButton flat testID="permissions-allow" onPress={() => void onRequest()}>
                Allow camera access
              </ChromeButton>
            </FadeInUp>
          )}
          {showSkip ? (
            <FadeInUp index={4}>
              <Animated.View
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  if (w > skipWidth.value) skipWidth.value = w;
                }}
                style={skipCollapse}
              >
                <QuietButton testID="permissions-skip" onPress={() => router.push("/onboarding/connect")}>
                  Skip
                </QuietButton>
              </Animated.View>
            </FadeInUp>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg },
  spacerTop: { flex: 0.9 },
  spacerBottom: { flex: 1 },
  hero: { alignItems: "center", gap: spacing.md },
  iconTile: {
    width: TILE_HERO_COMPACT,
    height: TILE_HERO_COMPACT,
    borderRadius: RADIUS_TILE,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  iconLayer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { textAlign: "center" },
  tagline: { textAlign: "center", maxWidth: 300 },
  footer: { gap: spacing.md, paddingBottom: spacing.xl },
});
