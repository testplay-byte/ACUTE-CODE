/**
 * The four primitives of the "quiet instrument" (R1 §6) — every screen is
 * assembled from exactly these plus raw View/Text:
 *
 *   PressableCard — the press state: 8% bg tint + 0.98 scale, one spring,
 *                   NO ripple (android_ripple stays off, forever)
 *   Hairline      — the 1px border line (StyleSheet.hairlineWidth)
 *   Badge         — the small count/label pill (8px radius)
 *   TypeScale     — the 15/13/11pt grotesque ladder + the mono machine text
 *
 * Nothing here owns a color: every value reads the resolved theme so a theme
 * switch re-renders the whole instrument with zero prop plumbing.
 */

import React, { useCallback, useEffect } from "react";
import {
  Pressable,
  PressableStateCallbackType,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring } from "react-native-reanimated";
import { useTheme } from "./theme";
import {
  RADIUS_CARD,
  RADIUS_PILL,
  TYPE_BODY,
  TYPE_CAPTION,
  TYPE_TITLE,
  fontStack,
  pressTint,
  spacing,
} from "./tokens";
import { ENTRANCE_DELTA, PRESS_SCALE, SPRING, staggerDelay } from "./motion";

// ── PressableCard ───────────────────────────────────────────────────────────

export interface PressableCardProps {
  children?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Card outer style (padding etc. is the caller's — content owns its shape). */
  style?: StyleProp<ViewStyle>;
  /** The inner content's style — applied to the animated layer. */
  contentStyle?: StyleProp<ViewStyle>;
  /** List index — when set, the card plays the fade-in-up entrance with the
   * 30ms stagger (leave undefined for static cards). */
  enterIndex?: number;
  disabled?: boolean;
  /** Accessibility label (required when the card carries only non-text content). */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * The ONE pressable surface: pressed = bg tinted 8% + scale 0.98 under the
 * shared spring. No ripple, no elevation, no shadow — the flat language.
 * (Plain Pressable owns the press state + tint; the Animated.View inside
 * owns the scale + entrance transform — one component, two quiet layers.)
 */
export function PressableCard({
  children,
  onPress,
  onLongPress,
  style,
  contentStyle,
  enterIndex,
  disabled = false,
  accessibilityLabel,
  testID,
}: PressableCardProps) {
  const { tokens } = useTheme();
  const pressed = useSharedValue(0);
  const entered = useSharedValue(enterIndex === undefined ? 1 : 0);

  // The entrance (fade-in-up) runs once on mount for list items.
  useEffect(() => {
    if (enterIndex === undefined) return;
    entered.value = withDelay(staggerDelay(enterIndex), withSpring(1, SPRING));
  }, [enterIndex, entered]);

  const animated = useAnimatedStyle(() => {
    const scale = 1 - pressed.value * (1 - PRESS_SCALE);
    const translateY = (1 - entered.value) * ENTRANCE_DELTA;
    return { transform: [{ scale }, { translateY }], opacity: entered.value };
  });

  const surfaceStyle = useCallback(
    (state: PressableStateCallbackType): StyleProp<ViewStyle> => [
      {
        backgroundColor: state.pressed ? pressTint(tokens.card, tokens.isDark) : tokens.card,
        borderRadius: RADIUS_CARD,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tokens.border,
        overflow: "hidden",
      },
      style,
    ],
    [tokens, style],
  );

  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled || !onPress}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => {
        pressed.value = withSpring(1, SPRING);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, SPRING);
      }}
      style={surfaceStyle}
    >
      <Animated.View style={[animated, contentStyle]}>{children}</Animated.View>
    </Pressable>
  );
}

// ── Hairline ────────────────────────────────────────────────────────────────

/** The quiet divider: one hairline, theme border color, optional inset. */
export function Hairline({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }) {
  const { tokens } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="separator"
      style={[
        {
          height: StyleSheet.hairlineWidth,
          backgroundColor: tokens.borderSubtle,
          marginLeft: inset,
          marginRight: inset,
        },
        style,
      ]}
    />
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

export interface BadgeProps {
  children: React.ReactNode;
  /** "neutral" (subtle fill) · "accent" (accent fill + contrast text) · "danger". */
  tone?: "neutral" | "accent" | "danger";
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/** The small pill — counts, scopes, status chips. 11pt, 8px radius. */
export function Badge({ children, tone = "neutral", style, textStyle }: BadgeProps) {
  const { tokens } = useTheme();
  const bg = tone === "accent" ? tokens.accent : tone === "danger" ? tokens.danger : tokens.pillBg;
  const fg = tone === "accent" ? tokens.accentText : tone === "danger" ? "#FFFFFF" : tokens.textSecondary;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: RADIUS_PILL,
          paddingHorizontal: spacing.sm,
          paddingVertical: 2,
          alignSelf: "flex-start",
        },
        style,
      ]}
    >
      <Text style={[{ color: fg, fontSize: TYPE_CAPTION, fontFamily: fontStack.sans, fontWeight: "600" }, textStyle]}>
        {children}
      </Text>
    </View>
  );
}

// ── TypeScale ───────────────────────────────────────────────────────────────

export interface TypeScaleProps {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}

/** 15pt/600 — titles, the host card's machine name. */
export function TypeTitle({ children, style, numberOfLines, testID }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_TITLE, fontFamily: fontStack.sans, fontWeight: "600" }, style]}
    >
      {children}
    </Text>
  );
}

/** 13pt/400 — body and list rows. */
export function TypeBody({ children, style, numberOfLines, testID }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_BODY, fontFamily: fontStack.sans, fontWeight: "400" }, style]}
    >
      {children}
    </Text>
  );
}

/** 11pt/400 — captions, status lines, metadata (secondary tone by default). */
export function TypeCaption({ children, style, numberOfLines, testID }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.textSecondary, fontSize: TYPE_CAPTION, fontFamily: fontStack.sans, fontWeight: "400" },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** Machine text — commands, fingerprints, PINs, addresses (platform mono). */
export function TypeMono({ children, style, numberOfLines, testID }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.textSecondary, fontSize: TYPE_CAPTION, fontFamily: fontStack.mono, fontWeight: "400" },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
