/**
 * Home — the host card (the app's centerpiece: live status, the calm
 * "Host offline — retrying", relative last-seen), the quick entries with
 * honest badges, and the theme quick-switch. Everything else on the app
 * hangs off this screen's entries.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Folder, MessageSquare, Palette, ShieldCheck, Bell } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { HostCard, timeAgo } from "@/components/host-card";
import { ThemeDots } from "@/components/theme-picker";
import { PressableCard, TypeBody, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";

export default function HomeScreen() {
  const { tokens } = useTheme();
  const { status, host, live, lastSeen, lastFailure } = useLink();
  const router = useRouter();
  const [now, setNow] = useState(Date.now());

  // A calm minute-tick so "seen 2h ago" stays honest without re-rendering
  // the card on every frame.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (host === null) {
    // The router gate normally prevents this render; the honest fallback.
    return (
      <ScreenScaffold title="ACUTE" back={false}>
        <TypeBody style={{ color: tokens.textSecondary }}>No host linked yet.</TypeBody>
      </ScreenScaffold>
    );
  }

  const failureMessage =
    status === "offline" && lastFailure !== null ? lastFailure.message : null;

  const entries = [
    {
      name: "approvals",
      Icon: ShieldCheck,
      title: "Approvals",
      caption: "Permission requests waiting on you",
      tone: tokens.accent,
    },
    {
      name: "projects",
      Icon: Folder,
      title: "Projects",
      caption: "Everything the agent is working on",
      tone: tokens.textSecondary,
    },
    {
      name: "sessions",
      Icon: MessageSquare,
      title: "Sessions",
      caption: "Conversations, live or complete",
      tone: tokens.textSecondary,
    },
    {
      name: "notifications",
      Icon: Bell,
      title: "Alerts",
      caption: "Task and agent activity history",
      tone: tokens.textSecondary,
    },
  ] as const;

  return (
    <ScreenScaffold
      title="ACUTE"
      back={false}
      right={
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          <Palette size={18} color={tokens.textTertiary} strokeWidth={1.8} />
        </View>
      }
    >
      <HostCard
        host={host}
        live={live}
        status={status}
        lastSeen={lastSeen}
        failureMessage={failureMessage}
        onRetry={() => getLinkManager().retryNow()}
        now={now}
      />

      <View style={{ gap: spacing.md }}>
        {entries.map(({ name, Icon, title, caption, tone }) => (
          <PressableCard
            key={name}
            accessibilityLabel={title}
            onPress={() => router.navigate(`/${name}`)}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <Icon size={22} color={tone} strokeWidth={1.8} />
              <View style={{ flex: 1 }}>
                <TypeBody style={{ color: tokens.text, fontWeight: "600" }}>{title}</TypeBody>
                <TypeCaption style={{ color: tokens.textTertiary }}>{caption}</TypeCaption>
              </View>
            </View>
          </PressableCard>
        ))}
      </View>

      <View style={{ gap: spacing.sm }}>
        <TypeCaption style={{ color: tokens.textTertiary }}>THEME</TypeCaption>
        <ThemeDots />
      </View>

      <PressableCard
        accessibilityLabel="Settings"
        onPress={() => router.navigate("/settings")}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor:
                status === "connected"
                  ? tokens.success
                  : status === "probing"
                    ? tokens.warning
                    : tokens.danger,
            }}
          />
          <TypeBody style={{ color: tokens.text, flex: 1 }}>
            Link settings · themes · unpair
          </TypeBody>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            {status === "connected" && lastSeen !== null ? `seen ${timeAgo(lastSeen, now)}` : ""}
          </TypeCaption>
        </View>
      </PressableCard>
    </ScreenScaffold>
  );
}
