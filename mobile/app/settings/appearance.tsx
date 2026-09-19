/**
 * Appearance — the theme page: all six themes as rows (Clay Studio first —
 * the default), the mode selector (system / dark / light — three clay
 * cards), and a PREVIEW card that shows the language itself: the clay
 * material's shadow pair, a primary CTA with its one quiet glint, a badge,
 * and body text — so the owner SEES what a switch changes.
 */

import { StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ThemeRows } from "@/components/theme-picker";
import {
  Badge,
  ChromeButton,
  ClayCard,
  PressableCard,
  SectionHeader,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
} from "@/design/primitives";
import { useTheme, type ThemeMode } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { selectionHaptic } from "@/design/haptics";
import { mobLog } from "@/lib/log";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string; caption: string }> = [
  { id: "system", label: "System", caption: "follows the OS" },
  { id: "dark", label: "Dark", caption: "pinned dark" },
  { id: "light", label: "Light", caption: "pinned light" },
];

export default function AppearanceSettingsScreen() {
  const { tokens, mode, setMode, themeId } = useTheme();

  return (
    <ScreenScaffold title="Appearance" back subtitle="the phone's own material">
      {/* ── the six themes ── */}
      <SectionHeader>Theme</SectionHeader>
      <ClayCard>
        <View style={styles.themePad}>
          <ThemeRows />
        </View>
      </ClayCard>

      {/* ── the mode selector ── */}
      <SectionHeader>Mode</SectionHeader>
      <View style={styles.modeRow}>
        {MODES.map((m) => {
          const selected = mode === m.id;
          return (
            <PressableCard
              key={m.id}
              onPress={() => {
                selectionHaptic();
                setMode(m.id);
                mobLog("settings", "mode set", { mode: m.id });
              }}
              accessibilityLabel={`Mode: ${m.label}${selected ? " (selected)" : ""}`}
              style={[
                styles.modeCard,
                selected
                  ? {
                      borderWidth: 2,
                      borderTopWidth: 2,
                      borderColor: tokens.accent,
                      borderTopColor: tokens.accent,
                    }
                  : styles.modeCardResting,
              ]}
            >
              <View style={styles.modeInner}>
                {selected ? <Check size={15} color={tokens.accent} strokeWidth={2.6} /> : null}
                <TypeBodyStrong
                  style={{ color: selected ? tokens.accent : tokens.text, textAlign: "center" }}
                >
                  {m.label}
                </TypeBodyStrong>
                <TypeCaption style={styles.modeCaption}>{m.caption}</TypeCaption>
              </View>
            </PressableCard>
          );
        })}
      </View>

      {/* ── the material preview: see the language before committing ── */}
      <SectionHeader>Preview</SectionHeader>
      <ClayCard elevated>
        <View style={styles.previewPad}>
          <View style={styles.previewHead}>
            <View style={styles.previewTitleWrap}>
              <TypeBodyStrong>The clay, up close</TypeBodyStrong>
              <TypeCaption numberOfLines={2} style={styles.previewBody}>
                Warm surfaces resting on two-leg shadows, a matte top edge, and one
                quiet glint on the primary action — nothing painted-on, nothing glowing.
              </TypeCaption>
            </View>
            <Badge tone="accent">badge</Badge>
          </View>
          <View style={styles.previewActions}>
            <ChromeButton
              onPress={() => selectionHaptic()}
              style={styles.previewCta}
              accessibilityLabel="Primary action preview — tap for a haptic tick"
            >
              Primary action
            </ChromeButton>
            <View style={styles.previewBadgeRow}>
              <Badge tone="success">live</Badge>
              <Badge tone="neutral">status</Badge>
            </View>
          </View>
          <TypeBody style={styles.previewFootnote}>
            This card is the theme <TypeBodyStrong>{themeId}</TypeBodyStrong> rendered live —
            switching above re-renders everything, instantly.
          </TypeBody>
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  themePad: { padding: spacing.md },
  modeRow: { flexDirection: "row", gap: spacing.md },
  modeCard: { flex: 1 },
  modeCardResting: { borderWidth: 0 },
  modeInner: {
    padding: spacing.md,
    gap: spacing.xs,
    alignItems: "center",
    minHeight: 68,
    justifyContent: "center",
  },
  modeCaption: { textAlign: "center" },
  previewPad: { padding: spacing.lg, gap: spacing.md },
  previewHead: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  previewTitleWrap: { flex: 1, gap: spacing.xs },
  previewBody: { lineHeight: 18 },
  previewActions: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  previewCta: { flex: 1 },
  previewBadgeRow: { flexDirection: "column", gap: spacing.sm, alignItems: "flex-start" },
  previewFootnote: { lineHeight: 20 },
});
