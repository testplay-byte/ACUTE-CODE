/**
 * LetterAvatar — the shared project identity tile
 * (docs/design-language/android/02-patterns/components.md): the label's
 * first letter, white TypeBodyStrong, on the project's own theme color, a
 * circle. Born local to home.tsx (R115-f); extracted R115-h the moment the
 * projects tab dropped its colored dot (donts #15 — "colored dots standing
 * in for identity avatars"). Used in: project rows, chat headers, session
 * context rows.
 *
 * The white-on-color literal is the components.md idiom (Badge's own fg) —
 * no token exists for on-project-color text.
 */

import { StyleSheet, View } from "react-native";
import { TypeBodyStrong } from "@/design/primitives";
import { TILE_ROW } from "@/design/tokens";

export interface LetterAvatarProps {
  /** The name whose first letter renders (the project's name). */
  label: string;
  /** The project's theme color (the registry row's own color). */
  color: string;
  /** The circle's diameter — the components.md row band is 36–44; the
   * default is TILE_ROW (40, the row geometry home.tsx established). */
  size?: number;
  testID?: string;
}

export function LetterAvatar({ label, color, size = TILE_ROW, testID }: LetterAvatarProps) {
  const trimmed = label.trim();
  const letter = trimmed === "" ? "?" : trimmed.charAt(0).toUpperCase();
  return (
    <View
      testID={testID}
      // The enclosing row's accessibility label names the project — the
      // bare letter must not double-read.
      accessibilityElementsHidden
      style={[styles.circle, { backgroundColor: color, width: size, height: size, borderRadius: size / 2 }]}
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
  circle: { alignItems: "center", justifyContent: "center" },
  letter: { color: "#FFFFFF" },
});
