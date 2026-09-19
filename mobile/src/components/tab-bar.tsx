/**
 * FloatingTabBar — the bottom navigation (DESIGN.md §2.1/§5): a floating
 * CLAY slab with spacing on all four sides, radius 28, the elevation-2
 * shadow, and the sanctioned CHROME edge (the 1px metal-ramp hairline —
 * one of the three chrome surfaces). The active tab slides a soft accent
 * pill under its icon; labels sit under icons at 11/600. The bar rides
 * above the content (absolute) and slides away under the keyboard.
 *
 * Purely presentational — the tabs layout owns navigation state.
 */

import React, { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
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
}

export interface FloatingTabBarProps {
  tabs: TabDescriptor[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

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
            {/* The sliding accent pill (the selected tab's soft tile) */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.indicator,
                {
                  width: tabWidth - spacing.sm,
                  left: spacing.sm / 2,
                  backgroundColor: tokens.subtleHover,
                  borderColor: tokens.borderSubtle,
                },
                indicatorStyle,
              ]}
            />
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              const active = index === activeIndex;
              const color = active ? tokens.accent : tokens.textTertiary;
              return (
                <Pressable
                  key={tab.name}
                  accessibilityLabel={`${tab.label} tab`}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  style={styles.tab}
                  onPress={() => {
                    if (!active) {
                      void selectionHaptic();
                      onSelect(index);
                    }
                  }}
                >
                  <View>
                    <Icon size={22} color={color} strokeWidth={active ? 2.4 : 2} />
                    {tab.badge !== undefined && tab.badge > 0 ? (
                      <View
                        style={[styles.badge, { backgroundColor: tokens.accent }]}
                        accessibilityLabel={`${tab.badge} pending`}
                      >
                        <Animated.Text style={[styles.badgeText, { color: tokens.accentText }]}>
                          {tab.badge > 99 ? "99+" : String(tab.badge)}
                        </Animated.Text>
                      </View>
                    ) : null}
                  </View>
                  <Animated.Text
                    style={[
                      styles.label,
                      { color, fontFamily: active ? fontFamily.bold : fontFamily.semibold },
                    ]}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Animated.Text>
                </Pressable>
              );
            })}
          </View>
        </ChromeEdge>
        </View>
      </Animated.View>
    </SafeAreaView>
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
