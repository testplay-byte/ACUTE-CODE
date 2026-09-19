/**
 * The connect stack — the link's front door (R109): the hub (add a
 * connection / manage the current one), the camera scanner, the manual
 * entry page, and the confirm+pair step. Screens own their chrome.
 */

import { Stack } from "expo-router";
import { useTheme } from "@/design/theme";

export default function ConnectLayout() {
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
      <Stack.Screen name="scan" />
      <Stack.Screen name="manual" />
      <Stack.Screen name="confirm" />
    </Stack>
  );
}
