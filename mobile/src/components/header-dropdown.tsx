/**
 * HeaderDropdown — the ANCHORED header menu (R116-l — components.md §Dropdown
 * menus, motion.md §4.8): a kebab/overflow control on a header opens its menu
 * DIRECTLY BELOW the control (top-right corner), springing in on the house
 * spring (scale 0.96→1 + opacity, origin top-right, ~180ms) and dismissing on
 * a scrim-less tap-outside with a 120ms fade — NOT a bottom sheet. Reserved
 * for header chrome; body rows keep sheets (the round-116 idiom).
 *
 * POSITIONING CONTRACT (the simplest honest shape): the caller renders this
 * component inside an absolutely-positioned anchor View aligned to the header
 * row's right/bottom (the session screen: {position:"absolute", top:<header
 * height>, left:0, right:0, bottom:0} with pointerEvents="box-none"). THIS
 * component then fills that anchor with one transparent tap-outside Pressable
 * (every tap below the header dismisses — the header row itself stays live so
 * the kebab toggles closed and the back chip keeps its own tap) and floats the
 * panel at the anchor's top-right. The anchor carries box-none so an empty
 * (closed) layer never steals a touch from the content beneath it.
 *
 * Rows are label (TypeBodyStrong) + live value (TypeCaption, right-aligned,
 * ONE line — the single-line law) + a ChevronRight for detail-routed rows; the
 * danger arm carries the stop glyph instead (the KebabRow grammar the old
 * sheet owned, restated for the menu). Presentation only — no data, no sheets:
 * every row's onPress routes the CALLER's surface (the session screen opens
 * the composer's matching sheet; the dropdown closes first).
 *
 * Reduced motion snaps (motion.md §5): the entrance lands at 1 with no spring,
 * the exit unmounts immediately.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { ChevronRight, Square } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeBodyStrong, TypeCaption, TypeMicro } from "@/design/primitives";
import { SPRING } from "@/design/motion";
import { RADIUS_INPUT, spacing, TOUCH_TARGET } from "@/design/tokens";

/** One menu row: label + live value + the route. */
export interface HeaderDropdownItem {
  /** The row's stable key — also its testID suffix ({testID}-{key}). */
  key: string;
  label: string;
  /** The row's CURRENT value, right-aligned ("Full Access", "42%", …). */
  value?: string;
  /** The danger tone (the stop arm) — a filled stop glyph, no chevron. */
  danger?: boolean;
  onPress: () => void;
}

export interface HeaderDropdownProps {
  /** Whether the menu is open (the caller owns the state). */
  open: boolean;
  /** Dismiss handler (the tap-outside catcher; the caller closes its state). */
  onClose: () => void;
  items: HeaderDropdownItem[];
  /** The panel's testID; each row carries {testID}-{item.key}. */
  testID?: string;
  /** The quiet title row above the items ("Session options"). */
  title?: string;
}

/** The panel's fixed width (~200-240 per components.md §Dropdown menus). */
const PANEL_WIDTH = 220;

/** motion.md §4.8 — the entrance scale floor (0.96→1, origin top-right). */
const ENTRANCE_SCALE = 0.96;

/** motion.md §4.8 — the tap-outside dismissal fade. */
const EXIT_FADE_MS = 120;

export function HeaderDropdown({ open, onClose, items, testID, title }: HeaderDropdownProps) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  // The measured panel height — the scale origin's translateY pin needs it
  // (origin top-right: the top edge stays put while the panel grows).
  const panelHeight = useSharedValue(0);
  // Mount/unmount discipline (the Sheet's): the panel springs in on open,
  // fades out over EXIT_FADE_MS on close, and unmounts only after the exit
  // settles — one clean animation, never a hard cut.
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      progress.value = reduced ? 1 : withSpring(1, SPRING);
      return;
    }
    if (!rendered) return;
    if (reduced) {
      // motion.md §5 — reduced motion snaps: no exit animation at all.
      progress.value = 0;
      setRendered(false);
      return;
    }
    progress.value = withTiming(0, { duration: EXIT_FADE_MS }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, rendered, reduced, progress]);

  // The entrance: opacity + scale 0.96→1 with the TOP-RIGHT corner pinned —
  // the deterministic origin pin (scale about center + the compensating
  // translations keeps the right and top edges exactly where they rest).
  const panelStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const s = ENTRANCE_SCALE + (1 - ENTRANCE_SCALE) * p;
    return {
      opacity: p,
      transform: [
        { translateX: (1 - s) * (PANEL_WIDTH / 2) },
        { translateY: -((1 - s) * (panelHeight.value / 2)) },
        { scale: s },
      ],
    };
  });

  const onPanelLayout = (event: LayoutChangeEvent): void => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0) panelHeight.value = measured;
  };

  if (!rendered) return null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* The tap-outside catcher — full-layer, transparent, scrim-less
          (components.md §Dropdown menus: never a bottom sheet's dim). */}
      <Pressable
        accessibilityLabel="Dismiss the menu"
        accessibilityRole="button"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      {/* The panel — ClayCard-class: card surface, r14, the matte clay top
          edge, clayShadow2 (the floating menu's elevation). */}
      <Animated.View
        accessibilityLabel={title !== undefined ? title : "Menu"}
        onLayout={onPanelLayout}
        style={[
          styles.panel,
          panelStyle,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
        ]}
        testID={testID}
      >
        {title !== undefined ? (
          <View style={[styles.titleRow, { borderBottomColor: tokens.borderSubtle }]}>
            <TypeMicro style={{ color: tokens.textTertiary }} numberOfLines={1}>
              {title}
            </TypeMicro>
          </View>
        ) : null}
        {items.map((item) => (
          <DropdownRow
            key={item.key}
            item={item}
            testID={testID !== undefined ? `${testID}-${item.key}` : undefined}
          />
        ))}
      </Animated.View>
    </View>
  );
}

/** One menu row — label + CURRENT value right-aligned + the chevron (the
 * danger arm carries the stop affordance instead). The old kebab sheet's
 * KebabRow grammar, restated for the anchored menu. */
function DropdownRow({ item, testID }: { item: HeaderDropdownItem; testID?: string }) {
  const { tokens } = useTheme();
  const danger = item.danger === true;
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={item.value !== undefined ? `${item.label} — ${item.value}` : item.label}
      accessibilityRole="button"
      onPress={item.onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? tokens.subtleHover : "transparent" }]}
    >
      <TypeBodyStrong style={{ flex: 1, color: danger ? tokens.danger : tokens.text }} numberOfLines={1}>
        {item.label}
      </TypeBodyStrong>
      {item.value !== undefined ? (
        <TypeCaption style={{ color: tokens.textSecondary, flexShrink: 1 }} numberOfLines={1}>
          {item.value}
        </TypeCaption>
      ) : null}
      {danger ? (
        <Square size={13} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
      ) : (
        <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** The anchored panel — top-right of the caller's layer, fixed width,
   * r14, the matte top edge + clayShadow2 (the ClayCard elevation idiom). */
  panel: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.sm,
    width: PANEL_WIDTH,
    borderRadius: RADIUS_INPUT,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
    overflow: "hidden",
  },
  titleRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
});
