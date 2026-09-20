/**
 * The design-system primitives — the CLAY STUDIO + LIQUID CHROME kit
 * (DESIGN.md, R109). Every screen is assembled from these plus raw
 * View/Text:
 *
 *   ClayCard      — the resting clay surface: radius 20, two-leg warm
 *                   shadow, matte 1px top-edge highlight (form, not glow)
 *   PressableCard — the press state: tint + 0.98 scale + shadow collapse,
 *                   one spring, NO ripple (android_ripple stays off forever)
 *   FadeInUp      — the fade-in-up entrance for non-card blocks (R115 §2)
 *   ChromeButton  — the primary CTA: accent fill + the quiet vertical sheen
 *                   (one of the three sanctioned chrome surfaces, §2);
 *                   flat = the R115 wizard CTA (sheen-less, clay shadow)
 *   QuietButton   — the secondary action: outlined, flat, honest
 *   ChromeEdge    — the 1px gradient border wrapper (the floating bar's
 *                   edge + selected markers — the other sanctioned chrome)
 *   ClayInput     — the text input: radius 14, focus ring in accent
 *   Chip          — the filter chip (selected = accent fill)
 *   ConnectionPill— the always-visible link status pill (§6)
 *   StatusDot     — the animated state dot (pulses while probing)
 *   Skeleton      — the loading placeholder (calm opacity pulse)
 *   SectionHeader — the 16/700 section heading + optional action
 *   Badge / Hairline / TypeScale — the quiet survivors, re-typed
 *
 * Nothing here owns a color: every value reads the resolved theme so a
 * theme switch re-renders the whole instrument with zero prop plumbing.
 */

import { LinearGradient } from "expo-linear-gradient";
import React, { useCallback, useEffect } from "react";
import {
  AccessibilityState,
  ActivityIndicator,
  Pressable,
  PressableStateCallbackType,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "./theme";
import {
  RADIUS_BAR,
  RADIUS_CARD,
  RADIUS_INPUT,
  RADIUS_PILL,
  TOUCH_TARGET,
  TYPE_BODY,
  TYPE_CAPTION,
  TYPE_DISPLAY,
  TYPE_HEADING,
  TYPE_MICRO,
  TYPE_MONO,
  TYPE_TITLE,
  fontFamily,
  pressTint,
  spacing,
} from "./tokens";
import { ENTRANCE_DELTA, PRESS_SCALE, SPRING, staggerDelay } from "./motion";

// ── ClayCard — the resting clay surface ─────────────────────────────────────

export interface ClayCardProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Elevation 2 renders the deeper shadow pair (heroes, sheets). */
  elevated?: boolean;
  /** The small-surface shadow step (chips, compact tiles). */
  small?: boolean;
  /** Solid hairline border (for input-ish cards); default is borderless clay. */
  bordered?: boolean;
  testID?: string;
}

/**
 * The resting clay surface — DESIGN.md §1. Depth is the two-leg warm shadow
 * plus the matte top-edge highlight (a SOLID 1px lighter line on the top
 * edge only — the molded-surface read, never a gradient, never animated).
 */
export function ClayCard({ children, style, elevated = false, small = false, bordered = false, testID }: ClayCardProps) {
  const { tokens } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: tokens.card,
          borderRadius: small ? RADIUS_INPUT : RADIUS_CARD,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.clayTopEdge,
          boxShadow: small ? tokens.clayShadowSm : elevated ? tokens.clayShadow2 : tokens.clayShadow1,
          ...(bordered
            ? { borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.border }
            : null),
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ── PressableCard — the press state on the clay material ────────────────────

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
  /** Elevation 2 (heroes) vs the default list-card shadow. */
  elevated?: boolean;
  /** Accessibility label (required when the card carries only non-text content). */
  accessibilityLabel?: string;
  /** R114-c: the caller's accessibility state (the projects accordion's
   * expanded flag) — merged with the disabled truth. */
  accessibilityState?: AccessibilityState;
  testID?: string;
}

/**
 * The ONE pressable surface: pressed = bg tinted 8% + scale 0.98 under the
 * shared spring, the shadow collapsing to its tight leg. No ripple.
 */
export function PressableCard({
  children,
  onPress,
  onLongPress,
  style,
  contentStyle,
  enterIndex,
  disabled = false,
  elevated = false,
  accessibilityLabel,
  accessibilityState,
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
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: tokens.clayTopEdge,
        boxShadow: state.pressed
          ? tokens.clayShadowPressed
          : elevated
            ? tokens.clayShadow2
            : tokens.clayShadow1,
        overflow: "hidden",
      },
      style,
    ],
    [tokens, style, elevated],
  );

  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={disabled ? { disabled: true, ...accessibilityState } : accessibilityState}
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

// ── FadeInUp — the entrance grammar for non-card blocks (R115) ─────────

export interface FadeInUpProps {
  children?: React.ReactNode;
  /** The stagger index — the entrance waits 30ms × index (motion.md §2);
   * the screen's hero enters at 0, everything after staggers on that beat. */
  index?: number;
  /** Hold the entrance (opacity 0) until this flips true — the granted
   * sequence's "then" gate (the Continue CTA waits for Skip's exit).
   * Default true: enter on mount. */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The fade-in-up entrance (motion.md §2) for hero text and CTAs — the same
 * recipe PressableCard's `enterIndex` plays, extracted for non-card blocks
 * (wizard titles, taglines, footer buttons). Reduced motion snaps it
 * (motion.md §5: entrance/stagger animations drop).
 */
export function FadeInUp({ children, index = 0, active = true, style, testID }: FadeInUpProps) {
  const entered = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!active) return; // held — the caller flips `active` to release it
    if (reduced) {
      entered.value = 1;
      return;
    }
    entered.value = withDelay(staggerDelay(index), withSpring(1, SPRING));
  }, [active, index, reduced, entered]);

  const animated = useAnimatedStyle(() => ({
    opacity: entered.value,
    transform: [{ translateY: (1 - entered.value) * ENTRANCE_DELTA }],
  }));

  return (
    <Animated.View testID={testID} style={[animated, style]}>
      {children}
    </Animated.View>
  );
}

// ── ChromeButton — the primary CTA (sanctioned chrome surface #2) ───────────

export interface ChromeButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** The quiet vertical sheen (default true — the §2.2 jewelry). */
  sheen?: boolean;
  /** R115: the flat wizard CTA — solid accent, NO sheen gradient, the clay
   *  elevation-2 shadow (the round-115 "no glow/sheen on CTAs" verdict,
   *  components.md's Primary idiom). Additive + optional: every other
   *  caller renders exactly as before. */
  flat?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** Show the busy spinner instead of the label. */
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * The primary action — accent fill, radius 14, 50px tall, and the ONE quiet
 * glint: a white α→0 gradient across the top half (a "one quiet glint,"
 * never a mirror). Pressed = scale 0.98 + tint. `flat` (R115) drops the
 * glint and adds the clay elevation-2 shadow — the wizard CTA idiom.
 */
export function ChromeButton({
  children,
  onPress,
  disabled = false,
  sheen = true,
  flat = false,
  style,
  textStyle,
  busy = false,
  testID,
  accessibilityLabel,
}: ChromeButtonProps) {
  const { tokens } = useTheme();
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => {
    const scale = 1 - pressed.value * (1 - PRESS_SCALE);
    return { transform: [{ scale }] };
  });

  const inert = disabled || busy || !onPress;
  const bg = disabled ? pressTint(tokens.card, tokens.isDark) : tokens.accent;
  const fg = disabled ? tokens.textTertiary : tokens.accentText;

  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? (typeof children === "string" ? children : undefined)}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPress={onPress}
      onPressIn={() => {
        pressed.value = withSpring(1, SPRING);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, SPRING);
      }}
      style={({ pressed: p }: PressableStateCallbackType): StyleProp<ViewStyle> => [
        {
          backgroundColor: p ? pressTint(bg, false) : bg,
          borderRadius: RADIUS_INPUT,
          minHeight: 50,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.md,
          flexDirection: "row",
          gap: spacing.sm,
          opacity: disabled ? 0.7 : 1,
          // The flat wizard CTA carries the clay elevation-2 shadow; pressed
          // collapses it to the tight leg (the house press grammar).
          ...(flat ? { boxShadow: p ? tokens.clayShadowPressed : tokens.clayShadow2 } : null),
        },
        style,
      ]}
    >
      <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: spacing.sm }, animated]}>
        {busy ? (
          <ActivityIndicator color={fg} />
        ) : (
          <>
            {sheen && !flat && !disabled ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: "55%",
                  borderTopLeftRadius: RADIUS_INPUT,
                  borderTopRightRadius: RADIUS_INPUT,
                  overflow: "hidden",
                }}
              >
                <LinearGradient
                  colors={[tokens.sheenTop, tokens.sheenBottom]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={{ flex: 1 }}
                />
              </View>
            ) : null}
            <Text
              style={[
                {
                  color: fg,
                  fontSize: TYPE_BODY,
                  fontFamily: fontFamily.bold,
                  letterSpacing: 0.2,
                },
                textStyle,
              ]}
            >
              {children}
            </Text>
          </>
        )}
      </Animated.View>
    </Pressable>
  );
}

// ── QuietButton — the secondary action ──────────────────────────────────────

export interface QuietButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** "neutral" outline · "danger" outline in the danger hue. */
  tone?: "neutral" | "danger";
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/** The secondary action — outlined, flat, honest. */
export function QuietButton({
  children,
  onPress,
  disabled = false,
  tone = "neutral",
  style,
  textStyle,
  testID,
}: QuietButtonProps) {
  const { tokens } = useTheme();
  const fg = tone === "danger" ? tokens.danger : tokens.textSecondary;
  const border = tone === "danger" ? tokens.danger : tokens.borderStrong;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={typeof children === "string" ? children : undefined}
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }: PressableStateCallbackType) => [
        {
          borderRadius: RADIUS_INPUT,
          minHeight: TOUCH_TARGET + 2,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: border,
          backgroundColor: pressed ? tokens.subtle : "transparent",
          opacity: disabled ? 0.6 : 1,
        },
        style,
      ]}
    >
      <Text style={[{ color: fg, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold }, textStyle]}>{children}</Text>
    </Pressable>
  );
}

// ── ChromeEdge — the 1px gradient border wrapper (chrome surface #1/#3) ─────

export interface ChromeEdgeProps {
  children: React.ReactNode;
  /** The wrapped surface's corner radius (the wrapper draws radius+1). */
  radius?: number;
  style?: StyleProp<ViewStyle>;
  /** The inner surface color (defaults to the theme card). */
  surface?: string;
}

/**
 * The liquid-chrome hairline — a 1px perpendicular metal ramp
 * (light→dark→light, low alpha) wrapping a surface. Sanctioned for the
 * floating tab bar and selected markers ONLY (DESIGN.md §2).
 */
export function ChromeEdge({ children, radius = RADIUS_BAR, style, surface }: ChromeEdgeProps) {
  const { tokens } = useTheme();
  const inner = surface ?? tokens.card;
  return (
    <LinearGradient
      colors={[tokens.chromeEdgeLight, tokens.chromeEdgeDark, tokens.chromeEdgeLight]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[{ borderRadius: radius, padding: 1 }, style]}
    >
      <View
        style={{
          borderRadius: Math.max(radius - 1, 0),
          backgroundColor: inner,
          overflow: "hidden",
        }}
      >
        {children}
      </View>
    </LinearGradient>
  );
}

// ── ClayInput — the text input ──────────────────────────────────────────────

export interface ClayInputProps extends TextInputProps {
  /** Mono machine text (addresses, PINs, fingerprints). */
  mono?: boolean;
  /** Renders the focus ring in the accent hue. */
  label?: string;
  caption?: string;
  containerStyle?: StyleProp<ViewStyle>;
}

/** The input — radius 14, quiet surface, accent focus ring. */
export function ClayInput({ mono = false, label, caption, containerStyle, style, ...inputProps }: ClayInputProps) {
  const { tokens } = useTheme();
  const [focused, setFocused] = React.useState(false);
  const border = focused ? tokens.accent : tokens.inputBorder;
  return (
    <View style={containerStyle}>
      {label ? (
        <Text
          style={{
            color: tokens.textSecondary,
            fontSize: TYPE_MICRO,
            fontFamily: fontFamily.semibold,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            marginBottom: spacing.sm,
          }}
        >
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={tokens.textTertiary}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...inputProps}
        style={[
          {
            backgroundColor: tokens.inputBg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: border,
            borderRadius: RADIUS_INPUT,
            color: tokens.text,
            fontSize: TYPE_BODY,
            fontFamily: mono ? fontFamily.mono : fontFamily.medium,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            minHeight: TOUCH_TARGET + 6,
          },
          style,
        ]}
      />
      {caption ? (
        <Text
          style={{
            color: tokens.textTertiary,
            fontSize: TYPE_CAPTION,
            fontFamily: fontFamily.regular,
            marginTop: spacing.xs,
          }}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

// ── Chip — the filter chip ──────────────────────────────────────────────────

export interface ChipProps {
  children: React.ReactNode;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/** The filter chip — selected = accent fill + contrast text. */
export function Chip({ children, selected = false, onPress, style, textStyle, testID }: ChipProps) {
  const { tokens } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }: PressableStateCallbackType) => [
        {
          backgroundColor: selected ? tokens.accent : pressed ? tokens.subtleHover : tokens.pillBg,
          borderRadius: RADIUS_PILL,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: selected ? tokens.accent : tokens.border,
        },
        style,
      ]}
    >
      <Text
        style={[
          {
            color: selected ? tokens.accentText : tokens.textSecondary,
            fontSize: TYPE_CAPTION,
            fontFamily: fontFamily.semibold,
          },
          textStyle,
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

// ── StatusDot — the animated state dot ──────────────────────────────────────

export interface StatusDotProps {
  color: string;
  /** Pulses (the probing / running states). */
  pulse?: boolean;
  size?: number;
}

/** The state dot — a steady fill, or a calm 1.2s pulse when probing. */
export function StatusDot({ color, pulse = false, size = 8 }: StatusDotProps) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!pulse) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.35, { duration: 600 }), withTiming(1, { duration: 600 })),
      -1,
      false,
    );
  }, [pulse, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel={pulse ? "status: connecting" : "status dot"}
      style={[animated, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}
    />
  );
}

// ── ConnectionPill — the always-visible link truth (§6) ─────────────────────

export type LinkStatusShape = "connected" | "probing" | "offline" | "unpaired";

export interface ConnectionPillProps {
  status: LinkStatusShape;
  onPress?: () => void;
  compact?: boolean;
}

const PILL_COPY: Record<LinkStatusShape, string> = {
  connected: "live",
  probing: "connecting",
  offline: "offline",
  unpaired: "link a device",
};

/**
 * The link's truth, always on screen (§6): a small pill with the state dot +
 * a one-word line. Tapping routes to the connect hub (the caller wires it).
 */
export function ConnectionPill({ status, onPress, compact = false }: ConnectionPillProps) {
  const { tokens } = useTheme();
  const dot =
    status === "connected"
      ? tokens.success
      : status === "probing"
        ? tokens.accent
        : status === "offline"
          ? tokens.warning
          : tokens.textTertiary;
  const text =
    status === "offline" ? tokens.warning : status === "connected" ? tokens.success : tokens.textSecondary;
  return (
    <Pressable
      accessibilityLabel={`link status: ${PILL_COPY[status]}`}
      accessibilityRole="button"
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }: PressableStateCallbackType) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs + 1,
        backgroundColor: pressed ? tokens.subtleHover : tokens.pillBg,
        borderRadius: RADIUS_PILL,
        paddingHorizontal: compact ? spacing.sm + 2 : spacing.md,
        paddingVertical: 5,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tokens.border,
      })}
    >
      <StatusDot color={dot} pulse={status === "probing"} size={compact ? 6 : 8} />
      <Text
        style={{
          color: text,
          fontSize: TYPE_MICRO,
          fontFamily: fontFamily.bold,
          letterSpacing: 0.3,
        }}
      >
        {PILL_COPY[status]}
      </Text>
    </Pressable>
  );
}

// ── Skeleton — the calm loading placeholder ─────────────────────────────────

export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const opacity = useSharedValue(0.45);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.85, { duration: 700 }), withTiming(0.45, { duration: 700 })),
      -1,
      false,
    );
  }, [opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const { tokens } = useTheme();
  return (
    <Animated.View
      style={[animated, { backgroundColor: tokens.subtleHover, borderRadius: RADIUS_INPUT }, style]}
    />
  );
}

// ── SectionHeader ───────────────────────────────────────────────────────────

export interface SectionHeaderProps {
  children: React.ReactNode;
  /** The right-side action ("manage", "see all") — a quiet accent link. */
  action?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** The 16/700 section heading, with the optional quiet action link. */
export function SectionHeader({ children, action, onAction, style }: SectionHeaderProps) {
  const { tokens } = useTheme();
  return (
    <View style={[{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }, style]}>
      <Text
        style={{
          color: tokens.text,
          fontSize: TYPE_HEADING,
          fontFamily: fontFamily.bold,
          letterSpacing: 0.2,
        }}
      >
        {children}
      </Text>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <Text
            style={{
              color: tokens.accent,
              fontSize: TYPE_CAPTION,
              fontFamily: fontFamily.bold,
              letterSpacing: 0.3,
            }}
          >
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
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
  /** The fixed semantic hues + neutral/accent. */
  tone?: "neutral" | "accent" | "danger" | "warning" | "success" | "running";
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/** The small pill — counts, scopes, status chips. 11pt/600, 8px radius. */
export function Badge({ children, tone = "neutral", style, textStyle }: BadgeProps) {
  const { tokens } = useTheme();
  const bg =
    tone === "accent"
      ? tokens.accent
      : tone === "danger"
        ? tokens.danger
        : tone === "warning"
          ? tokens.warning
          : tone === "success"
            ? tokens.success
            : tone === "running"
              ? tokens.running
              : tokens.pillBg;
  const fg =
    tone === "accent"
      ? tokens.accentText
      : tone === "neutral"
        ? tokens.textSecondary
        : "#FFFFFF";
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
      <Text style={[{ color: fg, fontSize: TYPE_MICRO, fontFamily: fontFamily.bold, letterSpacing: 0.3 }, textStyle]}>
        {children}
      </Text>
    </View>
  );
}

// ── TypeScale (the Manrope ladder, DESIGN.md §4) ────────────────────────────

export interface TypeScaleProps {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
  /** Screen-reader label (the a11y discipline — every meaningful text row). */
  accessibilityLabel?: string;
}

/** 28/800 — display: large titles (home hero, wizard headlines). */
export function TypeDisplay({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.text, fontSize: TYPE_DISPLAY, fontFamily: fontFamily.extrabold, letterSpacing: -0.5 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** 20/700 — title: pushed screens' headers. */
export function TypeTitle({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_TITLE, fontFamily: fontFamily.bold, letterSpacing: -0.2 }, style]}
    >
      {children}
    </Text>
  );
}

/** 16/700 — section headers. */
export function TypeHeading({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_HEADING, fontFamily: fontFamily.bold }, style]}
    >
      {children}
    </Text>
  );
}

/** 15/400 — body and list rows. */
export function TypeBody({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_BODY, fontFamily: fontFamily.regular, lineHeight: 22 }, style]}
    >
      {children}
    </Text>
  );
}

/** 15/600 — emphasized body (key numbers, names). */
export function TypeBodyStrong({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.text, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold, lineHeight: 22 }, style]}
    >
      {children}
    </Text>
  );
}

/** 12.5/500 — captions, status lines, metadata (secondary tone by default). */
export function TypeCaption({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.textSecondary, fontSize: TYPE_CAPTION, fontFamily: fontFamily.medium, lineHeight: 17 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** 11/600 — micro badges, uppercase kickers. */
export function TypeMicro({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[{ color: tokens.textSecondary, fontSize: TYPE_MICRO, fontFamily: fontFamily.semibold, letterSpacing: 0.5 }, style]}
    >
      {children}
    </Text>
  );
}

/** Machine text — commands, fingerprints, PINs, addresses (JetBrains Mono). */
export function TypeMono({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.monoText, fontSize: TYPE_MONO, fontFamily: fontFamily.mono, lineHeight: 19 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
