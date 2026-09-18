/**
 * TabBar — the fully custom bottom navigation (R1 §6): five quiet items,
 * hairline top border, no elevation, no ripple; the active item wears the
 * theme accent and a 3px accent underline dot. Purely presentational: the
 * tab-group layout passes the navigator's state + a single onTabPress
 * callback (the navigation.emit dance stays where the types live).
 */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, Folder, Home, MessageSquare, ShieldCheck } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TYPE_CAPTION, fontStack, spacing } from "@/design/tokens";

/** The tab inventory — one place; the route files match these names. */
const TABS = [
  { name: "home", label: "Home", Icon: Home },
  { name: "projects", label: "Projects", Icon: Folder },
  { name: "sessions", label: "Sessions", Icon: MessageSquare },
  { name: "approvals", label: "Approvals", Icon: ShieldCheck },
  { name: "notifications", label: "Alerts", Icon: Bell },
] as const;

export interface TabBarProps {
  /** The navigator's current index (which tab is focused). */
  index: number;
  /** The navigator's route list (name order must match TABS). */
  routes: ReadonlyArray<{ key: string; name: string }>;
  /** The single interaction: the layout runs the emit/navigate dance. */
  onTabPress: (index: number, name: string, focused: boolean) => void;
}

export function TabBar({ index, routes, onTabPress }: TabBarProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.borderSubtle,
          paddingBottom: Math.max(insets.bottom, spacing.xs),
        },
      ]}
    >
      {TABS.map(({ name, label, Icon }, tabIndex) => {
        const focused = index === tabIndex;
        const color = focused ? tokens.accent : tokens.textTertiary;
        return (
          <Pressable
            key={routes[tabIndex]?.key ?? name}
            accessibilityLabel={label}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            onPress={() => onTabPress(tabIndex, name, focused)}
            style={({ pressed }) => [
              styles.item,
              { backgroundColor: pressed ? tokens.subtleHover : "transparent" },
            ]}
          >
            <Icon size={22} color={color} strokeWidth={focused ? 2.2 : 1.8} />
            <View style={styles.labelRow}>
              <Text
                style={{
                  color,
                  fontSize: TYPE_CAPTION,
                  fontFamily: fontStack.sans,
                  fontWeight: focused ? "600" : "400",
                }}
              >
                {label}
              </Text>
              {focused && <View style={[styles.dot, { backgroundColor: tokens.accent }]} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    minHeight: 52,
    borderRadius: 8,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 2,
  },
});
