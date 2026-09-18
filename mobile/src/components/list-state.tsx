/**
 * ListState — the shared loading / empty / error blocks every feature screen
 * renders (the quiet instrument: a dim card, an honest line, never a spinner
 * circus). Same primitives as everything else; no new visual vocabulary.
 */

import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeBody, TypeCaption } from "@/design/primitives";
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
  tone: "neutral" | "danger";
}) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: tokens.card, borderColor: tone === "danger" ? tokens.danger : tokens.border },
      ]}
    >
      {Icon !== undefined && (
        <View style={{ alignItems: "center", paddingTop: spacing.sm }}>
          <Icon size={26} color={tone === "danger" ? tokens.danger : tokens.textTertiary} strokeWidth={1.6} />
        </View>
      )}
      <TypeBody
        style={{
          color: tone === "danger" ? tokens.danger : tokens.textSecondary,
          textAlign: "center",
          fontWeight: "600",
        }}
      >
        {title}
      </TypeBody>
      {caption !== undefined && (
        <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>
          {caption}
        </TypeCaption>
      )}
    </View>
  );
}

/** The loading state — one quiet activity indicator + a line. */
export function LoadingState({ caption = "Loading…" }: { caption?: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.card}>
      <ActivityIndicator size="small" color={tokens.accent} />
      <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>
        {caption}
      </TypeCaption>
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

/** The error state — the danger hue + the host's own message. */
export function ErrorState({ title, caption }: { title: string; caption?: string }) {
  return <StateCard title={title} caption={caption} tone="danger" />;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
    gap: spacing.md,
    alignItems: "center",
    paddingTop: spacing.xxl,
  },
});
