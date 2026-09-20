/**
 * Settings — the management HUB (R109 tab root; R115-g — MOVED here into
 * the pushed settings stack, its tab slot taken by the MORE hub): every
 * desktop-management page one tap away — connection, appearance, providers,
 * agents, prompts, preferences. A PUSHED screen now: the standard compact
 * header (chevron | title | right slot). The about card (version, the
 * one-line role, the wizard replay) lives in the More tab. Unpaired → the
 * config rows carry the honest "requires a linked host" caption and are
 * disabled (the hub itself never pretends the desktop is reachable).
 */

import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import {
  Bot,
  Boxes,
  ChevronRight,
  FileText,
  Palette,
  SlidersHorizontal,
  Unplug,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { PressableCard, StatusDot, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { getTheme, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { mobLog } from "@/lib/log";

export default function SettingsScreen() {
  const { tokens, themeId, mode } = useTheme();
  const router = useRouter();
  const { status, host } = useLink();

  useEffect(() => {
    mobLog("settings", "hub opened", { status });
  }, [status]);

  const connected = status === "connected";
  const unpaired = status === "unpaired";
  const themeName = getTheme(themeId).name;
  const modeWord = mode === "system" ? "follows system" : mode;

  // The config rows need a linked host. Connection + Appearance never do
  // (the link is managed from Connection; the theme is this phone's own).
  const configCaption = unpaired ? "requires a linked host" : null;

  return (
    <ScreenScaffold title="Settings" back>
      {/* ── the connection row: the live truth + the host's name ── */}
      <PressableCard
        onPress={() => router.push("/settings/host")}
        accessibilityLabel="Connection settings"
      >
        <View style={styles.rowInner}>
          <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
            <Unplug size={22} color={tokens.accent} strokeWidth={2.2} />
          </View>
          <View style={styles.rowText}>
            <View style={styles.rowTitleLine}>
              <TypeBodyStrong>Connection</TypeBodyStrong>
              <StatusDot
                color={
                  connected
                    ? tokens.success
                    : status === "offline"
                      ? tokens.warning
                      : status === "probing"
                        ? tokens.accent
                        : tokens.textTertiary
                }
                pulse={status === "probing"}
              />
            </View>
            <TypeCaption numberOfLines={1}>
              {host !== null
                ? connected
                  ? `live · ${host.hostLabel}`
                  : status === "probing"
                    ? `connecting… · ${host.hostLabel}`
                    : `offline · ${host.hostLabel}`
                : "no desktop linked yet"}
            </TypeCaption>
          </View>
          <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </View>
      </PressableCard>

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
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
