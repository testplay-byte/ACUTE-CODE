/**
 * Appearance — the theme page: all six themes as rows (Clay Studio first —
 * the default), the mode selector (system / dark / light — three clay
 * cards), the CHAT section (R114-c — the four synced prefs the appearance
 * domain grew: density, text size, timestamps, tool activity; every flip
 * optimistically applies + PUTs the partial patch, the same house pattern
 * as the theme/mode controls), and a PREVIEW card that shows the language
 * itself: the clay material's shadow pair, a primary CTA with its one
 * quiet glint, a badge, and body text — so the owner SEES what a switch
 * changes.
 */

import { StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ThemeRows } from "@/components/theme-picker";
import {
  Badge,
  ChromeButton,
  Chip,
  ClayCard,
  PressableCard,
  SectionHeader,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import {
  useTheme,
  type ChatDensity,
  type ChatTextSize,
  type ThemeMode,
  type TimestampsMode,
  type ToolActivity,
} from "@/design/theme";
import { spacing } from "@/design/tokens";
import { selectionHaptic } from "@/design/haptics";
import { mobLog } from "@/lib/log";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string; caption: string }> = [
  { id: "system", label: "System", caption: "follows the OS" },
  { id: "dark", label: "Dark", caption: "pinned dark" },
  { id: "light", label: "Light", caption: "pinned light" },
];

const DENSITIES: ReadonlyArray<{ id: ChatDensity; label: string }> = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const TEXT_SIZES: ReadonlyArray<{ id: ChatTextSize; label: string }> = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

const TIMESTAMPS: ReadonlyArray<{ id: TimestampsMode; label: string }> = [
  { id: "hover", label: "On hover" },
  { id: "hidden", label: "Hidden" },
];

const TOOL_ACTIVITY: ReadonlyArray<{ id: ToolActivity; label: string }> = [
  { id: "detailed", label: "Detailed" },
  { id: "compact", label: "Compact" },
  { id: "hidden", label: "Hidden" },
];

export default function AppearanceSettingsScreen() {
  const {
    tokens,
    mode,
    setMode,
    themeId,
    chatDensity,
    setChatDensity,
    chatTextSize,
    setChatTextSize,
    timestampsMode,
    setTimestampsMode,
    toolActivity,
    setToolActivity,
  } = useTheme();

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

      {/* ── the chat prefs (R114-c — the domain's four synced fields; every
          flip applies optimistically + PUTs its one-field partial patch) ── */}
      <SectionHeader>Chat</SectionHeader>
      <ClayCard>
        <View style={styles.chatPad}>
          <ChatPrefRow label="Chat density" caption="message spacing in the transcript">
            {DENSITIES.map((option) => (
              <Chip
                key={option.id}
                testID={`chat-density-${option.id}`}
                selected={chatDensity === option.id}
                onPress={() => {
                  if (chatDensity === option.id) return;
                  void selectionHaptic();
                  setChatDensity(option.id);
                  mobLog("settings", "chat density set", { chatDensity: option.id });
                }}
              >
                {option.label}
              </Chip>
            ))}
          </ChatPrefRow>
          <ChatPrefRow label="Text size" caption="transcript text size">
            {TEXT_SIZES.map((option) => (
              <Chip
                key={option.id}
                testID={`chat-text-size-${option.id}`}
                selected={chatTextSize === option.id}
                onPress={() => {
                  if (chatTextSize === option.id) return;
                  void selectionHaptic();
                  setChatTextSize(option.id);
                  mobLog("settings", "chat text size set", { chatTextSize: option.id });
                }}
              >
                {option.label}
              </Chip>
            ))}
          </ChatPrefRow>
          <ChatPrefRow label="Timestamps" caption="when message times appear">
            {TIMESTAMPS.map((option) => (
              <Chip
                key={option.id}
                testID={`chat-timestamps-${option.id}`}
                selected={timestampsMode === option.id}
                onPress={() => {
                  if (timestampsMode === option.id) return;
                  void selectionHaptic();
                  setTimestampsMode(option.id);
                  mobLog("settings", "timestamps mode set", { timestampsMode: option.id });
                }}
              >
                {option.label}
              </Chip>
            ))}
          </ChatPrefRow>
          <ChatPrefRow label="Tool activity" caption="how tool calls render" last>
            {TOOL_ACTIVITY.map((option) => (
              <Chip
                key={option.id}
                testID={`chat-tool-activity-${option.id}`}
                selected={toolActivity === option.id}
                onPress={() => {
                  if (toolActivity === option.id) return;
                  void selectionHaptic();
                  setToolActivity(option.id);
                  mobLog("settings", "tool activity set", { toolActivity: option.id });
                }}
              >
                {option.label}
              </Chip>
            ))}
          </ChatPrefRow>
          <TypeMicro style={{ color: tokens.textTertiary }}>
            synced to every paired device — the transcript applies them live
          </TypeMicro>
        </View>
      </ClayCard>

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

/** One chat-pref row — the label + caption + the segmented chip row. */
function ChatPrefRow({
  label,
  caption,
  last = false,
  children,
}: {
  label: string;
  caption: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.chatRow,
        last ? null : [styles.chatRowDivider, { borderBottomColor: tokens.borderSubtle }],
      ]}
    >
      <View style={styles.chatRowHead}>
        <TypeBodyStrong style={styles.chatRowLabel}>{label}</TypeBodyStrong>
        <TypeCaption style={styles.chatRowCaption}>{caption}</TypeCaption>
      </View>
      <View style={styles.chatChips}>{children}</View>
    </View>
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
  chatPad: { padding: spacing.lg, gap: spacing.lg },
  chatRow: { gap: spacing.sm },
  chatRowDivider: {
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chatRowHead: { gap: 2 },
  chatRowLabel: { fontSize: 15 },
  chatRowCaption: {},
  chatChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  previewPad: { padding: spacing.lg, gap: spacing.md },
  previewHead: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  previewTitleWrap: { flex: 1, gap: spacing.xs },
  previewBody: { lineHeight: 18 },
  previewActions: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  previewCta: { flex: 1 },
  previewBadgeRow: { flexDirection: "column", gap: spacing.sm, alignItems: "flex-start" },
  previewFootnote: { lineHeight: 20 },
});
