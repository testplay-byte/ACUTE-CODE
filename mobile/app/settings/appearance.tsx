/**
 * Appearance — the theme page (R115-O rebuild, the owner's verdict on the
 * old rows/cards/preview): the six themes as a clean TWO-COLUMN card grid
 * (each card = the 5-swatch strip, rendered in the ACTIVE mode's palette —
 * the honest preview of what a switch changes — + the theme name; selected
 * = the 2px accent border + the check badge), the mode selector as ONE
 * segmented control (the tab-bar pill grammar — a clay track at the pill
 * radius, three segments, the spring-sliding accent indicator, the selected
 * label bold accent), and the CHAT section (R114-c — the four synced prefs
 * the appearance domain grew: density, text size, timestamps, tool
 * activity; every flip optimistically applies + PUTs the partial patch,
 * the same house pattern as the theme/mode controls). The R114 "The clay,
 * up close" preview card is GONE — the owner: "the preview at the bottom
 * is completely unnecessary — remove."
 *
 * R116-i (verdicts #36/#37): the mode indicator carries the 2px accent
 * selection border (donts #34 — a selection border is never hairline),
 * and the chat rows sit their chips RIGHT-ALIGNED in the label's row —
 * [label + caption stacked] at the left, the chips vertically centered
 * against it at the right edge, no dead right space. A row that genuinely
 * can't fit (three wide chips on a narrow phone) wraps its chips to their
 * own right-aligned line — never a clipped label.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Chip,
  ClayCard,
  SectionHeader,
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
import {
  fontFamily,
  RADIUS_INPUT,
  RADIUS_PILL,
  spacing,
  THEMES,
  type ThemeColors,
  TYPE_BODY,
} from "@/design/tokens";
import { SPRING } from "@/design/motion";
import { selectionHaptic } from "@/design/haptics";
import { mobLog } from "@/lib/log";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
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

/** The six themes chunked into two-card rows (the 2-column grid; THEMES is
 * even today — a future odd theme stretches its lone card full width). */
const THEME_ROWS: ReadonlyArray<ReadonlyArray<ThemeColors>> = Array.from(
  { length: Math.ceil(THEMES.length / 2) },
  (_, row) => THEMES.slice(row * 2, row * 2 + 2),
);

export default function AppearanceSettingsScreen() {
  const {
    tokens,
    mode,
    setMode,
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
      {/* ── the six themes — the two-column preview-card grid ── */}
      <SectionHeader>Theme</SectionHeader>
      <ClayCard>
        <View style={styles.themePad}>
          <ThemeGrid />
        </View>
      </ClayCard>

      {/* ── the mode selector — one segmented control, one spring ── */}
      <SectionHeader>Mode</SectionHeader>
      <ModeSegmentedControl
        mode={mode}
        onSelect={(next) => {
          if (next === mode) return; // the selected segment is at rest
          void selectionHaptic();
          setMode(next);
          mobLog("settings", "mode set", { mode: next });
        }}
      />

      {/* ── the chat prefs (R114-c — the domain's four synced fields; every
          flip applies optimistically + PUTs its one-field partial patch) ── */}
      <SectionHeader>Chat</SectionHeader>
      <ClayCard>
        <View style={styles.chatPad}>
          <ChatPrefRow label="Chat density" caption="bubble spacing">
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
          <ChatPrefRow label="Text size" caption="reading size">
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
          <ChatPrefRow label="Timestamps" caption="when times appear">
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
          <ChatPrefRow label="Tool activity" caption="tool rendering" last>
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
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            synced across devices — applied live
          </TypeMicro>
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

// ── the theme grid — two columns of preview cards ───────────────────────────

/**
 * Each card: the theme's five palette swatches as ONE strip (rendered in
 * the palette of the mode the phone is IN — the honest preview of the
 * switch) above the theme name. Selected = the 2px accent border + the
 * check badge; the border WIDTH never changes (selection swaps the color
 * only — no reflow). Whole card is the touch target, 72px tall.
 */
function ThemeGrid() {
  const { tokens, themeId, setTheme } = useTheme();
  return (
    <View style={styles.themeGrid}>
      {THEME_ROWS.map((row) => (
        <View key={row[0].id} style={styles.themeGridRow}>
          {row.map((theme) => {
            const selected = theme.id === themeId;
            const palette = (tokens.isDark ? theme.paletteDark : theme.paletteLight).slice(0, 5);
            return (
              <Pressable
                key={theme.id}
                accessibilityRole="button"
                accessibilityLabel={`Theme: ${theme.name}`}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (selected) return;
                  void selectionHaptic();
                  setTheme(theme.id);
                }}
                style={[
                  styles.themeCard,
                  { borderColor: selected ? tokens.accent : tokens.borderSubtle },
                ]}
              >
                <View style={[styles.themeStrip, { borderColor: tokens.borderSubtle }]}>
                  {palette.map((hex, i) => (
                    <View key={i} style={[styles.themeSwatch, { backgroundColor: hex }]} />
                  ))}
                </View>
                <TypeBodyStrong numberOfLines={1} style={styles.themeName}>
                  {theme.name}
                </TypeBodyStrong>
                {selected ? (
                  <View style={[styles.themeCheck, { backgroundColor: tokens.accent }]}>
                    <Check size={12} color={tokens.accentText} strokeWidth={3} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ── the mode segmented control (the tab-bar pill grammar) ───────────────────

/** The indicator's inset inside the pill track (4px = spacing.xs). */
const SEGMENT_INSET = 4;
/** The track height — the inset pair + a 44px touch segment. */
const SEGMENT_TRACK_H = 52;

/**
 * ONE clay track (pill radius) with three segments and the spring-sliding
 * accent indicator — the tab-bar pill grammar exactly: a subtleHover fill
 * + the 2px accent border (donts #34 — selection borders are never
 * hairline), one spring (SPRING) slide, the selected label bold accent.
 * The indicator is positioned in INDEX space so the spring runs even
 * before the first layout measurement; reduced motion snaps (motion.md §5).
 */
function ModeSegmentedControl({
  mode,
  onSelect,
}: {
  mode: ThemeMode;
  onSelect: (next: ThemeMode) => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);

  const activeIndex = Math.max(0, MODES.findIndex((m) => m.id === mode));
  const segmentWidth = (trackWidth - SEGMENT_INSET * 2) / MODES.length;
  const indicatorIndex = useSharedValue(activeIndex);

  useEffect(() => {
    if (reduced) {
      indicatorIndex.value = activeIndex;
      return;
    }
    indicatorIndex.value = withSpring(activeIndex, SPRING);
  }, [activeIndex, reduced, indicatorIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorIndex.value * segmentWidth }],
  }));

  return (
    <View
      style={[styles.segTrack, { backgroundColor: tokens.pillBg, borderColor: tokens.border }]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      {trackWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segIndicator,
            {
              width: segmentWidth,
              backgroundColor: tokens.subtleHover,
              borderColor: tokens.accent,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {MODES.map((m) => {
        const selected = mode === m.id;
        return (
          <Pressable
            key={m.id}
            testID={`appearance-mode-${m.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Mode: ${m.label}`}
            accessibilityState={{ selected }}
            onPress={() => onSelect(m.id)}
            style={styles.segSegment}
          >
            <Text
              style={{
                color: selected ? tokens.accent : tokens.textSecondary,
                fontSize: TYPE_BODY,
                fontFamily: selected ? fontFamily.bold : fontFamily.medium,
              }}
            >
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── the chat pref row — label + caption left, chips right in the row ───────

/** One chat-pref row (R116-i — verdict #37): the label + one-line caption
 *  stacked at the LEFT, the option chips RIGHT-ALIGNED in the same row,
 *  vertically centered with the label — no dead right space. The head
 *  wraps only when a row genuinely can't fit (three wide chips on a
 *  narrow phone): the chips drop to their own right-aligned line
 *  (marginLeft auto owns that edge), never a clipped label. The selected
 *  chip carries the accent fill — the same chip grammar as the sheets. */
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
        styles.chatRowHead,
        last ? null : [styles.chatRowDivider, { borderBottomColor: tokens.borderSubtle }],
      ]}
    >
      <View style={styles.chatRowText}>
        <TypeBodyStrong numberOfLines={1} style={styles.chatRowLabel}>
          {label}
        </TypeBodyStrong>
        <TypeCaption numberOfLines={1} style={styles.chatRowCaption}>
          {caption}
        </TypeCaption>
      </View>
      <View style={styles.chatChips}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── theme grid ──
  themePad: { padding: spacing.lg },
  themeGrid: { gap: spacing.md },
  themeGridRow: { flexDirection: "row", gap: spacing.md },
  themeCard: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: RADIUS_INPUT,
    borderWidth: 2,
    minHeight: 72,
  },
  themeStrip: {
    height: 24,
    flexDirection: "row",
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  themeSwatch: { flex: 1 },
  themeName: { fontSize: 14 },
  themeCheck: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    width: 20,
    height: 20,
    // half-of-size — the circle geometry (the StatusDot recipe)
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  // ── mode segmented control ──
  segTrack: {
    height: SEGMENT_TRACK_H,
    // half-of-height — the pill geometry (the ClaySwitch track recipe)
    borderRadius: SEGMENT_TRACK_H / 2,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    padding: SEGMENT_INSET,
  },
  segIndicator: {
    position: "absolute",
    top: SEGMENT_INSET,
    bottom: SEGMENT_INSET,
    left: SEGMENT_INSET,
    // half-of-height — the pill geometry
    borderRadius: (SEGMENT_TRACK_H - SEGMENT_INSET * 2) / 2,
    // donts #34 — a selection border is 2px, never hairline
    borderWidth: 2,
  },
  segSegment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: SEGMENT_TRACK_H - SEGMENT_INSET * 2,
  },
  // ── chat prefs ──
  chatPad: { padding: spacing.lg, gap: spacing.lg },
  chatRowDivider: {
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // R116-i: the one-row anatomy — [label + caption stacked] left, the
  // chips right-aligned (vertically centered with the label). flexWrap +
  // the chips' marginLeft auto degrade gracefully: a row that can't fit
  // drops its chips to their own right-aligned line, never a clip.
  chatRowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    flexWrap: "wrap",
  },
  chatRowText: { gap: 2 },
  chatRowLabel: { fontSize: 15 },
  chatRowCaption: {},
  chatChips: {
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "flex-end",
    flexWrap: "wrap",
    marginLeft: "auto",
  },
});
