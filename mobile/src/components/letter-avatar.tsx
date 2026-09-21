/**
 * LetterAvatar — the shared project identity tile
 * (docs/design-language/android/02-patterns/components.md): the label's
 * first letter, white TypeBodyStrong, on the project's own theme color, a
 * ROUNDED-SQUARE clay tile (R116-k — the circle is retired): radius ≈38% of
 * the side (RADIUS_CHIP-class at the 40px row default), the clay card
 * material at tile scale — matte top edge over a hairline rim plus the
 * small-shadow leg. Born local to home.tsx (R115-f); extracted R115-h the
 * moment the projects tab dropped its colored dot (donts #15 — "colored
 * dots standing in for identity avatars"). Used in: project rows, chat
 * headers, session context rows. Identity avatars are never plain circles.
 *
 * The white-on-color literal is the components.md idiom (Badge's own fg) —
 * no token exists for on-project-color text.
 */

import { StyleSheet, View } from "react-native";
import { TypeBodyStrong } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { TILE_ROW } from "@/design/tokens";

export interface LetterAvatarProps {
  /** The name whose first letter renders (the project's name). */
  label: string;
  /** The project's theme color (the registry row's own color). */
  color: string;
  /** The tile's side — the components.md row band is 36–44; the default is
   * TILE_ROW (40, the row geometry home.tsx established). */
  size?: number;
  testID?: string;
}

export function LetterAvatar({ label, color, size = TILE_ROW, testID }: LetterAvatarProps) {
  const { tokens } = useTheme();
  const trimmed = label.trim();
  const letter = trimmed === "" ? "?" : trimmed.charAt(0).toUpperCase();
  return (
    <View
      testID={testID}
      // The enclosing row's accessibility label names the project — the
      // bare letter must not double-read.
      accessibilityElementsHidden
      style={[
        styles.tile,
        {
          backgroundColor: color,
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.38),
          // The clay card material at tile scale (PressableCard's idiom):
          // the matte top edge rides OVER the hairline white/black rim, and
          // the small two-leg shadow lifts the tile off the row.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.clayTopEdge,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.border,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
    >
      {/* Auto-scaled: size × 0.375 — exactly TYPE_BODY (15) at the default
          40px tile, proportional anywhere else in the 36–44 band. */}
      <TypeBodyStrong style={[styles.letter, { fontSize: Math.round(size * 0.375) }]}>
        {letter}
      </TypeBodyStrong>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center" },
  letter: { color: "#FFFFFF" },
});
