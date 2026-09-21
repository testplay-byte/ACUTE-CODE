/**
 * The confirm + pair step — the one screen that actually PAIRS. It receives
 * the candidate from the scanner (a QR payload) or the manual page (a
 * manual target) as JSON params.
 *
 * R115-D — onboarding.md's "Confirm the host" (Archetype 3, highlight
 * discipline): each datum its OWN tier — ADDRESS (mono body + one
 * tunnel/LAN caption), PAIRING PIN (big grouped 4+4 mono), the VALID-FOR
 * chip (prominent, warning tint under 30s, one calm scale pulse per tick),
 * and the certificate micro line (the fingerprint collapsed behind a
 * disclosure). The "PIN window is 120 seconds" footnote is DELETED.
 *
 * Countdown hits 0 → the actions area is REPLACED by the warning state card
 * ("The window closed — rescan the QR code") — never a dead Pair button.
 *
 * R116-D — the identity card grows a HOST NAME tier at the top when the QR
 * carried the desktop's machineLabel (verdict #14: "Confirm-host should
 * show the PC's name" — pairing.ts carries it additively now); and the
 * FailureCard renders pair-flow's honest manual-LAN TLS guidance (§1.1)
 * instead of the mismatch wording for that one case.
 *
 * On Pair: the FULL-SCREEN pairing moment (motion.md §4.4) — the content
 * crossfades out (150ms), two clay chips (desktop + phone) spring together
 * and merge, the desktop's word-pair name types in (TypeTitle), ~1.4s,
 * successHaptic at the merge — then the pairing ladder (validate → probe →
 * claim → store) proceeds exactly as before: success adopts the host and
 * lands on home; failure springs the overlay back out and renders the
 * honest FailureCard.
 */

import * as Device from "expo-device";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { CircleAlert, Monitor, Smartphone } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Disclosure } from "@/components/disclosure";
import {
  Badge,
  ClayCard,
  ChromeButton,
  FadeInUp,
  QuietButton,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import {
  RADIUS_CARD,
  RADIUS_CHIP,
  RADIUS_PILL,
  RADIUS_TILE,
  TILE_HERO,
  TILE_OPTION,
  TYPE_BODY,
  TYPE_MICRO,
  TYPE_PIN_DISPLAY,
  fontFamily,
  mixHex,
  spacing,
} from "@/design/tokens";
import { PAIRING_FADE_MS, PAIRING_MERGE_MS, SPRING } from "@/design/motion";
import { acuteNetTransport } from "@/link/native-transport";
import { hostStore } from "@/link/host-store";
import {
  candidateFromManual,
  candidateFromQr,
  MANUAL_TLS_GUIDANCE,
  pairWithHost,
  type PairFailure,
} from "@/link/pair-flow";
import type { ManualTarget, PairingPayload } from "@/link/pairing";
import { formatCertFP, formatPin, shortCertFP } from "@/link/pairing";
import { getLinkManager } from "@/link/runtime";
import { mobLog, mobWarn } from "@/lib/log";

type Phase = { kind: "confirm" } | { kind: "pairing" } | { kind: "error"; failure: PairFailure };

/** The countdown's urgency threshold — the chip tints warning under 30s. */
const URGENT_SECONDS = 30;

// The pairing moment's choreography (all derived from PAIRING_MERGE_MS):
const MEET_DELAY_MS = PAIRING_FADE_MS; // the chips move once the content is gone
const TYPE_DELAY_MS = PAIRING_MERGE_MS / 2; // the name starts typing at the merge
const TYPE_MS = PAIRING_MERGE_MS * 0.4; // …and finishes ≈1.26s in (~1.4s total)
const EXIT_MS = 300; // the failure spring-back-out

export default function ConfirmScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; payload?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pairingExit, setPairingExit] = useState(false);
  const [fpOpen, setFpOpen] = useState(false);
  const reduced = useReducedMotion();

  // R110 #6: the QR window's honest countdown — a 1s tick while the screen
  // is mounted (the parsed expiresAt drives it; manual entries have no
  // window — the desktop's own countdown is the truth there).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // The candidate + the QR's window expiry + the desktop's word-pair name —
  // parsed ONCE from the params (honest fallback: back to the hub when the
  // params are missing or corrupt). machineLabel rides the payload
  // additively (R115-E); pre-R115 payloads render "the desktop".
  const parsed = useMemo(() => {
    const raw = typeof params.payload === "string" ? params.payload : "";
    if (raw === "") return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (params.source === "manual") {
        return {
          candidate: candidateFromManual(value as ManualTarget),
          expiresAt: null as number | null,
          machineLabel: null as string | null,
        };
      }
      const payload = value as PairingPayload;
      const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : null;
      const labelSource = (value as { machineLabel?: unknown }).machineLabel;
      const machineLabel =
        typeof labelSource === "string" && labelSource.trim() !== "" ? labelSource.trim() : null;
      return { candidate: candidateFromQr(payload), expiresAt, machineLabel };
    } catch {
      return null;
    }
  }, [params.source, params.payload]);

  // ── the pairing moment's bridge: the stage reports "merged", the ladder
  //    waits for it so navigation always lands AFTER the full moment ──
  const mergedRef = useRef(false);
  const mergeResolveRef = useRef<(() => void) | null>(null);
  const failureRef = useRef<PairFailure | null>(null);

  function waitForMerge(): Promise<void> {
    if (mergedRef.current) return Promise.resolve();
    return new Promise((resolve) => {
      mergeResolveRef.current = resolve;
      // Safety valve: a lost animation (or a stage that never mounts) must
      // never deadlock the pairing ladder behind the moment.
      setTimeout(resolve, PAIRING_MERGE_MS + 800);
    });
  }

  const handleMeet = useCallback(() => {
    // The merge moment itself — motion.md §4.4's single successHaptic.
    void successHaptic();
  }, []);
  const handleMerged = useCallback(() => {
    mergedRef.current = true;
    mergeResolveRef.current?.();
    mergeResolveRef.current = null;
  }, []);
  const handleStageExited = useCallback(() => {
    const failure = failureRef.current;
    if (failure !== null) setPhase({ kind: "error", failure });
  }, []);

  // The content crossfades out when the pairing moment takes over (150ms)
  // and back in when it exits. (Declared before the params fallback return
  // — hooks run unconditionally.)
  const contentOpacity = useSharedValue(1);
  useEffect(() => {
    const hidden = phase.kind === "pairing";
    if (reduced) {
      contentOpacity.value = hidden ? 0 : 1;
      return;
    }
    contentOpacity.value = withTiming(hidden ? 0 : 1, { duration: PAIRING_FADE_MS });
  }, [phase.kind, reduced, contentOpacity]);
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentOpacity.value }));

  if (parsed === null) {
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

  const { candidate, expiresAt, machineLabel } = parsed;
  const secondsLeft =
    expiresAt !== null ? Math.max(0, Math.ceil((expiresAt - nowMs) / 1_000)) : null;
  const expired = secondsLeft === 0;

  async function onPair() {
    // Reset the moment's bookkeeping (a retry after failure re-runs it all).
    mergedRef.current = false;
    failureRef.current = null;
    setPairingExit(false);
    setPhase({ kind: "pairing" });
    mobLog("pair", "pairing started", { kind: candidate.kind });
    const ladder = pairWithHost(candidate, {
      net: acuteNetTransport,
      store: hostStore,
      label: Device.modelName ?? Device.deviceName ?? "Android device",
    });
    await waitForMerge();
    const result = await ladder;
    if (result.ok) {
      mobLog("pair", "pairing succeeded", { host: result.value.host.hostLabel });
      getLinkManager().adoptPairedHost(result.value);
      router.replace("/");
      return;
    }
    void warningHaptic();
    mobWarn("pair", "pairing failed", { kind: result.error.kind, message: result.error.message });
    failureRef.current = result.error;
    setPairingExit(true); // the stage springs back out → the FailureCard renders
  }

  const pin = candidate.pin;
  const addrs = candidate.addrs;
  const certFP = candidate.certFP;

  return (
    <>
      <ScreenScaffold title="Confirm the host" back noPill>
        <Animated.View
          style={[styles.content, contentStyle]}
          pointerEvents={phase.kind === "pairing" ? "none" : "auto"}
        >
          <FadeInUp index={0}>
            <ClayCard elevated>
              <View style={styles.identityPad}>
                {/* HOST NAME — its own tier, at the TOP (R116-D, verdict #14):
                    the desktop's word-pair name rides the QR payload
                    additively; manual pre-claims render nothing here. */}
                {machineLabel !== null ? (
                  <View style={styles.tier}>
                    <TypeMicro style={styles.tierLabel}>Desktop</TypeMicro>
                    <TypeBodyStrong numberOfLines={1} testID="confirm-host-name">
                      {machineLabel}
                    </TypeBodyStrong>
                  </View>
                ) : null}

                {/* ADDRESS — its own tier (divided under the host name) */}
                <View style={machineLabel !== null ? [styles.tier, styles.tierDivided] : styles.tier}>
                  <TypeMicro style={styles.tierLabel}>Address</TypeMicro>
                  <TypeMono numberOfLines={1} style={styles.addressMono}>
                    {addrs[0] ?? "the desktop"}
                  </TypeMono>
                  <TypeCaption>
                    {candidate.kind === "tunnel"
                      ? "Tunnel — works from any network"
                      : "LAN — same network as the desktop"}
                  </TypeCaption>
                </View>

                {/* PAIRING PIN — its own tier, the big grouped mono */}
                <View style={[styles.tier, styles.tierDivided]}>
                  <TypeMicro style={styles.tierLabel}>Pairing PIN</TypeMicro>
                  <TypeMono style={styles.pinDigits} numberOfLines={1} testID="pair-pin">
                    {formatPin(pin)}
                  </TypeMono>
                </View>

                {/* Valid-for chip — prominent, its own row (QR candidates) */}
                {secondsLeft !== null && secondsLeft > 0 ? (
                  <View style={[styles.tier, styles.tierDivided]}>
                    <ValidForChip seconds={secondsLeft} />
                  </View>
                ) : null}

                {/* Certificate — ONE micro line; the fp collapsed behind a
                    disclosure when the candidate carries one */}
                <View style={[styles.certLine, styles.tierDivided]}>
                  {certFP !== null ? (
                    <>
                      <TypeMicro>Certificate pinned on first contact</TypeMicro>
                      <Disclosure
                        open={fpOpen}
                        onToggle={() => setFpOpen((open) => !open)}
                        accessibilityLabel="Show the full certificate fingerprint"
                        testID="confirm-cert-disclosure"
                        label={<TypeMono>{shortCertFP(certFP)}</TypeMono>}
                      >
                        <TypeMono numberOfLines={2} style={styles.fpMono}>
                          {formatCertFP(certFP)}
                        </TypeMono>
                      </Disclosure>
                    </>
                  ) : (
                    <TypeMicro>Certificate trusted on first use (QR pins it)</TypeMicro>
                  )}
                </View>
              </View>
            </ClayCard>
          </FadeInUp>

          {phase.kind === "error" ? <FailureCard failure={phase.failure} /> : null}

          {expired ? (
            /* The window closed — the actions area is REPLACED (no dead
               Pair button on an expired window). */
            <FadeInUp index={1}>
              <ClayCard bordered>
                <View
                  style={[
                    styles.expiredPad,
                    { backgroundColor: mixHex(tokens.warning, tokens.card, 0.08) },
                  ]}
                >
                  <CircleAlert size={22} color={tokens.warning} strokeWidth={2.2} />
                  <TypeBodyStrong style={styles.expiredLine}>
                    The window closed — rescan the QR code
                  </TypeBodyStrong>
                  <QuietButton
                    onPress={() => router.replace("/connect/scan")}
                    testID="confirm-scan-again"
                  >
                    Scan again
                  </QuietButton>
                </View>
              </ClayCard>
            </FadeInUp>
          ) : (
            <FadeInUp index={1}>
              <View style={styles.actions}>
                <ChromeButton
                  flat
                  onPress={() => void onPair()}
                  disabled={phase.kind === "pairing"}
                  testID="confirm-pair"
                >
                  Pair with this host
                </ChromeButton>
                <QuietButton onPress={() => router.back()}>Not this one</QuietButton>
              </View>
            </FadeInUp>
          )}
        </Animated.View>
      </ScreenScaffold>

      {phase.kind === "pairing" ? (
        <PairingStage
          machineLabel={machineLabel}
          onMeet={handleMeet}
          onDone={handleMerged}
          exiting={pairingExit}
          onExited={handleStageExited}
        />
      ) : null}
    </>
  );
}

// ── the valid-for chip (countdown pressure, motion.md §3) ───────────────────

function ValidForChip({ seconds }: { seconds: number }) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const urgent = seconds < URGENT_SECONDS;

  useEffect(() => {
    if (!urgent || reduced) return;
    // One calm scale pulse per tick under 30s — never seizure flashing.
    scale.value = withSequence(withSpring(1.05, SPRING), withSpring(1, SPRING));
  }, [seconds, urgent, reduced, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const bg = urgent ? mixHex(tokens.warning, tokens.bg, 0.14) : tokens.pillBg;
  const border = urgent ? mixHex(tokens.warning, tokens.bg, 0.45) : tokens.border;
  const fg = urgent ? tokens.warning : tokens.textSecondary;

  return (
    <Animated.View
      accessibilityLabel={`Valid for ${seconds} seconds`}
      style={[styles.validChip, { backgroundColor: bg, borderColor: border }, style]}
    >
      <TypeMicro style={{ color: fg }}>Valid for {seconds}s</TypeMicro>
    </Animated.View>
  );
}

// ── the full-screen pairing moment (motion.md §4.4) ─────────────────────────

/** The merged pair's resting offsets (the chips overlap into one linked tile). */
const MERGE_DESK_X = -14;
const MERGE_DESK_Y = -8;
const MERGE_PHONE_X = 16;
const MERGE_PHONE_Y = 12;

function PairingStage({
  machineLabel,
  onMeet,
  onDone,
  exiting,
  onExited,
}: {
  machineLabel: string | null;
  onMeet: () => void;
  onDone: () => void;
  exiting: boolean;
  onExited: () => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const label = machineLabel ?? "the desktop";

  const meet = useSharedValue(0);
  const typeProgress = useSharedValue(0);
  const enter = useSharedValue(0);
  const exit = useSharedValue(1);
  const [typedCount, setTypedCount] = useState(0);
  const [waiting, setWaiting] = useState(false);

  // The parent's callbacks ride a ref — the mount choreography runs ONCE,
  // not per render identity.
  const cbRef = useRef({ onMeet, onDone, onExited });
  cbRef.current = { onMeet, onDone, onExited };
  const fireMeet = useCallback(() => cbRef.current.onMeet(), []);
  const fireDone = useCallback(() => {
    cbRef.current.onDone();
    setWaiting(true);
  }, []);
  const fireExited = useCallback(() => cbRef.current.onExited(), []);

  useEffect(() => {
    if (reduced) {
      meet.value = 1;
      typeProgress.value = 1;
      setTypedCount(label.length);
      setWaiting(true);
      fireMeet();
      fireDone();
      return;
    }
    // The chips spring together once the content has crossfaded out; the
    // spring's settle IS the merge moment (the successHaptic fires there).
    meet.value = withDelay(
      MEET_DELAY_MS,
      withSpring(1, SPRING, (finished) => {
        if (finished) runOnJS(fireMeet)();
      }),
    );
    // The word-pair name types in after the merge; the whole moment ≈ 1.4s.
    typeProgress.value = withDelay(
      TYPE_DELAY_MS,
      withTiming(1, { duration: TYPE_MS }, (finished) => {
        if (finished) runOnJS(fireDone)();
      }),
    );
  }, [reduced, label.length, meet, typeProgress, fireMeet, fireDone]);

  // The typewriter: the name reveals character-by-character on the UI thread.
  useAnimatedReaction(
    () => typeProgress.value,
    (value) => {
      "worklet";
      runOnJS(setTypedCount)(Math.round(value * label.length));
    },
    [label.length, typeProgress],
  );

  useEffect(() => {
    if (reduced) {
      enter.value = 1;
      return;
    }
    enter.value = withTiming(1, { duration: PAIRING_FADE_MS });
  }, [reduced, enter]);

  // Failure: the chips spring back out and the stage fades — THEN the
  // FailureCard renders (never a hard cut).
  useEffect(() => {
    if (!exiting) return;
    if (reduced) {
      fireExited();
      return;
    }
    meet.value = withSpring(0, SPRING);
    exit.value = withTiming(0, { duration: EXIT_MS }, (finished) => {
      if (finished) runOnJS(fireExited)();
    });
  }, [exiting, reduced, meet, exit, fireExited]);

  const stageStyle = useAnimatedStyle(() => ({ opacity: enter.value * exit.value }));
  const spread = width / 3;
  const deskStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(meet.value, [0, 1], [-spread, MERGE_DESK_X]) },
      { translateY: interpolate(meet.value, [0, 1], [0, MERGE_DESK_Y]) },
    ],
  }));
  const phoneStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(meet.value, [0, 1], [spread, MERGE_PHONE_X]) },
      { translateY: interpolate(meet.value, [0, 1], [0, MERGE_PHONE_Y]) },
    ],
  }));

  return (
    <SafeAreaView style={styles.stageRoot} edges={["top", "left", "right"]}>
      <Animated.View style={[styles.stageFill, { backgroundColor: tokens.bg }, stageStyle]}>
        <View style={styles.stageField}>
          <Animated.View
            style={[
              styles.chipDesktop,
              styles.chipBase,
              {
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
              deskStyle,
            ]}
          >
            <Monitor size={28} color={tokens.accent} strokeWidth={2.2} />
          </Animated.View>
          <Animated.View
            style={[
              styles.chipPhone,
              styles.chipBase,
              {
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                boxShadow: tokens.clayShadow2,
              },
              phoneStyle,
            ]}
          >
            <Smartphone size={20} color={tokens.accent} strokeWidth={2.2} />
          </Animated.View>
        </View>
        <View style={styles.stageLabel}>
          <TypeTitle numberOfLines={1} style={styles.stageName}>
            {label.slice(0, typedCount)}
          </TypeTitle>
          {waiting ? <WaitingDots /> : null}
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

/** The calm waiting idiom (motion.md §3) — three 6px dots, 1.2s pulse, 180ms
 *  stagger, while the pairing ladder probes the addresses. */
function WaitingDots() {
  const { tokens } = useTheme();
  return (
    <View style={styles.waitingRow} accessibilityLabel="Looking for the host">
      <WaitingDot index={0} color={tokens.accent} />
      <WaitingDot index={1} color={tokens.accent} />
      <WaitingDot index={2} color={tokens.accent} />
      <TypeCaption style={styles.waitingText}>Looking for the host…</TypeCaption>
    </View>
  );
}

function WaitingDot({ index, color }: { index: number; color: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    if (reduced) {
      opacity.value = 0.6;
      return;
    }
    // The initial 180ms × index delay phase-shifts the identical loops, so
    // the stagger persists for the whole wait.
    opacity.value = withDelay(
      index * 180,
      withRepeat(
        withSequence(withTiming(1, { duration: 600 }), withTiming(0.3, { duration: 600 })),
        -1,
        false,
      ),
    );
  }, [index, opacity, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.waitingDot, { backgroundColor: color }, style]} />;
}

// ── the failure card (one-line hints, copy.md) ──────────────────────────────

function FailureCard({ failure }: { failure: PairFailure }) {
  const { tokens } = useTheme();
  const tone = failure.kind === "tls" ? "danger" : "neutral";
  const hint =
    failure.kind === "wrong-pin"
      ? failure.message
      : failure.kind === "window-closed"
        ? "The window closed — rescan the QR code"
        : failure.kind === "tls"
          ? // R116-D (§1.1): a manual-LAN tls failure carries the honest TOFU
            // guidance from pair-flow — render it; every other tls failure
            // keeps the pinned mismatch wording.
            failure.message === MANUAL_TLS_GUIDANCE
            ? failure.message
            : "Certificate mismatch — re-pair from the desktop's QR"
          : failure.kind === "wrong-host"
            ? "A different machine answered — check the address"
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
  content: { gap: spacing.lg },
  identityPad: { padding: spacing.lg, gap: spacing.md },
  tier: { gap: spacing.xs },
  tierLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  tierDivided: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md },
  addressMono: { fontSize: TYPE_BODY, fontFamily: fontFamily.monoMedium, lineHeight: 22 },
  pinDigits: {
    fontSize: TYPE_PIN_DISPLAY,
    lineHeight: 32,
    fontFamily: fontFamily.monoMedium,
    letterSpacing: 1.5,
  },
  validChip: {
    alignSelf: "flex-start",
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  certLine: { gap: spacing.xs },
  fpMono: { fontSize: TYPE_MICRO, lineHeight: 16 },
  actions: { gap: spacing.md },
  expiredPad: {
    padding: spacing.xl,
    gap: spacing.md,
    alignItems: "center",
    borderRadius: RADIUS_CARD - 1,
  },
  expiredLine: { textAlign: "center" },
  errorPad: { padding: spacing.lg, gap: spacing.md },
  errorRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  // ── the full-screen pairing stage ──
  stageRoot: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  // The whole moment centers as one column: the chip field above, the typed
  // name (and the waiting dots) directly beneath the merged pair.
  stageFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xl },
  stageField: { width: "100%", height: TILE_HERO + spacing.xl },
  chipBase: {
    position: "absolute",
    left: "50%",
    top: "50%",
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  chipDesktop: {
    width: TILE_HERO,
    height: TILE_HERO,
    borderRadius: RADIUS_TILE,
    marginLeft: -TILE_HERO / 2,
    marginTop: -TILE_HERO / 2,
  },
  chipPhone: {
    width: TILE_OPTION,
    height: TILE_OPTION,
    borderRadius: RADIUS_CHIP,
    marginLeft: -TILE_OPTION / 2,
    marginTop: -TILE_OPTION / 2,
  },
  stageLabel: { alignItems: "center", gap: spacing.md },
  stageName: { textAlign: "center", maxWidth: 300 },
  waitingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  waitingDot: { width: 6, height: 6, borderRadius: 3 },
  waitingText: { marginTop: 0 },
});
