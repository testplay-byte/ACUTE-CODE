/**
 * The connection details page (R116-f — the owner's verdict #23 redo).
 *
 * MULTI-PC SEAM (round-116 §4, item 24 — DEFERRED, no code): the phone
 * stores exactly ONE StoredHost today (host-store.ts) and the
 * ConnectionManager owns one link; pairing a second desktop REPLACES the
 * link. The deferred multi-host round lands `hosts: StoredHost[]` + an
 * ACTIVE-host switcher (device tokens already work multi-desktop
 * server-side — the desktop's device list already holds N devices). THIS
 * page's hero — the word-pair name + live status card below — is where the
 * switcher's surface plugs in: the hero already renders host.hostLabel +
 * the live status off the single useLink() snapshot, so widening the
 * snapshot to { hosts, activeHostId } keeps this grammar intact. The
 * connect hub's hero card carries the same seam (the switcher's primary
 * landing spot — see connect/index.tsx).
 *
 * Layout, top → bottom:
 *
 *   · THE HERO — the same grammar as the connect hub's host branch: the
 *     word-pair name PROMINENT (TypeTitle — not buried in an icon row),
 *     the pinned status vocabulary single-line ("Live" /
 *     "Looking for the host…" / "Offline") with the state dot, the honest
 *     last-seen + version micro line, and the manual retry (byte-identical
 *     behavior — only while the link isn't live).
 *   · THIS DESKTOP — the identity card: the machine id, the certificate
 *     fingerprint in its full two-line mono spelling (split at the colon
 *     boundary — kept), the address ladder + port, the relay, when it was
 *     paired. Every long mono value is single-line + ellipsized (the
 *     single-line law, donts #1/#31).
 *   · DIAGNOSTICS — the last failure message + this app's boot trail (the
 *     last 12 [ACUTE-BOOT] stages).
 *   · THE DANGER ZONE — its own visually-distinct region (verdict #38):
 *     extra top margin + a hairline divider + the card bordered in the
 *     danger tint at 30% over a subtle danger wash — the last resort, not
 *     another card in the stack. The disconnect copy is honest and ONE
 *     line; the desktop-revokes detail lives in the confirm alert (the
 *     desktop keeps its device row — revoking is a separate desktop-side
 *     act).
 */

import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { MonitorSmartphone, RefreshCw } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { timeAgo } from "@/components/host-card";
import {
  Badge,
  ClayCard,
  Hairline,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { fontFamily, mixHex, spacing } from "@/design/tokens";
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
            <TypeCaption numberOfLines={1}>Pair once — this phone remembers the link for months.</TypeCaption>
            <QuietButton onPress={() => router.push("/connect")}>Link a desktop</QuietButton>
          </View>
        </ClayCard>
      </ScreenScaffold>
    );
  }

  const certLines = host.certFP !== null ? splitCertFP(formatCertFP(host.certFP)) : null;

  // The hero's pinned status vocabulary (copy.md) — the same grammar as the
  // connect hub's host branch, the state dot carrying the semantic hue.
  const statusWord = connected ? "Live" : status === "probing" ? "Looking for the host…" : "Offline";
  const statusTone = connected
    ? tokens.success
    : status === "probing"
      ? tokens.warning
      : tokens.danger;

  return (
    <ScreenScaffold title="Connection" back>
      {/* ── the hero: the word-pair name prominent + the live status + the
          honest last-seen micro line (the retry behavior is byte-identical —
          one quiet icon button, only while the link isn't live). ── */}
      <ClayCard elevated>
        <View style={styles.heroPad}>
          <View style={styles.heroTop}>
            <TypeTitle numberOfLines={1} style={styles.heroName} testID="host-hero-name">
              {host.hostLabel}
            </TypeTitle>
            {!connected ? (
              <QuietButton onPress={() => getLinkManager().retryNow()}>
                <View style={styles.retryIconRow}>
                  <RefreshCw size={16} color={tokens.textSecondary} strokeWidth={2.2} />
                </View>
              </QuietButton>
            ) : null}
          </View>
          <View style={styles.heroStatus}>
            <StatusDot color={statusTone} pulse={status === "probing"} />
            <TypeBodyStrong numberOfLines={1}>{statusWord}</TypeBodyStrong>
          </View>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {`last seen ${lastSeen === null ? "never" : timeAgo(lastSeen)}${
              live !== null ? ` · desktop v${live.version}` : ""
            }`}
          </TypeMicro>
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
              <TypeMicro>MACHINE {shortMachineId(host.machineId)}</TypeMicro>
            </View>
            <Badge tone={connected ? "success" : "neutral"}>{connected ? "live" : status}</Badge>
          </View>

          <View style={[styles.identityRows, { borderTopColor: tokens.borderSubtle }]}>
            <IdentityMono label="MACHINE ID" lines={[host.machineId]} ellipsizeMode="middle" />
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
            {host.relay !== null ? <IdentityMono label="CLOUD RELAY (PROBED LAST)" lines={[host.relay]} /> : null}
            <View style={styles.identityRow}>
              <TypeMicro>PAIRED</TypeMicro>
              <TypeCaption numberOfLines={1}>{timeAgo(host.pairedAt)} ago</TypeCaption>
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
            <TypeCaption numberOfLines={1}>
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

      {/* ── the danger zone — its own region (verdict #38): extra top
          margin + a hairline divider + the danger-tinted border/wash, so it
          reads as the LAST RESORT, not another card in the stack. ── */}
      <View style={styles.dangerZone}>
        <Hairline />
        <SectionHeader>Danger zone</SectionHeader>
        <ClayCard
          bordered
          style={{
            borderWidth: 1,
            borderColor: mixHex(tokens.danger, tokens.card, 0.7),
            backgroundColor: mixHex(tokens.danger, tokens.card, 0.95),
          }}
        >
          <View style={styles.dangerPad}>
            <TypeBodyStrong style={[{ color: tokens.danger }]}>Disconnect this desktop</TypeBodyStrong>
            <TypeBody numberOfLines={1}>Clears this phone's saved link.</TypeBody>
            <QuietButton tone="danger" onPress={onDisconnect}>
              Disconnect this desktop
            </QuietButton>
          </View>
        </ClayCard>
      </View>
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

function IdentityMono({
  label,
  lines,
  ellipsizeMode = "tail",
}: {
  label: string;
  lines: string[];
  ellipsizeMode?: "head" | "middle" | "tail";
}) {
  const { tokens } = useTheme();
  return (
    <View style={styles.identityRow}>
      <TypeMicro>{label}</TypeMicro>
      {lines.map((line, i) => (
        // A raw Text carrying TypeMono's exact recipe (the primitive's prop
        // surface has no ellipsizeMode — the R116-b scaffold-title
        // precedent): one line per value, honest truncation for the long
        // machine truths (the cert fingerprint arrives pre-split — kept).
        <Text
          key={i}
          numberOfLines={1}
          ellipsizeMode={ellipsizeMode}
          style={[
            styles.identityMonoLine,
            { color: tokens.monoText, fontFamily: fontFamily.mono },
          ]}
        >
          {line}
        </Text>
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
  // The hero (R116-f): the word-pair name prominent + the pinned status
  // line + the last-seen micro line.
  heroPad: { padding: spacing.lg, gap: spacing.sm },
  heroTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  heroName: { flex: 1 },
  heroStatus: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
  // The danger zone's own region (R116-f, verdict #38): separated from the
  // card stack by extra top margin + the hairline divider; the card's own
  // danger tint lands inline (the theme's tokens drive it).
  dangerZone: { marginTop: spacing.xl, gap: spacing.md },
  dangerPad: { padding: spacing.lg, gap: spacing.md },
});
