/**
 * BootErrorBoundary — the root safety net (R108).
 *
 * v0.103.0's splash-forever failure mode had NO on-device surface: if JS
 * threw before the first render, the user saw the logo and nothing else,
 * and the only path to truth was logcat on a dev machine. This boundary is
 * the app's own crash screen — rendered OUTSIDE the theme provider (a broken
 * theme must not break the crash screen too), hard-styled with plain values
 * (no tokens, no fonts to load), showing:
 *
 *   · the fatal error (message + stack, scrollable)
 *   · the boot breadcrumb trail (how far startup got)
 *   · the logcat hint (the one line an owner can hand to a debugger)
 *
 * It also force-hides the splash (a crash must never leave the logo parked)
 * and offers RETRY (re-mount the children — transient failures get one
 * honest second chance without a full app restart).
 */

import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { bootIdentity, getBootError, getBootTrace, recordBootError } from "@/features/boot-log";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: string | null;
  /** Bumped by RETRY — re-mounts the children (the honest second chance). */
  attempt: number;
}

export class BootErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // Record synchronously too — render-phase logging via componentDidCatch
    // is fine, but the record should exist even if logging itself then fails.
    recordBootError(error);
    return { error: getBootError() };
  }

  componentDidCatch(error: unknown): void {
    recordBootError(error);
    // A crash must never leave the splash parked over the crash screen.
    void SplashScreen.hideAsync().catch(() => {});
  }

  private retry = () => {
    this.setState({ error: null, attempt: this.state.attempt + 1 });
  };

  render() {
    if (this.state.error === null) {
      return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    }
    const trace = getBootTrace();
    return (
      <View style={styles.root}>
        <Text style={styles.title}>ACUTE could not start</Text>
        <Text style={styles.subtitle}>{bootIdentity()}</Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.section}>Error</Text>
          <Text style={styles.mono}>{this.state.error}</Text>
          {trace.length > 0 ? (
            <>
              <Text style={styles.section}>Startup trail</Text>
              <Text style={styles.mono}>{trace}</Text>
            </>
          ) : null}
          <Text style={styles.section}>For debugging</Text>
          <Text style={styles.mono}>
            {`Android Studio → Logcat, filter:\npackage:com.acutecode.companion\n(look for lines starting with [ACUTE-BOOT])`}
          </Text>
        </ScrollView>
        <TouchableOpacity style={styles.button} onPress={this.retry} accessibilityRole="button" accessibilityLabel="Retry starting ACUTE">
          <Text style={styles.buttonText}>RETRY</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

// Hard values ON PURPOSE — the boundary must render when the theme system,
// the font stack, or anything downstream of the tokens is what broke.
// Neutral dark-on-light, generous contrast, the app's own radius grammar.
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#FFFBF0",
    paddingTop: 72,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  title: {
    fontSize: 21,
    fontWeight: "700",
    color: "#111111",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: "#666666",
    marginBottom: 16,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  section: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: "#FF6B2C",
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 6,
  },
  mono: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    color: "#333333",
  },
  button: {
    marginTop: 16,
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    color: "#FFFBF0",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
