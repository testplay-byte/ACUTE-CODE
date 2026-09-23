/**
 * ModelFormSections — the model editor's shared form (R120-M): the field
 * set the Edit Model SCREEN renders (moved out of the provider detail
 * screen's sheets — the configure flow is a SCREEN now, round-120 §1
 * items 19-22), carrying the round's three editor upgrades:
 *
 *   · item 17 — the SIZING fields show their simplified form ON BLUR
 *     (1000000 → "1M", 26000 → "26K" — formatCompactCount) and the full
 *     digits ON FOCUS; the draft keeps the exact string internally (the
 *     blur form is the at-a-glance read, never the saved value);
 *   · item 18 — the input/output capabilities render as COLOR-CODED SVG
 *     icon pills on ONE line (CapabilityIcon + capabilityHue — one glyph
 *     + hue per capability, icon + label inline, the row never wraps);
 *   · item 21 — the REASONING LEVELS editor: the ladder ordered
 *     lowest→highest, a per-level delete, and the + affordance on the
 *     right of the highest level (a small sheet offering the vocabulary's
 *     remaining rungs — a level outside the shared vocabulary is a 400 on
 *     save, so the editor never offers one).
 *
 * The field set itself is the R116-j/R118-E contract: Identity, Sizing,
 * the Pricing trio (cache read included), the capability sets (text input
 * locked ON — every chat model accepts text; text output defaults ON),
 * and the hidden toggle. supportsThinking is deliberately ABSENT
 * (detected server-side); supportsTools rides the draft for the lossless
 * round-trip only. R118-A's sheet-caption ban follows the form to the
 * screen: label + control, one hint max (the smart-fetch's one-line note
 * lives on the screen, not between the fields).
 */

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Plus, X } from "lucide-react-native";
import {
  ClayInput,
  ClaySwitch,
  QuietIconButton,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import {
  fontFamily,
  RADIUS_CHIP,
  RADIUS_INPUT,
  RADIUS_PILL,
  spacing,
  TYPE_MICRO,
} from "@/design/tokens";
import { selectionHaptic } from "@/design/haptics";
import { Sheet } from "@/components/sheet";
import { CapabilityIcon, capabilityHue, CAPABILITY_ICON_SIZE, type CapabilityKind } from "@/components/capability-icons";
import { formatCompactCount } from "@/features/provider-display";
import {
  orderedReasoningEfforts,
  remainingReasoningEfforts,
  type ModelFormDraft,
} from "@/features/config";

// ── the draft patch seam (both editor screens speak it) ─────────────────────

export type ModelFormPatch = (next: Partial<ModelFormDraft>) => void;

// ── item 17: the simplified-on-blur numeric field ───────────────────────────

/**
 * The SIZING field: full digits while FOCUSED (editing), the K/M/B
 * simplified form on BLUR (1000000 → "1M", 26000 → "26K" — the owner's
 * item 17). The draft's raw string is the truth; the blurred display is
 * cosmetic (a non-numeric raw passes through untouched — the save's
 * per-field validation owns that honesty). Pricing fields stay PLAIN
 * ClayInputs — per-Mtok prices are small decimals, not large counts.
 */
function CompactNumberInput({
  label,
  value,
  onChangeText,
  accessibilityLabel,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  accessibilityLabel: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <ClayInput
      label={label}
      mono
      value={focused ? value : formatCompactCount(value)}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      keyboardType="number-pad"
      accessibilityLabel={accessibilityLabel}
    />
  );
}

// ── item 18: the color-coded capability pills, ONE line ─────────────────────

interface CapabilityPillSpec {
  kind: CapabilityKind;
  label: string;
  on: boolean;
  onPress?: () => void;
  locked?: boolean;
  testID?: string;
}

/**
 * ONE capability pill: the color-coded SVG glyph + its label on ONE line
 * (the owner's item 18). ON = the glyph in its capability hue + the label
 * in ink over a pillBg fill; OFF = both tertiary (the hue IS the coding —
 * a grayed glyph reads off at a glance). Locked pills (text input) render
 * selected with no press.
 */
function CapabilityPill({ kind, label, on, onPress, locked = false, testID }: CapabilityPillSpec) {
  const { tokens } = useTheme();
  const hue = capabilityHue(kind, tokens);
  const fg = on ? hue : tokens.textTertiary;
  const body = (
    <View
      style={[
        styles.capPill,
        {
          backgroundColor: on ? tokens.pillBg : "transparent",
          borderColor: on ? tokens.clayRim : tokens.borderSubtle,
        },
      ]}
    >
      <CapabilityIcon kind={kind} size={CAPABILITY_ICON_SIZE} color={fg} />
      <Text style={[styles.capPillLabel, { color: on ? tokens.text : tokens.textTertiary }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
  if (onPress === undefined || locked) {
    return (
      <View testID={testID} accessibilityLabel={`${label} ${on ? "on" : "off"}`}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${on ? "on" : "off"}`}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => [styles.capPillHit, pressed ? { opacity: 0.7 } : null]}
    >
      {body}
    </Pressable>
  );
}

/**
 * The capability row: every pill on ONE line (the owner's item 18 —
 * "laid out on a single line"), never a wrapping chip wall; the labels
 * clamp to one line and the row clips what cannot fit rather than wrap.
 */
function CapabilityRow({ items }: { items: CapabilityPillSpec[] }) {
  return (
    <View style={styles.capRow}>
      {items.map((item) => (
        <CapabilityPill key={item.kind} {...item} />
      ))}
    </View>
  );
}

// ── item 21: the reasoning-levels editor ─────────────────────────────────────

/**
 * The ladder editor: the levels ordered lowest→highest (the draft's array
 * is canonical — orderedReasoningEfforts at every mutation), a per-level
 * delete (the quiet X circle), and the + affordance on the RIGHT of the
 * highest level — a trailing row whose + opens the small add sheet
 * offering the vocabulary's remaining rungs. An empty ladder renders the
 * + row alone (the same grammar — the affordance never hides).
 */
function ReasoningLevelsSection({ draft, patch }: { draft: ModelFormDraft; patch: ModelFormPatch }) {
  const { tokens } = useTheme();
  const [addOpen, setAddOpen] = useState(false);
  const levels = orderedReasoningEfforts(draft.reasoningEfforts);
  const remaining = remainingReasoningEfforts(levels);

  const removeLevel = useCallback(
    (level: string) => {
      void selectionHaptic();
      patch({
        reasoningEfforts: levels.filter((l) => l !== level),
        reasoningTouched: true,
      });
    },
    [levels, patch],
  );

  const addLevel = useCallback(
    (level: string) => {
      void selectionHaptic();
      patch({
        reasoningEfforts: orderedReasoningEfforts([...levels, level]),
        reasoningTouched: true,
      });
      setAddOpen(false);
    },
    [levels, patch],
  );

  return (
    <View style={styles.formSection}>
      <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
        Reasoning levels
      </TypeCaption>
      <View style={[styles.levelWell, { borderColor: tokens.borderSubtle }]}>
        {levels.map((level, index) => (
          <View key={level}>
            {index > 0 ? <View style={[styles.levelRule, { backgroundColor: tokens.borderSubtle }]} /> : null}
            <View style={styles.levelRow}>
              <TypeMono numberOfLines={1} style={styles.levelName}>
                {level}
              </TypeMono>
              <QuietIconButton
                icon={X}
                iconSize={15}
                size={36}
                hitSlop={4}
                onPress={() => removeLevel(level)}
                accessibilityLabel={`Remove the ${level} level`}
              />
            </View>
          </View>
        ))}
        {/* The + on the right of the HIGHEST level (the owner's item 21):
            the trailing row's quiet circle opens the add sheet. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a reasoning level"
          onPress={() => {
            void selectionHaptic();
            setAddOpen(true);
          }}
          style={({ pressed }) => [styles.levelAddRow, pressed ? { opacity: 0.7 } : null]}
        >
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            Add a level
          </TypeMicro>
          <View style={[styles.levelAddCircle, { borderColor: tokens.borderStrong }]}>
            <Plus size={16} color={tokens.accentDeep} strokeWidth={2.2} />
          </View>
        </Pressable>
      </View>
      <AddReasoningLevelSheet
        open={addOpen}
        remaining={remaining}
        onPick={addLevel}
        onClose={() => setAddOpen(false)}
      />
    </View>
  );
}

/** The add-level sheet: the vocabulary's REMAINING rungs as one-line rows
 * (a level outside the shared vocabulary is a 400 on save — the editor
 * never offers one); the empty state names the full ladder. */
function AddReasoningLevelSheet({
  open,
  remaining,
  onPick,
  onClose,
}: {
  open: boolean;
  remaining: string[];
  onPick: (level: string) => void;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Sheet open={open} onClose={onClose} title="Add a level" testID="add-reasoning-level-sheet">
      {remaining.length === 0 ? (
        <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary, paddingVertical: spacing.md }}>
          every level is already here
        </TypeCaption>
      ) : (
        remaining.map((level) => (
          <Pressable
            key={level}
            accessibilityRole="button"
            accessibilityLabel={`Add the ${level} level`}
            onPress={() => onPick(level)}
            style={({ pressed }) => [
              styles.levelPickRow,
              { borderBottomColor: tokens.borderSubtle },
              pressed ? { backgroundColor: tokens.subtle } : null,
            ]}
          >
            <TypeMono numberOfLines={1} style={styles.levelName}>
              {level}
            </TypeMono>
            <Plus size={16} color={tokens.accentDeep} strokeWidth={2.2} />
          </Pressable>
        ))
      )}
    </Sheet>
  );
}

// ── the shared sections (the R116-j field set on the screen's grammar) ───────

export function ModelFormSections({
  draft,
  patch,
}: {
  draft: ModelFormDraft;
  patch: ModelFormPatch;
}) {
  const { tokens } = useTheme();
  return (
    <>
      {/* Identity — the human name + the parameter-size label. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Identity
        </TypeCaption>
        <ClayInput
          label="Display name"
          value={draft.displayName}
          onChangeText={(text) => patch({ displayName: text })}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Display name"
        />
        <ClayInput
          label="Size label"
          value={draft.sizeLabel}
          onChangeText={(text) => patch({ sizeLabel: text })}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Size label"
        />
      </View>

      {/* Sizing — item 17: the simplified form on blur, full digits on focus. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Sizing
        </TypeCaption>
        <CompactNumberInput
          label="Context window"
          value={draft.contextWindow}
          onChangeText={(text) => patch({ contextWindow: text })}
          accessibilityLabel="Context window"
        />
        <CompactNumberInput
          label="Max output tokens"
          value={draft.maxOutputTokens}
          onChangeText={(text) => patch({ maxOutputTokens: text })}
          accessibilityLabel="Max output tokens"
        />
      </View>

      {/* Pricing — the USD-per-Mtok trio (cache read included); plain
          fields — per-Mtok prices are small decimals, not large counts. */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Pricing
        </TypeCaption>
        <ClayInput
          label="Input price / Mtok"
          mono
          value={draft.inputPricePerMtok}
          onChangeText={(text) => patch({ inputPricePerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Input price per million tokens"
        />
        <ClayInput
          label="Output price / Mtok"
          mono
          value={draft.outputPricePerMtok}
          onChangeText={(text) => patch({ outputPricePerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Output price per million tokens"
        />
        <ClayInput
          label="Cache read / Mtok"
          mono
          value={draft.inputPriceCachedPerMtok}
          onChangeText={(text) => patch({ inputPriceCachedPerMtok: text })}
          keyboardType="decimal-pad"
          accessibilityLabel="Cache read price per million tokens"
        />
      </View>

      {/* Input capabilities — item 18: the color-coded icon pills on ONE
          line; text locked ON (every chat model accepts text). */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Input capabilities
        </TypeCaption>
        <CapabilityRow
          items={[
            { kind: "text", label: "Text", on: true, locked: true, testID: "model-cap-text-in" },
            {
              kind: "vision",
              label: "Images",
              on: draft.supportsVision,
              onPress: () => patch({ supportsVision: !draft.supportsVision }),
              testID: "model-cap-images-in",
            },
            {
              kind: "video",
              label: "Video",
              on: draft.supportsVideo === true,
              onPress: () => patch({ supportsVideo: draft.supportsVideo === true ? false : true }),
              testID: "model-cap-video-in",
            },
            {
              kind: "pdf",
              label: "PDF",
              on: draft.supportsPdf === true,
              onPress: () => patch({ supportsPdf: draft.supportsPdf === true ? false : true }),
              testID: "model-cap-pdf-in",
            },
            {
              kind: "audio",
              label: "Audio",
              on: draft.supportsAudio === true,
              onPress: () => patch({ supportsAudio: draft.supportsAudio === true ? false : true }),
              testID: "model-cap-audio-in",
            },
          ]}
        />
      </View>

      {/* Output capabilities — the same one-line pill row (text out
          defaults ON, the chat-completions contract). */}
      <View style={styles.formSection}>
        <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
          Output capabilities
        </TypeCaption>
        <CapabilityRow
          items={[
            {
              kind: "text",
              label: "Text out",
              on: draft.supportsTextOutput !== false,
              onPress: () =>
                patch({ supportsTextOutput: draft.supportsTextOutput !== false ? false : true }),
              testID: "model-cap-text-out",
            },
            {
              kind: "image",
              label: "Images out",
              on: draft.supportsImageOutput === true,
              onPress: () =>
                patch({ supportsImageOutput: draft.supportsImageOutput === true ? false : true }),
              testID: "model-cap-images-out",
            },
            {
              kind: "video",
              label: "Video out",
              on: draft.supportsVideoOutput === true,
              onPress: () =>
                patch({ supportsVideoOutput: draft.supportsVideoOutput === true ? false : true }),
              testID: "model-cap-video-out",
            },
            {
              kind: "audio",
              label: "Audio out",
              on: draft.supportsAudioOutput === true,
              onPress: () =>
                patch({ supportsAudioOutput: draft.supportsAudioOutput === true ? false : true }),
              testID: "model-cap-audio-out",
            },
          ]}
        />
      </View>

      {/* item 21 — the reasoning levels editor (lowest→highest, delete per
          level, the + on the right of the highest). */}
      <ReasoningLevelsSection draft={draft} patch={patch} />

      {/* Hide from the chat picker — the one behavioral toggle that stays. */}
      <View style={[styles.toggleCard, { borderColor: tokens.borderSubtle }]}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <TypeBodyStrong numberOfLines={1}>Hide from the chat picker</TypeBodyStrong>
          </View>
          <ClaySwitch
            value={draft.hidden}
            onValueChange={(next) => patch({ hidden: next })}
            label="Hidden toggle"
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  /** The section: label + fields, breathing room inside. */
  formSection: { gap: spacing.md },
  fieldLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  // item 18 — the ONE-LINE capability row: never wraps (labels clamp, the
  // row clips — the owner's single-line ruling), pills shrink before the
  // row ever wraps.
  capRow: { flexDirection: "row", flexWrap: "nowrap", gap: spacing.xs, overflow: "hidden" },
  capPillHit: { flexShrink: 1 },
  capPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
  },
  capPillLabel: { fontSize: TYPE_MICRO, fontFamily: fontFamily.semibold, letterSpacing: 0.2 },
  // item 21 — the levels well: one recessed surface, hairline rules between
  // the rungs (the key-pool row grammar).
  levelWell: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_CHIP,
    overflow: "hidden",
  },
  levelRule: { height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  levelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 48,
  },
  levelName: { flex: 1, fontSize: 13, lineHeight: 18 },
  /** The trailing + row: right-aligned (the + on the right of the highest). */
  levelAddRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 48,
  },
  levelAddCircle: {
    width: 36,
    height: 36,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  levelPickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_CHIP,
    padding: spacing.md,
    gap: spacing.md,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
  },
  toggleText: { flex: 1 },
});
