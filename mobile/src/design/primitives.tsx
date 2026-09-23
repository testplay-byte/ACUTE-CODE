/**
 * The design-system primitives — the CLAY STUDIO + LIQUID CHROME kit
 * (DESIGN.md, R109). Every screen is assembled from these plus raw
 * View/Text:
 *
 *   ClayCard      — the resting clay surface v2 (R117-g1): radius 20, the
 *                   warm hairline RIM on all four sides, two-leg shadow at
 *                   v2 alphas, the matte top edge dark-mode-only
 *   PressableCard — the press state: tint + 0.98 scale + shadow collapse,
 *                   one spring, NO ripple (android_ripple stays off forever)
 *   FadeInUp      — the fade-in-up entrance for non-card blocks (R115 §2)
 *   ChromeButton  — the primary CTA: accentDeep fill + accentText label +
 *                   the quiet vertical sheen (one of the three sanctioned
 *                   chrome surfaces, §2); flat = the R115 wizard CTA
 *                   (sheen-less, clay shadow)
 *   QuietButton   — the secondary action: outlined, flat, honest
 *   ChromeEdge    — the 1px gradient border wrapper (the floating bar's
 *                   edge + selected markers — the other sanctioned chrome)
 *   ClayInput     — the text input: radius 14, focus ring in accent
 *   Chip          — the filter chip (selected = accentDeep fill; resting
 *                   chips sit in the surfaceWell)
 *   ClayIconChip  — the tinted identity chip (R117-g2 §2.2): accentTint
 *                   fill + clayRim hairline + clayShadowSm, the accentDeep
 *                   glyph — kills the subtleHover ghost icon chips
 *   ConnectionPill— the always-visible link status pill (§6)
 *   StatusDot     — the animated state dot (pulses while probing)
 *   Skeleton      — the loading placeholder (calm opacity pulse, well fill)
 *   SectionHeader — the 16/700 section heading + optional action
 *   Badge / Hairline / TypeScale — the quiet survivors, re-typed; Badge
 *                   rides the R117-g1 tinted containers (deep-on-tint)
 *
 * Nothing here owns a color: every value reads the resolved theme so a
 * theme switch re-renders the whole instrument with zero prop plumbing.
 * R117-g1 (round-117-elevation.md §2.2) upgraded the materials WITHOUT a
 * single prop-API change — every consumer upgraded free.
 */

import { LinearGradient } from "expo-linear-gradient";
import React, { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react-native";
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
  interpolateColor,
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
  RADIUS_CHIP,
  RADIUS_INPUT,
  RADIUS_PILL,
  SEGMENT_INSET,
  SEGMENT_TRACK_H,
  TOUCH_TARGET,
  TYPE_BODY,
  TYPE_CAPTION,
  TYPE_DISPLAY,
  TYPE_HEADING,
  TYPE_MICRO,
  TYPE_MONO,
  TYPE_STAT,
  TYPE_TITLE,
  fontFamily,
  pressTint,
  spacing,
} from "./tokens";
import { ENTRANCE_DELTA, PRESS_SCALE, SPRING, TAB_SPRING, staggerDelay } from "./motion";

// ── ClayCard — the resting clay surface ─────────────────────────────────────

export interface ClayCardProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Elevation 2 renders the deeper shadow pair (heroes, sheets). */
  elevated?: boolean;
  /** The small-surface shadow step (chips, compact tiles). */
  small?: boolean;
  /** Input-ish cards swap the default clayRim for the stronger input
   *  border (R117-g1: the default is now rimmed on all four sides). */
  bordered?: boolean;
  testID?: string;
}

/**
 * The resting clay surface — DESIGN.md §1, the v2 R117-g1 material: fill
 * `card` + the warm hairline RIM on all four sides + the two-leg shadow at
 * v2 alphas. The matte top edge is a DARK-MODE-ONLY device (14% white) —
 * the old 55% white mix was arithmetically invisible on ~99%-white light
 * cards (round-117-elevation.md §1.1/§2.2, AMENDMENT 1). Still never a
 * gradient, never animated, never glow.
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
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: bordered ? tokens.border : tokens.clayRim,
          ...(tokens.isDark ? { borderTopColor: tokens.clayTopEdge } : null),
          boxShadow: small ? tokens.clayShadowSm : elevated ? tokens.clayShadow2 : tokens.clayShadow1,
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
        // The v2 R117-g1 material: rim all sides (the dark-mode top edge
        // rides the same hairline) + the two-leg shadow at v2 alphas.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tokens.clayRim,
        ...(tokens.isDark ? { borderTopColor: tokens.clayTopEdge } : null),
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
  /** R118-A — the destructive confirm rides the danger fill
   *  (dangerDeep + its AA ink); a destructive verb never wears the ember. */
  tone?: "accent" | "danger";
  /** The quiet vertical sheen (default true — the §2.2 jewelry). */
  sheen?: boolean;
  /** R115: the flat wizard CTA — solid accent, NO sheen gradient, the clay
   *  elevation-2 shadow (the round-115 "no glow/sheen on CTAs" verdict,
   *  components.md's Primary idiom). Additive + optional: every other
   *  caller renders exactly as before. */
  flat?: boolean;
  /** R119-P (round-119 §1 item 10 — the provider hero's "Test connection"
   *  line-broke to "Test"/"connection" at 360dp, where the two flex:1 peers
   *  leave ~144dp and the 15px bold label measures ~125–135dp plus 40dp of
   *  padding): opt-in label fitting — the label clamps to ONE line and
   *  SHRINKS to fit (adjustsFontSizeToFit, minimumFontScale 0.85), and the
   *  horizontal padding breathes xl(20)→md(12) so the shrink rarely engages
   *  at all. Default OFF: every other call site renders byte-identical
   *  (wrapping stays the platform default for long labels). */
  labelFit?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** Show the busy spinner instead of the label. */
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  /** R118-E — exposes the expand/collapse state on disclosure-style CTAs
   *  ("Add a provider") to screen readers. */
  accessibilityExpanded?: boolean;
}

/**
 * The primary action — accentDeep fill (the ember light / the salmon
 * dark), radius 14, 50px tall, and the ONE quiet glint: a white α→0
 * gradient across the top half at the R117-g1 whisper alpha 0.18 (a
 * "one quiet glint," never a mirror, never a 2012 gloss band). Label =
 * accentText (white on ember 4.98:1 / warm ink on salmon 6.30:1 — AA at
 * last). Pressed = scale 0.98 + tint. `flat` (R115) drops the glint and
 * adds the clay elevation-2 shadow — the wizard CTA idiom.
 */
export function ChromeButton({
  children,
  onPress,
  disabled = false,
  tone = "accent",
  sheen = true,
  flat = false,
  labelFit = false,
  style,
  textStyle,
  busy = false,
  testID,
  accessibilityLabel,
  accessibilityExpanded,
}: ChromeButtonProps) {
  const { tokens } = useTheme();
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => {
    const scale = 1 - pressed.value * (1 - PRESS_SCALE);
    return { transform: [{ scale }] };
  });

  const inert = disabled || busy || !onPress;
  // R117-g1 §2.2 — the CTA fill is the DEEP accent tier; the label rides
  // accentText (the dark-mode ink flip: warm ink on the salmon — AA in both
  // modes, where the old fill/label pair sat at 3.98:1 dark and 3.98:1
  // light). R118-A: tone="danger" swaps in dangerDeep (white ink light
  // 4.83:1 / warm ink dark 6.15:1) — the destructive confirm's grammar.
  const bg = disabled
    ? pressTint(tokens.card, tokens.isDark)
    : tone === "danger"
      ? tokens.dangerDeep
      : tokens.accentDeep;
  const fg = disabled
    ? tokens.textTertiary
    : tone === "danger"
      ? tokens.isDark
        ? "#211B16"
        : "#FFFFFF"
      : tokens.accentText;

  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? (typeof children === "string" ? children : undefined)}
      accessibilityRole="button"
      accessibilityState={{
        disabled: inert,
        busy,
        ...(accessibilityExpanded !== undefined ? { expanded: accessibilityExpanded } : null),
      }}
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
          // R119-P: labelFit trades 8dp of chrome per side for label room
          // (xl 20 → md 12) — the default keeps the R117-g1 breathing.
          paddingHorizontal: labelFit ? spacing.md : spacing.xl,
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
              numberOfLines={labelFit ? 1 : undefined}
              adjustsFontSizeToFit={labelFit}
              minimumFontScale={labelFit ? 0.85 : undefined}
              style={[
                {
                  color: fg,
                  fontSize: TYPE_BODY,
                  fontFamily: fontFamily.bold,
                  letterSpacing: 0.3,
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
  /** R118-B — the in-flight state (mirrors ChromeButton's busy idiom): the
   *  spinner replaces the label and the button stays inert. */
  busy?: boolean;
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
  busy = false,
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
      accessibilityState={disabled || busy ? { disabled: true, busy } : undefined}
      disabled={disabled || busy || !onPress}
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
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[{ color: fg, fontSize: TYPE_BODY, fontFamily: fontFamily.semibold }, textStyle]}>
          {children}
        </Text>
      )}
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
 * The liquid-chrome hairline — the tab bar's 1px metal ramp. R118-B
 * re-cuts the ramp VERTICAL (crown → base): the old diagonal start/end
 * put chromeEdgeLight at the top-left corner and chromeEdgeDark at the
 * bottom-right — one visible corner and a smudge at the other three. The
 * vertical run makes both top corners lit and both base corners grounded
 * (symmetric), with the R118-B deepened base stop (0.22 light / 0.08 dark)
 * so the grounded edge actually draws on the white bar. The gradient also
 * carries `overflow: "hidden"` so the ring's corner anti-aliasing clips
 * to the radius. Sanctioned for the floating tab bar and selected markers
 * ONLY (DESIGN.md §2).
 */
export function ChromeEdge({ children, radius = RADIUS_BAR, style, surface }: ChromeEdgeProps) {
  const { tokens } = useTheme();
  const inner = surface ?? tokens.card;
  return (
    <LinearGradient
      colors={[tokens.chromeEdgeLight, tokens.chromeEdgeDark]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[{ borderRadius: radius, padding: 1, overflow: "hidden" }, style]}
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
        {...inputProps}
        // R120-M (round-120 §1 item 17 — the model editor's numeric fields
        // swap to their simplified form ON BLUR and back to full digits ON
        // FOCUS): the caller's handlers CHAIN after the ring's own state.
        // Placed AFTER the spread so last-wins cannot let a caller's raw
        // onFocus/onBlur kill the focus ring (the old order did exactly
        // that). Additive: callers that pass none render byte-identical.
        onFocus={(e) => {
          setFocused(true);
          inputProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          inputProps.onBlur?.(e);
        }}
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

/** The filter chip — selected = accentDeep fill + accentText (4.98:1);
 *  resting chips sit in the surfaceWell with the clayRim hairline
 *  (R117-g1 §2.2 — the old pillBg ghost rectangle is gone). */
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
          backgroundColor: selected ? tokens.accentDeep : pressed ? tokens.subtleHover : tokens.surfaceWell,
          borderRadius: RADIUS_PILL,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: selected ? tokens.accentDeep : tokens.clayRim,
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

// ── ClaySwitch — the clay toggle (R120-M: moved verbatim from the provider
// detail screen, which carried the only copy as a private helper — the
// model-form module + the provider hero both render it now; additive to the
// shared kit, byte-identical behavior: accent pill + sliding dot, the house
// spring) ────────────────────────────────────────────────────────────────────

const SWITCH_TRACK_W = 52;
const SWITCH_TRACK_H = 32;
const SWITCH_DOT = 24;
const SWITCH_PAD = 3;
const SWITCH_TRAVEL = SWITCH_TRACK_W - SWITCH_DOT - SWITCH_PAD * 2;

export interface ClaySwitchProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

export function ClaySwitch({ value, onValueChange, disabled = false, label }: ClaySwitchProps) {
  const { tokens } = useTheme();
  const progress = useSharedValue(value ? 1 : 0);

  React.useEffect(() => {
    progress.value = withSpring(value ? 1 : 0, SPRING);
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [tokens.pillBg, tokens.accent]),
  }));
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * SWITCH_TRAVEL }],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={6}
      style={claySwitchStyles.target}
    >
      <Animated.View style={[claySwitchStyles.track, trackStyle, disabled ? { opacity: 0.5 } : null]}>
        <Animated.View
          style={[
            claySwitchStyles.dot,
            { backgroundColor: value ? tokens.accentText : tokens.textSecondary },
            dotStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const claySwitchStyles = StyleSheet.create({
  target: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  track: {
    width: SWITCH_TRACK_W,
    height: SWITCH_TRACK_H,
    borderRadius: SWITCH_TRACK_H / 2,
    padding: SWITCH_PAD,
    justifyContent: "center",
  },
  dot: {
    width: SWITCH_DOT,
    height: SWITCH_DOT,
    borderRadius: SWITCH_DOT / 2,
  },
});

// ── ClayIconChip — the tinted identity chip (R117-g2 §2.2) ─────────────────

export interface ClayIconChipProps {
  /** The glyph — the chip owns its color (accentDeep) + strokeWidth (2.2). */
  icon: LucideIcon;
  /** The glyph's size (px) — the caller owns it (17–24 across the sites). */
  iconSize: number;
  /** The chip's edge: 40 (r 14) · 44 (r 15) · 48 (r 16). Default 40. */
  size?: 40 | 44 | 48;
  /** Overlay children rendered inside the chip (home's unread dot). */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The per-size corner radii (round-117-elevation.md §2.2: 40→14, 44→15,
 *  48→16 — the geometry the migrated sites already carried). */
const CLAY_ICON_CHIP_RADIUS: Record<40 | 44 | 48, number> = {
  40: RADIUS_INPUT,
  44: 15,
  48: RADIUS_CHIP,
};

/**
 * The tinted identity chip (R117-g2, round-117-elevation.md §2.2): fill
 * `accentTint` (the 12%/18% accent container — hue without loudness) + the
 * `clayRim` hairline + `clayShadowSm`, glyph `accentDeep` strokeWidth 2.2.
 * This is the single change that puts hue into every list row without
 * touching the one-accent law: the old sites filled these with
 * `subtleHover` — ghost rectangles behind accent glyphs at 1.19:1 (§1.5).
 * The chips stay quiet (a 12% tint), but they finally exist.
 */
export function ClayIconChip({
  icon: Icon,
  iconSize,
  size = 40,
  children,
  style,
  testID,
}: ClayIconChipProps) {
  const { tokens } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          width: size,
          height: size,
          borderRadius: CLAY_ICON_CHIP_RADIUS[size],
          backgroundColor: tokens.accentTint,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.clayRim,
          boxShadow: tokens.clayShadowSm,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Icon size={iconSize} color={tokens.accentDeep} strokeWidth={2.2} />
      {children}
    </View>
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
export function StatusDot({ color, pulse = false, size = 10 }: StatusDotProps) {
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
      // R117-g1 §2.2 — the skeleton forecasts the WELL (one step warmer than
      // the card it stands in), not the old ghost overlay.
      style={[animated, { backgroundColor: tokens.surfaceWell, borderRadius: RADIUS_INPUT }, style]}
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
  /** R118-E — the LARGE variant (TypeTitle 20/700, −0.2): registry screens'
   *  inventory tier ("Your providers") — one ladder step above every other
   *  section header, the peer of the screen that heads it. */
  large?: boolean;
}

/** The 16/700 section heading, with the optional quiet action link.
 *  R117-g2 (AMENDMENT 5 — the rhythm): the header carries `marginTop:
 *  spacing.xl` (20) so a section break reads 32 px (20 + the scaffold's
 *  12 px intra-group gap) while rows knit at 12 — the cadence that replaced
 *  the uniform 16 px beat (round-117-elevation.md §2.1). R118-E: `large`
 *  renders the TypeTitle recipe for inventory-tier headings. */
export function SectionHeader({ children, action, onAction, style, large = false }: SectionHeaderProps) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginTop: spacing.xl,
        },
        style,
      ]}
    >
      <Text
        style={{
          color: tokens.text,
          fontSize: large ? TYPE_TITLE : TYPE_HEADING,
          fontFamily: fontFamily.bold,
          letterSpacing: large ? -0.2 : 0.2,
        }}
      >
        {children}
      </Text>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <Text
            style={{
              // R117-g1 §2.2 — accent-as-text rides the DEEP tier (4.89:1 on
              // card; the old accent-as-text was 3.9:1).
              color: tokens.accentDeep,
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

/** The quiet divider: one hairline, theme border color, optional inset.
 *  R118-B — `strong` renders the VISIBLE clay divider: a full 1dp line in
 *  borderStrong (0.18 ink) instead of the sub-pixel 0.33dp hairlineWidth in
 *  borderSubtle (0.06) — the row-separation recipe for home's recent
 *  activities, More's stats, the dashboard session rows, and the providers
 *  tier break (one spelling everywhere). */
export function Hairline({
  inset = 0,
  strong = false,
  style,
}: {
  inset?: number;
  strong?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="separator"
      style={[
        {
          height: strong ? 1 : StyleSheet.hairlineWidth,
          backgroundColor: strong ? tokens.borderStrong : tokens.borderSubtle,
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

/** The small pill — counts, scopes, status chips. 11/700, 8px radius.
 *  R117-g1 §2.2 — every tone is a TINTED CONTAINER (deep-on-tint, M3-style)
 *  off the theme's badgeTones map; the flat semantic hues remain for DOTS
 *  only. Every ink/tint pair ≥4.5:1 in both modes. */
export function Badge({ children, tone = "neutral", style, textStyle }: BadgeProps) {
  const { tokens } = useTheme();
  const { bg, fg } = tokens.badgeTones[tone];
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
      <Text style={[{ color: fg, fontSize: TYPE_MICRO, fontFamily: fontFamily.bold, letterSpacing: 0.4 }, textStyle]}>
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

/** 28/800 — display: large titles (home hero, wizard headlines). R117-g1:
 *  tracking tightened −0.5 → −0.8 (Manrope 800 at 28 likes it tighter; the
 *  wizard wordmark's +1.5 letterspaced brand line overrides via style). */
export function TypeDisplay({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.text, fontSize: TYPE_DISPLAY, fontFamily: fontFamily.extrabold, letterSpacing: -0.8 },
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

/** 12.5/500 — captions, status lines, metadata (secondary tone by default;
 *  R117-g1: lineHeight 17 → 18 — Manrope's tall ascenders wanted the room). */
export function TypeCaption({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.textSecondary, fontSize: TYPE_CAPTION, fontFamily: fontFamily.medium, lineHeight: 18 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** 11/600 — micro badges, uppercase kickers. R117-g1: lineHeight 15 +
 *  tracking 0.6 (the tiny tier gets its own rhythm instead of borrowing
 *  the line box). */
export function TypeMicro({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        {
          color: tokens.textSecondary,
          fontSize: TYPE_MICRO,
          fontFamily: fontFamily.semibold,
          lineHeight: 15,
          letterSpacing: 0.6,
        },
        style,
      ]}
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

/** 28 / mono-medium — stat & data numbers (R117-g1 §2.1, AMENDMENT 4): the
 *  dashboard's headline figures render at the display SIZE on the mono face
 *  (letterSpacing −0.5). The wave-3 dashboard upgrade consumes this; a
 *  named slot, not a new size. */
export function TypeStat({ children, style, numberOfLines, testID, accessibilityLabel }: TypeScaleProps) {
  const { tokens } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      style={[
        { color: tokens.text, fontSize: TYPE_STAT, fontFamily: fontFamily.monoMedium, letterSpacing: -0.5 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ── R118: QuietIconButton — the chrome circle (the back/close grammar) ──────

export interface QuietIconButtonProps {
  /** The lucide glyph (ArrowLeft for back, X for sheet close). */
  icon: LucideIcon;
  /** The glyph's size (px). */
  iconSize: number;
  onPress: () => void;
  accessibilityLabel: string;
  /** The circle's size — 36 (sheet chrome), 40 (screen back), 44 (full). */
  size?: 36 | 40 | 44;
  /** Extra hit room beyond the circle (default 4 — 40+4 carries the 44 law). */
  hitSlop?: number;
  testID?: string;
}

const QUIET_ICON_BUTTON_RADIUS: Record<36 | 40 | 44, number> = {
  36: 18,
  40: 20,
  44: 22,
};

/**
 * R118-A/D — the quiet chrome circle: the sheet's close button and the
 * screens' back button share ONE grammar (the owner: the sheet's X "needs
 * to be handled properly, just like how the back button is in our
 * application"). A `subtle`-filled circle with the hairline `borderSubtle`
 * rim and the text-tier glyph (strokeWidth 2.2), pressing to `subtleHover`
 * + the house 0.98 scale — the R116-b back chip's contract made circular
 * and shared. 36 = sheet chrome (X 18); 40 = the screen back (ArrowLeft
 * 22 — "make it a bit more smaller"); 44 = full-target uses.
 */
export function QuietIconButton({
  icon: Icon,
  iconSize,
  onPress,
  accessibilityLabel,
  size = 40,
  hitSlop = 4,
  testID,
}: QuietIconButtonProps) {
  const { tokens } = useTheme();
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => {
    const scale = 1 - pressed.value * (1 - PRESS_SCALE);
    return { transform: [{ scale }] };
  });
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={() => {
        pressed.value = withSpring(1, SPRING);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, SPRING);
      }}
      style={({ pressed: p }: PressableStateCallbackType): StyleProp<ViewStyle> => [
        {
          width: size,
          height: size,
          borderRadius: QUIET_ICON_BUTTON_RADIUS[size],
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: p ? tokens.subtleHover : tokens.subtle,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.borderSubtle,
        },
      ]}
    >
      <Animated.View style={animated}>
        <Icon size={iconSize} color={tokens.text} strokeWidth={2.2} />
      </Animated.View>
    </Pressable>
  );
}

// ── R118: SegmentedControl — the one-line N-way selector ────────────────────

export interface SegmentedControlOption<T extends string> {
  id: T;
  /** The display label — SHORT (≤4 chars where possible); the full name
   *  rides `accessibilityLabel` (donts #43: 2–4 mutually exclusive choices
   *  sit on ONE line, all visible). */
  label: string;
  /** The full option name for screen readers. */
  accessibilityLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedControlOption<T>>;
  selectedId: T;
  onSelect: (id: T) => void;
  testID?: string;
}

/**
 * R118-A — the one-line segmented control (the API-format selector's
 * three-on-one-row mandate; the appearance mode selector and the
 * dashboard's period selector converge on the same grammar). Track:
 * `surfaceWell` fill + hairline `clayRim` (the R117 chip resting surface),
 * 52 tall / radius 26 / 4 inset. The sliding indicator = the AA-clean
 * selection pill — `accentDeep` fill, NO border (a filled pill like the
 * Chip; donts #34 holds — there is no hairline to under-draw), gliding in
 * index space on TAB_SPRING (the calm slide). Selected label: 15/700 in
 * `accentText` (4.98:1 light / 6.30:1 dark — AA at any size); unselected:
 * 15/600 `textSecondary` (6.18:1). Segments carry the 44px touch law.
 * Deliberately NOT the tab pill's accentTint+2px-border recipe — that pair
 * computes 4.25:1/3.77:1 as TEXT and is pinned only at the 3:1 chrome
 * tier; this control's labels are text.
 */
export function SegmentedControl<T extends string>({
  options,
  selectedId,
  onSelect,
  testID,
}: SegmentedControlProps<T>) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);

  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === selectedId),
  );
  const segmentWidth = (trackWidth - SEGMENT_INSET * 2) / Math.max(options.length, 1);
  const indicatorIndex = useSharedValue(activeIndex);

  useEffect(() => {
    if (reduced) {
      indicatorIndex.value = activeIndex;
      return;
    }
    indicatorIndex.value = withSpring(activeIndex, TAB_SPRING);
  }, [activeIndex, reduced, indicatorIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorIndex.value * segmentWidth }],
  }));

  return (
    <View
      testID={testID}
      style={[
        {
          height: SEGMENT_TRACK_H,
          borderRadius: SEGMENT_TRACK_H / 2,
          padding: SEGMENT_INSET,
          flexDirection: "row",
          backgroundColor: tokens.surfaceWell,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.clayRim,
        },
      ]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      {trackWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: SEGMENT_INSET,
              bottom: SEGMENT_INSET,
              left: SEGMENT_INSET,
              width: segmentWidth,
              borderRadius: (SEGMENT_TRACK_H - SEGMENT_INSET * 2) / 2,
              backgroundColor: tokens.accentDeep,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {options.map((o) => {
        const selected = o.id === selectedId;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="button"
            accessibilityLabel={o.accessibilityLabel ?? o.label}
            accessibilityState={{ selected }}
            onPress={() => onSelect(o.id)}
            style={{
              flex: 1,
              minHeight: TOUCH_TARGET,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: spacing.xs,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? tokens.accentText : tokens.textSecondary,
                fontSize: TYPE_BODY,
                fontFamily: selected ? fontFamily.bold : fontFamily.medium,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── R118: LiveCaret — the "still typing" marker, shared ─────────────────────

/**
 * R118-B — the live caret extracted from transcript.tsx's private recipe
 * (byte-identical: width 8, height 15, radius 2, opacity 0.25↔1 at 550ms
 * legs, marginLeft 2 — motion.md §3's own "Live caret" idiom). The home
 * screen's Happening-now rows append it so the live preview carries the
 * unique animated presence the owner asked for; the transcript swaps to
 * this import (reuse, never re-roll). Reduced motion snaps solid.
 */
export function LiveCaret({ color, label = "live" }: { color: string; label?: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.25, { duration: 550 }), withTiming(1, { duration: 550 })),
      -1,
      false,
    );
  }, [opacity, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel={label}
      style={[animated, { width: 8, height: 15, borderRadius: 2, backgroundColor: color, marginLeft: 2 }]}
    />
  );
}
