/**
 * FloatingTabBar — the bottom navigation (components.md §Tab bar): a
 * floating CLAY slab with spacing on all four sides, radius 28, the
 * elevation-2 shadow, and the sanctioned CHROME edge (the 1px metal-ramp
 * hairline — one of the three chrome surfaces). The active tab slides a
 * soft accent pill under its icon (subtleHover tint + the accent hairline,
 * one spring); labels sit under icons at 11 (600 at rest, 700 when active). The bar rides above the
 * content (absolute) and slides away under the keyboard (the one sanctioned
 * damping-26 exception, motion.md §1).
 *
 * R115-g — the round-115 approvals mandate (motion.md §4.5): a tab whose
 * `alert` flag is true (pending approvals — derived from badge > 0 by the
 * tabs layout) tints its icon AND label to the accent and BREATHES: a calm
 * ~1.6s opacity cycle (0.75↔1) so the pending state reads at a glance, the
 * badge alone being not enough. The numeric badge keeps the exact count
 * (99+ cap). Reduced motion snaps the breathe off (motion.md §5).
 *
 * Purely presentational — the tabs layout owns navigation state.
 */

import React, { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
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
import { BAR_HEIGHT, BAR_MARGIN, TYPE_MICRO, fontFamily, spacing } from "@/design/tokens";
import { SPRING } from "@/design/motion";

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

/** One leg of the alert breathe (ms) — 800 + 800 = motion.md §4.5's ~1.6s. */
const ALERT_BREATHE_LEG_MS = 800;
/** The breathe's low opacity (motion.md §4.5: 0.75↔1). */
const ALERT_BREATHE_MIN = 0.75;

export function FloatingTabBar({ tabs, activeIndex, onSelect }: FloatingTabBarProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const keyboard = useKeyboardState();

  // The sliding indicator's x offset — one shared value, spring-driven.
  const indicatorX = useSharedValue(0);
  const barTranslate = useSharedValue(0);

  const barWidth = useMemo(
    () => windowWidth - BAR_MARGIN * 2,
    [windowWidth],
  );
  const tabWidth = useMemo(() => barWidth / Math.max(tabs.length, 1), [barWidth, tabs.length]);

  useEffect(() => {
    indicatorX.value = withSpring(activeIndex * tabWidth, SPRING);
  }, [activeIndex, tabWidth, indicatorX]);

  useEffect(() => {
    barTranslate.value = withSpring(keyboard.isVisible ? BAR_HEIGHT + insets.bottom + BAR_MARGIN : 0, {
      stiffness: 180,
      damping: 26,
    });
  }, [keyboard.isVisible, insets.bottom, barTranslate]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
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
        <View style={{ boxShadow: tokens.clayShadow2 }}>
        <ChromeEdge radius={28}>
          <View style={[styles.bar, { width: barWidth }]}>
            {/* The sliding accent pill — the selected tab's soft tile:
                subtleHover tint + the accent hairline, one spring slide. */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.indicator,
                {
                  width: tabWidth - spacing.sm,
                  left: spacing.sm / 2,
                  backgroundColor: tokens.subtleHover,
                  borderColor: tokens.accent,
                },
                indicatorStyle,
              ]}
            />
            {tabs.map((tab, index) => (
              <TabItem
                key={tab.name}
                tab={tab}
                active={index === activeIndex}
                onPress={() => {
                  if (index === activeIndex) return;
                  void selectionHaptic();
                  onSelect(index);
                }}
              />
            ))}
          </View>
        </ChromeEdge>
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

/** One tab item — the alert breathe lives here (icon + label share it). */
function TabItem({
  tab,
  active,
  onPress,
}: {
  tab: TabDescriptor;
  active: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const breathe = useSharedValue(1);
  const alert = tab.alert === true;
  const Icon = tab.icon;

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

  // One breathe, two attachments — each animated node needs its OWN style
  // descriptor (icon wrapper + label), both driven by the same shared value.
  const iconBreathe = useAnimatedStyle(() => ({ opacity: breathe.value }));
  const labelBreathe = useAnimatedStyle(() => ({ opacity: breathe.value }));

  // The pinned grammar (components.md §Tab bar): active = accent icon +
  // bold label; alert = the same accent tint even at rest; else tertiary.
  const color = alert || active ? tokens.accent : tokens.textTertiary;
  const badge = tab.badge;
  const pending = badge !== undefined && badge > 0;

  return (
    <Pressable
      accessibilityLabel={
        alert && pending
          ? `${tab.label} tab, ${badge} pending approvals`
          : `${tab.label} tab`
      }
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={styles.tab}
      onPress={onPress}
    >
      <View>
        <Animated.View style={iconBreathe}>
          <Icon size={22} color={color} strokeWidth={active ? 2.4 : 2} />
        </Animated.View>
        {pending ? (
          <View
            style={[styles.badge, { backgroundColor: tokens.accent }]}
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
          labelBreathe,
          { color, fontFamily: active ? fontFamily.bold : fontFamily.semibold },
        ]}
        numberOfLines={1}
      >
        {tab.label}
      </Animated.Text>
    </Pressable>
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
  },
  indicator: {
    position: "absolute",
    top: spacing.sm,
    bottom: spacing.sm,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    height: "100%",
  },
  badge: {
    position: "absolute",
    top: -6,
    right: -12,
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
    fontSize: TYPE_MICRO - 0.5,
    letterSpacing: 0.2,
  },
});
