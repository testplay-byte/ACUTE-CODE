/**
 * The settings stack — the management HUB (R115-g: index, pushed from the
 * More tab) + every pushed management page (host, appearance, preferences,
 * prompts, providers/*, agents/*) renders under this Stack: no native
 * headers (the pages own their compact header via ScreenScaffold with
 * back), the quiet fade transition, and the theme's bg so edge-to-edge
 * stays honest through the route change.
 */

import { Stack } from "expo-router";
import { useTheme } from "@/design/theme";

export default function SettingsLayout() {
  const { tokens } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "fade",
        contentStyle: { backgroundColor: tokens.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="host" />
      <Stack.Screen name="appearance" />
      <Stack.Screen name="preferences" />
      <Stack.Screen name="prompts" />
      <Stack.Screen name="providers/index" />
      <Stack.Screen name="providers/[id]" />
      <Stack.Screen name="agents/index" />
      <Stack.Screen name="agents/[id]" />
    </Stack>
  );
}
