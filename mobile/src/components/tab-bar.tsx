/**
 * FloatingTabBar — the bottom navigation (components.md §Tab bar): a
 * floating CLAY slab with spacing on all four sides, radius 28, the
 * elevation-2 shadow, and the sanctioned CHROME edge (the 1px metal-ramp
 * hairline — one of the three chrome surfaces). The bar rides above the
 * content (absolute) and slides away under the keyboard (the one sanctioned
 * damping-26 exception, motion.md §1).
 *
 * R116-b — the owner's anatomy (round-116, components.md §Tab bar + motion.md
 * §4.7): each item is a HORIZONTAL chip — icon LEFT, label RIGHT — and the
 * label renders ONLY on the selected item. Selecting morphs the pair: the
 * newly-selected label breathes IN (animated maxWidth 0→natural + opacity
 * 0→1, TAB_LABEL_MS) while the previous one collapses out. The maxWidth IS
 * the animation of the row's reflow, so the chip re-centers fluidly — the
 * icon glides, never jumps, and the neighbors' slots never move. The shared
 * selection pill wraps the selected chip: a 2px accent border (never
 * hairline — donts.md #34) whose CENTER slides on the calm over-damped
 * TAB_SPRING while its WIDTH rides the label's timing, so the wrap tracks
 * the morph. Label widths are MEASURED once at mount (the hidden measurement
 * row under the items) — the morph and the wrap are font-scale honest, no
 * hardcoded px. The a11y contract is untouched: every item keeps role "tab"
 * + the selected state + an accessibilityLabel carrying the tab name (screen
 * readers read unselected tabs whose visual label is collapsed). Reduced
 * motion snaps both the labels and the pill (motion.md §5).
 *
 * R117-g2 (round-117-elevation.md §2.3 — the tab bar's PRESENCE): the
 * selected chip sits on a warm terracotta-tinted pill — the indicator's
 * fill becomes `accentTint` under the unchanged 2px `accentDeep` border
 * (One UI's signature move, in clay; donts.md #34's never-a-hairline rule
 * holds). The active icon renders 23px / strokeWidth 2.5 in `accentDeep`;
 * inactive icons read `textSecondary` (they were 40%-black ghosts — 62%
 * reads as real chrome). Labels ride the 11.5 floor (TYPE_TAB_LABEL, the
 * label + measurement row switching TOGETHER — byte-identical recipes or
 * the morph mis-measures). The pending badge fills `accentDeep` + the
 * `accentText` ink. Bar height/radius/ChromeEdge/the measurement system
 * are untouched — R116-b's mechanics stay frozen.
 *
 * R115-g — the round-115 approvals mandate (motion.md §4.5): a tab whose
 * `alert` flag is true (pending approvals — derived from badge > 0 by the
 * tabs layout) tints its icon AND label to the accent and BREATHES: a calm
 * ~1.6s opacity cycle (0.75↔1) so the pending state reads at a glance, the
 * badge alone being not enough. The numeric badge keeps the exact count
 * (99+ cap) and sits at the icon's top-right. Reduced motion snaps the
 * breathe off (motion.md §5).
 *
 * R118-B — the ADAPTIVE SLOTS + the corner fix (round-118, spec-b §2.1):
 * the fixed `flex: 1` slots are DEAD — `computeTabSlots` (exported, pure,
 * pinned by tab-slots.test.ts) gives the SELECTED tab a slot sized to its
 * chip's natural width (icon + gutter + measured label + LABEL_EPSILON 2)
 * plus the pill's 12px breathing pair, while the neighbors rebalance to the
 * equal split of what remains (capped at the old barWidth/N width). The
 * row insets 12 from the slab's inner edges (TAB_INSET_X), so the FIRST and
 * LAST pills sit 12px off the edge (the old ~1px crowding is gone) and
 * "Approvals" finally fits (its label budget clears the measured label by
 * LABEL_EPSILON + 2*PILL_PAD_X = 26px). The edge clamp is DELETED — the
 * slot math makes it unreachable. Per-slot WIDTHS animate on TAB_LABEL_MS
 * (the row rebalances fluidly, the icons glide); the pill's CENTER still
 * rides TAB_SPRING and its WIDTH the label's timing, both off the same
 * layout. The corner artifact (the "sticker pasted" halo) dies with the
 * square shadow wrapper: the bar's radius-28 card fill + clayShadow2 now
 * live on ONE rounded View wrapping the (vertical, overflow-clipped)
 * ChromeEdge — ClayCard's own proven pattern. The label gains
 * ellipsizeMode="tail" beside numberOfLines 1 (Android's pixel grid can
 * clip the last glyph at an exactly-measured maxWidth). Frozen intact:
 * TAB_SPRING/TAB_LABEL_MS, the R116-b morph mechanics + measurement row,
 * the a11y contract, the alert breathe, the keyboard slide-away, the pill's
 * accentTint/2px-accentDeep material.
 *
 * Purely presentational — the tabs layout owns navigation state.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ChromeEdge } from "@/design/primitives";
import { selectionHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { BAR_HEIGHT, BAR_MARGIN, TYPE_TAB_LABEL, fontFamily, spacing } from "@/design/tokens";
import { TAB_LABEL_MS, TAB_SPRING } from "@/design/motion";
import { computeTabSlots, LABEL_EPSILON, TAB_INSET_X } from "./tab-slots";

export interface TabDescriptor {
  /** The route name (the navigation key). */
  name: string;
  label: string;
  /** The lucide icon component. */
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  /** Optional badge count (approvals pending, unread, …). */
  badge?: number;
  /**
   * R115-g (motion.md §4.5): while true the tab's icon + label tint to the
   * accent and breathe (0.75↔1, ~1.6s) — the approvals-pending state. The
   * tabs layout derives it from the badge count.
   */
  alert?: boolean;
}

export interface FloatingTabBarProps {
  tabs: TabDescriptor[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

// ── the R118-B adaptive slot algorithm — pure, lives in tab-slots.ts so the
// jest sandbox never imports this file's RN/reanimated graph; re-exported
// here as the bar's own surface (spec §2.1: tab-bar exports the algorithm).

export {
  computeTabSlots,
  TAB_INSET_X,
  PILL_PAD_X,
  LABEL_EPSILON,
  type TabSlotsInput,
  type TabSlotsLayout,
} from "./tab-slots";

/** One leg of the alert breathe (ms) — 800 + 800 = motion.md §4.5's ~1.6s. */
const ALERT_BREATHE_LEG_MS = 800;
/** The breathe's low opacity (motion.md §4.5: 0.75↔1). */
const ALERT_BREATHE_MIN = 0.75;

/** The inactive chip's icon size (px) — the fixed anchor the label breathes beside. */
const ICON_SIZE = 22;
/** The ACTIVE icon's size (R117-g2 §2.3: 22 → 23 — the selection gains
 *  weight alongside its strokeWidth/color, the M3/One UI state-weight cue). */
const ICON_SIZE_ACTIVE = 23;
/** The icon→label gutter inside the horizontal chip (px). */
const CHIP_GAP = 6;
/**
 * While a label's natural width is still unmeasured, its expanded maxWidth
 * rides this sentinel — a Text self-limits to its natural width, so the
 * sentinel renders exactly the natural label (no truncation, no guesswork).
 */
const LABEL_UNCONSTRAINED = 400;

export function FloatingTabBar({ tabs, activeIndex, onSelect }: FloatingTabBarProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const keyboard = useKeyboardState();
  const reduced = useReducedMotion();

  // R116-b — each label's TRUE natural width, captured once at mount by the
  // hidden measurement row rendered inside the bar (font-scale honest; the
  // morph and the pill's wrap read these, never hardcoded px).
  const [labelWidths, setLabelWidths] = useState<Record<string, number>>({});
  const allMeasured = tabs.every((tab) => (labelWidths[tab.name] ?? 0) > 0);

  const barWidth = useMemo(
    () => windowWidth - BAR_MARGIN * 2,
    [windowWidth],
  );
  const tabWidth = useMemo(() => barWidth / Math.max(tabs.length, 1), [barWidth, tabs.length]);

  // R118-B — the adaptive slots: the measured layout (what the row and the
  // pill animate toward once every label has reported) and the UNMEASURED
  // mount pose (selected slot at its floor, the others at the equal split),
  // both off the one pure function.
  const layout = useMemo(
    () =>
      computeTabSlots({
        barWidth,
        tabCount: tabs.length,
        activeIndex,
        labelWidths: tabs.map((tab) => labelWidths[tab.name] ?? 0),
      }),
    [barWidth, tabs, activeIndex, labelWidths],
  );
  const mountLayout = useMemo(
    () =>
      computeTabSlots({
        barWidth,
        tabCount: tabs.length,
        activeIndex,
        labelWidths: tabs.map(() => 0),
      }),
    [barWidth, tabs, activeIndex],
  );

  // The sliding indicator — one shared pill. Its CENTER glides on TAB_SPRING
  // (the calm slide, motion.md §1) while its WIDTH rides the label morph's
  // TAB_LABEL_MS timing, so the border visually wraps the selected chip at
  // every beat of the morph. R118-B: both read the adaptive slot layout —
  // the pill centers inside the SELECTED SLOT (the edge clamp is deleted;
  // the slot math keeps it ≥ TAB_INSET_X from the slab's rounded edges).
  // Until the labels measure, the pill holds the unmeasured pose (the
  // selected slot at its floor, the pill the slot's own width) — no flash,
  // no zero-width sliver.
  const indicatorCenter = useSharedValue(
    mountLayout.centers[activeIndex] ?? (activeIndex + 0.5) * tabWidth,
  );
  const indicatorWidth = useSharedValue(mountLayout.pillWidth);
  const barTranslate = useSharedValue(0);

  useEffect(() => {
    if (!allMeasured) return; // hold the mount pose until the labels measure
    const center = layout.centers[activeIndex] ?? (activeIndex + 0.5) * tabWidth;
    const width = layout.pillWidth;
    if (reduced) {
      indicatorCenter.value = center;
      indicatorWidth.value = width;
      return;
    }
    indicatorCenter.value = withSpring(center, TAB_SPRING);
    indicatorWidth.value = withTiming(width, { duration: TAB_LABEL_MS });
  }, [
    activeIndex,
    layout,
    tabWidth,
    allMeasured,
    reduced,
    indicatorCenter,
    indicatorWidth,
  ]);

  useEffect(() => {
    barTranslate.value = withSpring(keyboard.isVisible ? BAR_HEIGHT + insets.bottom + BAR_MARGIN : 0, {
      stiffness: 180,
      damping: 26,
    });
  }, [keyboard.isVisible, insets.bottom, barTranslate]);

  // The pill's left edge is derived on the UI thread (center − half width),
  // so the slide and the resize can never drift apart mid-morph.
  const indicatorStyle = useAnimatedStyle(() => ({
    width: indicatorWidth.value,
    transform: [{ translateX: indicatorCenter.value - indicatorWidth.value / 2 }],
  }));

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: barTranslate.value }],
  }));

  return (
    <SafeAreaView edges={["bottom"]} pointerEvents="box-none" style={styles.safeWrap}>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.floatWrap, { marginBottom: Math.max(insets.bottom, 8) }, barStyle]}
      >
        {/* R118-B — the corner fix: the bar's geometry (radius 28, card fill,
            the elevation-2 clay shadow) lives on ONE rounded View — the old
            square boxShadow wrapper cast a rectangular halo around the rounded
            slab (the "sticker pasted" corners). ClayCard's own pattern. */}
        <View
          style={{ borderRadius: 28, backgroundColor: tokens.card, boxShadow: tokens.clayShadow2 }}
        >
          <ChromeEdge radius={28}>
            <View style={[styles.bar, { width: barWidth }]}>
            {/* The sliding selection pill — R116-b's 2px-bordered wrap, with
                R117-g2's warm presence: the fill is accentTint (the selected
                chip sits on a terracotta-tinted pill) under the 2px accentDeep
                border (never hairline, donts.md #34); its center slides on
                TAB_SPRING, its width breathes with the label morph. */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.indicator,
                {
                  backgroundColor: tokens.accentTint,
                  borderColor: tokens.accentDeep,
                },
                indicatorStyle,
              ]}
            />
            {tabs.map((tab, index) => (
              <TabItem
                key={tab.name}
                tab={tab}
                active={index === activeIndex}
                labelWidth={labelWidths[tab.name] ?? 0}
                slotWidth={
                  allMeasured
                    ? (layout.slots[index] ?? tabWidth)
                    : (mountLayout.slots[index] ?? tabWidth)
                }
                onPress={() => {
                  if (index === activeIndex) return;
                  void selectionHaptic();
                  onSelect(index);
                }}
              />
            ))}
            {/* R116-b — the one-shot label measurement: an invisible,
                a11y-hidden row that lays every label out unconstrained so
                each tab's TRUE natural width is captured once at mount. */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={styles.measureRow}
            >
              {tabs.map((tab) => (
                <Text
                  key={tab.name}
                  numberOfLines={1}
                  onLayout={(e) => {
                    const w = e.nativeEvent.layout.width;
                    if (w <= 0) return;
                    setLabelWidths((prev) =>
                      tab.name in prev ? prev : { ...prev, [tab.name]: w },
                    );
                  }}
                  style={styles.measureLabel}
                >
                  {tab.label}
                </Text>
              ))}
            </View>
            </View>
          </ChromeEdge>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

/** One tab item — the animated slot, the horizontal chip, the label morph,
 *  the alert breathe. */

/** The tab's touch target carries an animated WIDTH (the adaptive slot) —
 *  RN core's Pressable can't take an animated style, so the animated wrapper
 *  owns the slot's box and the press sits inside it. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function TabItem({
  tab,
  active,
  labelWidth,
  slotWidth,
  onPress,
}: {
  tab: TabDescriptor;
  active: boolean;
  labelWidth: number;
  /** The slot's target width — the measured adaptive layout, or the
   *  unmeasured mount pose (floor/equal-split) until the labels report. */
  slotWidth: number;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const breathe = useSharedValue(1);
  const alert = tab.alert === true;
  const Icon = tab.icon;

  // R118-B — the SLOT's width (the fixed flex:1 slot is dead): the row
  // rebalances fluidly on the label morph's own TAB_LABEL_MS timing — the
  // newly-selected slot grows to its chip, every other slot glides to the
  // new equal split, so the icons glide and never jump. Mounted at the
  // unmeasured pose; the row blooms when allMeasured flips (the parent
  // swaps slotWidth to the measured layout then). Reduced motion snaps.
  const slot = useSharedValue(slotWidth);
  useEffect(() => {
    if (reduced) {
      slot.value = slotWidth;
      return;
    }
    slot.value = withTiming(slotWidth, { duration: TAB_LABEL_MS });
  }, [slotWidth, reduced, slot]);
  const slotStyle = useAnimatedStyle(() => ({ width: slot.value }));

  // The label morph's two drivers: the maxWidth the label's box animates
  // through (0 collapsed ↔ natural expanded) and its fade. Mounted at the
  // resting pose (selected = unconstrained, unselected = 0) so there is no
  // first-frame flash of every label.
  const labelMax = useSharedValue(active ? LABEL_UNCONSTRAINED : 0);
  const labelOpacity = useSharedValue(active ? 1 : 0);

  // The calm §4.5 breathe — only while alerting, never for reduced motion
  // (motion.md §5: state stays legible, the cycle drops).
  useEffect(() => {
    if (!alert || reduced) {
      breathe.value = 1;
      return;
    }
    breathe.value = withRepeat(
      withSequence(
        withTiming(ALERT_BREATHE_MIN, { duration: ALERT_BREATHE_LEG_MS }),
        withTiming(1, { duration: ALERT_BREATHE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [alert, reduced, breathe]);

  // R116-b — the label morph (motion.md §4.7): maxWidth animates the row's
  // reflow (the chip re-centers fluidly — no jump), opacity fades the text
  // in/out. While unmeasured the expanded max rides the unconstrained
  // sentinel (the Text self-limits to its natural width); once measured it
  // targets the measurement + LABEL_EPSILON (R118-B — Android's pixel-grid
  // rounding can clip the last glyph at an exactly-measured maxWidth, and
  // ellipsizeMode="tail" below spells the honest truncation). Reduced
  // motion snaps both values (motion.md §5).
  useEffect(() => {
    const max = active ? (labelWidth > 0 ? labelWidth + LABEL_EPSILON : LABEL_UNCONSTRAINED) : 0;
    const opacity = active ? 1 : 0;
    if (reduced) {
      labelMax.value = max;
      labelOpacity.value = opacity;
      return;
    }
    labelMax.value = withTiming(max, { duration: TAB_LABEL_MS });
    labelOpacity.value = withTiming(opacity, { duration: TAB_LABEL_MS });
  }, [active, labelWidth, reduced, labelMax, labelOpacity]);

  // One breathe, two attachments — each animated node needs its OWN style
  // descriptor (icon wrapper + label), both driven by the same shared value.
  // The label's opacity is the morph's fade × the breathe (one worklet).
  const iconBreathe = useAnimatedStyle(() => ({ opacity: breathe.value }));
  const labelStyle = useAnimatedStyle(() => ({
    maxWidth: labelMax.value,
    opacity: labelOpacity.value * breathe.value,
  }));

  // The pinned grammar (components.md §Tab bar): active = accentDeep icon +
  // bold label (R117-g2: the deep tier — accent-as-text duty); alert = the
  // same deep tint even at rest; else textSecondary — the inactive icons
  // were 40%-black ghosts, 62% reads as real chrome (§2.3).
  const color = alert || active ? tokens.accentDeep : tokens.textSecondary;
  const badge = tab.badge;
  const pending = badge !== undefined && badge > 0;

  return (
    <AnimatedPressable
      accessibilityLabel={
        alert && pending
          ? `${tab.label} tab, ${badge} pending approvals`
          : `${tab.label} tab`
      }
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.tab, slotStyle]}
      onPress={onPress}
    >
      {/* The horizontal chip (round-116): icon LEFT, label RIGHT — the label
          breathes in beside the icon while the SLOT widths rebalance around
          it (R118-B — the neighbors' centers glide on the same timing). */}
      <View style={styles.chip}>
        <View>
          <Animated.View style={iconBreathe}>
            {/* R117-g2 §2.3: the active icon is 23px / strokeWidth 2.5 — the
                state-weight change (outline stays 22 / 2) that reads as
                "product vs prototype" in the M3/One UI benchmark. */}
            <Icon
              size={active ? ICON_SIZE_ACTIVE : ICON_SIZE}
              color={color}
              strokeWidth={active ? 2.5 : 2}
            />
          </Animated.View>
          {pending ? (
            <View
              style={[styles.badge, { backgroundColor: tokens.accentDeep }]}
              accessibilityLabel={`${badge} pending`}
            >
              <Animated.Text style={[styles.badgeText, { color: tokens.accentText }]}>
                {badge > 99 ? "99+" : String(badge)}
              </Animated.Text>
            </View>
          ) : null}
        </View>
        <Animated.Text
          style={[
            styles.label,
            labelStyle,
            { color, fontFamily: active ? fontFamily.bold : fontFamily.semibold },
          ]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {tab.label}
        </Animated.Text>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  safeWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  floatWrap: {
    marginHorizontal: BAR_MARGIN,
    alignSelf: "stretch",
  },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    // R118-B — the row's 12px inset from the slab's inner edges: the pill
    // math (computeTabSlots) works in this padded space while the absolute
    // pill + measurement row keep the FULL-WIDTH coordinate space (absolute
    // children ignore padding).
    paddingHorizontal: TAB_INSET_X,
  },
  indicator: {
    position: "absolute",
    top: spacing.sm,
    bottom: spacing.sm,
    left: 0,
    borderRadius: 18,
    // R116-b/R117-g2: 2px accentDeep over the accentTint fill — never a
    // hairline (donts.md #34).
    borderWidth: 2,
  },
  tab: {
    // R118-B — the fixed flex:1 slot is DEAD: the width arrives as an
    // animated value (the adaptive slot layout) via slotStyle. The slot is
    // still the full-height touch target.
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  },
  /** The horizontal chip: icon LEFT, label RIGHT, one gutter. */
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: CHIP_GAP,
  },
  /** The pending-count badge at the icon's top-right (clear of the label). */
  badge: {
    position: "absolute",
    top: -6,
    right: -4,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    fontFamily: fontFamily.bold,
    lineHeight: 12,
  },
  label: {
    // R117-g2 (AMENDMENT 4): 11.5 — the ladder's own tab-label floor. The
    // measurement row below must stay byte-identical or the morph
    // mis-measures (round-117-elevation.md §2.1).
    fontSize: TYPE_TAB_LABEL,
    letterSpacing: 0.2,
  },
  /** The hidden measurement row — laid out unconstrained, never painted. */
  measureRow: {
    position: "absolute",
    top: 0,
    left: 0,
    flexDirection: "row",
    opacity: 0,
  },
  /** Must match the EXPANDED label's exact type recipe (bold — selected):
   *  same 11.5 TYPE_TAB_LABEL spelling, byte-for-byte. */
  measureLabel: {
    fontSize: TYPE_TAB_LABEL,
    letterSpacing: 0.2,
    fontFamily: fontFamily.bold,
  },
});
