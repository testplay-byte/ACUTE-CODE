/**
 * The wizard's welcome step — the brand moment: the app's name, what it is
 * (a remote control for the desktop agent), and the three things it does.
 * Clay-styled full-bleed (the first screen the owner sees in the new
 * language — it sets the whole visual register).
 */

import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Bell, MessageSquareText, ShieldCheck, Smartphone } from "lucide-react-native";
import {
  ChromeButton,
  ClayCard,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeDisplay,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";

export default function WelcomeScreen() {
  const { tokens } = useTheme();
  const router = useRouter();

  const rows = [
    {
      icon: MessageSquareText,
      title: "Work from anywhere",
      body: "See every project, session, and live agent turn on your desktop — and send messages from your pocket.",
    },
    {
      icon: ShieldCheck,
      title: "Approve from your pocket",
      body: "Every permission the agent asks for lands here: read the risk line, approve or deny in one tap.",
    },
    {
      icon: Bell,
      title: "Know the moment it matters",
      body: "Approvals, finished tasks, and failures arrive live — with the full history a tap away.",
    },
  ];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        <View style={styles.hero}>
          <View
            style={[
              styles.logoTile,
              {
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
            ]}
          >
            <Smartphone size={30} color={tokens.accent} strokeWidth={2.2} />
          </View>
          <TypeDisplay style={styles.title}>ACUTE</TypeDisplay>
          <TypeBody style={styles.tagline}>The remote for your desktop agent.</TypeBody>
        </View>

        <View style={styles.rows}>
          {rows.map((row, i) => {
            const Icon = row.icon;
            return (
              <ClayCard key={row.title} elevated={i === 0}>
                <View style={styles.rowInner}>
                  <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
                    <Icon size={20} color={tokens.accent} strokeWidth={2.2} />
                  </View>
                  <View style={styles.rowText}>
                    <TypeBodyStrong>{row.title}</TypeBodyStrong>
                    <TypeCaption style={styles.rowBody}>{row.body}</TypeCaption>
                  </View>
                </View>
              </ClayCard>
            );
          })}
        </View>

        <View style={styles.footer}>
          <TypeMicro style={styles.kicker}>
            YOUR DESKTOP DOES ALL THE WORK — THIS IS ITS SCREEN AND ITS TWO BUTTONS
          </TypeMicro>
          <ChromeButton onPress={() => router.push("/onboarding/permissions")}>Get started</ChromeButton>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.xxl, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xxxl },
  logoTile: {
    width: 76,
    height: 76,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: { letterSpacing: 1.5 },
  tagline: { textAlign: "center", maxWidth: 260 },
  rows: { gap: spacing.md },
  rowInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "flex-start" },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
  rowBody: { lineHeight: 18 },
  footer: { gap: spacing.md, paddingBottom: spacing.xl },
  kicker: { textAlign: "center", lineHeight: 15 },
});
