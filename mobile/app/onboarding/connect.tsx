/**
 * The wizard's connect step — the bridge into the real connection flow:
 * the two ways to link (scan the desktop's QR / type it in), plus "do it
 * later" (the tabs work unpaired; the connect hub is one tap away). This
 * screen completes the wizard either way — the pairing itself lives in
 * /connect (the hub the app reuses forever after).
 */

import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Keyboard, QrCode, ScanLine } from "lucide-react-native";
import { ChromeButton, ClayCard, PressableCard, QuietButton, TypeBody, TypeCaption, TypeDisplay, TypeMicro } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { completeOnboarding } from "@/features/onboarding";
import { spacing } from "@/design/tokens";

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
          <TypeDisplay style={styles.title}>Link your desktop</TypeDisplay>
          <TypeBody style={styles.tagline}>
            One link, one time — the phone then remembers this desktop and reconnects on its own.
          </TypeBody>
        </View>

        <View style={styles.options}>
          <PressableCard
            elevated
            onPress={() => void finishWizard("/connect/scan")}
            accessibilityLabel="Scan the QR code on your desktop"
          >
            <View style={styles.optionInner}>
              <View style={[styles.optionIcon, { backgroundColor: tokens.subtleHover }]}>
                <ScanLine size={24} color={tokens.accent} strokeWidth={2.2} />
              </View>
              <View style={styles.optionText}>
                <TypeBody>Scan the QR code</TypeBody>
                <TypeCaption>
                  On the desktop: Settings → Link a device — then point the camera here. Fastest way.
                </TypeCaption>
              </View>
            </View>
          </PressableCard>

          <PressableCard
            onPress={() => void finishWizard("/connect/manual")}
            accessibilityLabel="Enter the address and PIN by hand"
          >
            <View style={styles.optionInner}>
              <View style={[styles.optionIcon, { backgroundColor: tokens.subtleHover }]}>
                <Keyboard size={24} color={tokens.accent} strokeWidth={2.2} />
              </View>
              <View style={styles.optionText}>
                <TypeBody>Type it in instead</TypeBody>
                <TypeCaption>
                  Address (or a tunnel URL) + the 8-digit PIN — works from anywhere, camera never needed.
                </TypeCaption>
              </View>
            </View>
          </PressableCard>
        </View>

        <ClayCard>
          <View style={styles.trustInner}>
            <View style={styles.trustRow}>
              <QrCode size={16} color={tokens.textTertiary} strokeWidth={2} />
              <TypeMicro>THE LINK RIDES TLS · THE PHONE PINS THE DESKTOP'S CERTIFICATE AT PAIRING TIME</TypeMicro>
            </View>
          </View>
        </ClayCard>

        <View style={styles.footer}>
          <ChromeButton onPress={() => void finishWizard("/connect/scan")}>Scan the pairing code</ChromeButton>
          <QuietButton onPress={() => void finishWizard("/")}>Do it later</QuietButton>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.xl, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xxl },
  title: { textAlign: "center" },
  tagline: { textAlign: "center", maxWidth: 320 },
  options: { gap: spacing.md },
  optionInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1, gap: 2 },
  trustInner: { padding: spacing.lg },
  trustRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  footer: { gap: spacing.md, paddingBottom: spacing.xl },
});
