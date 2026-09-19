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
 *   /connect/scan        → the camera scanner (pinch zoom + torch)
 *   /connect/manual      → the manual entry page (address/URL + PIN + fingerprint)
 *   /activity            → the notifications history (pushed from the bell)
 *   /(tabs)/…            → home · sessions · approvals · dashboard · settings
 *                          (the group renders the FLOATING bottom bar)
 *   /session/:id         → the pushed transcript + live stream + composer
 *   /settings/*          → the pushed management pages (host, appearance,
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
import { startActivity } from "@/features/activity";
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
            <RootNavigator />
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
