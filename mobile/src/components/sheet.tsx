/**
 * Sheet — the reusable BOTTOM SHEET, built from the house primitives +
 * Reanimated inside a RN <Modal> (R113-c; NO new dependency): a scrim that
 * fades in, a clay panel that slides up under the over-damped SHEET spring
 * (R116-b: 210/30 — panels never bounce), and the honest close affordances
 * (the scrim tap, the X, Android's back button — the Modal's own
 * onRequestClose). The Modal host
 * keeps the sheet above EVERYTHING (keyboard included) without position
 * tricks inside the composer's subtree. The design language stays Clay
 * Studio — the elevated card surface, the matte top edge, the house radii —
 * exactly like the preferences/provider screens' expand patterns, just
 * anchored to the bottom. Every row the callers render must keep the 44px
 * touch discipline.
 *
 * R115 — the ghost-panel fix: the panel now enters FULLY OPAQUE, sliding its
 * whole height from below the fold (the old 96px-rise + 0.4-start opacity let
 * the page show through/below the sheet during the open animation). The scrim
 * rides its own faster timing so the dim completes as the panel crosses the
 * fold. Exit unchanged: spring-down + unmount after the timing settles.
 *
 * R116-b — the round-116 mechanics (components.md §Sheets, motion.md §1): the
 * entrance rides the over-damped SHEET_SPRING (210/30 — no overshoot, no
 * settle-wobble), the progress value is CLAMPED to [0,1] so the panel can
 * never dip below its rest even if a future spring overshoots, and the panel
 * carries a below-the-fold SKIRT (sacrificial card pixels hanging past the
 * fold) so the page background is never visible under it mid-animation. The
 * inner ScrollView sets overScrollMode="never" (no Android stretch). The
 * skirt is compensated INSIDE (scroller max + content padding) so the resting
 * geometry and the visible breathing room are pixel-identical to R115.
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
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption } from "@/design/primitives";
import { RADIUS_TILE, spacing, TYPE_BODY } from "@/design/tokens";
import { SHEET_SPRING } from "@/design/motion";

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
  // R116-b — the skirt's depth: the fixed share plus the safe-area/legroom
  // maximum, i.e. exactly the region under the fold that a mid-animation dip
  // could otherwise expose. The panel hangs this far below the fold; the
  // resting top edge and the visible content padding are compensated to stay
  // byte-identical to R115 (see maxContentHeight + the scroller's padding).
  const skirtDepth = SKIRT_PX + Math.max(insets.bottom, spacing.lg);
  // R114 — the systemic empty-sheet fix: Android's Yoga collapses a flex:1
  // ScrollView inside a content-sized (auto-height) panel to ZERO height —
  // every sheet rendered as just the title row + X. The scroller is now
  // clamped in PIXELS (resolved against the live window height) so the panel
  // can wrap its content without the flex chicken-and-egg.
  // R116-b — the scroller's max grows by the skirt so the panel's RESTING top
  // edge stays exactly where R115 put it (the skirt hangs below the fold, it
  // never steals screen real estate).
  const maxContentHeight =
    Math.max(240, Math.round(windowHeight * maxHeightFraction) - SHEET_CHROME) +
    skirtDepth;
  // R115 — two independent values: the panel spring and the scrim's faster
  // timing. Mount/unmount discipline: the panel springs IN on open, times OUT
  // on close, and the Modal unmounts only after the exit settles — one clean
  // animation, never a hard cut, never a flash of unanimated content.
  const panelProgress = useSharedValue(0);
  const scrimProgress = useSharedValue(0);
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      scrimProgress.value = withTiming(1, { duration: 160 });
      // R116-b: the over-damped SHEET spring — heavy and settled, no bounce.
      panelProgress.value = withSpring(1, SHEET_SPRING);
      return;
    }
    scrimProgress.value = withTiming(0, { duration: 160 });
    panelProgress.value = withTiming(0, { duration: 180 }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, panelProgress, scrimProgress]);

  // The panel's slide travel: at least its own maximum height, so the sheet
  // enters from fully below the fold — the background is never visible
  // through or beneath the rising panel.
  const panelTravel = Math.round(windowHeight * maxHeightFraction) + 48;

  const scrim = useAnimatedStyle(() => ({ opacity: scrimProgress.value }));
  // R116-b — the clamp: the progress is interpolated on [0,1] with
  // Extrapolation.CLAMP, so even if a spring ever overshoots 1 the translateY
  // can never go positive past the resting position. The panel physically
  // cannot dip below its rest; the skirt below the fold keeps the background
  // covered through every frame of the ride.
  const panel = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          panelProgress.value,
          [0, 1],
          [panelTravel, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
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
            { backgroundColor: tokens.isDark ? "rgba(0,0,0,0.62)" : "rgba(26,18,10,0.45)" },
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
                // round-117-elevation §2.2: the panel's upward shadow rides the
                // theme token (clayShadowSheet) — the hardcoded string is gone.
                boxShadow: tokens.clayShadowSheet,
                // R116-b — the skirt: the panel's border box hangs this far
                // below the fold (sacrificial card pixels), so a mid-animation
                // dip can never reveal the page background under the sheet.
                marginBottom: -skirtDepth,
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
                {
                  // R116-b: the skirt's inner compensation — the content's
                  // bottom padding grows by the skirt so the VISIBLE breathing
                  // room above the fold is exactly what R115 rendered.
                  paddingBottom:
                    Math.max(insets.bottom, spacing.lg) + spacing.sm + skirtDepth,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              overScrollMode="never"
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

/**
 * R116-b — the below-the-fold skirt's fixed share (components.md §Sheets).
 * The panel hangs SKIRT_PX + the safe-area/legroom maximum below the fold;
 * the resting top edge and the visible content padding are unchanged (the
 * scroller max + the content's bottom padding grow by the same depth).
 */
const SKIRT_PX = 28;

const styles = StyleSheet.create({
  anchor: {
    ...StyleSheet.absoluteFill,
    justifyContent: "flex-end",
  },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: RADIUS_TILE,
    borderTopRightRadius: RADIUS_TILE,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  gripRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xs,
  },
  grip: {
    width: 32,
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
