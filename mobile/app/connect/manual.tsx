/**
 * The manual entry page (R109: "it should lead to a new page where the user
 * can input the values manually or he can configure them as such") — the
 * full form: address (tunnel URL or host:port), the 8-digit PIN, the
 * optional certificate fingerprint (paste from the desktop), with live
 * tunnel/LAN detection and honest per-field validation. Submitting leads
 * to the confirm step — never straight to pairing.
 */

import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Globe, Network, ClipboardPaste } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  ClayCard,
  ClayInput,
  ChromeButton,
  TypeBody,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { selectionHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { parseManualEntry } from "@/link/pairing";
import { mobLog } from "@/lib/log";

export default function ManualEntryScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [certFP, setCertFP] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [fpError, setFpError] = useState<string | null>(null);

  const trimmedAddress = address.trim();
  const trimmedPin = pin.trim();
  const trimmedFp = certFP.trim();

  // The live shape hint — what the address parses AS, as the user types.
  const shape = useMemo(() => {
    if (trimmedAddress === "") return null;
    // The cloud relay's room form (v0.106.0): https://<relay>/m/<machineId> —
    // the path IS the address (it routes to the desktop's room).
    if (/^https:\/\/[^\/]+\/m\/[0-9a-fA-F]{64}\/?$/i.test(trimmedAddress)) {
      return { kind: "tunnel" as const, label: "cloud relay — reaches the desktop from any network" };
    }
    if (/^https:\/\//i.test(trimmedAddress)) {
      return { kind: "tunnel" as const, label: "tunnel URL — works from any network" };
    }
    if (/^http:\/\//i.test(trimmedAddress)) {
      return { kind: "bad" as const, label: "http is refused — the link rides TLS" };
    }
    if (/^[A-Za-z0-9\.\-\[\]:]+$/.test(trimmedAddress) && trimmedAddress.includes(":")) {
      return { kind: "lan" as const, label: "LAN address — same network as the desktop" };
    }
    if (trimmedAddress !== "" && !trimmedAddress.includes(":")) {
      return { kind: "bad" as const, label: "add the port — like 192.168.1.20:8443" };
    }
    return null;
  }, [trimmedAddress]);

  async function onPasteAddress() {
    try {
      const text = await Clipboard.getStringAsync();
      if (text.trim() !== "") {
        setAddress(text.trim());
        void selectionHaptic();
        mobLog("pair", "address pasted from clipboard");
      }
    } catch {
      // Clipboard is a convenience — a failure is quiet.
    }
  }

  function onSubmit() {
    setAddressError(null);
    setPinError(null);
    setFpError(null);
    const result = parseManualEntry({
      address: trimmedAddress,
      pin: trimmedPin,
      certFP: trimmedFp === "" ? undefined : trimmedFp,
    });
    if (!result.ok) {
      if (result.error.kind === "bad-pin") setPinError("the PIN is 8 digits");
      else if (result.error.kind === "bad-address")
        setAddressError("enter https://host:port (tunnel) or host:port (LAN)");
      else if (result.error.kind === "bad-certfp") setFpError("that fingerprint is not 64 hex characters");
      return;
    }
    void selectionHaptic();
    mobLog("pair", "manual entry validated", { kind: result.value.kind });
    router.push({
      pathname: "/connect/confirm",
      params: { source: "manual", payload: JSON.stringify(result.value) },
    });
  }

  const ShapeIcon =
    shape?.kind === "tunnel" ? Globe : shape?.kind === "lan" ? Network : null;

  return (
    <ScreenScaffold title="Manual entry" back noPill keyboardAware>
      <ClayCard elevated>
        <View style={styles.introPad}>
          <TypeBody style={styles.introTitle}>Enter the connection values</TypeBody>
          <TypeCaption style={styles.introBody}>
            The desktop shows its address and the one-time PIN under Settings → Link a device. A
            tunnel or cloud-relay URL (https://…) reaches it from any network; a LAN address
            (host:port) needs the same Wi-Fi.
          </TypeCaption>
        </View>
      </ClayCard>

      <View style={styles.form}>
        <View>
          <ClayInput
            label="Address or tunnel URL"
            mono
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="192.168.1.20:8443  ·  https://acute.example.com"
            value={address}
            onChangeText={setAddress}
            style={styles.monoInput}
          />
          <View style={styles.addressMetaRow}>
            {shape !== null && ShapeIcon !== null ? (
              <View style={styles.shapeRow}>
                <ShapeIcon size={14} color={tokens.textTertiary} strokeWidth={2.2} />
                <TypeMicro>{shape.label}</TypeMicro>
              </View>
            ) : shape?.kind === "bad" ? (
              <TypeMicro style={{ color: tokens.warning }}>{shape.label}</TypeMicro>
            ) : null}
            <View style={styles.spacer} />
            <View style={styles.pasteWrap}>
              <ChromeButton sheen={false} onPress={() => void onPasteAddress()} style={styles.pasteBtn}>
                <View style={styles.pasteRow}>
                  <ClipboardPaste size={14} color={tokens.accentText} strokeWidth={2.2} />
                  <TypeMicro style={{ color: tokens.accentText }}>paste</TypeMicro>
                </View>
              </ChromeButton>
            </View>
          </View>
          {addressError !== null ? (
            <TypeCaption style={{ color: tokens.danger }}>{addressError}</TypeCaption>
          ) : null}
        </View>

        <View>
          <ClayInput
            label="Pairing PIN"
            mono
            keyboardType="number-pad"
            maxLength={8}
            placeholder="8 digits"
            value={pin}
            onChangeText={setPin}
          />
          <TypeCaption style={styles.pinHint}>
            Valid for 120 seconds — generate a fresh one on the desktop if it expired.
          </TypeCaption>
          {pinError !== null ? (
            <TypeCaption style={{ color: tokens.danger }}>{pinError}</TypeCaption>
          ) : null}
        </View>

        <View>
          <ClayInput
            label="Certificate fingerprint — optional"
            mono
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="AA:BB:CC:… (64 hex, from the desktop's Devices tab)"
            value={certFP}
            onChangeText={setCertFP}
            style={styles.monoInput}
          />
          <TypeCaption style={styles.fpHint}>
            Pairing without it trusts the host's certificate on first use (the QR path pins it
            automatically). Typing it makes a LAN pairing exactly as strong.
          </TypeCaption>
          {fpError !== null ? (
            <TypeCaption style={{ color: tokens.danger }}>{fpError}</TypeCaption>
          ) : null}
        </View>
      </View>

      <ChromeButton
        onPress={onSubmit}
        disabled={trimmedPin === "" || trimmedAddress === ""}
        busy={false}
      >
        Continue
      </ChromeButton>

      <TypeCaption style={styles.footNote}>
        Leaving the address empty with just the PIN re-pairs the desktop you already linked.
      </TypeCaption>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  introPad: { padding: spacing.lg, gap: spacing.md },
  introTitle: { fontSize: 17 },
  introBody: { lineHeight: 19 },
  form: { gap: spacing.lg },
  monoInput: { fontSize: 13.5 },
  addressMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
    minHeight: 30,
  },
  shapeRow: { flexDirection: "row", gap: 5, alignItems: "center" },
  spacer: { flex: 1 },
  pasteWrap: {},
  pasteBtn: { minHeight: 32, paddingHorizontal: spacing.md, paddingVertical: 6 },
  pasteRow: { flexDirection: "row", gap: 5, alignItems: "center" },
  pinHint: { marginTop: -6 },
  fpHint: { marginTop: -6, lineHeight: 17 },
  footNote: { textAlign: "center", lineHeight: 17 },
});
