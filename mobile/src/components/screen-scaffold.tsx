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
 *
 * R116-b — the round-116 header grammar: the title (+subtitle) is now
 * ABSOLUTELY centered over the whole header row (donts.md #32 — a title
 * centered in the space remaining beside the side slots is not centered);
 * the overlay is pointerEvents-none so the side slots stay tappable, and
 * the text carries numberOfLines 1 + ellipsizeMode tail + a 72%-of-screen
 * maxWidth so long titles never collide with the slots. The back button is
 * a proper CHIP now (donts.md #41): the 44px target gains a subtle fill +
 * hairline border + the chip radius. `tabBarAware` joins the vocabulary
 * (opt OUT of the floating bar's inset; default true — today's behavior).
 *
 * R117-g2 (AMENDMENT 5 — the rhythm, round-117-elevation.md §2.1): the
 * bodyContent gap drops 16 → spacing.md (12) — the intra-group beat. The
 * 32 px section break is SectionHeader's own marginTop (spacing.xl 20) +
 * this 12 — two rhythms instead of the uniform 16 px phrase. Gutters stay
 * 16 (the body padding); card padding stays lg/md/xl.
 */

import { Bell, ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import React, { createContext, useContext } from "react";
import {
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionPill } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { fontFamily, RADIUS_CHIP, spacing, TYPE_CAPTION, TYPE_TITLE } from "@/design/tokens";
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
  /**
   * R116-b: account for the floating tab bar's bottom inset (default true —
   * the inset arrives via TabBarInsetContext, 0 outside the tabs host). Pass
   * false for a tab-hosted screen that deliberately bleeds to the bottom
   * edge: the bar's inset is ignored (the safe-area floor still applies).
   */
  tabBarAware?: boolean;
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
  tabBarAware = true,
}: ScreenScaffoldProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const tabBarInset = useTabBarInset();
  const { status } = useLink();
  const unread = useUnread();

  const pillVisible = chrome && !noPill;

  // R116-b — tabBarAware=false opts out of the floating bar's inset (the
  // safe-area floor still applies); the default is byte-identical to R115.
  const barInset = tabBarAware ? tabBarInset : 0;
  const bottomPad = barInset + bottomInset + Math.max(insets.bottom - barInset, 0);
  const Body = scroll ? (keyboardAware ? KeyboardAwareScrollView : ScrollView) : View;

  // R116-b — the centered title's budget: 72% of the screen, so a long title
  // ellipsizes (tail) instead of colliding with the side slots.
  const titleMaxWidth = Math.round(windowWidth * 0.72);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top", "left", "right"]}>
      {/* ── the ONE compact header: back | bell · centered title · right · pill ──
          (R114-c: chrome={false} renders NO row — the tab roots are header-free;
           R116-b: the title is absolutely centered over the WHOLE row, the back
           button is a chip, the spacer keeps the right side flush right) */}
      {chrome ? (
        <View style={styles.headerRow}>
          {back ? (
            <Pressable
              accessibilityLabel="Go back"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
              style={[
                styles.sideTarget,
                styles.backChip,
                { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle },
              ]}
              testID="scaffold-back"
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
          {/* R116-b — the spacer: the title no longer lives in the flex flow,
              so this keeps the right slot + pill flush right. */}
          <View style={styles.titleSpacer} />
          {right ? <View style={styles.rightSlot}>{right}</View> : null}
          {pillVisible ? (
            <ConnectionPill status={status} compact onPress={() => router.push("/connect")} />
          ) : null}
          {/* R116-b — the ABSOLUTELY centered title (donts.md #32): overlays the
              whole header row, pointerEvents none so the side slots stay
              tappable; the texts carry numberOfLines 1 + tail ellipsis + a
              72%-of-screen maxWidth so long titles never collide. The type
              recipes are TypeTitle/TypeCaption's exact token ladder. */}
          <View pointerEvents="none" style={styles.titleOverlay}>
            <Text
              ellipsizeMode="tail"
              numberOfLines={1}
              style={[styles.title, { color: tokens.text, maxWidth: titleMaxWidth }]}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text
                ellipsizeMode="tail"
                numberOfLines={1}
                style={[styles.subtitle, { color: tokens.textSecondary, maxWidth: titleMaxWidth }]}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
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
  /**
   * R116-b — the back CHIP (donts.md #41): the 44px target gains a subtle
   * fill + hairline border + the chip radius; the chevron is unchanged.
   * The fill/border colors ride the theme tokens (inline).
   */
  backChip: {
    borderRadius: RADIUS_CHIP,
    borderWidth: StyleSheet.hairlineWidth,
  },
  /** R116-b — the flex spacer (the title left the flow to center absolutely). */
  titleSpacer: { flex: 1 },
  /**
   * R116-b — the absolutely centered title: spans the whole header row so
   * the title centers over the SCREEN, not the space beside the slots.
   * pointerEvents none (set on the View prop) keeps the slots tappable.
   */
  titleOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  /** TypeTitle's exact recipe (20/700, −0.2 tracking) as a raw Text so the
   * tail-ellipsis + maxWidth can be pinned directly (R116-b). */
  title: {
    textAlign: "center",
    fontSize: TYPE_TITLE,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.2,
  },
  /** TypeCaption's exact recipe (12.5/500, 18 leading — R117-g1's caption
   *  lineHeight) — same treatment. */
  subtitle: {
    textAlign: "center",
    fontSize: TYPE_CAPTION,
    fontFamily: fontFamily.medium,
    lineHeight: 18,
  },
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
  /** R117-g2 (AMENDMENT 5): the intra-group beat is 12 (was 16); section
   *  breaks read 32 via SectionHeader's marginTop (20) + this gap. */
  bodyContent: { padding: spacing.lg, gap: spacing.md },
  /** The chromeless breathing room — extra top padding so the content's
   * first card sits clear of the status-bar inset (DESIGN.md §5's gutters). */
  bodyContentChromeless: { paddingTop: spacing.xxl },
});
