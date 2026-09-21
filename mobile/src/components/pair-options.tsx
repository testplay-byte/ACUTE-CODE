/**
 * PairOptionCard + PairOptionsPair — the shared "two ways to link" pair
 * (R115, waves C+D): the wizard's connect step and the post-wizard connect
 * hub render the same two options (scan the QR / type it in), so the pair
 * lives here once. A PressableCard carrying a 48×48 r16 icon chip + a
 * TypeBodyStrong label + ONE-line TypeCaption description — tokenized,
 * staggered on the standard entrance, nothing else (onboarding.md screen 3).
 *
 * R116-c (the single-line law, donts #31): the label AND the description
 * clamp to one line here, hard-set — the law is global now, every consumer
 * (the wizard's connect step) wants it, and RN's default ellipsize for a
 * clamped Text is "tail". Wrapping is a defect, not a layout accident.
 */

import type { LucideIcon } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { PressableCard, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_CHIP, TILE_OPTION, spacing } from "@/design/tokens";

export interface PairOptionCardProps {
  /** The leading icon chip's glyph (ScanLine / Keyboard). */
  icon: LucideIcon;
  /** The option's label ("Scan the QR code"). */
  label: string;
  /** The ONE-line description ("From the desktop's Link a device screen."). */
  description: string;
  onPress: () => void;
  /** List index — the fade-in-up entrance with the 30ms stagger. */
  enterIndex?: number;
  /** Elevation 2 (the primary option of the pair). */
  elevated?: boolean;
  /** Screen-reader label — defaults to the visible label. */
  accessibilityLabel?: string;
  testID?: string;
}

/** One way to link — the option row of the pair. */
export function PairOptionCard({
  icon: Icon,
  label,
  description,
  onPress,
  enterIndex,
  elevated = false,
  accessibilityLabel,
  testID,
}: PairOptionCardProps) {
  const { tokens } = useTheme();
  return (
    <PressableCard
      onPress={onPress}
      enterIndex={enterIndex}
      elevated={elevated}
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
    >
      <View style={styles.inner}>
        <View style={[styles.chip, { backgroundColor: tokens.subtleHover }]}>
          <Icon size={24} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.text}>
          <TypeBodyStrong numberOfLines={1}>{label}</TypeBodyStrong>
          <TypeCaption numberOfLines={1}>{description}</TypeCaption>
        </View>
      </View>
    </PressableCard>
  );
}

export interface PairOption {
  icon: LucideIcon;
  label: string;
  description: string;
  onPress: () => void;
  testID?: string;
}

export interface PairOptionsPairProps {
  options: readonly PairOption[];
  /** The stagger base — the screen's hero enters at 0, the pair follows. */
  start?: number;
  /** Elevate the first option (the scan path is the pair's primary). */
  elevatedFirst?: boolean;
}

/** The two stacked options, staggering in on the standard entrance. */
export function PairOptionsPair({ options, start = 0, elevatedFirst = true }: PairOptionsPairProps) {
  return (
    <View style={styles.pair}>
      {options.map((option, i) => (
        <PairOptionCard
          key={option.label}
          icon={option.icon}
          label={option.label}
          description={option.description}
          onPress={option.onPress}
          enterIndex={start + i}
          elevated={elevatedFirst && i === 0}
          testID={option.testID}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pair: { gap: spacing.md },
  inner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  chip: {
    width: TILE_OPTION,
    height: TILE_OPTION,
    borderRadius: RADIUS_CHIP,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, gap: spacing.xs },
});
