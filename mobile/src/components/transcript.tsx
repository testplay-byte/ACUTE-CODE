/**
 * Transcript — the session's rendered event log: user bubbles (right),
 * assistant text (per-delta fade-in-up while streaming), tool cards (mono
 * name + compact args + ok/FAIL), the collapsible dim thinking block,
 * approval mini-cards, dim meta lines, and honest error cards. One renderer
 * for BOTH sources — the persisted fold and the live stream produce the same
 * TranscriptItem union (features/sessions.ts); the rehydrate replaces the
 * live list wholesale, so the truth always renders through here.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Badge, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { ENTRANCE_DELTA, SPRING } from "@/design/motion";
import {
  RADIUS_CARD,
  RADIUS_PILL,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
  fontStack,
} from "@/design/tokens";
import type { TranscriptItem } from "@/features/sessions";

// ── the list ────────────────────────────────────────────────────────────────

/** The plain (non-virtualized) list — small transcripts + tests. */
export function TranscriptList({
  items,
  onApprovalDecide,
}: {
  items: TranscriptItem[];
  onApprovalDecide?: (approvalId: string) => void;
}) {
  return (
    <View style={styles.list} accessibilityLabel="Conversation transcript">
      {items.map((item) => (
        <TranscriptItemView key={item.key} item={item} onApprovalDecide={onApprovalDecide} />
      ))}
    </View>
  );
}

/** One row — exported for the session screen's inverted FlatList. */
export function TranscriptItemView({
  item,
  onApprovalDecide,
}: {
  item: TranscriptItem;
  onApprovalDecide?: (approvalId: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return <UserBubble content={item.content} queued={item.queued} />;
    case "assistant":
      return <AssistantBlock item={item} />;
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalMini item={item} onDecide={onApprovalDecide} />;
    case "meta":
      return <MetaLine text={item.text} />;
    case "error":
      return <ErrorCard code={item.code} message={item.message} />;
    case "debug":
      return <DebugBlock content={item.content} live={item.live} />;
  }
}

// ── user ────────────────────────────────────────────────────────────────────

function UserBubble({ content, queued }: { content: string; queued: boolean }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.userRow}>
      <View
        accessibilityLabel={queued ? "Queued message" : "Your message"}
        style={[
          styles.userBubble,
          {
            backgroundColor: queued ? tokens.subtle : tokens.selectedBg,
            borderColor: queued ? tokens.border : "transparent",
          },
        ]}
      >
        {queued && (
          <View style={{ marginBottom: spacing.xs }}>
            <Badge tone="neutral">queued</Badge>
          </View>
        )}
        <Text
          style={{
            color: queued ? tokens.text : tokens.selectedText,
            fontSize: TYPE_BODY,
            fontFamily: fontStack.sans,
            lineHeight: 19,
          }}
        >
          {content}
        </Text>
      </View>
    </View>
  );
}

// ── assistant (with the live per-delta entrance) ───────────────────────────

function AssistantBlock({ item }: { item: TranscriptItem & { kind: "assistant" } }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.block} accessibilityLabel="Assistant message">
      {item.thinking !== null && item.thinking !== "" && (
        <ThinkingBlock text={item.thinking} live={item.live} />
      )}
      {item.live && item.chunks !== null ? (
        <View style={styles.assistantText}>
          {item.chunks.map((chunk, index) => (
            <DeltaText key={index}>{chunk}</DeltaText>
          ))}
        </View>
      ) : item.content !== "" ? (
        <Text
          style={{
            color: tokens.text,
            fontSize: TYPE_BODY,
            fontFamily: fontStack.sans,
            lineHeight: 19,
          }}
        >
          {item.content}
        </Text>
      ) : null}
      {item.model !== null && !item.live && (
        <TypeMono style={{ color: tokens.textTertiary, marginTop: spacing.xs }}>
          {item.model}
        </TypeMono>
      )}
    </View>
  );
}

/** One streaming delta — its own fade-in-up entrance, the one spring. */
function DeltaText({ children }: { children: string }) {
  const { tokens } = useTheme();
  const entered = useSharedValue(0);
  useEffect(() => {
    entered.value = withSpring(1, SPRING);
  }, [entered]);
  const animated = useAnimatedStyle(() => ({
    opacity: entered.value,
    transform: [{ translateY: (1 - entered.value) * ENTRANCE_DELTA }],
  }));
  return (
    <Animated.Text style={[styles.deltaText, animated, { color: tokens.text }]}>{children}</Animated.Text>
  );
}

// ── thinking (collapsible dim block) ────────────────────────────────────────

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const { tokens } = useTheme();
  const [open, setOpen] = useState(live);
  return (
    <View style={[styles.thinking, { borderColor: tokens.borderSubtle }]}>
      <Pressable
        accessibilityLabel={open ? "Hide the agent's thinking" : "Show the agent's thinking"}
        accessibilityRole="button"
        onPress={() => setOpen((value) => !value)}
        style={styles.thinkingHead}
      >
        <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }}>
          {live ? "thinking…" : "thinking"}
        </TypeCaption>
        {open ? (
          <ChevronUp size={TYPE_CAPTION + 5} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={TYPE_CAPTION + 5} color={tokens.textTertiary} strokeWidth={2} />
        )}
      </Pressable>
      {open && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={live ? undefined : 12}>
          {text}
        </TypeMono>
      )}
    </View>
  );
}

// ── tool ────────────────────────────────────────────────────────────────────

function ToolCard({ item }: { item: TranscriptItem & { kind: "tool" } }) {
  const { tokens } = useTheme();
  const failed = item.ok === false;
  const running = item.ok === null;
  return (
    <View
      accessibilityLabel={`Tool ${item.toolName}${running ? " running" : failed ? " failed" : " succeeded"}`}
      style={[styles.toolCard, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}
    >
      <View style={styles.toolHead}>
        <TypeMono style={{ color: tokens.text, fontWeight: "600" }}>{item.toolName}</TypeMono>
        <View style={{ flex: 1 }} />
        {running ? (
          <Badge tone="warning">running</Badge>
        ) : failed ? (
          <Badge tone="danger">FAIL</Badge>
        ) : (
          <Badge tone="neutral">ok</Badge>
        )}
      </View>
      {item.argsSummary !== "" && (
        <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={3}>
          {item.argsSummary}
        </TypeMono>
      )}
      {item.outputTail !== null && item.outputTail !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={8}>
          {item.outputTail}
        </TypeMono>
      )}
      {item.outputSummary !== null && item.outputSummary !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={6}>
          {item.outputSummary}
        </TypeMono>
      )}
    </View>
  );
}

// ── approval mini-card ──────────────────────────────────────────────────────

function ApprovalMini({
  item,
  onDecide,
}: {
  item: TranscriptItem & { kind: "approval" };
  onDecide?: (approvalId: string) => void;
}) {
  const { tokens } = useTheme();
  const decision =
    item.decision === "approved"
      ? "approved"
      : item.decision === "denied"
        ? "denied"
        : item.decision === "expired"
          ? "expired"
          : null;
  const pending = decision === null;
  return (
    <View
      style={[styles.toolCard, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}
      accessibilityLabel={`Approval ${item.toolName} ${decision ?? "waiting"}`}
    >
      <View style={styles.toolHead}>
        <TypeMono style={{ color: tokens.text, fontWeight: "600" }}>{item.toolName}</TypeMono>
        <View style={{ flex: 1 }} />
        {pending ? (
          <Badge tone="warning">waiting</Badge>
        ) : (
          <Badge tone={decision === "approved" ? "accent" : "danger"}>{decision}</Badge>
        )}
      </View>
      {item.argsSummary !== "" && (
        <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={3}>
          {item.argsSummary}
        </TypeMono>
      )}
      {pending && onDecide !== undefined && (
        <Pressable
          accessibilityLabel="Open the approvals inbox"
          accessibilityRole="button"
          onPress={() => onDecide(item.approvalId)}
          style={styles.miniLink}
        >
          <TypeCaption style={{ color: tokens.accent, fontWeight: "600" }}>
            decide in the approvals inbox →
          </TypeCaption>
        </Pressable>
      )}
    </View>
  );
}

// ── meta / error / debug ────────────────────────────────────────────────────

function MetaLine({ text }: { text: string }) {
  const { tokens } = useTheme();
  return (
    <TypeCaption
      accessibilityLabel={text}
      style={{ color: tokens.textTertiary, textAlign: "center", alignSelf: "center", maxWidth: 320 }}
    >
      {text}
    </TypeCaption>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  const { tokens } = useTheme();
  return (
    <View
      accessibilityLabel={`Error: ${message}`}
      style={[styles.toolCard, { borderColor: tokens.danger }]}
    >
      <View style={styles.toolHead}>
        <TypeMono style={{ color: tokens.danger, fontWeight: "600" }}>{code}</TypeMono>
      </View>
      <TypeBody style={{ color: tokens.textSecondary }}>{message}</TypeBody>
    </View>
  );
}

function DebugBlock({ content, live }: { content: string; live: boolean }) {
  const { tokens } = useTheme();
  const [open, setOpen] = useState(false);
  if (content === "") {
    return <MetaLine text="the debug analyst is running…" />;
  }
  return (
    <View style={[styles.thinking, { borderColor: tokens.borderSubtle }]}>
      <Pressable
        accessibilityLabel={open ? "Hide the debug analyst report" : "Show the debug analyst report"}
        accessibilityRole="button"
        onPress={() => setOpen((value) => !value)}
        style={styles.thinkingHead}
      >
        <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }}>
          {live ? "debug analyst…" : "debug report"}
        </TypeCaption>
        {open ? (
          <ChevronUp size={TYPE_CAPTION + 5} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={TYPE_CAPTION + 5} color={tokens.textTertiary} strokeWidth={2} />
        )}
      </Pressable>
      {open && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={live ? undefined : 16}>
          {content}
        </TypeMono>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.md,
    paddingBottom: spacing.md,
  },
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  userBubble: {
    maxWidth: "88%",
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  block: {
    gap: spacing.sm,
    maxWidth: "100%",
  },
  assistantText: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
  },
  deltaText: {
    fontSize: TYPE_BODY,
    fontFamily: fontStack.sans,
    lineHeight: 19,
  },
  thinking: {
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  thinkingHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 32,
  },
  toolCard: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  toolHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  miniLink: {
    minHeight: 32,
    justifyContent: "center",
  },
});
