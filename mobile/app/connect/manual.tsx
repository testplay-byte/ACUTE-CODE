/**
 * The manual entry page — Archetype 3 (the form), rebuilt per
 * onboarding.md's "Manual entry (the anti-pattern, fixed)" + the round-116
 * grammar (the ConnectHeader, the 4+4 PIN boxes, the auto-dismissing paste
 * note, the raised CTA):
 *
 *   [ConnectHeader: the chip back + the truly-centered "Manual entry"]
 *      "Enter the pairing values" (ONE line — no paragraph)
 *      [Paste] smart action — parses address + PIN (+cert) from the
 *              desktop's "Copy pairing text" clipboard payload; a failed
 *              paste is ONE animated line that dismisses itself (verdict #11)
 *      Address input (mono) + ONE-clause shape hint
 *      Pairing PIN — the 4+4 BOXES (PinBoxRow, verdict #12)
 *      [Certificate fingerprint — collapsed "optional" disclosure]
 *      "Continue" (the raised 56px CTA; disabled until address+PIN, busy
 *      while submitting)
 *
 * The validation + parse flow and the confirm-screen route params are
 * unchanged — submitting still leads to the confirm step, never straight
 * to pairing.
 */

import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { ClipboardPaste, Globe, Network } from "lucide-react-native";
import { ConnectHeader } from "@/components/connect-header";
import { PinBoxRow } from "@/components/pin-box-row";
import { Disclosure } from "@/components/disclosure";
import {
  ClayInput,
  ChromeButton,
  FadeInUp,
  PressableCard,
  TypeBodyStrong,
  TypeCaption,
  TypeHeading,
  TypeMicro,
} from "@/design/primitives";
import { selectionHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_BAR, RADIUS_CHIP, TILE_OPTION, spacing } from "@/design/tokens";
import { formatCertFP, parseManualEntry, parsePairingText } from "@/link/pairing";
import { mobLog } from "@/lib/log";

/** The paste note's slide/fade-in (round-116 verdict #11, ~180ms). */
const NOTE_ANIM_MS = 180;
/** The paste note's self-dismiss (ms) — the timer RESETS on every attempt. */
const NOTE_DISMISS_MS = 3000;

export default function ManualEntryScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [certFP, setCertFP] = useState("");
  const [certOpen, setCertOpen] = useState(false);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  /** Bumped on every paste ATTEMPT so the dismiss timer resets even when the
   *  failure line is the same string twice in a row. */
  const [noteSeq, setNoteSeq] = useState(0);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [fpError, setFpError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const noteAnim = useSharedValue(0);
  const reduced = useReducedMotion();

  // The busy state covers the navigation prep only — coming BACK from the
  // confirm step must never show a stuck busy button.
  useFocusEffect(
    useCallback(() => {
      setSubmitting(false);
    }, []),
  );

  // The auto-dismissing failure line (verdict #11): slides/fades in
  // (~180ms), clears itself after 3s — the timer RESETS per attempt (noteSeq
  // rides the deps so a repeat failure restarts the clock).
  useEffect(() => {
    if (pasteNote === null) return;
    noteAnim.value = reduced ? 1 : withTiming(1, { duration: NOTE_ANIM_MS });
    const t = setTimeout(() => setPasteNote(null), NOTE_DISMISS_MS);
    return () => clearTimeout(t);
  }, [pasteNote, noteSeq, reduced, noteAnim]);

  const noteStyle = useAnimatedStyle(() => ({
    opacity: noteAnim.value,
    transform: [{ translateY: (1 - noteAnim.value) * 3 }],
  }));

  const trimmedAddress = address.trim();
  const trimmedPin = pin.trim();
  const trimmedFp = certFP.trim();

  // The live shape hint — ONE clause each (the tunnel/LAN truth, shortened
  // from the old two-clause sentences per the copy law).
  const shape = useMemo(() => {
    if (trimmedAddress === "") return null;
    // The cloud relay's room form (v0.106.0): https://<relay>/m/<machineId> —
    // the path IS the address (it routes to the desktop's room).
    if (/^https:\/\/[^\/]+\/m\/[0-9a-fA-F]{64}\/?$/i.test(trimmedAddress)) {
      return { kind: "tunnel" as const, label: "Tunnel — works from any network" };
    }
    if (/^https:\/\//i.test(trimmedAddress)) {
      return { kind: "tunnel" as const, label: "Tunnel — works from any network" };
    }
    if (/^http:\/\//i.test(trimmedAddress)) {
      return { kind: "bad" as const, label: "http is refused" };
    }
    if (/^[A-Za-z0-9\.\-\[\]:]+$/.test(trimmedAddress) && trimmedAddress.includes(":")) {
      return { kind: "lan" as const, label: "LAN — same network as the desktop" };
    }
    if (!trimmedAddress.includes(":")) {
      return { kind: "bad" as const, label: "Add the port — like 192.168.1.20:8443" };
    }
    return null;
  }, [trimmedAddress]);

  // Smart paste: one tap reads the clipboard and fills the form from the
  // desktop's "Copy pairing text" payload (parsePairingText also accepts the
  // loose human formats). Invalid → ONE honest animated line, never a red card.
  async function onSmartPaste() {
    let text = "";
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      text = "";
    }
    const values = parsePairingText(text);
    if (values === null) {
      showPasteNote("No pairing values found on the clipboard.");
      void warningHaptic();
      return;
    }
    setPasteNote(null);
    setAddress(values.address);
    setPin(values.pin);
    if (values.certFP !== undefined) {
      setCertFP(formatCertFP(values.certFP));
      setCertOpen(true);
    }
    void selectionHaptic();
    mobLog("pair", "pairing text pasted", {
      kind: values.address.toLowerCase().startsWith("https://") ? "tunnel" : "lan",
    });
  }

  function showPasteNote(line: string) {
    // Reset BEFORE the node mounts so the entrance always starts from 0.
    noteAnim.value = 0;
    setPasteNote(line);
    setNoteSeq((n) => n + 1);
  }

  function onEditAddress(text: string) {
    setAddress(text);
    setPasteNote(null);
  }

  // The PIN boxes' contract: digits-only, capped at 8 (PinBoxRow already
  // emits the clean value — the handler stays defensive anyway).
  function onEditPin(text: string) {
    setPin(text.replace(/\D/g, "").slice(0, 8));
    setPasteNote(null);
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
    setSubmitting(true);
    router.push({
      pathname: "/connect/confirm",
      params: { source: "manual", payload: JSON.stringify(result.value) },
    });
  }

  const ShapeIcon = shape?.kind === "tunnel" ? Globe : shape?.kind === "lan" ? Network : null;
  const canSubmit = trimmedPin !== "" && trimmedAddress !== "";

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.headerWrap}>
        <ConnectHeader title="Manual entry" backTestID="manual-back" />
      </View>
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.xl },
        ]}
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: tokens.bg }}
      >
        <FadeInUp index={0}>
          <TypeHeading numberOfLines={1} style={styles.hero}>
            Enter the pairing values
          </TypeHeading>
        </FadeInUp>

        <FadeInUp index={1}>
          <PressableCard
            elevated
            onPress={() => void onSmartPaste()}
            accessibilityLabel="Paste pairing text"
            testID="manual-paste"
          >
            <View style={styles.pasteInner}>
              <View style={[styles.pasteChip, { backgroundColor: tokens.subtleHover }]}>
                <ClipboardPaste size={24} color={tokens.accent} strokeWidth={2.2} />
              </View>
              <View style={styles.pasteText}>
                <TypeBodyStrong numberOfLines={1}>Paste pairing text</TypeBodyStrong>
                {pasteNote !== null ? (
                  <Animated.View style={noteStyle} testID="manual-paste-note">
                    <TypeCaption numberOfLines={1} style={{ color: tokens.warning }}>
                      {pasteNote}
                    </TypeCaption>
                  </Animated.View>
                ) : null}
              </View>
            </View>
          </PressableCard>
        </FadeInUp>

        <View style={styles.form}>
          <FadeInUp index={2}>
            <View>
              <ClayInput
                label="Address or tunnel URL"
                mono
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.20:8443  ·  https://acute.example.com"
                value={address}
                onChangeText={onEditAddress}
                returnKeyType={canSubmit ? "go" : "next"}
                onSubmitEditing={canSubmit ? onSubmit : undefined}
                style={styles.monoInput}
              />
              {shape !== null ? (
                shape.kind === "bad" ? (
                  <TypeMicro style={[styles.shapeRow, { color: tokens.warning }]} numberOfLines={1}>
                    {shape.label}
                  </TypeMicro>
                ) : ShapeIcon !== null ? (
                  <View style={styles.shapeRow}>
                    <ShapeIcon size={14} color={tokens.textTertiary} strokeWidth={2.2} />
                    <TypeMicro numberOfLines={1}>{shape.label}</TypeMicro>
                  </View>
                ) : null
              ) : null}
              {addressError !== null ? (
                <TypeCaption numberOfLines={1} style={{ color: tokens.danger }}>
                  {addressError}
                </TypeCaption>
              ) : null}
            </View>
          </FadeInUp>

          <FadeInUp index={3}>
            <View>
              <PinBoxRow
                label="Pairing PIN"
                value={pin}
                onChangeText={onEditPin}
                onSubmitEditing={canSubmit ? onSubmit : undefined}
                testID="manual-pin"
              />
              {pinError !== null ? (
                <TypeCaption numberOfLines={1} style={[styles.pinError, { color: tokens.danger }]}>
                  {pinError}
                </TypeCaption>
              ) : null}
            </View>
          </FadeInUp>

          <FadeInUp index={4}>
            <Disclosure
              open={certOpen}
              onToggle={() => setCertOpen((open) => !open)}
              accessibilityLabel="Optional: certificate fingerprint"
              testID="manual-cert-disclosure"
              label={<TypeCaption style={{ color: tokens.textTertiary }}>Optional: certificate fingerprint</TypeCaption>}
            >
              <ClayInput
                mono
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="AA:BB:CC:… (64 hex, from the desktop's Devices tab)"
                value={certFP}
                onChangeText={setCertFP}
                returnKeyType={canSubmit ? "go" : "done"}
                onSubmitEditing={canSubmit ? onSubmit : undefined}
                style={styles.monoInput}
              />
              {fpError !== null ? (
                <TypeCaption numberOfLines={1} style={{ color: tokens.danger }}>
                  {fpError}
                </TypeCaption>
              ) : null}
            </Disclosure>
          </FadeInUp>
        </View>

        <FadeInUp index={5}>
          <ChromeButton
            flat
            onPress={onSubmit}
            disabled={!canSubmit}
            busy={submitting}
            style={styles.continue}
            testID="manual-continue"
          >
            Continue
          </ChromeButton>
        </FadeInUp>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  /** The fixed header band — aligned to the body gutter so the back chip
   *  lines up with the fields below it. */
  headerWrap: { paddingHorizontal: spacing.lg },
  body: { padding: spacing.lg, gap: spacing.lg },
  hero: { paddingTop: spacing.xs },
  pasteInner: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  pasteChip: {
    width: TILE_OPTION,
    height: TILE_OPTION,
    borderRadius: RADIUS_CHIP,
    alignItems: "center",
    justifyContent: "center",
  },
  pasteText: { flex: 1, gap: spacing.xs },
  form: { gap: spacing.xl },
  monoInput: { fontSize: 13.5 },
  pinError: { marginTop: spacing.xs },
  /** The raised CTA (the R116-c grammar): 56px at the bar radius. */
  continue: { minHeight: 56, borderRadius: RADIUS_BAR },
  shapeRow: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
    marginTop: spacing.xs,
    minHeight: 18,
  },
});
