/**
 * Sheet — the reusable BOTTOM SHEET, built from the house primitives +
 * Reanimated inside a RN <Modal> (R113-c; NO new dependency): a scrim that
 * fades in, a clay panel that slides up under the ONE spring (stiffness 180
 * / damping 22), and the honest close affordances (the scrim tap, the X,
 * Android's back button — the Modal's own onRequestClose). The Modal host
 * keeps the sheet above EVERYTHING (keyboard included) without position
 * tricks inside the composer's subtree. The design language stays Clay
 * Studio — the elevated card surface, the matte top edge, the house radii —
 * exactly like the preferences/provider screens' expand patterns, just
 * anchored to the bottom. Every row the callers render must keep the 44px
 * touch discipline.
 */

import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption } from "@/design/primitives";
import { RADIUS_CARD, spacing, TYPE_BODY } from "@/design/tokens";
import { SPRING } from "@/design/motion";

export interface SheetProps {
  /** Whether the sheet is open (the caller owns the state). */
  open: boolean;
  /** Close handler (the scrim tap, the X, and Android's back button). */
  onClose: () => void;
  /** The sheet's title (the grab-handle row's caption). */
  title: string;
  children: React.ReactNode;
  /** Max height fraction of the viewport (default 0.78 — scrolls inside). */
  maxHeightFraction?: number;
  testID?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  maxHeightFraction = 0.78,
  testID,
}: SheetProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // R114 — the systemic empty-sheet fix: Android's Yoga collapses a flex:1
  // ScrollView inside a content-sized (auto-height) panel to ZERO height —
  // every sheet rendered as just the title row + X. The scroller is now
  // clamped in PIXELS (resolved against the live window height) so the panel
  // can wrap its content without the flex chicken-and-egg.
  const maxContentHeight = Math.max(
    240,
    Math.round(windowHeight * maxHeightFraction) - SHEET_CHROME,
  );
  const progress = useSharedValue(0);
  // Mount/unmount discipline: the panel springs IN on open, times OUT on
  // close, and the Modal unmounts only after the exit settles — one clean
  // animation, never a hard cut, never a flash of unanimated content.
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      progress.value = withSpring(1, SPRING);
      return;
    }
    progress.value = withTiming(0, { duration: 180 }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, progress]);

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panel = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * 96 }],
    opacity: 0.4 + 0.6 * progress.value,
  }));

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            scrim,
            { backgroundColor: tokens.isDark ? "rgba(0,0,0,0.55)" : "rgba(26,18,10,0.35)" },
          ]}
        >
          <Pressable
            accessibilityLabel="Close the sheet"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={onClose}
          />
        </Animated.View>
        <View style={styles.anchor}>
          <Animated.View
            // No accessibilityRole — RN's type surface carries no "dialog"
            // (the Modal itself is the native dialog window on Android).
            accessibilityLabel={title}
            style={[
              panel,
              styles.panel,
              {
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
              },
            ]}
          >
            <View style={styles.gripRow}>
              <View style={[styles.grip, { backgroundColor: tokens.borderStrong }]} />
              <TypeCaption style={{ flex: 1 }} numberOfLines={1}>
                {title}
              </TypeCaption>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={10}
                onPress={onClose}
                style={styles.closeTarget}
              >
                <X size={TYPE_BODY + 1} color={tokens.textSecondary} strokeWidth={2.2} />
              </Pressable>
            </View>
            <ScrollView
              style={{ maxHeight: maxContentHeight }}
              contentContainerStyle={[
                styles.content,
                { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.sm },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

/** The non-content chrome above the scroller (grip row 44 + padding + buffer). */
const SHEET_CHROME = 64;

const styles = StyleSheet.create({
  anchor: {
    ...StyleSheet.absoluteFill,
    justifyContent: "flex-end",
  },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: RADIUS_CARD,
    borderTopRightRadius: RADIUS_CARD,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    boxShadow: "0px -2px 18px rgba(42,32,24,0.18)",
  },
  gripRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xs,
  },
  grip: {
    width: 28,
    height: 4,
    borderRadius: 2,
    opacity: 0.6,
  },
  closeTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -spacing.sm,
  },
  content: {
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
});
