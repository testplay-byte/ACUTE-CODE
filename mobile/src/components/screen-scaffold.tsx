/**
 * ScreenScaffold — the shared screen chrome (DESIGN.md §5/§6): edge-to-edge
 * safe areas top AND bottom, the large-title header for tab roots (compact
 * for pushed screens), the CONNECTION PILL always on screen (the owner's
 * "it would not show me that it has disconnected" fix made structural),
 * the activity bell (tab roots), and the keyboard-aware scroll body.
 * 100% custom — no native headers anywhere.
 */

import { Bell, ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import React, { createContext, useContext } from "react";
import {
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionPill, TypeCaption, TypeDisplay, TypeTitle } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { useUnread } from "@/features/activity";

// ── the tab-bar inset context (the tabs layout provides; 0 outside tabs) ────

export const TabBarInsetContext = createContext<number>(0);

/** The content inset the floating tab bar demands (DESIGN.md §5). */
export function useTabBarInset(): number {
  return useContext(TabBarInsetContext);
}

export interface ScreenScaffoldProps {
  title: string;
  /** The caption line under a large title (tab roots). */
  subtitle?: string;
  /** Large-title header (tab roots); default = compact when back, large when not. */
  large?: boolean;
  /** Renders the back chevron and pops the stack (default: false). */
  back?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** Wrap the body in a ScrollView (default true). */
  scroll?: boolean;
  /** Pull-to-refresh, wired to the scroll body (the screens own the state). */
  refreshControl?: React.ReactElement<RefreshControlProps>;
  /** Extra bottom padding beyond the tab-bar inset (composer clearance etc.). */
  bottomInset?: number;
  /** Keyboard-aware scroll (default true — the input screens need it). */
  keyboardAware?: boolean;
  /** Hide the connection pill (the connect flow itself). */
  noPill?: boolean;
}

export function ScreenScaffold({
  title,
  subtitle,
  large,
  back = false,
  right,
  children,
  scroll = true,
  refreshControl,
  bottomInset = 0,
  keyboardAware = true,
  noPill = false,
}: ScreenScaffoldProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { status } = useLink();
  const unread = useUnread();

  const isLarge = large ?? !back;
  const pillVisible = !noPill;

  const bottomPad = tabBarInset + bottomInset + Math.max(insets.bottom - tabBarInset, 0);
  const Body = scroll ? (keyboardAware ? KeyboardAwareScrollView : ScrollView) : View;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      {isLarge ? (
        // ── the large header: pill + bell row, then the display title ──
        <View style={styles.largeHeader}>
          <View style={styles.largeTopRow}>
            {pillVisible ? (
              <ConnectionPill status={status} onPress={() => router.push("/connect")} />
            ) : (
              <View />
            )}
            <Pressable
              accessibilityLabel={`activity${unread > 0 ? `, ${unread} unread` : ""}`}
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.push("/activity")}
              style={styles.bellTarget}
            >
              <Bell size={22} color={tokens.text} strokeWidth={2} />
              {unread > 0 ? (
                <View
                  style={[styles.unreadDot, { backgroundColor: tokens.accent }]}
                  accessibilityLabel={`${unread} unread notifications`}
                />
              ) : null}
            </Pressable>
          </View>
          <TypeDisplay style={styles.largeTitle} numberOfLines={1}>
            {title}
          </TypeDisplay>
          {subtitle ? (
            <TypeCaption numberOfLines={1}>{subtitle}</TypeCaption>
          ) : null}
        </View>
      ) : (
        // ── the compact header: back | centered title | pill (+right slot) ──
        <View style={styles.headerRow}>
          {back ? (
            <Pressable
              accessibilityLabel="Go back"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
              style={styles.backTarget}
            >
              <ChevronLeft size={26} color={tokens.text} strokeWidth={2} />
            </Pressable>
          ) : (
            <View style={styles.backTarget} />
          )}
          <View style={styles.compactTitleWrap}>
            <TypeTitle style={styles.compactTitle} numberOfLines={1}>
              {title}
            </TypeTitle>
            {subtitle ? (
              <TypeCaption style={styles.compactSubtitle} numberOfLines={1}>
                {subtitle}
              </TypeCaption>
            ) : null}
          </View>
          {right ? <View style={styles.rightSlot}>{right}</View> : null}
          {pillVisible ? (
            <ConnectionPill status={status} compact onPress={() => router.push("/connect")} />
          ) : null}
        </View>
      )}
      <Body
        style={{ flex: 1, backgroundColor: tokens.bg }}
        {...(scroll
          ? {
              contentContainerStyle: [
                styles.bodyContent,
                { backgroundColor: tokens.bg, paddingBottom: Math.max(bottomPad, spacing.xl) + spacing.lg },
              ],
              contentInsetAdjustmentBehavior: "automatic",
              refreshControl,
            }
          : { style: [{ flex: 1, backgroundColor: tokens.bg }] })}
      >
        {children}
      </Body>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  largeHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  largeTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 40,
  },
  largeTitle: { marginTop: spacing.xs },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
  },
  backTarget: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  compactTitleWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  compactTitle: { textAlign: "center" },
  compactSubtitle: { textAlign: "center" },
  rightSlot: { minWidth: 44, alignItems: "center", justifyContent: "center" },
  bellTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  unreadDot: {
    position: "absolute",
    top: 7,
    right: 8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  bodyContent: { padding: spacing.lg, gap: spacing.lg },
});
