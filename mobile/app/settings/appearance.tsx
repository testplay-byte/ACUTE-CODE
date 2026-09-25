/**
 * Appearance — the theme page (R115-O rebuild, the owner's verdict on the
 * old rows/cards/preview): the six themes as a clean TWO-COLUMN card grid
 * (each card = the 5-swatch strip, rendered in the ACTIVE mode's palette —
 * the honest preview of what a switch changes — + the theme name; selected
 * = the 2px accent border + the check badge), the mode selector as the
 * SHARED SegmentedControl (R118-B — the local ModeSegmentedControl is
 * DELETED; the control's own comment always claimed the tab-pill grammar,
 * and now it finally rides it: the AA-clean accentDeep indicator sliding
 * on TAB_SPRING), and the CHAT section (R114-c — the four synced prefs the
 * appearance domain grew: density, text size, timestamps, tool activity;
 * every flip optimistically applies + PUTs the partial patch, the same
 * house pattern as the theme/mode controls). The R114 "The clay, up close"
 * preview card is GONE — the owner: "the preview at the bottom is
 * completely unnecessary — remove."
 *
 * R118-B (items 18-20, spec §2.6): the chat rows' CAPTIONS DIE — each row
 * is the label heading (TypeBodyStrong) on top with the option chips BELOW
 * as a centered wrapping row (flexWrap + justifyContent center + gap sm,
 * nearly full width — the options are the content, not a right-aligned
 * afterthought); the rows knit with the strong Hairline dividers; the
 * "synced across devices — applied live" footer is DELETED (the sync is
 * the system's own behavior, not a caption's job).
 *
 * R127-W8 — the Tool activity picker RETIRES its "Hidden" rung: the
 * R127-Ra research verdict named it the ONLY render path that produces the
 * owner's exact symptom ("conversation text but NO tool activity, at all"),
 * and it syncs server-side so it survives every reconnect. Detailed and
 * Compact stay selectable (compact already reduces noise without hiding
 * everything). A PERSISTED "hidden" is never silently overridden — the
 * picker renders its explicit state row ("Hidden — tools never render in
 * the transcript") with a one-tap "Show tool activity" action back to
 * detailed; the rung itself can no longer be SELECTED going forward.
 *
 * R128-W6 — the sync's honest give-up row: a local appearance change whose
 * PUT could not reach the desktop (offline flip, failed PUT) rides the
 * pending-flush machinery in features/appearance-sync.ts (flushed at the
 * next connect/hello BEFORE the server apply); after 3 failed flushes the
 * change is honestly lost and THIS quiet danger row says so. Any fresh
 * chip flip re-arms the sync and clears the row on its next landed PUT.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Chip,
  ClayCard,
  Hairline,
  SectionHeader,
  SegmentedControl,
  TypeBodyStrong,
  TypeCaption,
} from "@/design/primitives";
import {
  useTheme,
  type ChatDensity,
  type ChatTextSize,
  type ThemeMode,
  type TimestampsMode,
  type ToolActivity,
} from "@/design/theme";
import { toolActivityIsHidden } from "@/features/chat-prefs";
import { appearanceSyncStatus, subscribeAppearanceSyncStatus } from "@/features/appearance-sync";
import { RADIUS_INPUT, RADIUS_PILL, spacing, THEMES, type ThemeColors } from "@/design/tokens";
import { selectionHaptic } from "@/design/haptics";
import { mobLog } from "@/lib/log";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string; accessibilityLabel: string }> = [
  { id: "system", label: "System", accessibilityLabel: "Mode: follow the system setting" },
  { id: "dark", label: "Dark", accessibilityLabel: "Mode: dark" },
  { id: "light", label: "Light", accessibilityLabel: "Mode: light" },
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

/**
 * R127-W8 — the selectable rungs. "hidden" is RETIRED (the R127-Ra verdict:
 * the one phone-side pick that renders conversation text with ZERO tool
 * rows ever, synced server-side so it won every reconnect); a persisted
 * hidden value renders the explicit legacy row below instead of a chip.
 */
const TOOL_ACTIVITY: ReadonlyArray<{ id: ToolActivity; label: string }> = [
  { id: "detailed", label: "Detailed" },
  { id: "compact", label: "Compact" },
];

/** The six themes chunked into two-card rows (the 2-column grid; THEMES is
 * even today — a future odd theme stretches its lone card full width). */
const THEME_ROWS: ReadonlyArray<ReadonlyArray<ThemeColors>> = Array.from(
  { length: Math.ceil(THEMES.length / 2) },
  (_, row) => THEMES.slice(row * 2, row * 2 + 2),
);

export default function AppearanceSettingsScreen() {
  const {
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
    tokens,
  } = useTheme();

  // R128-W6 — the appearance sync's surfaced state (the give-up row's
  // source; the subscribe seam re-renders it live — the machinery in
  // features/appearance-sync.ts owns the story).
  const [syncError, setSyncError] = useState<string | null>(appearanceSyncStatus().error);
  useEffect(() => {
    setSyncError(appearanceSyncStatus().error);
    return subscribeAppearanceSyncStatus(() => setSyncError(appearanceSyncStatus().error));
  }, []);

  return (
    <ScreenScaffold title="Appearance" back subtitle="the phone's own material">
      {/* ── the six themes — the two-column preview-card grid ── */}
      <SectionHeader>Theme</SectionHeader>
      <ClayCard>
        <View style={styles.themePad}>
          <ThemeGrid />
        </View>
      </ClayCard>

      {/* ── the mode selector — the SHARED SegmentedControl (R118-B: the
          local ModeSegmentedControl is deleted; the control rides TAB_SPRING
          — the grammar its own comment always claimed). ── */}
      <SectionHeader>Mode</SectionHeader>
      <SegmentedControl
        testID="appearance-mode"
        options={MODES}
        selectedId={mode}
        onSelect={(next) => {
          if (next === mode) return; // the selected segment is at rest
          void selectionHaptic();
          setMode(next);
          mobLog("settings", "mode set", { mode: next });
        }}
      />

      {/* ── the chat prefs (R114-c — the domain's four synced fields; every
          flip applies optimistically + PUTs its one-field partial patch).
          R118-B: the captions DIE — the label heads the row, the options sit
          BELOW as a centered wrapping chips row, and the strong dividers knit
          the rows. ── */}
      <SectionHeader>Chat</SectionHeader>
      <ClayCard>
        <View style={styles.chatPad}>
          <ChatPrefRow label="Chat density">
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
          <Hairline strong inset={spacing.md} />
          <ChatPrefRow label="Text size">
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
          <Hairline strong inset={spacing.md} />
          <ChatPrefRow label="Timestamps">
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
          <Hairline strong inset={spacing.md} />
          <ChatPrefRow label="Tool activity">
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
            {/* R127-W8 — the RETIRED rung's honest state row: a persisted
                "hidden" (the owner's current state) is not overridden — it
                is SHOWN, named, and one tap away from detailed. Rendered
                only while the stored value is hidden; gone the moment the
                rung is left. */}
            {toolActivityIsHidden(toolActivity) && (
              <View style={styles.legacyHiddenRow} testID="chat-tool-activity-legacy-hidden">
                <TypeCaption
                  numberOfLines={2}
                  style={[styles.legacyHiddenText, { color: tokens.textTertiary }]}
                >
                  Hidden — tools never render in the transcript
                </TypeCaption>
                <Chip
                  testID="chat-tool-activity-show"
                  onPress={() => {
                    void selectionHaptic();
                    setToolActivity("detailed");
                    mobLog("settings", "tool activity un-hidden (legacy rung recovery)", {
                      toolActivity: "detailed",
                    });
                  }}
                >
                  Show tool activity
                </Chip>
              </View>
            )}
          </ChatPrefRow>
        </View>
      </ClayCard>

      {/* R128-W6 — the sync's honest give-up row (the whole appearance
          domain's story, so it sits under the Chat card): a local change
          that could not reach the desktop after 3 flush attempts. Quiet
          danger caption — an honest state, not an alarm card. */}
      {syncError !== null && (
        <View style={styles.syncErrorRow} testID="appearance-sync-error">
          <TypeCaption numberOfLines={2} style={[styles.syncErrorText, { color: tokens.danger }]}>
            {syncError}
          </TypeCaption>
        </View>
      )}
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

// ── the chat pref row — the label heads, the options sit below ──────────────

/** One chat-pref row (R118-B, items 19/20): the CAPTION DIES — the label is
 *  the heading (TypeBodyStrong) on its own line, the option chips sit BELOW
 *  as a CENTERED wrapping row (flexWrap + justifyContent center + gap sm,
 *  nearly full width — the options ARE the row's content, not a
 *  right-aligned afterthought). The rows knit via the strong Hairline
 *  dividers the caller renders between them; the selected chip carries the
 *  accent fill — the same chip grammar as the sheets. */
function ChatPrefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.chatRow}>
      <TypeBodyStrong numberOfLines={1} style={styles.chatRowLabel}>
        {label}
      </TypeBodyStrong>
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
  // ── chat prefs (R118-B: label heads, chips wrap centered below; the
  // rows knit via the strong Hairline dividers the caller renders) ──
  chatPad: { padding: spacing.lg },
  chatRow: { paddingVertical: spacing.md, gap: spacing.sm },
  chatRowLabel: { fontSize: 15 },
  chatChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: spacing.sm,
  },
  // ── R127-W8 — the retired Hidden rung's state row (the R118-B row's own
  // grammar: the caption heads, the action chip sits below; centered like
  // the chips row, quiet like a meta line — the state is information, not
  // an alarm) ──
  legacyHiddenRow: {
    alignSelf: "stretch",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
  },
  // The color rides tokens at render (textTertiary — the quiet meta voice);
  // only the layout lives here.
  legacyHiddenText: {
    textAlign: "center",
  },
  // ── R128-W6 — the sync give-up row (the legacy state row's own grammar:
  // a centered quiet caption; the danger tint rides tokens at render) ──
  syncErrorRow: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  syncErrorText: {
    textAlign: "center",
  },
});

