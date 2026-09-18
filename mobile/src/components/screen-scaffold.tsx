/**
 * ScreenScaffold — the shared screen chrome: safe-area top, the quiet
 * custom header (back chevron when pushed, title, right slot, hairline),
 * and the scroll body. 100% custom — no native headers anywhere.
 */

import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design/theme";
import { Hairline, TypeTitle } from "@/design/primitives";
import { spacing, TYPE_TITLE } from "@/design/tokens";

export interface ScreenScaffoldProps {
  title: string;
  /** Renders the back chevron and pops the stack (default: when provided). */
  back?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** Wrap the body in a ScrollView (default true). */
  scroll?: boolean;
}

export function ScreenScaffold({ title, back = true, right, children, scroll = true }: ScreenScaffoldProps) {
  const { tokens } = useTheme();
  const router = useRouter();

  const Body = scroll ? ScrollView : View;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top"]}>
      <View style={styles.headerRow}>
        {back ? (
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => router.back()}
            style={styles.backTarget}
          >
            <ChevronLeft size={TYPE_TITLE + 6} color={tokens.text} strokeWidth={2} />
          </Pressable>
        ) : (
          <View style={styles.backTarget} />
        )}
        <TypeTitle style={styles.title} numberOfLines={1}>
          {title}
        </TypeTitle>
        <View style={styles.backTarget}>{right}</View>
      </View>
      <Hairline />
      <Body
        style={{ flex: 1 }}
        {...(scroll
          ? { contentContainerStyle: [styles.bodyContent, { backgroundColor: tokens.bg }] }
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
    height: 52,
    paddingHorizontal: spacing.sm,
  },
  backTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
  bodyContent: { padding: spacing.lg, gap: spacing.lg },
});
