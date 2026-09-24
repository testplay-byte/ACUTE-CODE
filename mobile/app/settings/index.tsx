/**
 * Settings — the management HUB (R109 tab root; R115-g — MOVED here into
 * the pushed settings stack, its tab slot taken by the MORE hub): every
 * desktop-management page one tap away — appearance, providers, agents,
 * prompts, preferences. A PUSHED screen now: the standard compact header
 * (chevron | title | right slot). The about card (version, the one-line
 * role, the wizard replay) lives in the More tab. Unpaired → the config
 * rows carry the honest "requires a linked host" caption and are disabled
 * (the hub itself never pretends the desktop is reachable).
 *
 * R118-B (spec §2.4): the CONNECTION ROW IS DELETED — the link's surface
 * is the More hero (tap → the connect hub) and /settings/host stays
 * reachable from the hub's "Manage this connection" row. The settings
 * stack starts at Appearance; the WHO+status truth lives in ONE place.
 */

import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Bot,
  Boxes,
  ChevronRight,
  FileText,
  Palette,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { PressableCard, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { getTheme, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { mobLog } from "@/lib/log";
import { getCachedCheck } from "@/update/updater";

export default function SettingsScreen() {
  const { tokens, themeId, mode } = useTheme();
  const router = useRouter();
  const { status } = useLink();

  useEffect(() => {
    mobLog("settings", "hub opened", { status });
  }, [status]);

  const unpaired = status === "unpaired";
  const themeName = getTheme(themeId).name;
  const modeWord = mode === "system" ? "follows system" : mode;

  // R124 — the phone's own update row's caption: the 24 h auto-check's
  // cached answer ("v0.117.0 available") when one exists, else the plain
  // "check for the latest APK" line. Phone-own: never needs the host.
  const [updateCaption, setUpdateCaption] = useState("check for the latest APK");
  useEffect(() => {
    void getCachedCheck().then((cached) => {
      if (cached?.kind === "available") {
        setUpdateCaption(`v${cached.version} available · tap to update`);
      }
    });
  }, []);

  // The config rows need a linked host. Appearance never does (the theme is
  // this phone's own).
  const configCaption = unpaired ? "requires a linked host" : null;

  return (
    <ScreenScaffold title="Settings" back>
      {/* ── R118-B: the connection row is DELETED — the More hero + the
          connect hub own the link's whole surface now; /settings/host stays
          reachable from the hub's "Manage this connection" row. The stack
          starts at this phone's own material. ── */}

      {/* ── appearance: this phone's own material ── */}
      <PressableCard
        onPress={() => router.push("/settings/appearance")}
        accessibilityLabel="Appearance settings"
      >
        <View style={styles.rowInner}>
          <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
            <Palette size={22} color={tokens.accent} strokeWidth={2.2} />
          </View>
          <View style={styles.rowText}>
            <TypeBodyStrong>Appearance</TypeBodyStrong>
            <TypeCaption numberOfLines={1}>
              {themeName} · {modeWord}
            </TypeCaption>
          </View>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>

      {/* ── app updates: this phone's own build (R124 — the in-app APK
          updater; phone-own like Appearance, never needs the host) ── */}
      <PressableCard
        onPress={() => router.push("/settings/update")}
        accessibilityLabel="App updates"
      >
        <View style={styles.rowInner}>
          <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
            <RefreshCw size={22} color={tokens.accent} strokeWidth={2.2} />
          </View>
          <View style={styles.rowText}>
            <TypeBodyStrong>App updates</TypeBodyStrong>
            <TypeCaption numberOfLines={1}>{updateCaption}</TypeCaption>
          </View>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>

      {/* ── the desktop-management rows (need a linked host) ── */}
      <ConfigRow
        icon={Boxes}
        title="Providers"
        caption={configCaption ?? "models & API keys"}
        disabled={unpaired}
        onPress={() => router.push("/settings/providers")}
      />
      <ConfigRow
        icon={Bot}
        title="Agents"
        caption={configCaption ?? "the worker roster"}
        disabled={unpaired}
        onPress={() => router.push("/settings/agents")}
      />
      <ConfigRow
        icon={FileText}
        title="Prompts"
        caption={configCaption ?? "per-project section overrides"}
        disabled={unpaired}
        onPress={() => router.push("/settings/prompts")}
      />
      <ConfigRow
        icon={SlidersHorizontal}
        title="Preferences"
        caption={configCaption ?? "orchestration, retry, memory…"}
        disabled={unpaired}
        onPress={() => router.push("/settings/preferences")}
      />
    </ScreenScaffold>
  );
}

/** A desktop-management row (disabled with the honest caption when unpaired). */
function ConfigRow({
  icon: Icon,
  title,
  caption,
  disabled,
  onPress,
}: {
  icon: typeof Boxes;
  title: string;
  caption: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <PressableCard
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={disabled ? `${title} — requires a linked host` : `${title} settings`}
    >
      <View style={[styles.rowInner, disabled ? styles.rowDisabled : null]}>
        <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
          <Icon
            size={22}
            color={disabled ? tokens.textTertiary : tokens.accent}
            strokeWidth={2.2}
          />
        </View>
        <View style={styles.rowText}>
          <TypeBodyStrong style={{ color: disabled ? tokens.textSecondary : tokens.text }}>
            {title}
          </TypeBodyStrong>
          <TypeCaption
            numberOfLines={1}
            style={disabled ? { color: tokens.textTertiary } : null}
          >
            {caption}
          </TypeCaption>
        </View>
        <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 68,
  },
  rowDisabled: { opacity: 0.6 },
  rowIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 3 },
});
