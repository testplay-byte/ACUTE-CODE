/**
 * Settings — the management HUB (tab root, R109): every desktop-management
 * page one tap away — connection, appearance, providers, agents, prompts,
 * preferences — plus the about card (version, the view+input ceiling, the
 * wizard replay). Unpaired → the config rows carry the honest "requires a
 * linked host" caption and are disabled (the hub itself never pretends the
 * desktop is reachable).
 */

import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import {
  Bot,
  Boxes,
  ChevronRight,
  FileText,
  Info,
  Palette,
  SlidersHorizontal,
  Unplug,
} from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  Badge,
  ClayCard,
  PressableCard,
  QuietButton,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { getTheme, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { resetOnboarding } from "@/features/onboarding";
import { mobLog } from "@/lib/log";

/** The version the about card shows — the BUILD's own app.json version
 * (embedded by expo-constants), falling back to the R109 release number. */
const APP_VERSION = Constants.expoConfig?.version ?? "0.105.0";

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
    <ScreenScaffold title="Settings" subtitle="manage the desktop from your pocket">
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

      {/* ── about: version + the view/input ceiling + the wizard replay ── */}
      <ClayCard>
        <View style={styles.aboutPad}>
          <View style={styles.aboutHead}>
            <View style={[styles.aboutIcon, { backgroundColor: tokens.subtleHover }]}>
              <Info size={20} color={tokens.accent} strokeWidth={2.2} />
            </View>
            <View style={styles.aboutHeadText}>
              <TypeBodyStrong>ACUTE companion</TypeBodyStrong>
              <TypeMicro>VIEW + INPUT MEDIUM · ANDROID</TypeMicro>
            </View>
            <Badge tone="neutral">v{APP_VERSION}</Badge>
          </View>
          <TypeBody style={styles.aboutBody}>
            This phone is a view + input medium for the desktop agent — nothing is
            processed here, no model runs here. Every action rides the paired,
            pinned link to your own desktop.
          </TypeBody>
          <QuietButton onPress={() => onReplayWizard(router)}>Replay the setup wizard</QuietButton>
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

/** The wizard replay: clear the onboarding flag, land on the welcome page. */
function onReplayWizard(router: ReturnType<typeof useRouter>): void {
  mobLog("settings", "wizard replay requested");
  void resetOnboarding().then(() => {
    router.replace("/onboarding/welcome");
  });
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
  aboutPad: { padding: spacing.lg, gap: spacing.md },
  aboutHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  aboutIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  aboutHeadText: { flex: 1, gap: 2 },
  aboutBody: { lineHeight: 21, paddingBottom: spacing.xs },
});
