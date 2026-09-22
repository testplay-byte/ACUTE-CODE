/**
 * Disclosure — the collapsed "optional" row (R115-D): a 44px-target row with
 * a label + ChevronRight, expanding its hidden content (chevron rotates 90°
 * alongside — motion.md §3's accordion grammar).
 *
 * R118-C §2.7 — THE MOTION SPLIT: expansion rides DISCLOSURE_SPRING {180,24}
 * (ζ 0.894 — one soft settle, the bounce the owner likes as a whisper);
 * COLLAPSE rides withTiming 200ms ease-out on the height while the content
 * fades over 150ms — a timing curve cannot overshoot, so closing never
 * bounces. Reduced motion snaps.
 *
 * The height animation uses the R115-plan Yoga fix: the content is measured
 * by an ABSOLUTELY-POSITIONED child (top/left/right) inside the clipping
 * container, so a collapsed height of 0 never clamps the child's own layout
 * measurement (the projects-accordion deadlock, avoided by construction).
 *
 * Controlled: the caller owns `open` (the manual screen's smart-paste expands
 * the certificate row when the clipboard carried a fingerprint).
 */

import { ChevronRight } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { DISCLOSURE_COLLAPSE_MS, DISCLOSURE_FADE_MS, DISCLOSURE_SPRING } from "@/design/motion";
import { TOUCH_TARGET, spacing } from "@/design/tokens";

/** The collapse's timing curve — ease-out, zero overshoot by construction. */
const COLLAPSE_EASING = Easing.out(Easing.quad);

export interface DisclosureProps {
  /** The row's label (text or a small node — the manual screen's mono value). */
  label: React.ReactNode;
  /** The hidden content, revealed on expand. */
  children: React.ReactNode;
  /** Controlled open state — the caller owns it. */
  open: boolean;
  onToggle: () => void;
  testID?: string;
  /** Screen-reader label for the row (defaults to the testID-less label node). */
  accessibilityLabel?: string;
}

export function Disclosure({
  label,
  children,
  open,
  onToggle,
  testID,
  accessibilityLabel,
}: DisclosureProps) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const chevron = useSharedValue(0);
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);
  const measured = useSharedValue(0);
  const [hasMeasured, setHasMeasured] = useState(false);

  // The callbacks ride a ref — the motion effect runs once per open flip,
  // not per render identity.
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  useEffect(() => {
    if (reduced) {
      chevron.value = open ? 1 : 0;
      height.value = open ? measured.value : 0;
      opacity.value = open ? 1 : 0;
      return;
    }
    if (open) {
      // §2.7 — the expand: the disclosure spring (one soft settle).
      chevron.value = withSpring(1, DISCLOSURE_SPRING);
      height.value = withSpring(measured.value, DISCLOSURE_SPRING);
      opacity.value = withSpring(1, DISCLOSURE_SPRING);
    } else {
      // §2.7 — the collapse: timing cannot overshoot; the content fades
      // slightly ahead of the height.
      chevron.value = withTiming(0, { duration: DISCLOSURE_COLLAPSE_MS, easing: COLLAPSE_EASING });
      height.value = withTiming(0, { duration: DISCLOSURE_COLLAPSE_MS, easing: COLLAPSE_EASING });
      opacity.value = withTiming(0, { duration: DISCLOSURE_FADE_MS });
    }
  }, [open, reduced, chevron, height, opacity, measured]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevron.value * 90}deg` }],
  }));
  const clipStyle = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));

  return (
    <View>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibilityLabel}
        onPress={() => toggleRef.current()}
        style={styles.row}
      >
        <View style={styles.rowLabel}>{label}</View>
        <Animated.View style={[styles.chevron, chevronStyle]}>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </Animated.View>
      </Pressable>
      <Animated.View style={[styles.clip, clipStyle]} pointerEvents={open ? "auto" : "none"}>
        {/* The measurement child: absolutely positioned so the collapsed
            clip height can never clamp its own layout (R115-plan fix). */}
        <View
          style={styles.measure}
          onLayout={(event) => {
            const h = event.nativeEvent.layout.height;
            if (h <= 0) return;
            measured.value = h;
            if (!hasMeasured && open) {
              // First measurement landed while already open (smart paste
              // expanded us before layout) — jump straight to it.
              height.value = h;
              setHasMeasured(true);
            } else if (!hasMeasured) {
              setHasMeasured(true);
            }
          }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  rowLabel: { flex: 1 },
  chevron: { alignItems: "center", justifyContent: "center" },
  clip: { overflow: "hidden", height: 0 },
  measure: { position: "absolute", top: 0, left: 0, right: 0 },
});
