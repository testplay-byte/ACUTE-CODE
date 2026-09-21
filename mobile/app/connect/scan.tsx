/**
 * The QR scanner — round-116's PORTRAIT MONOCHROME viewfinder (verdicts
 * #6-#9, screen-archetypes.md "The scanner" amendment):
 *
 *   [ConnectHeader: the chip back + the truly-centered "Scan QR code"]
 *      · "scanning" — the calm top strip: a breathing accent dot + word
 *      PORTRAIT viewfinder (width = screen − gutters, height = width × 4/3,
 *      clamped to the vertical budget) wearing the MONOCHROME TREATMENT —
 *      a ~35% black scrim + an edge vignette + white brackets + the
 *      traveling white scan line, every layer pointerEvents="none" (the
 *      native barcode decode reads the TRUE frames, never the styled view)
 *      [pinch to zoom — gestures only]
 *      "Choose a photo instead" / "Type the address + PIN instead" — the
 *      two proper fallback ROWS (verdict #7)
 *
 * The photo pipeline PAUSES the camera (verdict #8): the viewfinder becomes
 * the reading pane (the black ground + a skeleton block + "Reading the
 * image…" with breathing dots), then a RESULT CARD — success ("Pairing code
 * read", Check, the success tint) navigates after ~600ms; failure renders
 * the honest one-liner in the warning tint (the scanner's constitution:
 * quiet warnings, never red cards) and auto-dismisses after ~3s, when the
 * camera resumes. The LIVE camera's parse failures stay the ONE quiet
 * auto-clearing line. Permission states keep the honest fallback panel in
 * the portrait frame (the camera is never required).
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Defs, RadialGradient, Rect, Stop, Svg } from "react-native-svg";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Check, CircleAlert, Image as ImageIcon, Keyboard, ScanLine } from "lucide-react-native";
import { ConnectHeader } from "@/components/connect-header";
import {
  ChromeButton,
  ClayCard,
  PressableCard,
  QuietButton,
  Skeleton,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { mixHex, RADIUS_CARD, spacing } from "@/design/tokens";
import { SCAN_TRAVEL_MS } from "@/design/motion";
import { parsePairingPayload, type PairingParseError } from "@/link/pairing";
import { pickQrFromPhoto } from "@/features/qr-from-image";
import { mobLog, mobWarn } from "@/lib/log";

const ZOOM_MAX = 1;

/** The scan line's travel region inside the frame (ratios of frame height). */
const LINE_TOP_RATIO = 0.16;
const LINE_SPAN_RATIO = 0.68;

// ── the monochrome treatment (round-116 #9 — VISUAL ONLY) ───────────────────

/** The flat scrim leg: pure black at 35% over the live preview. */
const SCRIM_OPACITY = 0.35;
/** The vignette's edge strength: a transparent center ramping to #000 at
 *  0.55 opacity at the gradient's rim (the quiet edge-darkening). */
const VIGNETTE_EDGE_OPACITY = 0.55;
/** The vignette's rim radius, as a fraction of the frame's long side. */
const VIGNETTE_R_RATIO = 0.75;
/** The treatment's framing color — pure white brackets + scan line. */
const FRAME_WHITE = "#FFFFFF";
/** The reading pane's bone + caption tones — white on the sensor-black
 *  ground (mode-independent: the house subtle-hover is invisible on #000). */
const READING_BONE = "rgba(255,255,255,0.16)";
const READING_TEXT = "rgba(255,255,255,0.72)";

// ── the portrait geometry (round-116 #6) ────────────────────────────────────

/** The body's side gutters (both edges). */
const GUTTER = spacing.lg;
/** The vertical budget ABOVE the viewfinder: the 56px ConnectHeader row plus
 *  the breathing "scanning" strip and its margins. */
const TOP_BUDGET = 80;
/** The vertical budget BELOW the viewfinder: the notice slot + the option
 *  rows + their margins (the bottom inset is subtracted separately). */
const OPTIONS_BUDGET = 150;
/** The clamp's honest floor — a viewfinder never collapses to nothing. */
const FRAME_MIN_H = 120;

// ── the photo flow's timings (round-116 #8) ─────────────────────────────────

/** The success card's beat before the route — the card must be SEEN. */
const RESULT_NAVIGATE_MS = 600;
/** The failure card's auto-dismiss — then the camera resumes. */
const RESULT_DISMISS_MS = 3000;
/** The live strip's opacity breathe: 0.75 ↔ 1 over one ~1.6s loop. */
const LIVE_BREATHE_MIN = 0.75;
const LIVE_BREATHE_LEG_MS = 800;
/** The reading dots' stagger (ms). */
const DOT_STAGGER_MS = 180;

/** The photo pipeline's flow state — anything but "idle" suspends the camera. */
type PhotoFlow = "idle" | "processing" | "result-ok" | "result-fail";

/** The parse failure's honest one-liner — ONE vocabulary shared by the live
 *  notice line and the photo result card (the R115-D strings, verbatim). */
function parseFailureLine(kind: PairingParseError["kind"]): string {
  if (kind === "expired") return "that code expired — generate a fresh one on the desktop";
  if (kind === "bad-version") return "that code is from a different protocol version — update the desktop";
  if (kind === "bad-relay") return "that code carries an invalid relay address — update the desktop and scan again";
  return "that is not an ACUTE pairing code";
}

// The animated camera — the zoom rides a UI-thread shared value straight
// into the native prop (60fps pinch with zero JS-thread chatter).
const AnimatedCamera = Animated.createAnimatedComponent(CameraView);

export default function ScanScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestCamera] = useCameraPermissions();
  const [notice, setNotice] = useState<string | null>(null);
  const [photoFlow, setPhotoFlow] = useState<PhotoFlow>("idle");
  const [photoResult, setPhotoResult] = useState<string | null>(null);
  const lockedRef = useRef(false);
  const pickingRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoom = useSharedValue(0);
  const zoomBase = useSharedValue(0);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const granted = permission?.granted ?? false;

  // The PORTRAIT viewfinder (round-116 #6): width = the screen minus both
  // gutters, height = width × 4/3 — clamped to the vertical budget (header +
  // options + the bottom inset), deriving the width back from 3/4 when the
  // clamp bites.
  const availableH = windowHeight - TOP_BUDGET - OPTIONS_BUDGET - Math.max(insets.bottom, spacing.lg);
  let frameW = windowWidth - GUTTER * 2;
  let frameH = Math.round((frameW * 4) / 3);
  if (frameH > availableH) {
    frameH = Math.max(Math.round(availableH), FRAME_MIN_H);
    frameW = Math.round((frameH * 3) / 4);
  }

  const cameraProps = useAnimatedProps(() => ({ zoom: zoom.value }));

  // The pinch: relative to the gesture-start zoom, clamped 0–1. Gestures
  // only — no +/- steps, no multiplier label (donts.md #21).
  const pinch = Gesture.Pinch()
    .onBegin(() => {
      "worklet";
      zoomBase.value = zoom.value;
    })
    .onUpdate((event) => {
      "worklet";
      const next = zoomBase.value * event.scale;
      zoom.value = Math.min(Math.max(next, 0), ZOOM_MAX);
    });

  // One honest auto-clearing line — the LIVE path's only error surface.
  function showNotice(line: string, onClear?: () => void) {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice(line);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
      onClear?.();
    }, 2500);
  }

  // The photo flow's FAILURE surface: the result card in the paused
  // viewfinder, auto-dismissing after ~3s — then the camera resumes (and
  // the parse lock, when the failure was a parse, releases with it).
  function showPhotoFailure(line: string, onDismiss?: () => void) {
    if (flowTimer.current !== null) clearTimeout(flowTimer.current);
    setPhotoResult(line);
    setPhotoFlow("result-fail");
    flowTimer.current = setTimeout(() => {
      flowTimer.current = null;
      setPhotoFlow("idle");
      setPhotoResult(null);
      onDismiss?.();
    }, RESULT_DISMISS_MS);
  }

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
      if (flowTimer.current !== null) clearTimeout(flowTimer.current);
    };
  }, []);

  // The ONE parse + route path — the live camera and the photo pipeline feed
  // the exact same locked handler; `viaPhoto` only routes the SURFACE (the
  // live path keeps the quiet notice line, the photo path renders the result
  // card inside the paused viewfinder).
  function onScannedText(event: { data: string }, viaPhoto = false) {
    if (lockedRef.current) return;
    const result = parsePairingPayload(event.data);
    if (result.ok) {
      lockedRef.current = true;
      void successHaptic();
      mobLog("pair", "QR payload parsed", {
        addrs: result.value.addrs.length,
        port: result.value.port,
      });
      const candidate = JSON.stringify(result.value);
      if (!viaPhoto) {
        router.replace({
          pathname: "/connect/confirm",
          params: { source: "qr", payload: candidate },
        });
        return;
      }
      // viaPhoto: the success card is SEEN first (~600ms), then the route.
      if (flowTimer.current !== null) clearTimeout(flowTimer.current);
      setPhotoResult("Pairing code read");
      setPhotoFlow("result-ok");
      flowTimer.current = setTimeout(() => {
        flowTimer.current = null;
        router.replace({
          pathname: "/connect/confirm",
          params: { source: "qr", payload: candidate },
        });
      }, RESULT_NAVIGATE_MS);
      return;
    }
    // Not an ACUTE code — honest feedback, keep scanning (rate-limited by lock).
    lockedRef.current = true;
    void warningHaptic();
    const reason = parseFailureLine(result.error.kind);
    if (viaPhoto) {
      // The lock releases when the card dismisses and the camera resumes.
      showPhotoFailure(reason, () => {
        lockedRef.current = false;
      });
    } else {
      showNotice(reason, () => {
        lockedRef.current = false;
      });
    }
    mobWarn("pair", "QR parse failed", { kind: result.error.kind });
  }

  // "Choose a photo instead" (round-116 #8) — document picker → downscale →
  // decode → jsQR (features/qr-from-image.ts). Picking PAUSES the camera:
  // the viewfinder becomes the reading pane, then the result card; every
  // dead end is the card's honest one-liner, and a hit rides the exact same
  // locked path as the live camera.
  async function onPickPhoto() {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      if (flowTimer.current !== null) {
        clearTimeout(flowTimer.current);
        flowTimer.current = null;
      }
      setPhotoResult(null);
      setPhotoFlow("processing");
      const outcome = await pickQrFromPhoto();
      if (outcome.kind === "canceled") {
        setPhotoFlow("idle");
        return;
      }
      if (outcome.kind === "unsupported") {
        showPhotoFailure("Save the image as PNG or JPG and try again.");
        return;
      }
      if (outcome.kind === "no-code") {
        showPhotoFailure("No QR code found in that image.");
        return;
      }
      onScannedText({ data: outcome.text }, true);
    } catch (err) {
      mobWarn("pair", "photo QR decode failed", err instanceof Error ? err.message : String(err));
      showPhotoFailure("That image couldn't be read — try again.");
    } finally {
      pickingRef.current = false;
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.body}>
        <ConnectHeader title="Scan QR code" backTestID="scan-back" />
        {/* The live strip breathes only when the scanner is actually armed —
            never over a denied camera. */}
        {granted ? <LiveStrip /> : null}

        <View style={[styles.frame, { width: frameW, height: frameH }]}>
          {granted && photoFlow === "idle" ? (
            <GestureDetector gesture={pinch}>
              <Animated.View style={styles.cameraWrap}>
                <AnimatedCamera
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={onScannedText}
                  animatedProps={cameraProps}
                />
                {/* THE MONOCHROME TREATMENT (round-116 #9) — visual only:
                    every layer is pointerEvents="none", so the native barcode
                    decode always reads the TRUE camera frames. */}
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <View style={[StyleSheet.absoluteFill, styles.scrim]} />
                  <ScanVignette width={frameW} height={frameH} />
                  <ScanBrackets color={FRAME_WHITE} />
                </View>
              </Animated.View>
            </GestureDetector>
          ) : granted ? (
            photoFlow === "processing" ? (
              <ReadingPane />
            ) : (
              <PhotoResultCard ok={photoFlow === "result-ok"} line={photoResult ?? ""} />
            )
          ) : (
            <View style={styles.permissionWrap}>
              <PermissionPanel
                canAsk={permission?.canAskAgain ?? true}
                onRequest={async () => {
                  const result = await requestCamera();
                  mobLog("pair", "camera permission", { granted: result.granted });
                }}
                onManual={() => router.replace("/connect/manual")}
              />
            </View>
          )}
        </View>

        {/* The one-line notice slot — the LIVE path's only error surface; a
            fixed-height home so the quiet line never jumps the options (a
            long line wraps within it, exactly as before). */}
        <View style={styles.noticeSlot}>
          {notice !== null ? (
            <TypeCaption style={[styles.notice, { color: tokens.warning }]}>{notice}</TypeCaption>
          ) : null}
        </View>

        <View style={styles.spacer} />

        {/* The fallback rows (round-116 #7) — the photo row rides the
            picker; the manual row always shows. The footer keeps the
            safe-area bottom padding. */}
        <View style={[styles.options, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          {granted ? (
            <OptionRow
              icon={<ImageIcon size={20} color={tokens.accent} strokeWidth={2.2} />}
              label="Choose a photo instead"
              onPress={() => void onPickPhoto()}
              testID="scan-choose-photo"
            />
          ) : null}
          <OptionRow
            icon={<Keyboard size={20} color={tokens.accent} strokeWidth={2.2} />}
            label="Type the address + PIN instead"
            onPress={() => router.replace("/connect/manual")}
            testID="scan-type-instead"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

// ── the calm top strip (verdict #6: "add a top animation") ──────────────────

/** The breathing accent dot + the word "scanning" — one shared opacity
 *  (1.6s loop, 0.75↔1); reduced motion holds it static. */
function LiveStrip() {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const breathe = useSharedValue(LIVE_BREATHE_MIN);

  useEffect(() => {
    if (reduced) {
      breathe.value = 1;
      return;
    }
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: LIVE_BREATHE_LEG_MS }),
        withTiming(LIVE_BREATHE_MIN, { duration: LIVE_BREATHE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [breathe, reduced]);

  const style = useAnimatedStyle(() => ({ opacity: breathe.value }));
  return (
    <View style={styles.liveRow}>
      <Animated.View style={[styles.liveInner, style]} testID="scan-live">
        <View style={[styles.liveDot, { backgroundColor: tokens.accent }]} />
        <TypeMicro>scanning</TypeMicro>
      </Animated.View>
    </View>
  );
}

// ── the vignette (the monochrome treatment's edge leg) ──────────────────────

/** The vignette — a radial gradient rect (userSpaceOnUse, so the numbers are
 *  the frame's own pixels): transparent through the inner half, darkening to
 *  #000 ~0.55 at the rim, darkest in the corners. Purely visual; the wrapper
 *  is pointerEvents="none". */
function ScanVignette({ width, height }: { width: number; height: number }) {
  const r = Math.max(width, height) * VIGNETTE_R_RATIO;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg height={height} width={width}>
        <Defs>
          <RadialGradient
            cx={width / 2}
            cy={height / 2}
            gradientUnits="userSpaceOnUse"
            id="scan-vignette"
            r={r}
          >
            <Stop offset="0.5" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={VIGNETTE_EDGE_OPACITY} />
          </RadialGradient>
        </Defs>
        <Rect fill="url(#scan-vignette)" height={height} width={width} x={0} y={0} />
      </Svg>
    </View>
  );
}

// ── the paused viewfinder's reading pane (round-116 #8) ─────────────────────

/** The reading pane — the black scrim ground + ONE skeleton block + the
 *  "Reading the image…" caption with breathing dots. */
function ReadingPane() {
  return (
    <View style={styles.readingWrap}>
      <Skeleton style={styles.readingBone} />
      <View style={styles.readingCaption}>
        <BreathingDots />
        <TypeMicro style={styles.readingText}>Reading the image…</TypeMicro>
      </View>
    </View>
  );
}

/** Three breathing dots — 180ms stagger on a ~1.2s loop; reduced motion
 *  holds them static. */
function BreathingDots() {
  return (
    <View style={styles.dotsRow}>
      <BreathDot index={0} />
      <BreathDot index={1} />
      <BreathDot index={2} />
    </View>
  );
}

function BreathDot({ index }: { index: number }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    if (reduced) {
      opacity.value = 0.6;
      return;
    }
    opacity.value = withDelay(
      index * DOT_STAGGER_MS,
      withRepeat(
        withSequence(withTiming(1, { duration: 600 }), withTiming(0.35, { duration: 600 })),
        -1,
        false,
      ),
    );
  }, [index, opacity, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.breathDot, style]} />;
}

// ── the photo flow's result card (round-116 #8) ─────────────────────────────

/** The RESULT CARD, rendered in the paused viewfinder region. Success: the
 *  success tint + Check + "Pairing code read". Failure: the honest
 *  one-liner in the warning tint (never a red card — the scanner's own
 *  constitution) + CircleAlert. ONE line either way. */
function PhotoResultCard({ ok, line }: { ok: boolean; line: string }) {
  const { tokens } = useTheme();
  const hue = ok ? tokens.success : tokens.warning;
  return (
    <View style={styles.resultWrap}>
      <ClayCard elevated testID={ok ? "scan-result-ok" : "scan-result-fail"}>
        <View style={[styles.resultPad, { backgroundColor: mixHex(hue, tokens.card, 0.08) }]}>
          {ok ? (
            <Check size={22} color={tokens.success} strokeWidth={2.4} />
          ) : (
            <CircleAlert size={22} color={tokens.warning} strokeWidth={2.2} />
          )}
          <TypeBodyStrong numberOfLines={1}>{line}</TypeBodyStrong>
        </View>
      </ClayCard>
    </View>
  );
}

// ── the fallback rows (round-116 #7) ────────────────────────────────────────

/** One option row under the viewfinder — the compact 48px PressableCard row:
 *  a small icon chip + ONE single-line label (proper rows, not quiet stubs). */
function OptionRow({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const { tokens } = useTheme();
  return (
    <PressableCard accessibilityLabel={label} onPress={onPress} testID={testID}>
      <View style={styles.optionInner}>
        <View style={[styles.optionChip, { backgroundColor: tokens.subtleHover }]}>{icon}</View>
        <TypeBodyStrong numberOfLines={1} style={styles.optionLabel}>
          {label}
        </TypeBodyStrong>
      </View>
    </PressableCard>
  );
}

/** The animated corner brackets + the traveling scan line (R115-D: the line
 *  actually travels — translateY over the frame height, ~1.8s loop, its
 *  opacity fading to nothing at both ends so the loop wrap is invisible).
 *  R116-D: the color is the treatment's pure white, never the accent. */
function ScanBrackets({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);
  const travel = useSharedValue(0);
  const [frameH, setFrameH] = useState(0);

  useEffect(() => {
    if (reduced) {
      pulse.value = 0.5;
      travel.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(withTiming(1, { duration: 900 }), withTiming(0, { duration: 900 })),
      -1,
      false,
    );
    travel.value = withRepeat(withTiming(1, { duration: SCAN_TRAVEL_MS }), -1, false);
  }, [pulse, travel, reduced]);

  const bracketsStyle = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));
  const lineStyle = useAnimatedStyle(() => {
    const p = travel.value;
    const top = frameH * LINE_TOP_RATIO;
    const span = frameH * LINE_SPAN_RATIO;
    return {
      transform: [{ translateY: top + p * span }],
      opacity: reduced ? 0 : Math.sin(p * Math.PI) * 0.9,
    };
  });

  const size = 34;
  const arm = { width: size, height: size, borderColor: color, borderWidth: 2.5 } as const;
  return (
    <View
      style={styles.bracketFrame}
      onLayout={(event) => setFrameH(event.nativeEvent.layout.height)}
    >
      <Animated.View style={[styles.bracket, arm, styles.bracketTL, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketTR, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketBL, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketBR, bracketsStyle]} />
      <Animated.View style={[styles.scanLine, { backgroundColor: color }, lineStyle]} />
    </View>
  );
}

function PermissionPanel({
  canAsk,
  onRequest,
  onManual,
}: {
  canAsk: boolean;
  onRequest: () => Promise<void>;
  onManual: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <ClayCard elevated>
      <View style={styles.permissionInner}>
        <ScanLine size={28} color={tokens.accent} strokeWidth={2.2} />
        <TypeBody>{canAsk ? "Camera access needed" : "Camera blocked"}</TypeBody>
        <TypeCaption style={styles.permissionBody}>
          {canAsk
            ? "The scanner reads the desktop's pairing code through the camera."
            : "You can type the code instead."}
        </TypeCaption>
        {canAsk ? (
          <ChromeButton onPress={() => void onRequest()}>Grant camera access</ChromeButton>
        ) : null}
        <QuietButton onPress={onManual}>Enter the values manually</QuietButton>
      </View>
    </ClayCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, paddingHorizontal: GUTTER },
  frame: {
    borderRadius: RADIUS_CARD,
    alignSelf: "center",
    overflow: "hidden",
    // The camera's own ground — sensor black, not a palette surface.
    backgroundColor: "#000000",
  },
  cameraWrap: {
    flex: 1,
    borderRadius: RADIUS_CARD,
    overflow: "hidden",
    backgroundColor: "#000000",
  },
  /** The monochrome treatment's flat leg (visual only — see SCRIM_OPACITY). */
  scrim: { backgroundColor: "#000000", opacity: SCRIM_OPACITY },
  liveRow: {
    flexDirection: "row",
    justifyContent: "center",
    height: 16,
    marginTop: 4,
    marginBottom: 4,
  },
  liveInner: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5 },
  readingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
  },
  readingBone: { width: "62%", height: 12, borderRadius: 6, backgroundColor: READING_BONE },
  readingCaption: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  readingText: { color: READING_TEXT },
  dotsRow: { flexDirection: "row", gap: 4 },
  breathDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.9)" },
  resultWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.md },
  resultPad: { alignItems: "center", gap: spacing.md, padding: spacing.lg },
  optionInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  /** A 32px chip at the 48px chip's RADIUS_CHIP proportions (≈ its third). */
  optionChip: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  optionLabel: { flex: 1 },
  options: { gap: spacing.md },
  noticeSlot: { minHeight: 18, justifyContent: "center", marginTop: spacing.sm },
  notice: { textAlign: "center" },
  spacer: { flex: 1 },
  permissionWrap: { flex: 1, justifyContent: "center", padding: spacing.lg },
  permissionInner: { padding: spacing.xl, gap: spacing.md, alignItems: "center" },
  permissionBody: { textAlign: "center", lineHeight: 18 },
  bracketFrame: { flex: 1, alignItems: "center", justifyContent: "center" },
  bracket: { position: "absolute", width: 34, height: 34, borderWidth: 2.5 },
  bracketTL: { top: "12%", left: "12%", borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 10 },
  bracketTR: { top: "12%", right: "12%", borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 10 },
  bracketBL: { bottom: "12%", left: "12%", borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 10 },
  bracketBR: { bottom: "12%", right: "12%", borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 10 },
  scanLine: { position: "absolute", left: "16%", right: "16%", top: 0, height: 1.5 },
});
