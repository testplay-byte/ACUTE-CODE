/**
 * AttachmentViewer — the composer's attachment VIEWER POP-UP (R120-P,
 * round-120.md §1 item 32 — the owner's ask: "tapping ANY attachment opens
 * a viewer pop-up — images: a large preview; text files: a scrollable text
 * view; non-previewable types get a sensible viewer (name + size + type)").
 *
 * THE KINDS (features/attachments.ts's pure `attachmentPreviewKind`):
 *   · "image" — a PICKED image whose bytes the phone holds (localUri) → the
 *     existing full-screen ImageViewer rides AS-IS (the same surface the
 *     transcript's images open — one viewer vocabulary, never two);
 *   · "text"  — a chip carrying a head (a picked file's read, or the
 *     server-read ≤128KB head) → THIS component's centered clay card with
 *     the scrollable mono body (the ConfirmDialog family's materials —
 *     scrim, card, spring-in 0.96→1, the static first-frame pose — grown
 *     into a document surface: a title row + the body + the size line);
 *   · "info"  — a binary over the wire (or an image whose bytes live on
 *     the desktop host and never crossed to the phone) → the honest
 *     name + size + kind card — never a preview that pretends to hold
 *     pixels it does not.
 *
 * Motion: the card springs in on the house SPRING (origin center, the
 * centered-dialog grammar), the scrim fades over the sheet tokens' 160ms,
 * the exit is the 120ms fade; reduced motion snaps (motion.md §5); the
 * R118-A static initial pose guards the Modal's first frame. The image arm
 * delegates ALL of that to ImageViewer (its own law) — this component only
 * freezes the chip for the exit beat so the handoff never flashes.
 */

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { FileText, X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { SPRING } from "@/design/motion";
import { RADIUS_CARD, TYPE_BODY, fontFamily, spacing } from "@/design/tokens";
import { ImageViewer } from "@/components/image-viewer";
import { attachmentPreviewKind, formatAttachmentSize, isImageFileName, type ComposerAttachment } from "@/features/attachments";

export interface AttachmentViewerProps {
  /** The chip to view (null = closed — the caller owns the state). */
  chip: ComposerAttachment | null;
  onClose: () => void;
  testID?: string;
}

/** The text/info card's width ceiling — a document surface, wider than the
 *  confirm dialog's 320 floor but guttered the same way. */
export const VIEWER_CARD_MAX_WIDTH = 520;
/** The gutter the card keeps from the screen's edges (the dialog's own). */
export const VIEWER_SCREEN_MARGIN = 40;
/** The scrim's fade, in and out (the sheet tokens' own 160ms). */
export const VIEWER_SCRIM_MS = 160;
/** The card's exit fade (the dialog's own 120ms). */
export const VIEWER_EXIT_FADE_MS = 120;
/** The entrance scale floor (0.96→1, origin center — the dialog grammar). */
export const VIEWER_ENTRANCE_SCALE = 0.96;
/** The scroll body's share of the screen height (the rest is chrome). */
export const VIEWER_BODY_HEIGHT_RATIO = 0.6;

/** The card's width: min(520, windowWidth − 40). Pure (pinned by the tests). */
export function viewerCardWidth(windowWidth: number): number {
  return Math.min(VIEWER_CARD_MAX_WIDTH, Math.max(0, windowWidth - VIEWER_SCREEN_MARGIN));
}

/** The scroll body's maxHeight: 60% of the window height. Pure. */
export function viewerBodyMaxHeight(windowHeight: number): number {
  return Math.round(windowHeight * VIEWER_BODY_HEIGHT_RATIO);
}

/** The honest one-line caption under the body: the size, plus the head cap
 *  note when the chip carries only the first 128KB. Pure. */
export function viewerSizeCaption(chip: ComposerAttachment): string {
  const size = chip.size > 0 ? formatAttachmentSize(chip.size) : null;
  if (chip.truncated) {
    return size !== null ? `${size} · first 128 KB` : "first 128 KB";
  }
  return size ?? "";
}

/** The info card's kind line — a binary stays a binary; an image the phone
 *  has no bytes for says exactly where its bytes live. Pure. */
export function viewerKindCaption(chip: ComposerAttachment): string {
  if (chip.text !== null) return "text file";
  return isImageFileName(chip.name)
    ? "image · the bytes live on the host — no preview on this phone"
    : "binary file";
}

export function AttachmentViewer({ chip, onClose, testID }: AttachmentViewerProps) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // The chip FROZEN for the exit beat — a null `chip` starts the fade with
  // the last content still mounted, so the card never flashes empty.
  const [renderedChip, setRenderedChip] = useState<ComposerAttachment | null>(chip);
  const [rendered, setRendered] = useState(chip !== null);
  const cardProgress = useSharedValue(0);
  const scrimProgress = useSharedValue(0);

  useEffect(() => {
    if (chip !== null) {
      setRendered(true);
      setRenderedChip(chip);
      scrimProgress.value = withTiming(1, { duration: VIEWER_SCRIM_MS });
      cardProgress.value = reduced ? 1 : withSpring(1, SPRING);
      return;
    }
    if (!rendered) return;
    if (reduced) {
      // motion.md §5 — reduced motion snaps: no exit animation at all.
      cardProgress.value = 0;
      scrimProgress.value = 0;
      setRendered(false);
      setRenderedChip(null);
      return;
    }
    cardProgress.value = withTiming(0, { duration: VIEWER_EXIT_FADE_MS });
    scrimProgress.value = withTiming(0, { duration: VIEWER_SCRIM_MS }, (finished) => {
      if (finished) {
        runOnJS(setRendered)(false);
        runOnJS(setRenderedChip)(null);
      }
    });
  }, [chip, rendered, reduced, cardProgress, scrimProgress]);

  const cardStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, cardProgress.value));
    const s = VIEWER_ENTRANCE_SCALE + (1 - VIEWER_ENTRANCE_SCALE) * p;
    return { opacity: p, transform: [{ scale: s }] };
  });
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimProgress.value }));

  if (!rendered || renderedChip === null) return null;

  // ── the IMAGE arm: the existing full-screen viewer owns everything —
  // its scrim, its zoom spring, its caption bar. `open` follows the live
  // chip so the close plays the viewer's own 160ms exit (the frozen chip
  // keeps it mounted for exactly that beat).
  if (renderedChip.localUri !== undefined && attachmentPreviewKind(renderedChip) === "image") {
    const caption =
      renderedChip.size > 0
        ? `${renderedChip.name} · ${formatAttachmentSize(renderedChip.size)}`
        : renderedChip.name;
    return (
      <ImageViewer
        uri={renderedChip.localUri}
        caption={caption}
        open={chip !== null}
        onClose={onClose}
        testID={testID !== undefined ? `${testID}-image` : undefined}
      />
    );
  }

  // ── the TEXT / INFO arm: the centered clay card (the ConfirmDialog
  // family's materials, grown into a document surface).
  const isText = attachmentPreviewKind(renderedChip) === "text";
  return (
    <Modal
      visible
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
            // R118-A — the first-frame guard: zero until the worklet reports.
            { opacity: 0 },
            scrimStyle,
            { backgroundColor: tokens.isDark ? "rgba(0,0,0,0.62)" : "rgba(26,18,10,0.45)" },
          ]}
        >
          <Pressable
            accessibilityLabel="Close the attachment"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={onClose}
          />
        </Animated.View>
        <View style={styles.center}>
          <Animated.View
            accessibilityLabel={`Attachment ${renderedChip.name}`}
            style={[
              styles.card,
              // R118-A — the static initial pose: hidden until the worklet
              // reports (a centered surface must never paint open on the
              // Modal's first frame).
              { opacity: 0, transform: [{ scale: VIEWER_ENTRANCE_SCALE }] },
              cardStyle,
              {
                width: viewerCardWidth(windowWidth),
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
            ]}
          >
            {/* The title row — the file glyph + the one-line name + the
                close circle (the 44px law; the X glyph carries the word). */}
            <View style={styles.titleRow}>
              <FileText size={16} color={tokens.textTertiary} strokeWidth={2.2} />
              <TypeBodyStrong numberOfLines={1} style={styles.titleText}>
                {renderedChip.name}
              </TypeBodyStrong>
              <Pressable
                accessibilityLabel="Close the attachment"
                accessibilityRole="button"
                hitSlop={8}
                onPress={onClose}
                style={styles.closeTarget}
                testID={testID !== undefined ? `${testID}-close` : undefined}
              >
                <X size={TYPE_BODY + 2} color={tokens.text} strokeWidth={2.2} />
              </Pressable>
            </View>
            {isText && renderedChip.text !== null ? (
              <>
                {/* The scrollable mono body — the whole head the chip
                    carries (≤128KB server-side), selectable so the owner
                    can copy a span out of it. */}
                <ScrollView
                  style={{ maxHeight: viewerBodyMaxHeight(windowHeight) }}
                  overScrollMode="never"
                  nestedScrollEnabled
                >
                  <Text selectable style={[styles.body, { color: tokens.text }]}>
                    {renderedChip.text}
                  </Text>
                </ScrollView>
                <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
                  {viewerSizeCaption(renderedChip)}
                </TypeCaption>
              </>
            ) : (
              /* The honest info card — name (the title row) + size + kind.
                 Never a preview that pretends to hold pixels it does not. */
              <View style={styles.infoBlock}>
                <TypeCaption numberOfLines={1} style={{ color: tokens.textSecondary }}>
                  {viewerKindCaption(renderedChip)}
                </TypeCaption>
                {renderedChip.size > 0 ? (
                  <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
                    {formatAttachmentSize(renderedChip.size)}
                  </TypeCaption>
                ) : null}
              </View>
            )}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  card: {
    borderRadius: RADIUS_CARD,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  titleText: { flex: 1 },
  closeTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  infoBlock: {
    gap: spacing.xs,
    alignItems: "flex-start",
    paddingVertical: spacing.xs,
  },
});
