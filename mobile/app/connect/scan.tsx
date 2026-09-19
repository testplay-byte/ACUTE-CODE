/**
 * The QR scanner (R109: "the user cannot zoom in or zoom out… look into
 * it and handle properly") — a full-bleed camera page with:
 *
 *   - PINCH TO ZOOM (Gesture.Pinch + the camera's 0–1 zoom prop)
 *   - explicit +/− zoom steps (a11y: zoom without gestures)
 *   - the TORCH toggle (dark rooms)
 *   - animated corner brackets with a calm scan pulse
 *   - honest permission states: not-determined → request card;
 *     denied → the manual-entry fallback (camera never required)
 *
 * On a valid QR payload: one success haptic, then the confirm step.
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { CircleAlert, Flashlight, FlashlightOff, Minus, Plus, ScanLine } from "lucide-react-native";
import {
  ChromeButton,
  ClayCard,
  PressableCard,
  QuietButton,
  TypeBody,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { selectionHaptic, successHaptic, warningHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { parsePairingPayload } from "@/link/pairing";
import { mobLog, mobWarn } from "@/lib/log";
const ZOOM_STEP = 0.15;
const ZOOM_MAX = 1;

// The animated camera — the zoom rides a UI-thread shared value straight
// into the native prop (60fps pinch with zero JS-thread chatter).
const AnimatedCamera = Animated.createAnimatedComponent(CameraView);

export default function ScanScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const [permission, requestCamera] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [zoomDisplay, setZoomDisplay] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const lockedRef = useRef(false);
  const zoom = useSharedValue(0);
  const zoomBase = useSharedValue(0);

  const granted = permission?.granted ?? false;

  const cameraProps = useAnimatedProps(() => ({ zoom: zoom.value }));

  // The pinch: relative to the gesture-start zoom, clamped 0–1, synced to
  // the label state when the gesture settles (one JS call, not per-frame).
  const syncZoomLabel = (value: number) => setZoomDisplay(value);
  const pinch = Gesture.Pinch()
    .onBegin(() => {
      "worklet";
      zoomBase.value = zoom.value;
    })
    .onUpdate((event) => {
      "worklet";
      const next = zoomBase.value * event.scale;
      zoom.value = Math.min(Math.max(next, 0), ZOOM_MAX);
    })
    .onFinalize(() => {
      "worklet";
      runOnJS(syncZoomLabel)(zoom.value);
    });

  function stepZoom(delta: number) {
    zoom.value = Math.min(Math.max(zoom.value + delta, 0), ZOOM_MAX);
    setZoomDisplay(zoom.value);
    void selectionHaptic();
  }

  function onBarcode(event: { data: string }) {
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
    setParseError(reason);
    mobWarn("pair", "QR parse failed", { kind: result.error.kind });
    setTimeout(() => {
      lockedRef.current = false;
      setParseError(null);
    }, 2500);
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <QuietButton onPress={() => router.back()}>Back</QuietButton>
        <TypeMicro>SCAN THE DESKTOP'S PAIRING CODE</TypeMicro>
      </View>

      <View style={styles.cameraZone}>
        {granted ? (
          <GestureDetector gesture={pinch}>
            <Animated.View style={styles.cameraWrap}>
              <AnimatedCamera
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onBarcode}
                animatedProps={cameraProps}
                enableTorch={torch}
              />
              {/* The framing overlay: brackets + the calm scan pulse */}
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <ScanBrackets color={tokens.accent} />
              </View>
            </Animated.View>
          </GestureDetector>
        ) : (
          <PermissionPanel
            canAsk={permission?.canAskAgain ?? true}
            onRequest={async () => {
              const result = await requestCamera();
              mobLog("pair", "camera permission", { granted: result.granted });
            }}
            onManual={() => router.replace("/connect/manual")}
          />
        )}
      </View>

      {/* The controls row: zoom steps + torch */}
      {granted ? (
        <View style={styles.controlsRow}>
          <ZoomButton icon={<Minus size={18} color={tokens.text} strokeWidth={2.4} />} onPress={() => stepZoom(-ZOOM_STEP)} label="zoom out" />
          <ClayCard small>
            <View style={styles.zoomLabel}>
              <TypeMicro>{Math.round((0.4 + zoomDisplay * 2.6) * 10) / 10}×</TypeMicro>
            </View>
          </ClayCard>
          <ZoomButton icon={<Plus size={18} color={tokens.text} strokeWidth={2.4} />} onPress={() => stepZoom(ZOOM_STEP)} label="zoom in" />
          <View style={styles.spacer} />
          <ZoomButton
            icon={
              torch ? (
                <Flashlight size={18} color={tokens.accent} strokeWidth={2.4} />
              ) : (
                <FlashlightOff size={18} color={tokens.text} strokeWidth={2.4} />
              )
            }
            onPress={() => {
              setTorch((t) => !t);
              void selectionHaptic();
            }}
            label={torch ? "torch on" : "torch off"}
          />
        </View>
      ) : null}

      {parseError !== null ? (
        <ClayCard bordered>
          <View style={styles.parseErrorInner}>
            <CircleAlert size={16} color={tokens.warning} strokeWidth={2.2} />
            <TypeCaption style={{ color: tokens.warning, flex: 1 }}>{parseError}</TypeCaption>
          </View>
        </ClayCard>
      ) : null}

      <View style={styles.footer}>
        <TypeCaption style={styles.footerLine}>
          Pinch (or the +/− steps) to zoom · the torch helps in dark rooms
        </TypeCaption>
        <QuietButton onPress={() => router.replace("/connect/manual")}>
          Type the address + PIN instead
        </QuietButton>
      </View>
    </SafeAreaView>
  );
}

function ZoomButton({
  icon,
  onPress,
  label,
}: {
  icon: React.ReactNode;
  onPress: () => void;
  label: string;
}) {
  return (
    <PressableCard onPress={onPress} accessibilityLabel={label} style={styles.zoomButton}>
      <View style={styles.zoomButtonInner}>{icon}</View>
    </PressableCard>
  );
}

/** The animated corner brackets + the calm traveling scan line. */
function ScanBrackets({ color }: { color: string }) {
  const pulse = useSharedValue(0);
  const scanY = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(1, { duration: 900 }), withTiming(0, { duration: 900 })),
      -1,
      false,
    );
    scanY.value = withRepeat(
      withSequence(withTiming(1, { duration: 1800 }), withTiming(0, { duration: 1800 })),
      -1,
      false,
    );
  }, [pulse, scanY]);
  const bracketsStyle = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));
  const scanLineStyle = useAnimatedStyle(() => ({ opacity: 0.25 + pulse.value * 0.6 }));
  const size = 34;
  const arm = { width: size, height: size, borderColor: color, borderWidth: 2.5 } as const;
  return (
    <View style={styles.bracketFrame}>
      <Animated.View style={[styles.bracket, arm, styles.bracketTL, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketTR, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketBL, bracketsStyle]} />
      <Animated.View style={[styles.bracket, arm, styles.bracketBR, bracketsStyle]} />
      <Animated.View
        style={[styles.scanLine, { backgroundColor: color }, scanLineStyle]}
      />
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
            ? "The scanner reads your desktop's pairing QR code through the camera — nothing is ever recorded."
            : "Android says no — you can enable it in system settings, or skip the camera entirely and pair by typing the values."}
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
  root: { flex: 1, gap: spacing.md },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
  },
  cameraZone: { flex: 1, marginHorizontal: spacing.lg },
  cameraWrap: { flex: 1, borderRadius: 24, overflow: "hidden", backgroundColor: "#000000" },
  bracketFrame: { flex: 1, alignItems: "center", justifyContent: "center" },
  bracket: { position: "absolute", width: 34, height: 34, borderWidth: 2.5 },
  bracketTL: { top: "22%", left: "12%", borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 10 },
  bracketTR: { top: "22%", right: "12%", borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 10 },
  bracketBL: { bottom: "22%", left: "12%", borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 10 },
  bracketBR: { bottom: "22%", right: "12%", borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 10 },
  scanLine: { position: "absolute", left: "18%", right: "18%", top: "24%", height: 1.5, opacity: 0.7 },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  zoomButton: {},
  zoomButtonInner: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomLabel: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  spacer: { flex: 1 },
  parseErrorInner: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    padding: spacing.md,
  },
  footer: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  footerLine: { textAlign: "center" },
  permissionInner: { padding: spacing.xl, gap: spacing.md, alignItems: "center" },
  permissionBody: { textAlign: "center", lineHeight: 18 },
});
