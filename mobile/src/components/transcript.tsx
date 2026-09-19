/**
 * Transcript v2 (R109) — the session's rendered event log in the clay
 * language, with the FORMATTED prose the owner asked for:
 *
 *   - assistant blocks render through MarkdownText (bold is bold, code
 *     blocks are mono tiles, lists, quotes, tables — the R109 fix), and
 *     while LIVE the accumulated content re-parses per delta with the
 *     pulsing clay caret at the end (results stream in, formatted)
 *   - user bubbles: accent-tinted, right-aligned, queued variant
 *   - tool cards: clay tiles with depth, tap-to-expand (full args/output)
 *   - thinking: the collapsible dim block, restyled
 *   - approval mini-cards, meta lines, honest error cards, debug blocks
 *
 * One renderer for BOTH sources — the persisted fold and the live stream
 * produce the same TranscriptItem union (features/sessions.ts).
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { ChevronDown, ChevronUp, Wrench } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Badge, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { MarkdownText } from "@/components/markdown-text";
import {
  RADIUS_CARD,
  RADIUS_INPUT,
  fontFamily,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
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
            backgroundColor: queued ? tokens.card : tokens.selectedBg,
            borderTopColor: queued ? tokens.clayTopEdge : "transparent",
            borderColor: queued ? tokens.border : "transparent",
            boxShadow: queued ? tokens.clayShadowSm : undefined,
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
            fontFamily: fontFamily.medium,
            lineHeight: 21,
          }}
        >
          {content}
        </Text>
      </View>
    </View>
  );
}

// ── assistant (markdown, live-formatted, the pulsing caret) ─────────────────

function AssistantBlock({ item }: { item: TranscriptItem & { kind: "assistant" } }) {
  const { tokens } = useTheme();
  const liveText =
    item.live && item.chunks !== null ? item.chunks.join("") : null;
  const settled = !item.live && item.content !== "" ? item.content : null;

  return (
    <View style={styles.block} accessibilityLabel="Assistant message">
      {item.thinking !== null && item.thinking !== "" && (
        <ThinkingBlock text={item.thinking} live={item.live} />
      )}
      {liveText !== null && liveText !== "" ? (
        <View style={styles.assistantLive}>
          <MarkdownText content={liveText} />
          <Caret color={tokens.accent} />
        </View>
      ) : settled !== null ? (
        <MarkdownText content={settled} />
      ) : item.live ? (
        <Caret color={tokens.accent} />
      ) : null}
      {item.model !== null && !item.live && (
        <TypeMono style={{ color: tokens.textTertiary, marginTop: spacing.xs, fontSize: 10.5 }}>
          {item.model}
        </TypeMono>
      )}
    </View>
  );
}

/** The live cursor — a calm 1.1s pulse marking the stream still flowing. */
function Caret({ color }: { color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.25, { duration: 550 }), withTiming(1, { duration: 550 })),
      -1,
      false,
    );
  }, [opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel="the agent is still writing"
      style={[animated, { width: 8, height: 15, borderRadius: 2, backgroundColor: color, marginLeft: 2 }]}
    />
  );
}

// ── thinking (collapsible dim block, clay-styled) ───────────────────────────

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const { tokens } = useTheme();
  const [open, setOpen] = useState(live);
  return (
    <View
      style={[
        styles.thinking,
        {
          borderColor: tokens.borderSubtle,
          backgroundColor: tokens.monoBg,
          borderTopColor: tokens.clayTopEdge,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
    >
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
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={live ? undefined : 14}>
          {text}
        </TypeMono>
      )}
    </View>
  );
}

// ── tool (clay tile, tap to expand the full story) ──────────────────────────

function ToolCard({ item }: { item: TranscriptItem & { kind: "tool" } }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const failed = item.ok === false;
  const running = item.ok === null;
  return (
    <Pressable
      accessibilityLabel={`Tool ${item.toolName}${running ? " running" : failed ? " failed" : " succeeded"}${expanded ? ", expanded" : ""}`}
      accessibilityRole="button"
      onPress={() => setExpanded((v) => !v)}
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: failed ? tokens.danger : tokens.borderSubtle,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
    >
      <View style={styles.toolHead}>
        <Wrench size={13} color={tokens.textSecondary} strokeWidth={2.2} />
        <TypeMono style={{ color: tokens.text, fontFamily: fontFamily.monoMedium }}>{item.toolName}</TypeMono>
        <View style={{ flex: 1 }} />
        {running ? (
          <Badge tone="warning">running</Badge>
        ) : failed ? (
          <Badge tone="danger">FAIL</Badge>
        ) : (
          <Badge tone="success">ok</Badge>
        )}
        {expanded ? (
          <ChevronUp size={15} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={15} color={tokens.textTertiary} strokeWidth={2} />
        )}
      </View>
      {item.argsSummary !== "" && (
        <TypeMono
          style={{ color: tokens.textSecondary }}
          numberOfLines={expanded ? undefined : 3}
        >
          {item.argsSummary}
        </TypeMono>
      )}
      {item.outputTail !== null && item.outputTail !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={expanded ? undefined : 8}>
          {item.outputTail}
        </TypeMono>
      )}
      {item.outputSummary !== null && item.outputSummary !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={expanded ? undefined : 6}>
          {item.outputSummary}
        </TypeMono>
      )}
    </Pressable>
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
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: pending ? tokens.warning : tokens.borderSubtle,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
      accessibilityLabel={`Approval ${item.toolName} ${decision ?? "waiting"}`}
    >
      <View style={styles.toolHead}>
        <TypeMono style={{ color: tokens.text, fontFamily: fontFamily.monoMedium }}>{item.toolName}</TypeMono>
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
          <TypeCaption style={{ color: tokens.accent, fontFamily: fontFamily.bold }}>
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
      style={[
        styles.toolCard,
        { backgroundColor: tokens.card, borderTopColor: tokens.clayTopEdge, borderColor: tokens.danger, boxShadow: tokens.clayShadowSm },
      ]}
    >
      <View style={styles.toolHead}>
        <TypeMono style={{ color: tokens.danger, fontFamily: fontFamily.monoMedium }}>{code}</TypeMono>
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
    <View
      style={[
        styles.thinking,
        {
          borderColor: tokens.borderSubtle,
          backgroundColor: tokens.monoBg,
          borderTopColor: tokens.clayTopEdge,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
    >
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  block: {
    gap: spacing.sm,
    maxWidth: "100%",
  },
  assistantLive: {
    flexDirection: "row",
    alignItems: "flex-end",
    flexWrap: "wrap",
  },
  thinking: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
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
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
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
