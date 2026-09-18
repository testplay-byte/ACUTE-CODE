/**
 * The tab group layout — five quiet tabs behind the fully custom TabBar
 * (no native tab chrome, no ripple, no elevation). The navigator's
 * emit/navigate dance lives HERE (where its types live); the TabBar itself
 * is purely presentational. Every screen renders inside ScreenScaffold's
 * safe-area + hairline header; the bar owns the bottom safe area.
 */

import { Tabs } from "expo-router";
import { TabBar } from "@/components/tab-bar";

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={({ state, navigation }) => (
        <TabBar
          index={state.index}
          routes={state.routes}
          onTabPress={(index, name, focused) => {
            const event = navigation.emit({
              type: "tabPress",
              target: state.routes[index]?.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(name);
            }
          }}
        />
      )}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="projects" />
      <Tabs.Screen name="sessions" />
      <Tabs.Screen name="approvals" />
      <Tabs.Screen name="notifications" />
    </Tabs>
  );
}
