/**
 * ImageViewer — the full-screen image overlay (R113-c), built from the house
 * motion recipes + RN <Image> inside a RN <Modal>: the scrim fades in, the
 * image settles from a 0.96 scale under the ONE spring (the same entrance
 * language the list cards speak), a tap on the scrim or the X (or the
 * Android back button) dismisses, and the caption rides the bottom with the
 * safe-area inset. NO new dependency — the zoom is the entrance's own
 * spring, deliberately quiet (the transcript's honesty, not a gallery).
 */

import { useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption } from "@/design/primitives";
import { RADIUS_INPUT, spacing, TYPE_BODY } from "@/design/tokens";
import { SPRING } from "@/design/motion";

export interface ImageViewerProps {
  /** The image's source URI (a cache file URI — features/raster.ts). */
  uri: string;
  /** The caption line (the capturing tool + timestamp). */
  caption: string;
  /** Whether the viewer is open (the caller owns the state). */
  open: boolean;
  onClose: () => void;
  testID?: string;
}

export function ImageViewer({ uri, caption, open, onClose, testID }: ImageViewerProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      progress.value = withSpring(1, SPRING);
      return;
    }
    progress.value = withTiming(0, { duration: 160 }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, progress]);

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
  const zoom = useAnimatedStyle(() => ({
    transform: [{ scale: 0.96 + 0.04 * progress.value }],
    opacity: progress.value,
  }));

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, scrim, { backgroundColor: "rgba(12,8,4,0.92)" }]}>
          <Pressable
            accessibilityLabel="Close the image"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={onClose}
          />
        </Animated.View>
        <View style={styles.center}>
          <Animated.View style={[zoom, styles.imageWrap]}>
            <Image
              source={{ uri }}
              style={styles.image}
              resizeMode="contain"
              accessibilityLabel={caption}
            />
          </Animated.View>
        </View>
        <View style={[styles.captionRow, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            accessibilityLabel="Close the image"
            accessibilityRole="button"
            hitSlop={10}
            onPress={onClose}
            style={styles.closeTarget}
          >
            <X size={TYPE_BODY + 6} color={tokens.text} strokeWidth={2.2} />
          </Pressable>
          <View style={{ flex: 1 }} />
        </View>
        <View style={[styles.captionBottom, { paddingBottom: insets.bottom + spacing.lg }]}>
          <TypeCaption style={{ color: "rgba(255,251,240,0.85)", textAlign: "center" }} numberOfLines={2}>
            {caption}
          </TypeCaption>
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
  imageWrap: {
    borderRadius: RADIUS_INPUT,
    overflow: "hidden",
    maxWidth: "100%",
    maxHeight: "100%",
  },
  image: {
    width: "100%",
    aspectRatio: 16 / 10,
  },
  captionRow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
  },
  closeTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  captionBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xl,
  },
});
