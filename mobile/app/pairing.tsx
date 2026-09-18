/**
 * Pairing — the front door of the link: camera QR scan (the desktop's
 * Devices → "Pair a device" QR) with a custom corner-bracket overlay, the
 * manual fallback (a full https URL for the tunnel path, or host:port), a
 * post-scan confirmation card (host identity, the fingerprint being
 * pinned), and the honest ladder of failure states (wrong pin + attempts
 * left, window closed, unreachable, certificate mismatch).
 *
 * On success the pairing is persisted and the manager adopts it — the
 * router lands on Home with a live host card.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Badge, Hairline, PressableCard, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_CARD, spacing, TYPE_BODY } from "@/design/tokens";
import {
  parsePairingPayload,
  parseManualEntry,
  type ManualTarget,
  type PairingPayload,
} from "@/link/pairing";
import {
  candidateFromQr,
  candidateFromManual,
  pairWithHost,
  type PairFailure,
} from "@/link/pair-flow";
import { acuteNetTransport } from "@/link/native-transport";
import { getLinkManager } from "@/link/runtime";
import { hostStore } from "@/link/host-store";

type PairingInput = PairingPayload | ManualTarget;

type Phase =
  | { kind: "scan" }
  | { kind: "confirm"; input: PairingInput }
  | { kind: "pairing" }
  | { kind: "error"; failure: PairFailure; input: PairingInput };

/** The QR payload has no `kind` field; manual targets are discriminated by it. */
function isManualTarget(input: PairingInput): input is ManualTarget {
  return (input as ManualTarget).kind !== undefined;
}

export default function PairingScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: "scan" });
  const [manualAddress, setManualAddress] = useState("");
  const [manualPin, setManualPin] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    locked.current = false; // a new render of the scan phase re-arms scanning
  }, [phase.kind]);

  function onScanned(payloadText: string) {
    if (locked.current) return;
    const result = parsePairingPayload(payloadText);
    if (!result.ok) {
      setManualError("scanned code is not an ACUTE pairing QR — scan the desktop's Devices QR");
      return;
    }
    locked.current = true;
    setManualError(null);
    setPhase({ kind: "confirm", input: result.value });
  }

  function onManualSubmit() {
    setManualError(null);
    const result = parseManualEntry({
      address: manualAddress.trim(),
      pin: manualPin.trim(),
    });
    if (!result.ok) {
      setManualError(
        result.error.kind === "bad-pin"
          ? "the PIN is 8 digits"
          : result.error.kind === "bad-address"
            ? "enter https://host:port (tunnel) or host:port (LAN)"
            : "that fingerprint is not 64 hex characters",
      );
      return;
    }
    setPhase({ kind: "confirm", input: result.value });
  }

  async function onPair(input: PairingInput) {
    setPhase({ kind: "pairing" });
    const candidate = isManualTarget(input) ? candidateFromManual(input) : candidateFromQr(input);
    const result = await pairWithHost(candidate, {
      net: acuteNetTransport,
      store: hostStore,
      label: Device.modelName ?? Device.deviceName ?? "Android device",
    });
    if (result.ok) {
      getLinkManager().adoptPairedHost(result.value);
      router.replace("/home");
      return;
    }
    setPhase({ kind: "error", failure: result.error, input });
  }

  const cameraDenied = permission !== null && !permission.granted;

  return (
    <ScreenScaffold title="Link a device" back={false}>
      {phase.kind === "confirm" ? (
        <ConfirmCard input={phase.input} onPair={() => void onPair(phase.input)} />
      ) : phase.kind === "pairing" ? (
        <View style={styles.centerCol}>
          <ActivityIndicator color={tokens.accent} />
          <TypeBody style={{ color: tokens.textSecondary, marginTop: spacing.md }}>
            linking to the host…
          </TypeBody>
        </View>
      ) : (
        <View style={{ gap: spacing.lg }}>
          <TypeBody style={{ color: tokens.textSecondary }}>
            On the desktop: Settings → Devices → "Pair a device", then scan
            the QR code it shows.
          </TypeBody>

          {permission !== null && permission.granted ? (
            <View style={styles.cameraWrap}>
              <CameraView
                style={styles.camera}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => onScanned(data)}
              />
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                <View style={[styles.bracket, styles.tl, { borderColor: tokens.accent }]} />
                <View style={[styles.bracket, styles.tr, { borderColor: tokens.accent }]} />
                <View style={[styles.bracket, styles.bl, { borderColor: tokens.accent }]} />
                <View style={[styles.bracket, styles.br, { borderColor: tokens.accent }]} />
              </View>
            </View>
          ) : cameraDenied && !permission.canAskAgain ? (
            <PressableCard disabled>
              <TypeBody style={{ color: tokens.textTertiary, textAlign: "center" }}>
                camera unavailable — use the manual entry below
              </TypeBody>
            </PressableCard>
          ) : (
            <PressableCard
              accessibilityLabel="Grant camera access"
              onPress={() => void requestPermission()}
            >
              <TypeBody style={{ color: tokens.text, textAlign: "center" }}>
                Grant camera access to scan
              </TypeBody>
            </PressableCard>
          )}

          {phase.kind === "error" && <FailureCard failure={phase.failure} />}
          {manualError !== null && (
            <TypeCaption style={{ color: tokens.danger }}>{manualError}</TypeCaption>
          )}

          <Hairline />

          <TypeCaption style={{ color: tokens.textTertiary, letterSpacing: 0.4 }}>
            MANUAL — ALSO WORKS FROM ANYWHERE
          </TypeCaption>
          <TextInput
            accessibilityLabel="Desktop address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://your-tunnel.example.com  or  192.168.1.42"
            placeholderTextColor={tokens.textTertiary}
            value={manualAddress}
            onChangeText={setManualAddress}
            style={[
              styles.input,
              {
                color: tokens.text,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
              },
            ]}
          />
          <TextInput
            accessibilityLabel="Pairing PIN"
            autoCorrect={false}
            keyboardType="number-pad"
            maxLength={8}
            placeholder="8-digit PIN"
            placeholderTextColor={tokens.textTertiary}
            value={manualPin}
            onChangeText={setManualPin}
            style={[
              styles.input,
              {
                color: tokens.text,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
              },
            ]}
          />
          <PressableCard
            accessibilityLabel="Pair with the entered address"
            disabled={manualAddress.trim() === "" || manualPin.trim() === ""}
            onPress={onManualSubmit}
          >
            <TypeBody style={{ color: tokens.text, textAlign: "center", fontWeight: "600" }}>
              Pair
            </TypeBody>
          </PressableCard>
        </View>
      )}
    </ScreenScaffold>
  );
}

function ConfirmCard({ input, onPair }: { input: PairingInput; onPair: () => void }) {
  const { tokens } = useTheme();
  const line = isManualTarget(input)
    ? input.kind === "tunnel"
      ? input.url
      : input.kind === "lan"
        ? `${input.host}:${input.port}`
        : "the saved host"
    : `${input.addrs[0]}:${input.port}`;
  const fp = isManualTarget(input)
    ? input.kind === "lan"
      ? input.certFP
      : null
    : input.certFP;
  const pin = isManualTarget(input) ? input.pin : input.pin;

  return (
    <View style={{ gap: spacing.lg }}>
      <TypeBody style={{ color: tokens.textSecondary }}>
        Confirm the host before pairing — the certificate fingerprint below
        is what this phone will trust from now on.
      </TypeBody>
      <View
        style={[
          styles.confirmCard,
          { backgroundColor: tokens.card, borderColor: tokens.border },
        ]}
      >
        <TypeBody style={{ color: tokens.text, fontWeight: "600" }}>ACUTE desktop</TypeBody>
        <TypeMono style={{ color: tokens.textSecondary }}>{line}</TypeMono>
        {fp !== null && (
          <TypeMono style={{ color: tokens.textTertiary, fontSize: 10 }}>
            {`pin  ${fp.slice(0, 23)}…\n      …${fp.slice(-8)}`}
          </TypeMono>
        )}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            marginTop: spacing.xs,
          }}
        >
          <Badge tone="accent">{pin}</Badge>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            {isManualTarget(input) ? "typed PIN" : "from the QR — valid for its window"}
          </TypeCaption>
        </View>
      </View>
      <PressableCard
        accessibilityLabel="Pair with this host"
        onPress={onPair}
      >
        <TypeBody style={{ color: tokens.accent, textAlign: "center", fontWeight: "600" }}>
          Pair with this host
        </TypeBody>
      </PressableCard>
    </View>
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
    <View style={{ gap: spacing.xs }}>
      <Badge tone={tone}>{failure.kind}</Badge>
      <TypeCaption style={{ color: tokens.textSecondary }}>{hint}</TypeCaption>
    </View>
  );
}

const styles = StyleSheet.create({
  cameraWrap: {
    alignSelf: "stretch",
    aspectRatio: 1,
    borderRadius: RADIUS_CARD,
    overflow: "hidden",
  },
  camera: { flex: 1 },
  bracket: {
    position: "absolute",
    width: 34,
    height: 34,
    borderWidth: 2.5,
  },
  tl: { top: 18, left: 18, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 8 },
  tr: { top: 18, right: 18, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 8 },
  bl: { bottom: 18, left: 18, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 8 },
  br: { bottom: 18, right: 18, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 8 },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: TYPE_BODY,
    fontFamily: "monospace",
  },
  confirmCard: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  centerCol: { alignItems: "center", paddingTop: spacing.xl, gap: spacing.sm },
});
