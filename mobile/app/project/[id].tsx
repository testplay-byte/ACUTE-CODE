/**
 * Project detail — R114-c: the THIN REDIRECT. The per-project page died
 * with the projects accordion (the owner: "tapping a project should
 * expand its sessions below, not open a new page") — the Projects TAB is
 * the project screen now. This file survives purely as the deep-link
 * compat shim (a stale notification, a saved link, an /activity row that
 * still points here): it replaces onto the Projects tab in an effect and
 * renders a quiet spinner for the beat the navigation takes.
 *
 * The file is NOT deleted — expo-router's typed routes regenerate only
 * under expo commands, and deleting a route file out-of-band risks stale
 * typegen; a redirect keeps the route table honest.
 */

import { useEffect } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useTheme } from "@/design/theme";
import { mobLog } from "@/lib/log";

export default function ProjectDetailScreen() {
  const router = useRouter();
  const { tokens } = useTheme();

  useEffect(() => {
    mobLog("project", "redirecting to the projects tab (the accordion owns project detail now)");
    router.replace("/projects");
  }, [router]);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ActivityIndicator size="small" color={tokens.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
});
