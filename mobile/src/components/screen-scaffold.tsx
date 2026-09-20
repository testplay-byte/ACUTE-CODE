/**
 * ScreenScaffold — the shared screen chrome (DESIGN.md §5/§6): edge-to-edge
 * safe areas top AND bottom, the ONE compact header row (R113-e: the owner's
 * "at the very top on every single one of the screens it shows the
 * headings… takes up way too much important space" — the large TypeDisplay
 * header tier is DEAD; every screen, tab roots included, renders the same
 * 56px row: back-or-bell · title · right slot · the CONNECTION PILL), and
 * the keyboard-aware scroll body. 100% custom — no native headers anywhere.
 *
 * The compact idiom (R113-e):
 *   · pushed screens — back chevron, centered title (+ optional caption),
 *     the right slot, the pill;
 *   · tab roots — the ACTIVITY BELL in the back slot (44px target, the
 *     unread dot rides it), the same title row, the pill. No TypeDisplay,
 *     no subtitles like "usage, tokens, costs, health" — the content is the
 *     screen's top now (home's host hero, the dashboard's stat cards…).
 *
 * R114-c — the header-free tab roots (the owner: "the live status and the
 * notification at the top are unnecessary; the Dashboard/Approvals/Projects
 * headings are not needed — free the space"): `chrome={false}` kills the
 * whole 56px row — no title, no bell, no pill. The content starts below
 * the status-bar safe-area inset with a small breathing padding. The bell's
 * job moved into Home's Activity row (unread-gated); the pill's honesty
 * moved into Home's offline/connecting banner — every other screen already
 * handles staleness through pull-to-refresh + reconnect reloads. Pushed
 * screens (session, settings subpages, connect flows) KEEP their headers.
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
import { ConnectionPill, TypeCaption, TypeTitle } from "@/design/primitives";
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
  /** The small caption under the title (pushed screens' context line — the
   * session status, the provider kind; tab roots pass none, the content
   * speaks). */
  subtitle?: string;
  /** Renders the back chevron and pops the stack (default: false — tab
   * roots show the activity bell in the same slot instead). */
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
  /**
   * R114-c: render the header row at all (default true). The FIVE tab roots
   * pass chrome={false} — no title, no bell, no pill; the content starts
   * below the status-bar inset with breathing padding. Pushed screens keep
   * the full row (back chevron etc.).
   */
  chrome?: boolean;
}

export function ScreenScaffold({
  title,
  subtitle,
  back = false,
  right,
  children,
  scroll = true,
  refreshControl,
  bottomInset = 0,
  keyboardAware = true,
  noPill = false,
  chrome = true,
}: ScreenScaffoldProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { status } = useLink();
  const unread = useUnread();

  const pillVisible = chrome && !noPill;

  const bottomPad = tabBarInset + bottomInset + Math.max(insets.bottom - tabBarInset, 0);
  const Body = scroll ? (keyboardAware ? KeyboardAwareScrollView : ScrollView) : View;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      {/* ── the ONE compact header: back | bell · centered title · right · pill ──
          (R114-c: chrome={false} renders NO row — the tab roots are header-free) */}
      {chrome ? (
        <View style={styles.headerRow}>
          {back ? (
            <Pressable
              accessibilityLabel="Go back"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
              style={styles.sideTarget}
            >
              <ChevronLeft size={26} color={tokens.text} strokeWidth={2} />
            </Pressable>
          ) : (
            // The tab roots' bell — the notifications entry (the pushed screens
            // reach it through their own tab root underneath).
            <Pressable
              accessibilityLabel={`activity${unread > 0 ? `, ${unread} unread` : ""}`}
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.push("/activity")}
              style={styles.sideTarget}
            >
              <Bell size={22} color={tokens.text} strokeWidth={2} />
              {unread > 0 ? (
                <View
                  style={[styles.unreadDot, { backgroundColor: tokens.accent }]}
                  accessibilityLabel={`${unread} unread notifications`}
                />
              ) : null}
            </Pressable>
          )}
          <View style={styles.titleWrap}>
            <TypeTitle style={styles.title} numberOfLines={1}>
              {title}
            </TypeTitle>
            {subtitle ? (
              <TypeCaption style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </TypeCaption>
            ) : null}
          </View>
          {right ? <View style={styles.rightSlot}>{right}</View> : null}
          {pillVisible ? (
            <ConnectionPill status={status} compact onPress={() => router.push("/connect")} />
          ) : null}
        </View>
      ) : null}
      <Body
        style={{ flex: 1, backgroundColor: tokens.bg }}
        {...(scroll
          ? {
              contentContainerStyle: [
                styles.bodyContent,
                // R114-c: header-free roots breathe under the status-bar
                // inset — the first card never kisses the safe area's edge.
                !chrome ? styles.bodyContentChromeless : null,
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
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
  },
  /** The 44px side target: the back chevron (pushed screens) or the bell
   * (tab roots) — one discipline, one width. */
  sideTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  titleWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { textAlign: "center" },
  subtitle: { textAlign: "center" },
  rightSlot: { minWidth: 44, alignItems: "center", justifyContent: "center" },
  unreadDot: {
    position: "absolute",
    top: 5,
    right: 5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  bodyContent: { padding: spacing.lg, gap: spacing.lg },
  /** The chromeless breathing room — extra top padding so the content's
   * first card sits clear of the status-bar inset (DESIGN.md §5's gutters). */
  bodyContentChromeless: { paddingTop: spacing.xxl },
});
