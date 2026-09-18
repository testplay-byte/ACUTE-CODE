/**
 * ComingSoon — the styled placeholder for the S4b screens (projects,
 * sessions, approvals, notifications): honest about what arrives next,
 * rendered in the design system rather than a bare Text. The screen it
 * stands in for is named in the caption; the icon carries the accent.
 */

import { View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { PressableCard, TypeBody, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";

export function ComingSoon({
  Icon,
  title,
  caption,
}: {
  Icon: LucideIcon;
  title: string;
  caption: string;
}) {
  const { tokens } = useTheme();
  return (
    <View style={{ gap: spacing.lg, paddingTop: spacing.xl }}>
      <View style={{ alignItems: "center", paddingTop: spacing.xl }}>
        <View
          accessibilityLabel={`${title} placeholder`}
          style={{
            width: 72,
            height: 72,
            borderRadius: 24,
            borderWidth: 1,
            borderColor: tokens.borderSubtle,
            backgroundColor: tokens.subtle,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={30} color={tokens.accent} strokeWidth={1.6} />
        </View>
      </View>
      <View style={{ alignItems: "center", gap: spacing.xs }}>
        <TypeBody style={{ color: tokens.text, fontWeight: "600", fontSize: 15 }}>{title}</TypeBody>
        <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>
          {caption}
        </TypeCaption>
      </View>
      <PressableCard disabled onPress={() => undefined}>
        <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>
          arrives in the next build — the link, themes and pairing you see
          today are already real
        </TypeCaption>
      </PressableCard>
    </View>
  );
}
