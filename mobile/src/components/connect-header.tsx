/**
 * ConnectHeader — the connect flow's custom header (R116-D): the scanner and
 * the manual-entry screen build their header row IN-PAGE (round-116's "stop
 * using ScreenScaffold's chrome for this screen — build the row so you
 * control it") instead of the shared scaffold:
 *
 *   · the back button is the SHARED QuietIconButton (R118-B, spec §2.7 —
 *     the 40px quiet circle, ArrowLeft 22: the same grammar the screen
 *     scaffold's back slot adopted; the R116-b chevron chip is retired);
 *   · the title is ABSOLUTELY centered over the whole row (donts.md #32 — a
 *     title centered in the space remaining beside the back button is not
 *     centered), on a pointerEvents="none" overlay so the button stays
 *     tappable, carrying numberOfLines 1 + a 72%-of-screen maxWidth;
 *   · there is NO right slot — these two screens are single-purpose moments.
 *
 * The row renders inside the caller's body gutter, so the back button aligns
 * with the content below it (the viewfinder / the form fields).
 */

import { ArrowLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { QuietIconButton } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { fontFamily, spacing, TYPE_TITLE } from "@/design/tokens";

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
      <View style={styles.backWrap}>
        <QuietIconButton
          icon={ArrowLeft}
          iconSize={22}
          size={40}
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          testID={backTestID}
        />
      </View>
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
  /** The 56px header row (the scaffold's compact grammar). R118-B: the row
   *  carries the 4dp gap so the back button's own 4dp tail margin reads 8dp
   *  to the title's overlay space (the scaffold's exact arithmetic). */
  row: { height: 56, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  /** R118-B — the shared ArrowLeft back button's wrapper (the 4dp tail gap). */
  backWrap: { marginRight: spacing.xs },
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
