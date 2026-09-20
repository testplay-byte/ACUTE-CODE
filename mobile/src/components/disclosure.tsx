/**
 * Disclosure — the collapsed "optional" row (R115-D): a 44px-target row with
 * a label + ChevronRight, expanding its hidden content on the house spring
 * (chevron rotates 90° alongside — motion.md §3's accordion grammar).
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
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { SPRING } from "@/design/motion";
import { TOUCH_TARGET, spacing } from "@/design/tokens";

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
  const measured = useSharedValue(0);
  const [hasMeasured, setHasMeasured] = useState(false);

  // The callbacks ride a ref — the spring effect runs once per open flip,
  // not per render identity.
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  useEffect(() => {
    if (reduced) {
      chevron.value = open ? 1 : 0;
      height.value = open ? measured.value : 0;
      return;
    }
    chevron.value = withSpring(open ? 1 : 0, SPRING);
    height.value = withSpring(open ? measured.value : 0, SPRING);
  }, [open, reduced, chevron, height, measured]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevron.value * 90}deg` }],
  }));
  const clipStyle = useAnimatedStyle(() => ({ height: height.value }));

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
