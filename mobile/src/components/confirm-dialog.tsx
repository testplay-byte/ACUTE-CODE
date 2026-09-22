/**
 * ConfirmDialog — the app's FIRST centered dialog primitive (R118-D §2.3;
 * no centered-dialog surface existed — Sheet was the only Modal host). A
 * RN <Modal> transparent host carrying a small clay card: scrim → card →
 * title + one-line body + the two-button row. Reserved for the short
 * destructive confirmations the owner ruled need a second word ("do you
 * want to stop?") — NOT a general form container (sheets own forms).
 *
 * The grammar (the Sheet's own materials, re-anchored to center):
 *   · scrim 0.45 light / 0.62 dark (the sheet tokens) fading 160ms in/out;
 *     tapping it cancels — the honest dismissal, exactly like a sheet;
 *   · card width min(320, windowWidth − 40), RADIUS_CARD 20, tokens.card,
 *     the matte clay top edge + clayShadow2 (the floating elevation);
 *   · Title TypeTitle (2 lines max) + body TypeCaption (ONE line) — the
 *     single-line law; a confirm dialog is a sentence, not a document;
 *   · the button row: flex 1 both, minHeight 46, radius 14 — cancel = the
 *     QUIET outline (QuietButton), confirm = filled `dangerDeep` with white
 *     ink light / #211B16 dark, label 15/700 (the destructive grammar; a
 *     non-destructive confirm falls back to the accentDeep CTA pair);
 *   · entrance scale 0.96→1 on the house SPRING, origin CENTER (a centered
 *     dialog grows from its own middle — the dropdown's top-right pin is
 *     wrong here); exit = the 120ms fade; reduced motion snaps (motion.md
 *     §5); `warningHaptic` fires on CONFIRM only (a cancel is not an event).
 *
 * R118-A (the first-frame law, applied): the Modal surfaces a NEW Android
 * window whose first frame(s) can composite BEFORE Reanimated attaches —
 * the card carries the STATIC INITIAL POSE (opacity 0 + scale 0.96) ahead
 * of the animated style in the flatten array, so those frames find the
 * card hidden, never open (last-wins; inert after frame one).
 */

import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { QuietButton, TypeCaption, TypeTitle } from "@/design/primitives";
import { warningHaptic } from "@/design/haptics";
import { SPRING } from "@/design/motion";
import { RADIUS_CARD, RADIUS_INPUT, TYPE_BODY, fontFamily, spacing } from "@/design/tokens";

export interface ConfirmDialogProps {
  /** Whether the dialog is open (the caller owns the state). */
  open: boolean;
  /** The question, TypeTitle, ≤2 lines ("Stop this turn?"). */
  title: string;
  /** The one-line context sentence (TypeCaption, 1 line). */
  body?: string;
  /** The confirm button's label. */
  confirmLabel: string;
  /** The quiet cancel button's label. */
  cancelLabel: string;
  /** The destructive grammar: confirm fills dangerDeep (else accentDeep). */
  destructive?: boolean;
  onConfirm: () => void;
  /** Cancel — the scrim tap, the quiet button, and Android's back button. */
  onCancel: () => void;
  testID: string;
}

/** §2.3 — the card's floor width. */
export const DIALOG_CARD_MIN_WIDTH = 320;
/** §2.3 — the gutter the card keeps from the screen's edges. */
export const DIALOG_SCREEN_MARGIN = 40;
/** §2.3 — the button row's height + radius (r14 = RADIUS_INPUT). */
export const DIALOG_BUTTON_MIN_HEIGHT = 46;
/** The scrim's fade, in and out (the sheet tokens' own 160ms). */
export const DIALOG_SCRIM_MS = 160;
/** The card's exit fade (the dropdown's own 120ms). */
export const DIALOG_EXIT_FADE_MS = 120;
/** The entrance scale floor (0.96→1, origin center). */
export const DIALOG_ENTRANCE_SCALE = 0.96;

/** §2.3 — the card's width: min(320, windowWidth − 40). Pure (the tests
 *  pin this arithmetic). */
export function dialogCardWidth(windowWidth: number): number {
  return Math.min(DIALOG_CARD_MIN_WIDTH, Math.max(0, windowWidth - DIALOG_SCREEN_MARGIN));
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
  testID,
}: ConfirmDialogProps) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const { width: windowWidth } = useWindowDimensions();
  // Two independent values (the Sheet's discipline): the scrim's own
  // 160ms timing and the card's spring-in / fade-out. Mount/unmount: the
  // card springs in on open, fades out over DIALOG_EXIT_FADE_MS on close,
  // and the Modal unmounts only after the SLOWER scrim fade settles.
  const cardProgress = useSharedValue(0);
  const scrimProgress = useSharedValue(0);
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      scrimProgress.value = withTiming(1, { duration: DIALOG_SCRIM_MS });
      cardProgress.value = reduced ? 1 : withSpring(1, SPRING);
      return;
    }
    if (!rendered) return;
    if (reduced) {
      // motion.md §5 — reduced motion snaps: no exit animation at all.
      cardProgress.value = 0;
      scrimProgress.value = 0;
      setRendered(false);
      return;
    }
    cardProgress.value = withTiming(0, { duration: DIALOG_EXIT_FADE_MS });
    scrimProgress.value = withTiming(0, { duration: DIALOG_SCRIM_MS }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, rendered, reduced, cardProgress, scrimProgress]);

  const cardStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, cardProgress.value));
    const s = DIALOG_ENTRANCE_SCALE + (1 - DIALOG_ENTRANCE_SCALE) * p;
    return { opacity: p, transform: [{ scale: s }] };
  });
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimProgress.value }));

  const confirmInk = destructive ? (tokens.isDark ? "#211B16" : "#FFFFFF") : tokens.accentText;

  if (!rendered) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onCancel}
      testID={testID}
    >
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            // R118-A — the first-frame guard: zero until the worklet reports.
            { opacity: 0 },
            scrimStyle,
            { backgroundColor: tokens.isDark ? "rgba(0,0,0,0.62)" : "rgba(26,18,10,0.45)" },
          ]}
        >
          <Pressable
            accessibilityLabel="Cancel"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={onCancel}
          />
        </Animated.View>
        <View style={styles.center}>
          <Animated.View
            accessibilityLabel={title}
            style={[
              styles.card,
              // R118-A — the static initial pose: hidden until the worklet
              // reports, then last-wins silently loses. A centered dialog
              // must never paint OPEN on the Modal's first frame.
              { opacity: 0, transform: [{ scale: DIALOG_ENTRANCE_SCALE }] },
              cardStyle,
              {
                width: dialogCardWidth(windowWidth),
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
            ]}
          >
            <TypeTitle numberOfLines={2}>{title}</TypeTitle>
            {body !== undefined ? (
              <TypeCaption numberOfLines={1} style={{ color: tokens.textSecondary }}>
                {body}
              </TypeCaption>
            ) : null}
            <View style={styles.buttonRow}>
              <QuietButton onPress={onCancel} style={styles.button} testID={`${testID}-cancel`}>
                {cancelLabel}
              </QuietButton>
              <Pressable
                accessibilityLabel={confirmLabel}
                accessibilityRole="button"
                testID={`${testID}-confirm`}
                onPress={() => {
                  // §2.3 — the haptic rides the DECISION, never the cancel.
                  void warningHaptic();
                  onConfirm();
                }}
                style={({ pressed }) => [
                  styles.confirmButton,
                  {
                    backgroundColor: destructive ? tokens.dangerDeep : tokens.accentDeep,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                  },
                ]}
              >
                <Text style={[styles.confirmLabel, { color: confirmInk }]} numberOfLines={1}>
                  {confirmLabel}
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /** The centered anchor — the card sits the screen's middle. */
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  /** §2.3 — RADIUS_CARD 20 + the matte top edge + clayShadow2 (inline
   *  colors), padding lg, gap sm. */
  card: {
    borderRadius: RADIUS_CARD,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  /** One row, both buttons flex 1 minHeight 46 r14. */
  buttonRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  button: {
    flex: 1,
    minHeight: DIALOG_BUTTON_MIN_HEIGHT,
  },
  confirmButton: {
    flex: 1,
    minHeight: DIALOG_BUTTON_MIN_HEIGHT,
    borderRadius: RADIUS_INPUT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  /** The confirm's label — 15/700 (the filled CTA's weight). */
  confirmLabel: {
    fontSize: TYPE_BODY,
    fontFamily: fontFamily.bold,
  },
});
