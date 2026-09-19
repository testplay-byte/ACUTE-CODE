/**
 * The wizard's permissions step (R109: "ask for all the permissions
 * needed"). Today that is exactly ONE permission — the camera (the QR
 * scan) — requested with its rationale up front, honestly skippable (the
 * manual-entry path works without it). Internet access is a normal
 * permission Android grants silently; push notifications arrive with the
 * Firebase round (the setup guide ships in this release's docs).
 */

import { useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Camera, Check, CircleAlert } from "lucide-react-native";
import { ChromeButton, ClayCard, QuietButton, TypeBody, TypeCaption, TypeDisplay, TypeMicro } from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { mobLog } from "@/lib/log";

export default function PermissionsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [denied, setDenied] = useState(false);

  const granted = cameraPermission?.granted ?? false;

  async function onRequest() {
    try {
      const result = await requestCamera();
      if (result.granted) {
        setDenied(false);
        void successHaptic();
        mobLog("onboarding", "camera permission granted");
      } else {
        setDenied(true);
        void warningHaptic();
        mobLog("onboarding", "camera permission denied");
      }
    } catch (err) {
      mobLog("onboarding", "camera permission request failed", err instanceof Error ? err.message : err);
      setDenied(true);
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        <View style={styles.hero}>
          <View
            style={[
              styles.iconTile,
              {
                backgroundColor: granted ? tokens.success : tokens.card,
                borderTopColor: granted ? tokens.success : tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
            ]}
          >
            {granted ? (
              <Check size={28} color="#FFFFFF" strokeWidth={2.6} />
            ) : (
              <Camera size={28} color={tokens.accent} strokeWidth={2.2} />
            )}
          </View>
          <TypeDisplay style={styles.title}>{granted ? "Camera ready" : "Camera access"}</TypeDisplay>
          <TypeBody style={styles.tagline}>
            {granted
              ? "You can scan the desktop's pairing QR code."
              : "The QR scanner needs the camera to read your desktop's pairing code."}
          </TypeBody>
        </View>

        <ClayCard elevated>
          <View style={styles.cardInner}>
            <View style={styles.stepRow}>
              <View style={[styles.stepDot, { backgroundColor: granted ? tokens.success : tokens.accent }]}>
                <TypeMicro style={{ color: "#FFFFFF", fontSize: 11 }}>1</TypeMicro>
              </View>
              <View style={styles.stepText}>
                <TypeBody>
                  On your desktop, open Settings → Link a device — the QR code and PIN appear there.
                </TypeBody>
              </View>
            </View>
            <View style={styles.stepRow}>
              <View style={[styles.stepDot, { backgroundColor: granted ? tokens.success : tokens.accent }]}>
                <TypeMicro style={{ color: "#FFFFFF", fontSize: 11 }}>2</TypeMicro>
              </View>
              <View style={styles.stepText}>
                <TypeBody>Point this phone's camera at it — zoom in if it's far away.</TypeBody>
              </View>
            </View>
            <View style={styles.stepRow}>
              <View style={[styles.stepDot, { backgroundColor: tokens.textTertiary }]}>
                <TypeMicro style={{ color: "#FFFFFF", fontSize: 11 }}>3</TypeMicro>
              </View>
              <View style={styles.stepText}>
                <TypeBody>Confirm the host's identity, and the two stay linked for months.</TypeBody>
              </View>
            </View>
          </View>
        </ClayCard>

        {denied ? (
          <ClayCard bordered>
            <View style={styles.deniedInner}>
              <View style={styles.deniedRow}>
                <CircleAlert size={18} color={tokens.warning} strokeWidth={2.2} />
                <TypeBody style={{ color: tokens.warning, flex: 1 }}>
                  Camera blocked — you can still pair by typing the address and PIN by hand.
                </TypeBody>
              </View>
              <TypeCaption>
                To enable later: Android Settings → Apps → ACUTE → Permissions → Camera.
              </TypeCaption>
            </View>
          </ClayCard>
        ) : null}

        <View style={styles.footer}>
          {granted ? (
            <ChromeButton onPress={() => router.push("/onboarding/connect")}>Continue</ChromeButton>
          ) : (
            <ChromeButton onPress={() => void onRequest()}>Allow camera access</ChromeButton>
          )}
          <QuietButton onPress={() => router.push("/onboarding/connect")}>
            Skip for now — I'll type it in
          </QuietButton>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.xl, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xxl },
  iconTile: {
    width: 72,
    height: 72,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  title: { textAlign: "center" },
  tagline: { textAlign: "center", maxWidth: 300 },
  cardInner: { padding: spacing.lg, gap: spacing.lg },
  stepRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  stepDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { flex: 1 },
  deniedInner: { padding: spacing.lg, gap: spacing.md },
  deniedRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  footer: { gap: spacing.md, paddingBottom: spacing.xl },
});
