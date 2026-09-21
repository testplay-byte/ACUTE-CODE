/**
 * ConnectHeader — the connect flow's custom header (R116-D): the scanner and
 * the manual-entry screen build their header row IN-PAGE (round-116's "stop
 * using ScreenScaffold's chrome for this screen — build the row so you
 * control it") instead of the shared scaffold:
 *
 *   · the back button is the CHIP idiom (donts.md #41 — the 44px target with
 *     a subtle fill + hairline border + the chip radius, the R116-b
 *     screen-scaffold back chip's exact grammar);
 *   · the title is ABSOLUTELY centered over the whole row (donts.md #32 — a
 *     title centered in the space remaining beside the back chip is not
 *     centered), on a pointerEvents="none" overlay so the chip stays
 *     tappable, carrying numberOfLines 1 + a 72%-of-screen maxWidth;
 *   · there is NO right slot — these two screens are single-purpose moments.
 *
 * The row renders inside the caller's body gutter, so the back chip aligns
 * with the content below it (the viewfinder / the form fields).
 */

import { ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useTheme } from "@/design/theme";
import { fontFamily, RADIUS_CHIP, TYPE_TITLE } from "@/design/tokens";

export interface ConnectHeaderProps {
  /** The absolutely-centered title (numberOfLines 1, tail-ellipsized). */
  title: string;
  /** The back chip's testID ("scan-back" / "manual-back"). */
  backTestID: string;
}

export function ConnectHeader({ title, backTestID }: ConnectHeaderProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityLabel="Go back"
        accessibilityRole="button"
        hitSlop={12}
        onPress={() => router.back()}
        style={[styles.backChip, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}
        testID={backTestID}
      >
        {/* R116-n — 26/2: the scaffold + session header's exact glyph (this
            chip claimed the "exact grammar" and shipped a 24 — the drift). */}
        <ChevronLeft size={26} color={tokens.text} strokeWidth={2} />
      </Pressable>
      {/* The ABSOLUTELY centered title: spans the whole row so it centers over
          the SCREEN, not the space beside the chip; pointerEvents none keeps
          the chip tappable. TypeTitle's exact recipe as a raw Text (the
          R116-b scaffold-title precedent). */}
      <View pointerEvents="none" style={styles.titleOverlay}>
        <Text
          numberOfLines={1}
          style={[styles.title, { color: tokens.text, maxWidth: Math.round(windowWidth * 0.72) }]}
        >
          {title}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The 56px header row (the scaffold's compact grammar). */
  row: { height: 56, flexDirection: "row", alignItems: "center" },
  /** The back CHIP (donts #41): 44px target, subtle fill, hairline border. */
  backChip: {
    width: 44,
    height: 44,
    borderRadius: RADIUS_CHIP,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  titleOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  /** TypeTitle's exact recipe (20/700, −0.2 tracking). */
  title: {
    textAlign: "center",
    fontSize: TYPE_TITLE,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.2,
  },
});
