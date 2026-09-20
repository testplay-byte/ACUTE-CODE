/**
 * The tab group layout — FIVE tabs behind the FLOATING clay bar (R109):
 * Home · Projects · Approvals (live pending badge + the §4.5 breathe) ·
 * Dashboard · More. The bar floats with margins on all four sides, radius
 * 28, the elevation-2 clay shadow and the chrome edge (components.md §Tab
 * bar); content scrolls under it via the TabBarInsetContext every screen's
 * scaffold reads.
 *
 * R115-g — the round-115 pinned decision: tab 5 is the MORE hub (app/
 * (tabs)/more.tsx — connection summary, activity, about, the settings
 * ENTRY), not the settings list itself. The settings hub moved to the
 * pushed settings stack (app/settings/index.tsx); the old (tabs)/settings
 * route is gone. The universal three-dots glyph ("Ellipsis" — this lucide
 * version's name for EllipsisHorizontal) is the icon.
 *
 * The approvals badge: a calm 45-second poll while connected (the live
 * notification stream covers the rest — approvals are also notifications).
 * While the count is > 0 the tab's icon + label breathe in the accent
 * (motion.md §4.5) — the badge alone was judged not enough.
 */

import { Tabs } from "expo-router";
import { useEffect, useState } from "react";
import { Ellipsis, Folders, Gauge, House, ShieldCheck } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloatingTabBar, type TabDescriptor } from "@/components/tab-bar";
import { TabBarInsetContext } from "@/components/screen-scaffold";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { fetchPendingApprovals } from "@/features/approvals";
import { BAR_HEIGHT, BAR_MARGIN } from "@/design/tokens";

/** The pending-approvals badge cadence (calm; the stream does the rest). */
const BADGE_POLL_MS = 45_000;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { status } = useLink();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (status !== "connected") {
      setPendingCount(0);
      return;
    }
    let alive = true;
    const load = async () => {
      const outcome = await fetchPendingApprovals(getLinkManager());
      if (alive && outcome.ok) setPendingCount(outcome.data.length);
    };
    void load();
    const t = setInterval(() => void load(), BADGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [status]);

  const tabs: TabDescriptor[] = [
    { name: "home", label: "Home", icon: House },
    { name: "projects", label: "Projects", icon: Folders },
    {
      name: "approvals",
      label: "Approvals",
      icon: ShieldCheck,
      badge: pendingCount,
      alert: pendingCount > 0,
    },
    { name: "dashboard", label: "Dashboard", icon: Gauge },
    { name: "more", label: "More", icon: Ellipsis },
  ];

  // The content inset the floating bar demands (DESIGN.md §5): the bar's
  // height + its top margin + the bottom safe area it rides above + air.
  const tabBarInset = BAR_HEIGHT + BAR_MARGIN + Math.max(insets.bottom, 8) + 8;

  return (
    <TabBarInsetContext.Provider value={tabBarInset}>
      <Tabs
        screenOptions={{ headerShown: false, lazy: false }}
        tabBar={({ state, navigation }) => (
          <FloatingTabBar
            tabs={tabs}
            activeIndex={state.index}
            onSelect={(index) => {
              const route = state.routes[index];
              if (route === undefined) return;
              const focused = state.index === index;
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            }}
          />
        )}
      >
        <Tabs.Screen name="home" />
        <Tabs.Screen name="projects" />
        <Tabs.Screen name="approvals" />
        <Tabs.Screen name="dashboard" />
        <Tabs.Screen name="more" />
      </Tabs>
    </TabBarInsetContext.Provider>
  );
}
