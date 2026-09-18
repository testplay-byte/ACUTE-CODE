/**
 * Settings/Linking — the link's control room: the five themes + mode
 * (system / dark / light), the host's identity details (machine id,
 * certificate fingerprint, the address ladder), "Unpair this device"
 * (clears THIS phone's link — the desktop's revoke is a separate act),
 * and the about/version block.
 */

import { Alert, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ThemeRows } from "@/components/theme-picker";
import { Badge, Hairline, PressableCard, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { formatCertFP, shortMachineId } from "@/link/pairing";

export default function SettingsScreen() {
  const { tokens, mode, setMode } = useTheme();
  const { host, status, live } = useLink();
  const router = useRouter();

  function onUnpair() {
    Alert.alert(
      "Unpair this device?",
      "The saved link is cleared on this phone. The desktop keeps its device row — revoke it there if you want the token dead.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: () => {
            void getLinkManager()
              .unpair()
              .then(() => router.replace("/pairing"));
          },
        },
      ],
      { cancelable: true },
    );
  }

  return (
    <ScreenScaffold title="Settings">
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
            THEME
          </TypeCaption>
          <ThemeRows />
        </View>

        <View style={{ gap: spacing.sm }}>
          <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
            APPEARANCE
          </TypeCaption>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {(["system", "dark", "light"] as const).map((m) => (
              <PressableCard
                key={m}
                accessibilityLabel={`Mode: ${m}`}
                onPress={() => setMode(m)}
                style={{ flex: 1, paddingVertical: 10 }}
              >
                <TypeBody
                  style={{
                    color: mode === m ? tokens.accent : tokens.textSecondary,
                    textAlign: "center",
                    fontWeight: mode === m ? "600" : "400",
                  }}
                >
                  {m === "system" ? "System" : m === "dark" ? "Dark" : "Light"}
                </TypeBody>
              </PressableCard>
            ))}
          </View>
        </View>

        <Hairline />

        {host !== null ? (
          <View style={{ gap: spacing.md }}>
            <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
              LINKED HOST
            </TypeCaption>
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                padding: spacing.lg,
                gap: spacing.sm,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <TypeBody style={{ color: tokens.text, fontWeight: "600", flex: 1 }}>
                  {host.hostLabel}
                </TypeBody>
                <Badge tone={status === "connected" ? "accent" : "neutral"}>
                  {status === "connected" ? "live" : status}
                </Badge>
              </View>
              <TypeMono style={{ color: tokens.textSecondary, fontSize: 10 }}>
                {`machine ${shortMachineId(host.machineId)}`}
              </TypeMono>
              {host.certFP !== null && (
                <TypeMono style={{ color: tokens.textTertiary, fontSize: 10 }}>
                  {`cert   ${formatCertFP(host.certFP).slice(0, 23)}…`}
                </TypeMono>
              )}
              <TypeMono style={{ color: tokens.textTertiary, fontSize: 10 }}>
                {`addrs  ${host.addrs.join(" · ")}${host.port !== null ? `:${host.port}` : ""}`}
              </TypeMono>
              {live !== null && (
                <TypeCaption style={{ color: tokens.textTertiary }}>
                  {`desktop v${live.version}`}
                </TypeCaption>
              )}
            </View>

            <PressableCard
              accessibilityLabel="Unpair this device"
              onPress={onUnpair}
            >
              <TypeBody
                style={{ color: tokens.danger, textAlign: "center", fontWeight: "600" }}
              >
                Unpair this device
              </TypeBody>
            </PressableCard>
          </View>
        ) : (
          <TypeBody style={{ color: tokens.textSecondary }}>No host linked.</TypeBody>
        )}

        <Hairline />

        <View style={{ gap: spacing.xs }}>
          <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
            ABOUT
          </TypeCaption>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            ACUTE companion · view + input medium for the desktop agent —
            nothing is processed on this phone.
          </TypeCaption>
        </View>
      </View>
    </ScreenScaffold>
  );
}
