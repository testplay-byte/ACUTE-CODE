/**
 * PinBoxRow — the manual-entry pairing PIN's 4+4 BOXES (R116-D, the owner's
 * verdict #12: "1234 5678" needs PROPER visual separation). Eight
 * ClayInput-class digit boxes with a small dash divider between the groups;
 * ONE visually-hidden TextInput captures every keystroke (typing appends,
 * backspace pops — the number-pad's own buffer does the work), and the boxes
 * render the managed state.
 *
 * The boxes are NOT individually focusable: tapping anywhere on the row
 * focuses the hidden input. Smart paste fills the row through the parent's
 * `value` exactly like the old single input did (the buffer syncs from the
 * prop). The hidden field keeps its own buffer so the native input never
 * fights the clean state — a stray non-digit (a paste into the invisible
 * field) is never shown; the BOXES always render the clean digits.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useTheme } from "@/design/theme";
import { fontFamily, RADIUS_INPUT, spacing, TYPE_MICRO } from "@/design/tokens";

export interface PinBoxRowProps {
  /** The managed PIN state — 0..8 digits (the parent owns it). */
  value: string;
  /** Fires with the CLEAN value (non-digits stripped, capped at 8). */
  onChangeText: (text: string) => void;
  /** The label above the boxes (the ClayInput label idiom, uppercase). */
  label?: string;
  /** The keyboard's action key submits when the parent wires it. */
  onSubmitEditing?: () => void;
  testID?: string;
}

/** One big centered mono glyph per box. */
const DIGIT_SIZE = 20;
/** The box height (the "44×48" shape; the width flexes to the screen). */
const BOX_H = 48;
/** The box width ceiling — ~44 on wide screens, clamped to fit 360dp-class. */
const BOX_W_MAX = 44;
/** The floor — never narrower than a digit + its breathing room. */
const BOX_W_MIN = 28;
/** The gutter between boxes and around the divider. */
const BOX_GAP = 6;
/** The 4+4 divider — a small rounded dash. */
const DIVIDER_W = 12;
const DIVIDER_H = 3;

export function PinBoxRow({ value, onChangeText, label, onSubmitEditing, testID }: PinBoxRowProps) {
  const { tokens } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  // The hidden input's own buffer: mirrors `value` when the parent changes it
  // (typing, smart paste), keeps what the user actually typed otherwise —
  // the boxes render the clean state either way.
  const [buffer, setBuffer] = useState(value);

  useEffect(() => {
    setBuffer(value);
  }, [value]);

  function handleChange(raw: string) {
    const clean = raw.replace(/\D/g, "").slice(0, 8);
    setBuffer(raw);
    onChangeText(clean);
  }

  // The responsive box width: ~44 when the screen allows, clamped so all 8
  // boxes + the divider always fit the body gutter on 360dp hardware.
  const bodyW = windowWidth - spacing.lg * 2;
  const boxW = Math.max(
    BOX_W_MIN,
    Math.min(BOX_W_MAX, Math.floor((bodyW - DIVIDER_W - BOX_GAP * 7) / 8)),
  );
  const activeIndex = Math.min(value.length, 7);

  return (
    <View>
      {label ? (
        <Text style={[styles.label, { color: tokens.textSecondary }]}>{label}</Text>
      ) : null}
      <Pressable
        accessibilityLabel="Pairing PIN, 8 digits"
        accessibilityRole="button"
        onPress={() => inputRef.current?.focus()}
        style={styles.row}
        testID={testID}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <View key={i} style={styles.boxSlot}>
            {i === 4 ? <View style={[styles.divider, { backgroundColor: tokens.textTertiary }]} /> : null}
            <DigitBox
              digit={value[i] ?? ""}
              active={focused && i === activeIndex}
              width={boxW}
            />
          </View>
        ))}
      </Pressable>
      {/* The hidden input — opacity 0, 1×1, off the a11y tree; it owns the
          keyboard while the boxes render the state (the task's
          "visually-hidden TextInput capturing input" approach). */}
      <TextInput
        ref={inputRef}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        caretHidden
        keyboardType="number-pad"
        maxLength={8}
        onBlur={() => setFocused(false)}
        onChangeText={handleChange}
        onFocus={() => setFocused(true)}
        onSubmitEditing={onSubmitEditing}
        style={styles.hidden}
        value={buffer}
      />
    </View>
  );
}

function DigitBox({ digit, active, width }: { digit: string; active: boolean; width: number }) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.box,
        {
          width,
          backgroundColor: tokens.inputBg,
          borderColor: active ? tokens.accent : tokens.inputBorder,
          borderWidth: active ? 2 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      {digit !== "" ? <Text style={[styles.digit, { color: tokens.text }]}>{digit}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /** The ClayInput label idiom, copied exactly (11/600, uppercase kicker). */
  label: {
    fontSize: TYPE_MICRO,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: BOX_GAP,
  },
  /** Each box + (before index 4) the divider, one flex slot so the row
      centers as a whole. */
  boxSlot: { flexDirection: "row", alignItems: "center", gap: BOX_GAP },
  box: {
    height: BOX_H,
    borderRadius: RADIUS_INPUT,
    alignItems: "center",
    justifyContent: "center",
  },
  digit: {
    fontSize: DIGIT_SIZE,
    fontFamily: fontFamily.monoMedium,
    lineHeight: 24,
  },
  divider: {
    width: DIVIDER_W,
    height: DIVIDER_H,
    borderRadius: DIVIDER_H / 2,
  },
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
});
