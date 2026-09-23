/**
 * Toast — the app's transient one-line verdict strip (R120-M, round-120
 * §1 item 16 — the owner's ruling: "A failed model test and a Hide-model
 * action show their details at the bottom of the sheet — they must be a
 * toast that auto-dismisses in ~2s").
 *
 * THE TOAST LAW (the round's amendment to components.md's feedback rule —
 * "Success/error feedback = the NoteLine idiom or a haptic; toasts only
 * for cross-screen consequences"):
 *   · a toast carries ONE transient verdict — auto-dismisses in 2s
 *     (TOAST_MS); the newest toast REPLACES the one before it (never a
 *     stack, never a queue — these are one-line verdicts, not a log);
 *   · placement is TOP (below the status-bar inset): the bottom band
 *     belongs to the sheets these verdicts fire over and to the composer
 *     elsewhere — a bottom toast would collide with exactly the surfaces
 *     that trigger it;
 *   · anatomy = the NoteLine's grammar on a floating clay strip: the
 *     semantic StatusDot + ONE caption (2 lines max, tail-clipped), card
 *     fill + clayRim hairline + clayShadow2, radius 14 — no icon walls,
 *     no action buttons (a toast never asks a question — sheets ask);
 *   · motion = the quick crossfade family (180ms ease-out fade + an 8dp
 *     settle from above; the exit is a 120ms fade) — reduced motion snaps;
 *   · a Modal-hosted surface (a Sheet) renders its OWN `<ToastHost />` as
 *     the first child of its content: RN Modals are separate native
 *     windows, so a toast fired while a sheet is open must render INSIDE
 *     the sheet's own tree to be visible — both hosts read the SAME
 *     provider state, so one `show()` serves whichever surface is showing.
 *
 * Pure seams exported for the jest pins: TOAST_MS / TOAST_ENTER_MS /
 * TOAST_EXIT_MS / TOAST_MAX_LINES / toastToneColor(kind, tokens) /
 * toastClampText(text) — no React Native import in those helpers' graph.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { StatusDot } from "@/design/primitives";
import type { ResolvedTheme } from "@/design/tokens";
import { RADIUS_INPUT, TYPE_CAPTION, fontFamily, spacing } from "@/design/tokens";

// ── the vocabulary ──────────────────────────────────────────────────────────

/** The three verdict tones (the NoteLine's own set — no new vocabulary). */
export type ToastKind = "saved" | "caution" | "error";

/** One transient verdict: the tone + the one line of text. */
export interface ToastSpec {
  kind: ToastKind;
  text: string;
}

/** The owner's "~2s" — the auto-dismiss budget. */
export const TOAST_MS = 2000;
/** The enter: the quick crossfade family's 180ms leg + the 8dp settle. */
export const TOAST_ENTER_MS = 180;
/** The exit: the 120ms fade (the sheet-exit family's own number). */
export const TOAST_EXIT_MS = 120;
/** The caption's line ceiling — a verdict is a line, never a wall. */
export const TOAST_MAX_LINES = 2;
/** The text clamp — keeps the two lines honest on the narrowest screens. */
export const TOAST_TEXT_CAP = 140;

/**
 * The tone → dot/text hue mapping (the NoteLine's exact tones: saved =
 * success, caution = warningDeep, error = danger). Pure.
 */
export function toastToneColor(kind: ToastKind, tokens: ResolvedTheme): string {
  if (kind === "error") return tokens.danger;
  if (kind === "caution") return tokens.warningDeep;
  return tokens.success;
}

/**
 * The clamp every toast text rides at the provider edge: whitespace
 * collapsed, capped at TOAST_TEXT_CAP with an honest ellipsis. Pure.
 */
export function toastClampText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  return collapsed.length > TOAST_TEXT_CAP ? `${collapsed.slice(0, TOAST_TEXT_CAP - 3)}…` : collapsed;
}

// ── the context ─────────────────────────────────────────────────────────────

export interface ToastContextValue {
  /** Show ONE toast (replaces whatever is showing; auto-dismisses in 2s). */
  show: (spec: ToastSpec) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * The provider: owns the ONE active toast + its timers. `show()` clamps the
 * text, clears any running timer, and starts the 2s auto-dismiss; the exit
 * phase keeps the strip mounted for its 120ms fade before it unmounts.
 * Mount inside ThemeProvider (the strip reads the resolved tokens).
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [exiting, setExiting] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (dismissTimer.current !== null) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (exitTimer.current !== null) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const show = useCallback(
    (spec: ToastSpec) => {
      const text = toastClampText(spec.text);
      if (text === "") return;
      clearTimers();
      setExiting(false);
      setToast({ kind: spec.kind, text });
      dismissTimer.current = setTimeout(() => {
        // The exit phase: the strip fades over TOAST_EXIT_MS, then goes.
        setExiting(true);
        exitTimer.current = setTimeout(() => {
          setToast(null);
          setExiting(false);
        }, TOAST_EXIT_MS);
      }, TOAST_MS);
    },
    [clearTimers],
  );

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);
  const state = useMemo<ToastState>(() => ({ toast, exiting }), [toast, exiting]);

  return (
    <ToastContext.Provider value={value}>
      <ToastStateContext.Provider value={state}>
        {children}
        {/* The ROOT host — the top-of-screen strip (see the toast law). */}
        <RootToastHost />
      </ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

/**
 * The hook. Fails OPEN outside a provider (a no-op show) — a screen that
 * renders in a test harness or outside the shell never crashes on a toast.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return useMemo(
    () => ctx ?? { show: () => undefined },
    [ctx],
  );
}

// ── the strip ───────────────────────────────────────────────────────────────

/**
 * The toast strip itself — the NoteLine grammar on a floating clay card.
 * Mount-entrance: the 180ms fade + the 8dp settle from above (reduced
 * motion snaps); `exiting` fades it out over 120ms. Renders null when no
 * toast is active (a hidden toast occupies no layout — donts #48).
 */
export function ToastStrip({ toast, exiting }: { toast: ToastSpec; exiting: boolean }) {
  const { tokens } = useTheme();
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // A replacement toast re-enters from 0 (withTiming alone would start
    // from the settled 1 and never visibly animate).
    if (reducedMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: TOAST_ENTER_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [toast, reducedMotion, progress]);

  useEffect(() => {
    if (!exiting) return;
    progress.value = reducedMotion
      ? 0
      : withTiming(0, { duration: TOAST_EXIT_MS, easing: Easing.in(Easing.quad) });
  }, [exiting, reducedMotion, progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -8 }],
  }));

  const tone = toastToneColor(toast.kind, tokens);
  return (
    <Animated.View
      accessibilityLabel={`Toast: ${toast.text}`}
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        animated,
        {
          backgroundColor: tokens.card,
          borderColor: tokens.clayRim,
          boxShadow: tokens.clayShadow2,
        },
      ]}
    >
      <StatusDot color={tone} />
      <Text style={[styles.text, { color: tone }]} numberOfLines={TOAST_MAX_LINES} ellipsizeMode="tail">
        {toast.text}
      </Text>
    </Animated.View>
  );
}

// ── the provider's internal state seam (the hosts read, the provider writes) ─

interface ToastState {
  toast: ToastSpec | null;
  exiting: boolean;
}

const ToastStateContext = createContext<ToastState>({ toast: null, exiting: false });

function useToastState(): ToastState {
  return useContext(ToastStateContext);
}

/**
 * A toast host for a Modal-hosted surface: renders the active strip (or
 * nothing — donts #48: no content, no chrome). A Sheet renders
 * `<ToastHost />` as the FIRST child of its content so a verdict fired
 * while the sheet is open is VISIBLE — the RN Modal is a separate native
 * window that hides anything rendered in the root tree (the toast law's
 * Modal clause). The strip enters with the standard 180ms fade; the 2s
 * auto-dismiss is the provider's own timer.
 */
export function ToastHost() {
  const state = useToastState();
  if (state.toast === null) return null;
  return <ToastStrip toast={state.toast} exiting={state.exiting} />;
}

// ── the root host's placement (the toast law: TOP, below the inset) ─────────

function RootToastHost() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const state = useToastState();
  if (state.toast === null) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.rootAnchor,
        { top: insets.top + spacing.sm, maxWidth: Math.round(windowWidth * 0.86) },
      ]}
    >
      <ToastStrip toast={state.toast} exiting={state.exiting} />
    </View>
  );
}

const styles = StyleSheet.create({
  /** The strip: the floating clay card — self-sized, centered by its anchor. */
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: {
    flex: 1,
    fontSize: TYPE_CAPTION,
    fontFamily: fontFamily.medium,
    lineHeight: 18,
  },
  /** The root anchor: the top-of-screen overlay band (never intercepts touch). */
  rootAnchor: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    alignSelf: "center",
    alignItems: "center",
  },
});
