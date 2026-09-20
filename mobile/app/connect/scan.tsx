/**
 * The QR scanner — onboarding.md's "QR scanner" pattern (R115-D):
 *
 *   [chevron header: "Scan QR code"]
 *      SQUARE viewfinder (fills width, 1:1) — corner brackets + a scan
 *      line that ACTUALLY travels top→bottom (~1.8s loop, opacity fades
 *      at the ends so the wrap is invisible)
 *      [pinch to zoom — gestures only]
 *      "Choose a photo instead" (quiet, below the frame)
 *
 * The +/− zoom buttons, the fake multiplier label, and the torch are
 * DELETED (donts.md #21/#22 — manual controls for gestural things,
 * flashlight toggles). "Choose a photo instead" runs the photo pipeline
 * (features/qr-from-image.ts) and feeds the EXACT same locked parse/route
 * path as the live camera. Permission states keep the honest fallback
 * panel (the camera is never required); parse errors stay one quiet line
 * + haptic that auto-clears — no red cards.
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Image, ScanLine } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  ChromeButton,
  ClayCard,
  QuietButton,
  TypeBody,
  TypeCaption,
} from "@/design/primitives";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { RADIUS_CARD, spacing } from "@/design/tokens";
import { SCAN_TRAVEL_MS } from "@/design/motion";
import { parsePairingPayload } from "@/link/pairing";
import { pickQrFromPhoto } from "@/features/qr-from-image";
import { mobLog, mobWarn } from "@/lib/log";

const ZOOM_MAX = 1;

/** The scan line's travel region inside the square (ratios of frame height). */
const LINE_TOP_RATIO = 0.16;
const LINE_SPAN_RATIO = 0.68;

// The animated camera — the zoom rides a UI-thread shared value straight
// into the native prop (60fps pinch with zero JS-thread chatter).
const AnimatedCamera = Animated.createAnimatedComponent(CameraView);

export default function ScanScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestCamera] = useCameraPermissions();
  const [notice, setNotice] = useState<string | null>(null);
  const lockedRef = useRef(false);
  const pickingRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoom = useSharedValue(0);
  const zoomBase = useSharedValue(0);
  const { width: windowWidth } = useWindowDimensions();

  const granted = permission?.granted ?? false;

  // The SQUARE viewfinder: width minus both gutters, 1:1, card radius.
  const squareSide = windowWidth - spacing.lg * 2;

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

  // One honest auto-clearing line — the scanner's ONLY error surface.
  function showNotice(line: string, onClear?: () => void) {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice(line);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
      onClear?.();
    }, 2500);
  }

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    };
  }, []);

  // The ONE parse + route path — the live camera and the photo pipeline
  // feed the exact same locked handler.
  function onScannedText(event: { data: string }) {
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
      router.replace({
        pathname: "/connect/confirm",
        params: { source: "qr", payload: candidate },
      });
      return;
    }
    // Not an ACUTE code — honest feedback, keep scanning (rate-limited by lock).
    lockedRef.current = true;
    void warningHaptic();
    const reason =
      result.error.kind === "expired"
        ? "that code expired — generate a fresh one on the desktop"
        : result.error.kind === "bad-version"
          ? "that code is from a different protocol version — update the desktop"
          : result.error.kind === "bad-relay"
            ? "that code carries an invalid relay address — update the desktop and scan again"
            : "that is not an ACUTE pairing code";
    showNotice(reason, () => {
      lockedRef.current = false;
    });
    mobWarn("pair", "QR parse failed", { kind: result.error.kind });
  }

  // "Choose a photo instead" — document picker → downscale → decode → jsQR
  // (features/qr-from-image.ts); every dead end is one honest line, and a
  // hit rides the exact same locked path as the camera.
  async function onPickPhoto() {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      const outcome = await pickQrFromPhoto();
      if (outcome.kind === "canceled") return;
      if (outcome.kind === "unsupported") {
        showNotice("Save the image as PNG or JPG and try again.");
        return;
      }
      if (outcome.kind === "no-code") {
        showNotice("No QR code found in that image.");
        return;
      }
      onScannedText({ data: outcome.text });
    } catch (err) {
      mobWarn("pair", "photo QR decode failed", err instanceof Error ? err.message : String(err));
      showNotice("That image couldn't be read — try again.");
    } finally {
      pickingRef.current = false;
    }
  }

  return (
    <ScreenScaffold title="Scan QR code" back noPill scroll={false}>
      <View style={styles.body}>
        <View style={styles.spacer} />
        <View style={[styles.square, { width: squareSide, height: squareSide }]}>
          {granted ? (
            <GestureDetector gesture={pinch}>
              <Animated.View style={styles.cameraWrap}>
                <AnimatedCamera
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={onScannedText}
                  animatedProps={cameraProps}
                />
                {/* The framing overlay: brackets + the traveling scan line */}
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <ScanBrackets color={tokens.accent} />
                </View>
              </Animated.View>
            </GestureDetector>
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
        <View style={styles.spacer} />

        {granted ? (
          <QuietButton
            onPress={() => void onPickPhoto()}
            testID="scan-choose-photo"
            style={styles.photoButton}
          >
            <Image size={16} color={tokens.textSecondary} strokeWidth={2.2} /> Choose a photo
            instead
          </QuietButton>
        ) : null}

        {/* The one-line notice slot — a fixed-height home so the quiet line
            never jumps the footer when it appears. */}
        <View style={styles.noticeSlot}>
          {notice !== null ? (
            <TypeCaption style={[styles.notice, { color: tokens.warning }]}>{notice}</TypeCaption>
          ) : null}
        </View>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <QuietButton onPress={() => router.replace("/connect/manual")}>
            Type the address + PIN instead
          </QuietButton>
        </View>
      </View>
    </ScreenScaffold>
  );
}

/** The animated corner brackets + the traveling scan line (R115-D: the line
 *  actually travels — translateY over the frame height, ~1.8s loop, its
 *  opacity fading to nothing at both ends so the loop wrap is invisible). */
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
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  spacer: { flex: 1 },
  square: { borderRadius: RADIUS_CARD, alignSelf: "center" },
  cameraWrap: {
    flex: 1,
    borderRadius: RADIUS_CARD,
    overflow: "hidden",
    // The camera's own ground — sensor black, not a palette surface.
    backgroundColor: "#000000",
  },
  bracketFrame: { flex: 1, alignItems: "center", justifyContent: "center" },
  bracket: { position: "absolute", width: 34, height: 34, borderWidth: 2.5 },
  bracketTL: { top: "12%", left: "12%", borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 10 },
  bracketTR: { top: "12%", right: "12%", borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 10 },
  bracketBL: { bottom: "12%", left: "12%", borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 10 },
  bracketBR: { bottom: "12%", right: "12%", borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 10 },
  scanLine: { position: "absolute", left: "16%", right: "16%", top: 0, height: 1.5 },
  photoButton: { alignSelf: "center" },
  noticeSlot: { minHeight: 18, justifyContent: "center" },
  notice: { textAlign: "center" },
  footer: {},
  permissionWrap: { flex: 1, justifyContent: "center", padding: spacing.md },
  permissionInner: { padding: spacing.xl, gap: spacing.md, alignItems: "center" },
  permissionBody: { textAlign: "center", lineHeight: 18 },
});
