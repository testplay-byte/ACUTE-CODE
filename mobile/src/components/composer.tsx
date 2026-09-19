/**
 * Composer v2 (R109) — the session screen's sticky bottom in the clay
 * language: ONE growing TextInput (max ~5 lines) + the SEND button as the
 * sanctioned chrome CTA (accent circle with the quiet sheen). While a turn
 * runs, Send becomes Stop (+ Queue); while the link is offline, Send lands
 * the message in the outbox — and the outbox chip now carries its own
 * DISMISS affordance (the owner's "manage everything" ask — a wrong
 * queued message can be taken back). Keyboard-aware via the screen's
 * KeyboardAvoidingView; touch targets ≥ 44px; the send haptic.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowUp, ListPlus, Square, X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeCaption } from "@/design/primitives";
import { successHaptic } from "@/design/haptics";
import {
  pressTint,
  RADIUS_INPUT,
  RADIUS_ROUND,
  fontFamily,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
} from "@/design/tokens";

export type ComposerMode = "compose" | "running" | "offline";

export interface ComposerProps {
  mode: ComposerMode;
  /** The pending outbox entries for THIS session (the dim chip). */
  outboxCount: number;
  onSend: (content: string) => void;
  onStop: () => void;
  onQueue: (content: string) => void;
  /** Dismiss the queued offline messages for this session (the X on the chip). */
  onDismissOutbox?: () => void;
}

const MAX_INPUT_HEIGHT = 5 * 21 + 16; // ~5 lines at 21pt line height + padding

export function Composer({
  mode,
  outboxCount,
  onSend,
  onStop,
  onQueue,
  onDismissOutbox,
}: ComposerProps) {
  const { tokens } = useTheme();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
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
    void successHaptic();
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
    <View style={[styles.root, { borderTopColor: tokens.borderSubtle }]}>
      {mode === "offline" && outboxCount === 0 && (
        <View style={styles.chipRow}>
          <TypeCaption style={{ color: tokens.textTertiary }}>
            host offline — messages will send when the host returns
          </TypeCaption>
        </View>
      )}
      {outboxCount > 0 && (
        <View style={styles.chipRow}>
          <View
            style={[
              styles.chip,
              { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle },
            ]}
          >
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {outboxCount} message{outboxCount === 1 ? "" : "s"} will send when the host returns
            </TypeCaption>
            {onDismissOutbox !== undefined ? (
              <Pressable
                accessibilityLabel="Dismiss the queued offline messages"
                accessibilityRole="button"
                hitSlop={8}
                onPress={onDismissOutbox}
                style={styles.chipX}
              >
                <X size={13} color={tokens.textTertiary} strokeWidth={2.4} />
              </Pressable>
            ) : null}
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onContentSizeChange={(event) => {
            const height = event.nativeEvent.contentSize.height;
            setInputHeight(Math.min(height, MAX_INPUT_HEIGHT));
          }}
          placeholder={running ? "Queue a message behind the running turn…" : "Message the agent…"}
          placeholderTextColor={tokens.textTertiary}
          style={[
            styles.input,
            {
              backgroundColor: tokens.card,
              borderColor: focused ? tokens.accent : tokens.inputBorder,
              borderTopColor: tokens.clayTopEdge,
              color: tokens.text,
              fontFamily: fontFamily.medium,
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
                  backgroundColor: tokens.card,
                  borderTopColor: tokens.clayTopEdge,
                  borderColor: pressed ? pressTint(tokens.card, tokens.isDark) : tokens.borderStrong,
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
          // The send CTA — the sanctioned chrome circle (§2.2): accent fill
          // + the quiet vertical sheen, one glint, never a mirror.
          <Pressable
            accessibilityLabel={mode === "offline" ? "Save the message to send later" : "Send the message"}
            accessibilityRole="button"
            accessibilityState={canSend ? undefined : { disabled: true }}
            disabled={!canSend}
            onPress={sendNow}
            style={({ pressed }) => [
              styles.sendButton,
              {
                backgroundColor: canSend ? tokens.accent : tokens.subtleHover,
                transform: [{ scale: pressed && canSend ? 0.96 : 1 }],
              },
            ]}
          >
            {canSend ? (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <LinearGradient
                  colors={[tokens.sheenTop, tokens.sheenBottom]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={styles.sendSheen}
                />
              </View>
            ) : null}
            <ArrowUp
              size={TYPE_BODY + 6}
              color={canSend ? tokens.accentText : tokens.textTertiary}
              strokeWidth={2.4}
            />
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
    borderRadius: RADIUS_ROUND,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  chipX: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    fontSize: TYPE_BODY,
    lineHeight: 21,
    minHeight: 50,
  },
  sendButton: {
    width: 50,
    height: 50,
    borderRadius: RADIUS_ROUND,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  sendSheen: {
    flex: 1,
    height: "60%",
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
  },
  runningButtons: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  queueButton: {
    width: 50,
    height: 50,
    borderRadius: RADIUS_ROUND,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    height: 50,
    paddingHorizontal: spacing.md,
    borderRadius: RADIUS_ROUND,
    borderWidth: 1,
    justifyContent: "center",
  },
  stopLabel: {
    fontSize: TYPE_CAPTION + 2,
    fontFamily: fontFamily.semibold,
  },
});
