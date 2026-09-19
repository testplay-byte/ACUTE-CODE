/**
 * The confirm + pair step — the one screen that actually PAIRS. It receives
 * the candidate from the scanner (a QR payload) or the manual page (a
 * manual target) as JSON params, shows the host's identity for the final
 * look (addresses, PIN, the certificate fingerprint that will be pinned,
 * the machine id), then runs the pairing ladder:
 *
 *   validate → probe the address ladder → claim the PIN → store
 *
 * On success: the phone adopts the host, one success haptic, straight to
 * home. On failure: the typed ladder's honest error card + retry.
 */

import * as Device from "expo-device";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CircleAlert, FingerprintPattern, KeyRound, MonitorSmartphone } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Badge,
  ClayCard,
  ChromeButton,
  QuietButton,
  TypeBody,
  TypeCaption,
  TypeMono,
} from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { acuteNetTransport } from "@/link/native-transport";
import { hostStore } from "@/link/host-store";
import {
  candidateFromManual,
  candidateFromQr,
  pairWithHost,
  type PairFailure,
} from "@/link/pair-flow";
import type { ManualTarget, PairingPayload } from "@/link/pairing";
import { formatCertFP } from "@/link/pairing";
import { getLinkManager } from "@/link/runtime";
import { mobLog, mobWarn } from "@/lib/log";

type Phase = { kind: "confirm" } | { kind: "pairing" } | { kind: "error"; failure: PairFailure };

export default function ConfirmScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; payload?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });

  // The candidate — parsed ONCE from the params (honest fallback: back to
  // the hub when the params are missing or corrupt).
  const candidate = React.useMemo(() => {
    const raw = typeof params.payload === "string" ? params.payload : "";
    if (raw === "") return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (params.source === "manual") {
        return candidateFromManual(parsed as ManualTarget);
      }
      return candidateFromQr(parsed as PairingPayload);
    } catch {
      return null;
    }
  }, [params.source, params.payload]);

  if (candidate === null) {
    return (
      <ScreenScaffold title="Confirm" back noPill>
        <ClayCard bordered>
          <View style={styles.errorPad}>
            <CircleAlert size={20} color={tokens.warning} strokeWidth={2.2} />
            <TypeBody>That pairing request is no longer valid.</TypeBody>
            <QuietButton onPress={() => router.replace("/connect")}>Back to connect</QuietButton>
          </View>
        </ClayCard>
      </ScreenScaffold>
    );
  }

  async function onPair() {
    setPhase({ kind: "pairing" });
    mobLog("pair", "pairing started", { kind: candidate?.kind });
    const result = await pairWithHost(candidate!, {
      net: acuteNetTransport,
      store: hostStore,
      label: Device.modelName ?? Device.deviceName ?? "Android device",
    });
    if (result.ok) {
      void successHaptic();
      mobLog("pair", "pairing succeeded", { host: result.value.host.hostLabel });
      getLinkManager().adoptPairedHost(result.value);
      router.replace("/");
      return;
    }
    void warningHaptic();
    mobWarn("pair", "pairing failed", { kind: result.error.kind, message: result.error.message });
    setPhase({ kind: "error", failure: result.error });
  }

  const pin = candidate.pin;
  const addrs = candidate.addrs;
  const certFP = candidate.certFP;

  return (
    <ScreenScaffold title="Confirm the host" back noPill>
      <ClayCard elevated>
        <View style={styles.identityPad}>
          <View style={styles.identityRow}>
            <View style={[styles.identityIcon, { backgroundColor: tokens.subtleHover }]}>
              <MonitorSmartphone size={22} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <View style={styles.identityText}>
              <TypeBody>{addrs[0] ?? "the desktop"}</TypeBody>
              <TypeCaption>
                {candidate.kind === "tunnel"
                  ? "tunnel link — reachable from any network"
                  : `${addrs.length} address${addrs.length === 1 ? "" : "es"} · port ${candidate.port}`}
              </TypeCaption>
            </View>
            <Badge tone="accent">
              <View style={styles.pinRow}>
                <KeyRound size={11} color={tokens.accentText} strokeWidth={2.4} />
                {pin}
              </View>
            </Badge>
          </View>

          <View style={[styles.fpRow, { borderTopColor: tokens.borderSubtle }]}>
            <FingerprintPattern size={16} color={tokens.textTertiary} strokeWidth={2} />
            <View style={styles.fpText}>
              {certFP !== null ? (
                <>
                  <TypeCaption>this certificate gets pinned on first contact:</TypeCaption>
                  <TypeMono numberOfLines={2} style={styles.fpMono}>
                    {formatCertFP(certFP)}
                  </TypeMono>
                </>
              ) : (
                <TypeCaption>
                  no fingerprint provided — the host's certificate is trusted on first use (QR
                  pairing pins it automatically)
                </TypeCaption>
              )}
            </View>
          </View>
        </View>
      </ClayCard>

      {phase.kind === "error" ? <FailureCard failure={phase.failure} /> : null}

      {phase.kind === "pairing" ? (
        <ClayCard>
          <View style={styles.pairingPad}>
            <ActivityIndicator color={tokens.accent} />
            <TypeBody>linking to the host…</TypeBody>
            <TypeCaption>probing the addresses, then claiming the PIN</TypeCaption>
          </View>
        </ClayCard>
      ) : (
        <View style={styles.actions}>
          <ChromeButton onPress={() => void onPair()}>Pair with this host</ChromeButton>
          <QuietButton onPress={() => router.back()}>Not this one</QuietButton>
        </View>
      )}

      <TypeCaption style={styles.footNote}>
        The PIN window is 120 seconds. If it closes, the desktop can generate a fresh one without
        touching anything here.
      </TypeCaption>
    </ScreenScaffold>
  );
}

function FailureCard({ failure }: { failure: PairFailure }) {
  const { tokens } = useTheme();
  const tone = failure.kind === "tls" ? "danger" : "neutral";
  const hint =
    failure.kind === "wrong-pin"
      ? failure.attemptsRemaining !== undefined
        ? `${failure.message} · ${failure.attemptsRemaining} attempts left`
        : failure.message
      : failure.kind === "window-closed"
        ? "the 120-second window closed — generate a new PIN on the desktop and scan again"
        : failure.kind === "tls"
          ? "the certificate fingerprint does not match what was pinned — re-pair from the desktop's QR"
          : failure.kind === "wrong-host"
            ? "a different machine answered — check the address"
            : failure.message;
  return (
    <ClayCard bordered>
      <View style={styles.errorPad}>
        <View style={styles.errorRow}>
          <CircleAlert size={16} color={tokens.warning} strokeWidth={2.2} />
          <Badge tone={tone}>{failure.kind}</Badge>
        </View>
        <TypeCaption style={{ color: tokens.textSecondary }}>{hint}</TypeCaption>
      </View>
    </ClayCard>
  );
}

const styles = StyleSheet.create({
  identityPad: { padding: spacing.lg, gap: spacing.md },
  identityRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  identityIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  identityText: { flex: 1, gap: 2 },
  pinRow: { flexDirection: "row", gap: 4, alignItems: "center" },
  fpRow: {
    flexDirection: "row",
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    alignItems: "flex-start",
  },
  fpText: { flex: 1, gap: 2 },
  fpMono: { fontSize: 11.5, lineHeight: 16 },
  actions: { gap: spacing.md },
  pairingPad: { padding: spacing.xl, gap: spacing.md, alignItems: "center" },
  errorPad: { padding: spacing.lg, gap: spacing.md },
  errorRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  footNote: { textAlign: "center", lineHeight: 17 },
});
