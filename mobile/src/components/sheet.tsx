/**
 * Sheet — the reusable BOTTOM SHEET, built from the house primitives +
 * Reanimated inside a RN <Modal> (R113-c; NO new dependency): a scrim that
 * fades in, a clay panel that slides up under the over-damped SHEET spring
 * (R116-b: 210/30 — panels never bounce), and the honest close affordances
 * (the scrim tap, the X circle, Android's back button — the Modal's own
 * onRequestClose). The Modal host
 * keeps the sheet above EVERYTHING (keyboard included) without position
 * tricks inside the composer's subtree. The design language stays Clay
 * Studio — the elevated card surface, the matte top edge, the house radii —
 * exactly like the preferences/provider screens' expand patterns, just
 * anchored to the bottom. Every row the callers render must keep the 44px
 * touch discipline.
 *
 * R115 — the ghost-panel fix: the panel now enters FULLY OPAQUE, sliding its
 * whole height from below the fold. The scrim rides its own faster timing
 * so the dim completes as the panel crosses the fold.
 *
 * R116-b — the round-116 mechanics (components.md §Sheets, motion.md §1): the
 * entrance rides the over-damped SHEET_SPRING (no overshoot, no
 * settle-wobble), the progress value is CLAMPED to [0,1], and the panel
 * carries a below-the-fold SKIRT (sacrificial card pixels hanging past the
 * fold) so the page background is never visible under it mid-animation. The
 * inner ScrollView sets overScrollMode="never" (no Android stretch).
 *
 * R118-A (the owner's round-118 verdict — "the bottom-up menu is trash"):
 * (1) THE FIRST-FRAME LAW: the Modal surfaces a NEW Android window whose
 * first frame(s) can composite BEFORE Reanimated's UI thread attaches the
 * animated props — and `useAnimatedStyle`'s JS-side return for those frames
 * is an EMPTY style object, so the panel painted at its layout position
 * (fully OPEN at rest) and the scrim at opacity 1. That was the owner's
 * "it just directly opens up from the bottom, then after a small while it
 * plays the animation" artifact. The fix is the STATIC INITIAL POSE in the
 * style arrays: a plain `transform: translateY(panelTravel)` / `opacity: 0`
 * placed BEFORE the animated style — RN's array flattening is last-wins per
 * key, so the static pose holds every frame until the worklet reports, then
 * silently loses. Deterministic, inert after frame one, zero timing
 * dependency. (2) THE HEADER: the grip is DELETED (a non-draggable sheet
 * wears no drag handle — the owner read it as "a simple line"), and the
 * title row becomes the header grammar: TypeTitle 20/700 left + a 36px
 * QuietIconButton close (the back-button circle, per the owner's "just like
 * how the back button is"). (3) SHEET_CHROME stays 64 — re-derived: sm 8 +
 * header 48 + xs 4 + 4 buffer.
 *
 * R118-E (the keyboard law): the sheet is KEYBOARD-AWARE — the panel rides
 * the IME (translateY -= min(kbHeight, headroom) on the SHEET spring, fed by
 * RN-core Keyboard events — guaranteed to fire from the Modal's own window,
 * unlike inset-plumbing libraries), and the ScrollView's content padding
 * absorbs the unrisen remainder so bottom fields scroll clear even when a
 * tall panel cannot rise further. KeyboardAvoidingView stays BANNED inside
 * sheets (the R115-K ruling — its padding math is parent-frame-relative and
 * under-reports on inset devices).
 *
 * R119-P (the owner's round-119 verdict — the Add-Provider sheet's UI was
 * right but "the animations were not that good"): the entrance now rides the
 * house DISCLOSURE settle (SHEET_SPRING {180, 24} — motion.ts, superseding
 * R116-b's stiffer 210/30 snap), the scrim fades in 200ms ease-out cubic
 * (was 160 linear), the close is a 200ms ease-in-quad DEPARTURE on both legs
 * (was 180/160 linear), and the content row (below the header) gains a
 * 120ms fade-in starting 40ms after the panel begins to move — the header
 * lands first, the body follows (reduced motion snaps it, the Entrance
 * idiom). The first-frame static-pose law, SHEET_CHROME/SHEET_HEADER_ROW,
 * SKIRT_PX, the keyboard-ride mechanics, and maxHeightFraction are all
 * untouched (frozen this round).
 */

import { useEffect, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { QuietIconButton } from "@/design/primitives";
import { RADIUS_TILE, SHEET_HEADER_ROW, spacing, TYPE_TITLE, fontFamily } from "@/design/tokens";
import {
  SHEET_CLOSE_MS,
  SHEET_CONTENT_FADE_DELAY_MS,
  SHEET_CONTENT_FADE_MS,
  SHEET_SCRIM_OPEN_MS,
  SHEET_SPRING,
} from "@/design/motion";

export interface SheetProps {
  /** Whether the sheet is open (the caller owns the state). */
  open: boolean;
  /** Close handler (the scrim tap, the X, and Android's back button). */
  onClose: () => void;
  /** The sheet's title (the header row's TypeTitle). */
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
  // R118-A — the scroller's max grows by the skirt so the panel's RESTING top
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
  // R119-P — the CONTENT RIDE: a third value fading the children container
  // (below the header row) in 40ms after the panel begins to move (120ms,
  // ease-out) — the header lands first, the body follows; the read is "the
  // sheet settles onto its content" instead of one flat block snapping up.
  // Driven in the SAME open/close effect as the panel (one effect, three
  // values — no second animation pipeline).
  const contentProgress = useSharedValue(0);
  const [rendered, setRendered] = useState(open);
  // The content ride honors the house reduced-motion pattern (the
  // primitives' Entrance idiom: snap to the end state, never a fade). The
  // panel/scrim legs stay always-on exactly as R115/R116-b/R118-A left
  // them — their laws are frozen this round.
  const reducedMotion = useReducedMotion();

  // R118-E — the keyboard ride: how far the panel lifts when the IME shows
  // (clamped to the headroom between the panel's resting top and the screen
  // top), animated on the same over-damped SHEET spring. The unrisen
  // remainder grows the scroller's bottom padding (JS state — one re-render
  // per keyboard transition, none per frame).
  const rise = useSharedValue(0);
  const [panelRestTopY, setPanelRestTopY] = useState(windowHeight);
  const [kbRemainder, setKbRemainder] = useState(0);

  useEffect(() => {
    if (open) {
      setRendered(true);
      // R119-P: the scrim eases OUT over 200ms (was 160 linear) — the dim
      // completes as the panel crosses the fold, without the abrupt tail
      // the linear cut left.
      scrimProgress.value = withTiming(1, {
        duration: SHEET_SCRIM_OPEN_MS,
        easing: Easing.out(Easing.cubic),
      });
      // R116-b: the over-damped SHEET spring — heavy and settled, no bounce.
      // R119-P: SHEET_SPRING is now the house DISCLOSURE settle {180, 24}
      // (the owner's "animations were not that good" verdict — the R116-b
      // 210/30 pair read as a snap-cut; see motion.ts).
      panelProgress.value = withSpring(1, SHEET_SPRING);
      // R119-P: the content ride — delayed 40ms so the panel's rise leads,
      // then a 120ms ease-out fade (or the instant snap under reduced
      // motion — never a fade for the reduced-motion reader).
      contentProgress.value = reducedMotion
        ? 1
        : withDelay(
            SHEET_CONTENT_FADE_DELAY_MS,
            withTiming(1, { duration: SHEET_CONTENT_FADE_MS, easing: Easing.out(Easing.cubic) }),
          );
      return;
    }
    // R119-P: the close is an accelerating DEPARTURE — 200ms ease-in quad
    // on both legs (was 180ms linear panel + 160ms linear scrim): the sheet
    // gathers itself and leaves, matching how a dismissal feels. The scrim
    // matches the panel's duration + curve so the dim and the slide read as
    // ONE exit.
    scrimProgress.value = withTiming(0, {
      duration: SHEET_CLOSE_MS,
      easing: Easing.in(Easing.quad),
    });
    panelProgress.value = withTiming(
      0,
      { duration: SHEET_CLOSE_MS, easing: Easing.in(Easing.quad) },
      (finished) => {
        if (finished) runOnJS(setRendered)(false);
      },
    );
    contentProgress.value = withTiming(0, {
      duration: SHEET_CONTENT_FADE_MS,
      easing: Easing.in(Easing.quad),
    });
  }, [open, panelProgress, scrimProgress, contentProgress, reducedMotion]);

  // R118-E — RN-core Keyboard events fire from the window hosting the
  // focused TextInput (the Modal's own dialog window on Android), so the
  // feed is guaranteed inside the sheet with zero library plumbing.
  useEffect(() => {
    if (!rendered) return;
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      const headroom = Math.max(0, panelRestTopY - insets.top - spacing.xl);
      const kb = e.endCoordinates.height;
      rise.value = withSpring(Math.min(kb, headroom), SHEET_SPRING);
      setKbRemainder(Math.max(0, Math.round(kb - headroom)));
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      rise.value = withSpring(0, SHEET_SPRING);
      setKbRemainder(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [rendered, panelRestTopY, insets.top, rise]);

  useEffect(() => {
    if (!rendered) {
      rise.value = 0;
      setKbRemainder(0);
    }
  }, [rendered, rise]);

  // The panel's slide travel: at least its own maximum height, so the sheet
  // enters from fully below the fold — the background is never visible
  // through or beneath the rising panel.
  const panelTravel = Math.round(windowHeight * maxHeightFraction) + 48;

  const scrim = useAnimatedStyle(() => ({ opacity: scrimProgress.value }));
  // R119-P — the content ride's style (the children container below the
  // header row). The STATIC zero-opacity pose placed BEFORE the animated
  // style is the R118-A first-frame law applied to the new value: the
  // Modal's first composited frame(s) must find the content hidden exactly
  // as they find the panel below the fold (last-wins takes over once the
  // worklet reports).
  const contentFade = useAnimatedStyle(() => ({ opacity: contentProgress.value }));
  // R116-b — the clamp: the progress is interpolated on [0,1] with
  // Extrapolation.CLAMP, so even if a spring ever overshoots 1 the translateY
  // can never go positive past the resting position. R118-E — the keyboard
  // rise subtracts INSIDE the same worklet so the entrance and the IME ride
  // compose without drift.
  const panel = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          interpolate(
            panelProgress.value,
            [0, 1],
            [panelTravel, 0],
            Extrapolation.CLAMP,
          ) - rise.value,
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
            // R118-A — the first-frame guard: an unset opacity renders 1 (a
            // one-frame full-black scrim before the fade-in). Zero until
            // `scrim` lands, then last-wins takes over.
            { opacity: 0 },
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
            onLayout={(e) => {
              // R118-E — the panel's RESTING top edge (layout ignores the
              // transform, so y is stable at rest) — the keyboard ride's
              // headroom reference.
              setPanelRestTopY(e.nativeEvent.layout.y);
            }}
            style={[
              styles.panel,
              // R118-A — the static initial pose: the Modal's NEW Android
              // window can composite a frame BEFORE Reanimated's UI thread
              // applies the animated transform; those frames must find the
              // panel BELOW THE FOLD, never at rest. Array flattening is
              // last-wins: once `panel` reports its transform this line is
              // inert; until then it holds the pose.
              { transform: [{ translateY: panelTravel }] },
              panel,
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
            {/* R118-A — the header row: TypeTitle left + the quiet circle
                close (the back-button grammar the owner ruled). The grip is
                DELETED — a non-draggable sheet wears no drag handle. */}
            <View style={styles.headerRow}>
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.headerTitle, { color: tokens.text }]}
              >
                {title}
              </Text>
              <QuietIconButton
                icon={X}
                iconSize={18}
                size={36}
                hitSlop={8}
                onPress={onClose}
                accessibilityLabel="Close"
              />
            </View>
            {/* R119-P — the CONTENT RIDE: the scroller (everything below the
                header row) fades in 40ms after the panel begins its rise —
                the header lands first, the body follows. The scroller keeps
                its R114 pixel clamp + the R116-b/R118-E padding laws
                byte-identical; only the opacity rides. */}
            <Animated.ScrollView
              style={[{ maxHeight: maxContentHeight }, { opacity: 0 }, contentFade]}
              contentContainerStyle={[
                styles.content,
                {
                  // R116-b: the skirt's inner compensation — the content's
                  // bottom padding grows by the skirt so the VISIBLE breathing
                  // room above the fold is exactly what R115 rendered.
                  // R118-E: plus the unrisen keyboard remainder — the scroll
                  // floor ends above the IME even when the panel cannot ride
                  // fully onto it.
                  paddingBottom:
                    Math.max(insets.bottom, spacing.lg) +
                    spacing.sm +
                    skirtDepth +
                    kbRemainder,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              overScrollMode="never"
            >
              {children}
            </Animated.ScrollView>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

/** The non-content chrome above the scroller.
 *  R118-A re-derivation: paddingTop sm (8) + header row 48 + content
 *  paddingTop xs (4) + buffer 4 = 64 — the R114 clamp math is preserved
 *  byte-for-byte. */
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
  /** R118-A — the header row: 48 tall, the title left-aligned with the
   *  fields below (the panel's own lg gutter is the row's gutter), the
   *  close circle right (its hitSlop reaches past the panel's edge). */
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    height: SHEET_HEADER_ROW,
    paddingHorizontal: spacing.xs,
  },
  headerTitle: {
    flex: 1,
    fontSize: TYPE_TITLE,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.2,
  },
  content: {
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
});
