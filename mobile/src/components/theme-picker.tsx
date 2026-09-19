/**
 * ThemePicker — both spellings of the theme switch:
 *   ThemeDots  — the home screen's quick-switch (accent dots, one ring)
 *   ThemeRows  — the settings screen's full rows (palette strip + name + check)
 * The 6-theme table rides tokens.THEMES (Clay Studio first — the R109
 * default); selection persists via the ThemeProvider (theme.tsx).
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { THEMES } from "@/design/tokens";
import { TypeBody } from "@/design/primitives";
import { RADIUS_PILL, spacing } from "@/design/tokens";

export function ThemeDots() {
  const { themeId, setTheme, tokens } = useTheme();
  return (
    <View style={styles.dotsRow} accessibilityLabel="Quick theme switch">
      {THEMES.map((theme) => {
        const selected = theme.id === themeId;
        return (
          <Pressable
            key={theme.id}
            accessibilityLabel={`Theme: ${theme.name}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => setTheme(theme.id)}
            style={[
              styles.dotTarget,
              {
                borderColor: selected ? tokens.accent : tokens.border,
                backgroundColor: selected ? theme.accent : "transparent",
              },
            ]}
          >
            {!selected && (
              <View style={[styles.dot, { backgroundColor: theme.accent }]} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

export function ThemeRows() {
  const { themeId, setTheme, tokens } = useTheme();
  return (
    <View style={styles.rows}>
      {THEMES.map((theme) => {
        const selected = theme.id === themeId;
        return (
          <Pressable
            key={theme.id}
            accessibilityLabel={`Theme: ${theme.name}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => setTheme(theme.id)}
            style={[
              styles.row,
              {
                backgroundColor: selected ? tokens.subtle : "transparent",
                borderColor: selected ? tokens.accent : tokens.borderSubtle,
              },
            ]}
          >
            <View style={styles.strip}>
              {theme.paletteLight.slice(0, 5).map((hex, i) => (
                <View key={i} style={[styles.swatch, { backgroundColor: hex }]} />
              ))}
            </View>
            <View style={styles.stripDark}>
              {theme.paletteDark.slice(0, 5).map((hex, i) => (
                <View key={i} style={[styles.swatch, { backgroundColor: hex }]} />
              ))}
            </View>
            <TypeBody style={{ flex: 1, color: tokens.text }}>{theme.name}</TypeBody>
            {selected && <Check size={16} color={tokens.accent} strokeWidth={2.4} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dotsRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center",
  },
  dotTarget: {
    width: 32,
    height: 32,
    borderRadius: RADIUS_PILL,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: RADIUS_PILL,
  },
  rows: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  strip: {
    flexDirection: "row",
    borderRadius: 4,
    overflow: "hidden",
  },
  stripDark: {
    flexDirection: "row",
    borderRadius: 4,
    overflow: "hidden",
    marginLeft: 4,
  },
  swatch: { width: 12, height: 12 },
});
