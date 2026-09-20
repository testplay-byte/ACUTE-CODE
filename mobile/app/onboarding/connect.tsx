/**
 * The wizard's connect step — the bridge into the real connection flow:
 * the two ways to link (scan the QR / type it in) plus "do it later" (the
 * tabs work unpaired; the connect hub is one tap away).
 *
 * R115: minimal — the title (no description paragraph), the two one-line
 * option cards, and the footer pair. The TLS trust card and the old long
 * "Scan the pairing code" CTA are deleted (onboarding.md screen 3). The
 * wizard completes on this screen's FIRST action either way; the pairing
 * itself lives in /connect (the hub the app reuses forever after).
 */

import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Keyboard, ScanLine } from "lucide-react-native";
import { ChromeButton, FadeInUp, QuietButton, TypeDisplay } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { completeOnboarding } from "@/features/onboarding";
import { spacing } from "@/design/tokens";
import { PairOptionsPair } from "@/components/pair-options";

export default function ConnectStepScreen() {
  const { tokens } = useTheme();
  const router = useRouter();

  async function finishWizard(target: string) {
    await completeOnboarding();
    router.replace(target as never);
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        <View style={styles.hero}>
          <FadeInUp index={0}>
            <TypeDisplay style={styles.title}>Link your desktop</TypeDisplay>
          </FadeInUp>
        </View>

        <PairOptionsPair
          start={1}
          options={[
            {
              icon: ScanLine,
              label: "Scan the QR code",
              description: "From the desktop's Link a device screen.",
              onPress: () => void finishWizard("/connect/scan"),
              testID: "link-scan",
            },
            {
              icon: Keyboard,
              label: "Type it in instead",
              description: "Address and PIN, no camera needed.",
              onPress: () => void finishWizard("/connect/manual"),
              testID: "link-manual",
            },
          ]}
        />

        <View style={styles.footer}>
          <FadeInUp index={3}>
            <ChromeButton flat testID="link-scan-cta" onPress={() => void finishWizard("/connect/scan")}>
              Scan
            </ChromeButton>
          </FadeInUp>
          <FadeInUp index={4}>
            <QuietButton testID="link-do-later" onPress={() => void finishWizard("/")}>
              Do it later
            </QuietButton>
          </FadeInUp>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.xl, justifyContent: "space-between" },
  hero: { alignItems: "center", paddingTop: spacing.xxl },
  title: { textAlign: "center" },
  footer: { gap: spacing.md, paddingBottom: spacing.xl },
});
