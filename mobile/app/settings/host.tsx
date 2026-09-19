/**
 * The connection management page: the host's identity card (label, machine
 * id, the certificate fingerprint in its full two-line mono spelling, the
 * address ladder + port, the desktop version, when it was paired), the live
 * status row with the manual retry, the diagnostics card (the last failure
 * message + this app's boot trail — the last 12 [ACUTE-BOOT] stages), and
 * the danger zone: disconnect this desktop (honest copy — the desktop keeps
 * its device list; revoking is a separate desktop-side act).
 */

import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { MonitorSmartphone, RefreshCw } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import {
  Badge,
  ClayCard,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { formatCertFP, shortMachineId } from "@/link/pairing";
import { getBootStages } from "@/features/boot-log";
import { mobLog, mobWarn } from "@/lib/log";

/** How many boot stages the diagnostics card shows (the tail is the story). */
const BOOT_TRAIL_ROWS = 12;

export default function HostSettingsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status, host, live, lastSeen, lastFailure } = useLink();
  const [, setTick] = useState(0);

  // The honest relative clock (paired-at / last-seen) — 30s.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    mobLog("settings", "host page opened", { status });
  }, [status]);

  const connected = status === "connected";

  function onDisconnect() {
    Alert.alert(
      "Disconnect this desktop?",
      "The saved link is cleared on this phone. The desktop keeps its device row — revoke it there too if you want the token dead.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            mobLog("settings", "disconnecting host (unpair)");
            void getLinkManager()
              .unpair()
              .then(() => router.replace("/connect"))
              .catch((err: unknown) => {
                mobWarn("settings", "unpair failed", {
                  message: err instanceof Error ? err.message : String(err),
                });
              });
          },
        },
      ],
      { cancelable: true },
    );
  }

  if (host === null) {
    // Honest no-host state (e.g. revoked mid-visit) — the hub is one tap away.
    return (
      <ScreenScaffold title="Connection" back>
        <ClayCard elevated>
          <View style={styles.noHostPad}>
            <View style={[styles.noHostIcon, { backgroundColor: tokens.subtleHover }]}>
              <MonitorSmartphone size={26} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <TypeBodyStrong>No desktop linked</TypeBodyStrong>
            <TypeCaption>
              Pair once — scan the desktop's QR code or type the values — and this
              phone remembers the link for months.
            </TypeCaption>
            <QuietButton onPress={() => router.push("/connect")}>Link a desktop</QuietButton>
          </View>
        </ClayCard>
      </ScreenScaffold>
    );
  }

  const certLines = host.certFP !== null ? splitCertFP(formatCertFP(host.certFP)) : null;

  return (
    <ScreenScaffold title="Connection" back subtitle={host.hostLabel}>
      {/* ── the live status row ── */}
      <ClayCard elevated>
        <View style={styles.statusPad}>
          <View style={styles.statusRow}>
            <StatusDot
              color={
                connected
                  ? tokens.success
                  : status === "offline"
                    ? tokens.warning
                    : tokens.accent
              }
              pulse={status === "probing"}
            />
            <View style={styles.statusText}>
              <TypeBodyStrong>
                {connected
                  ? "live"
                  : status === "probing"
                    ? "looking for the host…"
                    : "host offline — retrying"}
              </TypeBodyStrong>
              <TypeCaption>
                {`last seen ${lastSeen === null ? "never" : timeAgo(lastSeen)}`}
                {live !== null ? ` · desktop v${live.version}` : ""}
              </TypeCaption>
            </View>
            {!connected ? (
              <QuietButton onPress={() => getLinkManager().retryNow()}>
                <View style={styles.retryIconRow}>
                  <RefreshCw size={16} color={tokens.textSecondary} strokeWidth={2.2} />
                </View>
              </QuietButton>
            ) : null}
          </View>
        </View>
      </ClayCard>

      {/* ── the identity card ── */}
      <SectionHeader>This desktop</SectionHeader>
      <ClayCard>
        <View style={styles.identityPad}>
          <View style={styles.identityHead}>
            <View style={[styles.identityIcon, { backgroundColor: tokens.subtleHover }]}>
              <MonitorSmartphone size={22} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <View style={styles.identityHeadText}>
              <TypeBodyStrong>{host.hostLabel}</TypeBodyStrong>
              <TypeMicro>MACHINE {shortMachineId(host.machineId)}</TypeMicro>
            </View>
            <Badge tone={connected ? "success" : "neutral"}>{connected ? "live" : status}</Badge>
          </View>

          <View style={[styles.identityRows, { borderTopColor: tokens.borderSubtle }]}>
            <IdentityMono label="MACHINE ID" lines={[host.machineId]} />
            {certLines !== null ? (
              <IdentityMono label="CERT FINGERPRINT" lines={certLines} />
            ) : (
              <IdentityMono label="CERT FINGERPRINT" lines={["(tunnel-paired — no pin stored)"]} />
            )}
            <IdentityMono
              label="ADDRESS LADDER"
              lines={[
                ...host.addrs.map((addr) => displayAddr(addr, host.port)),
                `port ${host.port}`,
              ]}
            />
            <View style={styles.identityRow}>
              <TypeMicro>PAIRED</TypeMicro>
              <TypeCaption>{timeAgo(host.pairedAt)} ago</TypeCaption>
            </View>
          </View>
        </View>
      </ClayCard>

      {/* ── diagnostics: the last failure + this app's boot trail ── */}
      <SectionHeader>Diagnostics</SectionHeader>
      <ClayCard bordered>
        <View style={styles.diagPad}>
          <View style={styles.diagRow}>
            <TypeMicro>LAST FAILURE</TypeMicro>
            <TypeCaption>
              {lastFailure !== null
                ? `${lastFailure.kind} · ${lastFailure.message}`
                : connected
                  ? "none — the link is answering"
                  : "none recorded this session"}
            </TypeCaption>
          </View>
          <View style={[styles.diagRow, styles.diagDivider, { borderTopColor: tokens.borderSubtle }]}>
            <TypeMicro>PHONE BOOT TRAIL</TypeMicro>
            <View style={[styles.trailWrap, { backgroundColor: tokens.monoBg, borderColor: tokens.monoBorder }]}>
              <ScrollView
                horizontal={false}
                nestedScrollEnabled
                style={styles.trailScroll}
                contentContainerStyle={styles.trailContent}
              >
                {getBootStages()
                  .slice(-BOOT_TRAIL_ROWS)
                  .map((stage) => (
                    <TypeMono key={`${stage.at}-${stage.stage}`} style={styles.trailLine}>
                      {`${stage.at}ms ${stage.stage}${stage.detail ? ` — ${stage.detail}` : ""}`}
                    </TypeMono>
                  ))}
              </ScrollView>
            </View>
          </View>
        </View>
      </ClayCard>

      {/* ── the danger zone ── */}
      <SectionHeader>Danger zone</SectionHeader>
      <ClayCard bordered>
        <View style={styles.dangerPad}>
          <TypeBodyStrong style={[{ color: tokens.danger }]}>Disconnect this desktop</TypeBodyStrong>
          <TypeBody style={styles.dangerBody}>
            Clears the saved link on this phone — every screen falls back to "link a
            device". The desktop keeps its device list; revoke this phone there too
            if you want the token dead.
          </TypeBody>
          <QuietButton tone="danger" onPress={onDisconnect}>
            Disconnect this desktop
          </QuietButton>
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

/** The full fingerprint split at the colon boundary into two mono lines. */
function splitCertFP(formatted: string): [string, string] {
  const pairs = formatted.split(":");
  const half = Math.ceil(pairs.length / 2);
  return [pairs.slice(0, half).join(":"), pairs.slice(half).join(":")];
}

/** Bare LAN hosts carry the port; full-URL (tunnel) entries already do. */
function displayAddr(addr: string, port: number): string {
  return /^https?:\/\//i.test(addr) ? addr : `${addr}:${port}`;
}

function IdentityMono({ label, lines }: { label: string; lines: string[] }) {
  return (
    <View style={styles.identityRow}>
      <TypeMicro>{label}</TypeMicro>
      {lines.map((line, i) => (
        <TypeMono key={i} style={styles.identityMonoLine}>
          {line}
        </TypeMono>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  noHostPad: { padding: spacing.lg, gap: spacing.md, alignItems: "flex-start" },
  noHostIcon: {
    width: 56,
    height: 56,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  statusPad: { padding: spacing.lg },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  statusText: { flex: 1, gap: 2 },
  retryIconRow: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  identityPad: { padding: spacing.lg, gap: spacing.md },
  identityHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  identityIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  identityHeadText: { flex: 1, gap: 2 },
  identityRows: { borderTopWidth: StyleSheet.hairlineWidth, gap: spacing.md },
  identityRow: { gap: spacing.xs },
  identityMonoLine: { fontSize: 11, lineHeight: 16, opacity: 0.85 },
  diagPad: { padding: spacing.lg },
  diagRow: { gap: spacing.xs, paddingVertical: spacing.md },
  trailWrap: {
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  diagDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  trailScroll: { maxHeight: 132 },
  trailContent: { padding: spacing.sm, gap: 2 },
  trailLine: { fontSize: 11, lineHeight: 15 },
  dangerPad: { padding: spacing.lg, gap: spacing.md },
  dangerBody: { lineHeight: 20 },
});
