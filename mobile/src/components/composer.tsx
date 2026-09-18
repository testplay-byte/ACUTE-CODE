/**
 * Composer — the session screen's sticky bottom: ONE growing TextInput
 * (max ~5 lines) + Send. While a turn runs, Send becomes Stop (+ Queue);
 * while the link is offline, Send lands the message in the outbox (the dim
 * "will send when the host returns" chip shows the queue). Keyboard-aware
 * (the screen wraps it in KeyboardAvoidingView); touch targets ≥ 44px.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowUp, ListPlus, Square } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption } from "@/design/primitives";
import { pressTint, RADIUS_CARD, RADIUS_PILL, spacing, TYPE_BODY, TYPE_CAPTION, fontStack } from "@/design/tokens";

export type ComposerMode = "compose" | "running" | "offline";

export interface ComposerProps {
  mode: ComposerMode;
  /** The pending outbox entries for THIS session (the dim chip). */
  outboxCount: number;
  onSend: (content: string) => void;
  onStop: () => void;
  onQueue: (content: string) => void;
}

const MAX_INPUT_HEIGHT = 5 * 20 + 16; // ~5 lines at 20pt line height + padding

export function Composer({ mode, outboxCount, onSend, onStop, onQueue }: ComposerProps) {
  const { tokens } = useTheme();
  const [draft, setDraft] = useState("");
  const [inputHeight, setInputHeight] = useState<number | null>(null);

  // The draft survives mode changes — the user's typing is theirs; only
  // delivery changed (send → queue → outbox).

  const canSend = draft.trim() !== "";
  const running = mode === "running";

  const sendNow = (): void => {
    if (!canSend) return;
    const content = draft;
    setDraft("");
    setInputHeight(null);
    onSend(content);
  };

  const queueNow = (): void => {
    if (!canSend) return;
    const content = draft;
    setDraft("");
    setInputHeight(null);
    onQueue(content);
  };

  return (
    <View style={[styles.root, { borderColor: tokens.borderSubtle }]}>
      {mode === "offline" && outboxCount === 0 && (
        <View style={styles.chipRow}>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            host offline — messages will send when the host returns
          </TypeCaption>
        </View>
      )}
      {outboxCount > 0 && (
        <View style={styles.chipRow}>
          <View style={[styles.chip, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}>
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {outboxCount} message{outboxCount === 1 ? "" : "s"} will send when the host returns
            </TypeCaption>
          </View>
        </View>
      )}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Message the agent"
          accessibilityHint={
            running
              ? "A turn is running — queue behind it or stop it"
              : mode === "offline"
                ? "The host is offline — the message will be sent when it returns"
                : "Send this message to the agent on the desktop"
          }
          multiline
          value={draft}
          onChangeText={setDraft}
          onContentSizeChange={(event) => {
            const height = event.nativeEvent.contentSize.height;
            setInputHeight(Math.min(height, MAX_INPUT_HEIGHT));
          }}
          placeholder={running ? "Queue a message behind the running turn…" : "Message the agent…"}
          placeholderTextColor={tokens.textTertiary}
          style={[
            styles.input,
            {
              backgroundColor: tokens.inputBg,
              borderColor: tokens.inputBorder,
              color: tokens.text,
              fontFamily: fontStack.sans,
            },
            inputHeight !== null ? { height: inputHeight + 16 } : null,
          ]}
        />
        {running ? (
          <View style={styles.runningButtons}>
            <Pressable
              accessibilityLabel="Queue this message behind the running turn"
              accessibilityRole="button"
              accessibilityState={canSend ? undefined : { disabled: true }}
              disabled={!canSend}
              onPress={queueNow}
              style={({ pressed }) => [
                styles.queueButton,
                {
                  borderColor: tokens.borderStrong,
                  backgroundColor: pressed ? pressTint(tokens.card, tokens.isDark) : "transparent",
                  opacity: canSend ? 1 : 0.45,
                },
              ]}
            >
              <ListPlus size={TYPE_BODY + 3} color={tokens.textSecondary} strokeWidth={2} />
            </Pressable>
            <Pressable
              accessibilityLabel="Stop the running turn"
              accessibilityRole="button"
              onPress={onStop}
              style={({ pressed }) => [
                styles.stopButton,
                {
                  borderColor: tokens.danger,
                  backgroundColor: pressed ? pressTint(tokens.card, tokens.isDark) : "transparent",
                },
              ]}
            >
              <Square size={TYPE_BODY - 2} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
              <Text style={[styles.stopLabel, { color: tokens.danger }]}>Stop</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityLabel={mode === "offline" ? "Save the message to send later" : "Send the message"}
            accessibilityRole="button"
            accessibilityState={canSend ? undefined : { disabled: true }}
            disabled={!canSend}
            onPress={sendNow}
            style={({ pressed }) => [
              styles.sendButton,
              {
                backgroundColor: canSend ? tokens.accent : tokens.subtle,
                borderColor: pressed && canSend ? pressTint(tokens.accent, tokens.isDark) : "transparent",
              },
            ]}
          >
            <ArrowUp size={TYPE_BODY + 6} color={canSend ? tokens.accentText : tokens.textTertiary} strokeWidth={2.4} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  chipRow: {
    alignItems: "center",
  },
  chip: {
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: TYPE_BODY,
    minHeight: 48,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: RADIUS_PILL,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  runningButtons: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  queueButton: {
    width: 48,
    height: 48,
    borderRadius: RADIUS_PILL,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: RADIUS_PILL,
    borderWidth: 1,
    justifyContent: "center",
  },
  stopLabel: {
    fontSize: TYPE_CAPTION + 2,
    fontFamily: fontStack.sans,
    fontWeight: "600",
  },
});
