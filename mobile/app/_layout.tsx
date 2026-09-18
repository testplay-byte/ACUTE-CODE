/**
 * The app shell — ONE root stack, fully custom chrome (no native headers,
 * no Material anything): the theme provider, the gesture root, the splash
 * hold until prefs load, and the StatusBar that follows the resolved mode.
 *
 * Route map (expo-router file routes — documented for S4b):
 *   /            → the router gate (paired ? tabs : pairing)
 *   /pairing     → QR scan + manual fallback + confirm + pair
 *   /settings    → themes, mode, host details, unpair, about
 *   /(tabs)/…    → home · projects · sessions · approvals · notifications
 *                  (the group renders the custom bottom bar)
 *   /session/:id → the pushed transcript + live stream + composer
 *                  (OUTSIDE the tabs — a stack screen over them)
 */

import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ThemeProvider, useTheme } from "@/design/theme";

// Hold the native splash until the persisted theme prefs resolve (cosmetic
// flash prevention — the first frame renders in the RIGHT palette).
void SplashScreen.preventAutoHideAsync().catch(() => {});

function RootNavigator() {
  const { tokens } = useTheme();
  const [chromeReady, setChromeReady] = useState(false);

  useEffect(() => {
    // Prefs land inside ThemeProvider's first effect — one tick later is
    // always enough; the hold is cosmetic-only, never a gate.
    const t = setTimeout(() => {
      setChromeReady(true);
      void SplashScreen.hideAsync().catch(() => {});
    }, 80);
    return () => clearTimeout(t);
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
        <Stack.Screen name="pairing" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="session/[id]" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider>
        <RootNavigator />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hidden: { opacity: 0 },
});
