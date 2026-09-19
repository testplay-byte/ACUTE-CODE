/**
 * ListState v2 — the shared loading / empty / error blocks every feature
 * screen renders (DESIGN.md: clay cards, honest lines, retry affordances).
 * Loading can be a quiet spinner card or a skeleton block; errors carry an
 * optional retry button (the owner's "I had to manually refresh" fix — the
 * retry is always right there).
 */

import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Pressable, type PressableStateCallbackType, StyleProp, ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Skeleton, TypeBody, TypeCaption } from "@/design/primitives";
import { RADIUS_CARD, spacing } from "@/design/tokens";

function StateCard({
  Icon,
  title,
  caption,
  tone,
}: {
  Icon?: LucideIcon;
  title: string;
  caption?: string;
  tone: "neutral" | "danger" | "warning";
}) {
  const { tokens } = useTheme();
  const fg = tone === "danger" ? tokens.danger : tone === "warning" ? tokens.warning : tokens.textSecondary;
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          boxShadow: tokens.clayShadow1,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      {Icon !== undefined && (
        <View style={{ alignItems: "center", paddingTop: spacing.sm }}>
          <Icon size={26} color={fg} strokeWidth={1.8} />
        </View>
      )}
      <TypeBody style={{ color: fg, textAlign: "center", fontWeight: "600" }}>{title}</TypeBody>
      {caption !== undefined && (
        <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>{caption}</TypeCaption>
      )}
    </View>
  );
}

/** The loading state — one quiet activity indicator + a line. */
export function LoadingState({ caption = "loading…" }: { caption?: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.card}>
      <ActivityIndicator size="small" color={tokens.accent} />
      <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>{caption}</TypeCaption>
    </View>
  );
}

/** The skeleton block — pinned-height placeholder rows for known layouts. */
export function SkeletonList({ rows = 4, rowHeight = 68 }: { rows?: number; rowHeight?: number }) {
  return (
    <View style={{ gap: spacing.md }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} style={{ height: rowHeight, borderRadius: RADIUS_CARD }} />
      ))}
    </View>
  );
}

/** The empty state — honest, quiet ("Nothing is waiting on you."). */
export function EmptyState({
  Icon,
  title,
  caption,
}: {
  Icon?: LucideIcon;
  title: string;
  caption?: string;
}) {
  return <StateCard Icon={Icon} title={title} caption={caption} tone="neutral" />;
}

/** The error state — the danger hue + the host's own message + retry. */
export function ErrorState({
  title,
  caption,
  retryLabel,
  onRetry,
}: {
  title: string;
  caption?: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <StateCard title={title} caption={caption} tone="danger" />
      {onRetry !== undefined ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
            {
              borderRadius: 14,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.borderStrong,
              backgroundColor: pressed ? tokens.subtle : "transparent",
              paddingHorizontal: spacing.xl,
            },
          ]}
        >
          <TypeCaption style={{ color: tokens.textSecondary }}>{retryLabel ?? "try again"}</TypeCaption>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    padding: spacing.xl,
    gap: spacing.md,
    alignItems: "center",
    paddingTop: spacing.xxl,
  },
});
