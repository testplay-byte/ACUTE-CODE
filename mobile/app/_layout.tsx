/**
 * The app shell — ONE root stack, fully custom chrome (no native headers,
 * no Material anything): the boot trail, the error boundary, the theme
 * provider, the gesture root, the KEYBOARD controller (R109 — inputs never
 * sit under the keyboard), the live activity controller, the splash hold
 * until prefs + fonts load, and the StatusBar that follows the resolved mode.
 *
 * Route map (expo-router file routes — documented for the walkthrough):
 *   /                    → the router gate (onboarding → connect → tabs)
 *   /onboarding/*        → the FIRST-RUN setup wizard (welcome → permissions → connect)
 *   /connect             → the connection hub (add a connection: scan / manual; host management)
 *   /connect/scan        → the camera scanner (pinch zoom + the photo-pick
 *                          fallback — R115-d deleted the torch, donts #22)
 *   /connect/manual      → the manual entry page (address/URL + PIN + fingerprint)
 *   /activity            → the notifications history (pushed from the bell)
 *   /(tabs)/…            → home · projects · approvals · dashboard · more
 *                          (the group renders the FLOATING bottom bar; the
 *                          old sessions tab merged INTO projects — R113-e;
 *                          the settings tab became the MORE hub — R115-g)
 *   /project/:id         → a project's sessions (pushed from the tab)
 *   /session/:id         → the pushed transcript + live stream + composer
 *   /settings/*          → the pushed management hub (index, pushed from
 *                          the More tab) + its pages (host, appearance,
 *                          update [R124 — the phone's own APK updater],
 *                          providers, agents, prompts, preferences)
 *
 * R108 BOOT DISCIPLINE (the splash-forever lesson, kept): every startup
 * stage is a breadcrumb ([ACUTE-BOOT] lines under the ReactNativeJS logcat
 * tag — see mobile/README.md for the Android Studio filter), the boundary
 * catches anything render-shaped, the global hook catches module-eval
 * throws, and the splash has a HARD 4-second fallback release.
 */

import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ThemeProvider, useTheme } from "@/design/theme";
import { BootErrorBoundary } from "@/components/error-boundary";
// R120-M (round-120 §1 item 16 — the toast law): the app-wide toast
// provider mounts INSIDE ThemeProvider (the strip reads the resolved
// tokens) — every screen + sheet reaches it through useToast().
import { ToastProvider } from "@/components/toast";
import { startActivity } from "@/features/activity";
import { startEvents } from "@/features/events";
// R124 — the phone's own 24 h update check (silent on failure: a startup
// check must never nag; the cached answer paints the settings row).
import { maybeAutoCheck } from "@/update/updater";
import {
  bootIdentity,
  bootLog,
  installBootErrorHandling,
} from "@/features/boot-log";

// Hold the native splash until the persisted theme prefs + fonts resolve
// (cosmetic flash prevention — the first frame renders in the RIGHT palette
// with the RIGHT type). The ThemeProvider itself gates on useFonts.
void SplashScreen.preventAutoHideAsync().catch(() => {});

// The trail starts at module evaluation — if startup dies between here and
// the first render, logcat (and the boundary) still show how far it got.
bootLog("js-module-eval", bootIdentity());
installBootErrorHandling();

/** The cosmetic hold's hard ceiling: if prefs somehow never resolve, the
 *  splash releases anyway — a stuck logo is a failure MODE, not a policy. */
const SPLASH_FALLBACK_MS = 4000;

function RootNavigator() {
  const { tokens } = useTheme();
  const [chromeReady, setChromeReady] = useState(false);

  useEffect(() => {
    bootLog("root-mounted");
    // The live activity controller (unread badge + the notifications stream).
    startActivity();
    // R113-e: the events controller — the phone's LIVE VIEW (remote turns
    // stream, lists refresh, settings/appearance sync). The same lifecycle
    // as the activity controller: the stream lives while connected +
    // foregrounded (the R42 discipline).
    startEvents();
    // R124: the once-per-24 h update check — fire-and-forget, silent on
    // failure; its answer lands in AsyncStorage for the settings hub's
    // row caption. Deferred a tick so it never competes with the splash.
    const updateCheck = setTimeout(() => {
      void maybeAutoCheck().catch(() => null);
    }, 2000);
    // Prefs land inside ThemeProvider's first effect — one tick later is
    // always enough; the hold is cosmetic-only, never a gate.
    const t = setTimeout(() => {
      setChromeReady(true);
      bootLog("splash-hidden");
      void SplashScreen.hideAsync().catch(() => {});
    }, 80);
    // The fail-safe: whatever else happens, the logo never parks forever.
    const fallback = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => {});
    }, SPLASH_FALLBACK_MS);
    return () => {
      clearTimeout(t);
      clearTimeout(fallback);
      clearTimeout(updateCheck);
    };
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }, !chromeReady && styles.hidden]}>
      <StatusBar style={tokens.isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "fade",
          contentStyle: { backgroundColor: tokens.bg },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="activity" />
        <Stack.Screen name="session/[id]" />
        <Stack.Screen name="project/[id]" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  return (
    <BootErrorBoundary>
      <GestureHandlerRootView style={styles.root}>
        <KeyboardProvider>
          <ThemeProvider>
            <ToastProvider>
              <RootNavigator />
            </ToastProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </BootErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hidden: { opacity: 0 },
});
