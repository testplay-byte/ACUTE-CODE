/**
 * The connection hub (R109: "There should be an option to add a connection
 * and after doing that it should lead to a new page where the user can
 * input the values manually or he can configure them as such").
 *
 * No host yet → the "Add a connection" hero: scan the desktop's QR, or
 * enter the values by hand — both land on the confirm step.
 * Host linked → the current connection (identity + live status + retry),
 * "pair a different desktop" (scan again replaces the link), and the
 * disconnect action lives in the host-management page it links to.
 *
 * R110 #4 (v0.106.0): the hub is a ROOT screen — after onboarding (and after
 * every replace() landing) there is nothing behind it, so the back chevron
 * only renders when the root stack can actually pop (e.g. pushed from the
 * connection pill inside the tabs). R110 #5: the hero copy is one short
 * line — the trust-fine-print row is gone.
 */

import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Keyboard,
  MonitorSmartphone,
  RefreshCw,
  ScanLine,
  Unplug,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import {
  ClayCard,
  PressableCard,
  QuietButton,
  TypeBody,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { fontFamily, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";

export default function ConnectHubScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live, lastSeen } = useLink();
  const [, setTick] = useState(0);

  // R110 #4: the hub is the ROOT of the connect flow — the chevron only
  // makes sense when the ROOT stack can pop (pushed from the tabs' pill).
  // As the post-onboarding landing screen there is nothing to go back to.
  const canPopRoot = router.canGoBack();

  // The honest relative "last seen" — a 30s tick while a host exists.
  useEffect(() => {
    if (host === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [host]);

  const connected = status === "connected";

  return (
    <ScreenScaffold title="Connect" back={canPopRoot} noPill>
      {host === null ? (
        // ── no host yet: the "add a connection" hero (R110 #5: one line) ──
        <>
          <ClayCard elevated>
            <View style={styles.cardPad}>
              <TypeBody style={styles.heroTitle}>Add a connection</TypeBody>
              <TypeCaption style={styles.heroBody}>
                Scan a pairing QR from your desktop, or enter an address manually.
              </TypeCaption>
            </View>
          </ClayCard>

          <PressableCard
            elevated
            onPress={() => router.push("/connect/scan")}
            accessibilityLabel="Scan the pairing QR code"
          >
            <OptionRow
              icon={<ScanLine size={24} color={tokens.accent} strokeWidth={2.2} />}
              title="Scan the QR code"
              body="The desktop shows it under Settings → Link a device. Pinch to zoom, tap for the torch."
            />
          </PressableCard>

          <PressableCard
            onPress={() => router.push("/connect/manual")}
            accessibilityLabel="Enter the connection values by hand"
          >
            <OptionRow
              icon={<Keyboard size={24} color={tokens.accent} strokeWidth={2.2} />}
              title="Enter the values manually"
              body="Address or tunnel URL, the 8-digit PIN, and — optionally — the desktop's certificate fingerprint."
            />
          </PressableCard>
        </>
      ) : (
        // ── host linked: the current connection + the management paths ──
        <>
          <ClayCard elevated>
            <View style={styles.cardPad}>
              <View style={styles.hostRow}>
                <View style={[styles.hostIcon, { backgroundColor: tokens.subtleHover }]}>
                  <MonitorSmartphone size={22} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <View style={styles.hostText}>
                  <TypeBody>{host.hostLabel}</TypeBody>
                  <TypeCaption>
                    {connected
                      ? `connected · desktop v${live?.version ?? "?"}`
                      : status === "probing"
                        ? "looking for the host…"
                        : "host offline — retrying"}
                  </TypeCaption>
                </View>
                {!connected ? (
                  <QuietButton onPress={() => getLinkManager().retryNow()} tone="neutral">
                    <RefreshCw size={16} color={tokens.textSecondary} strokeWidth={2.2} />
                  </QuietButton>
                ) : null}
              </View>
              <TypeCaption style={styles.lastSeen}>
                last seen {lastSeen === null ? "never" : timeAgo(lastSeen)} · paired{" "}
                {timeAgo(host.pairedAt)} ago
              </TypeCaption>
            </View>
          </ClayCard>

          <PressableCard onPress={() => router.push("/settings/host")}>
            <OptionRow
              icon={<Unplug size={22} color={tokens.textSecondary} strokeWidth={2.2} />}
              title="Manage this connection"
              body="Identity, addresses, diagnostics, replay the wizard, or disconnect completely."
            />
          </PressableCard>

          <TypeMicro style={styles.kicker}>PAIR A DIFFERENT DESKTOP</TypeMicro>
          <PressableCard
            onPress={() => router.push("/connect/scan")}
            accessibilityLabel="Scan to pair a different desktop"
          >
            <OptionRow
              icon={<ScanLine size={22} color={tokens.accent} strokeWidth={2.2} />}
              title="Scan a new pairing code"
              body="Replaces this link — the desktop keeps its own list, revoke this phone there if you leave it."
            />
          </PressableCard>
        </>
      )}
    </ScreenScaffold>
  );
}

function OptionRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <View style={styles.optionInner}>
      <View style={styles.optionIcon}>{icon}</View>
      <View style={styles.optionText}>
        <TypeBody>{title}</TypeBody>
        <TypeCaption style={styles.optionBody}>{body}</TypeCaption>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardPad: { padding: spacing.lg, gap: spacing.md },
  heroTitle: { fontSize: 17, fontFamily: fontFamily.bold },
  heroBody: { lineHeight: 19 },
  optionInner: { flexDirection: "row", gap: spacing.md, padding: spacing.lg, alignItems: "center" },
  optionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: { flex: 1, gap: 2 },
  optionBody: { lineHeight: 18 },
  hostRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  hostIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  hostText: { flex: 1, gap: 2 },
  lastSeen: { marginTop: spacing.xs },
  kicker: { marginTop: spacing.xs },
});
