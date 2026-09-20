/**
 * Transcript v3 (R113-c) — the session's rendered event log in the clay
 * language, now a REAL replica of the PC chat (the owner's directive):
 *
 *   - assistant blocks render through MarkdownText (bold is bold, code
 *     blocks are mono tiles, lists, quotes, tables — the R109 fix), and
 *     while LIVE the accumulated content re-parses per delta with the
 *     pulsing clay caret at the end (results stream in, formatted)
 *   - user bubbles: accent-tinted, right-aligned, queued variant, and the
 *     attachments a message carried render as chips under the text
 *   - tool cards: clay tiles with depth, tap-to-expand (full args/output)
 *   - thinking: the collapsible dim block
 *   - QUESTION cards (R87 ask_user): option pills + a custom-answer input +
 *     one POST resolves the whole ask; answered/timeout/cancelled states
 *   - TODO cards (todo.update): the compact progress header + checklist
 *     rows, collapsible under the house spring
 *   - SUB-AGENT cards (live subagent-status frames): role/code/status/task,
 *     tap → the child session's own transcript screen
 *   - IMAGE tiles (live screenshot frames): lazy-fetched PNG rasters, capped
 *     height, tap → the full-screen viewer
 *   - approval mini-cards, meta lines, honest error cards, debug blocks
 *
 * One renderer for BOTH sources — the persisted fold and the live stream
 * produce the same TranscriptItem union (features/sessions.ts).
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BookOpenText, Check, ChevronDown, ChevronUp, CircleX, FileCode2, ImageIcon, Minus, SquareTerminal, Wrench } from "lucide-react-native";
import { useTheme, useChatPrefs } from "@/design/theme";
import { Badge, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { MarkdownText } from "@/components/markdown-text";
import { ImageViewer } from "@/components/image-viewer";
import { getLinkManager } from "@/link/runtime";
import { fetchRasterFile, type RasterState } from "@/features/raster";
import {
  densityVerticalPadding,
  messageClock,
  textSizeScale,
  timestampsVisible,
  toolActivityVisibility,
} from "@/features/chat-prefs";
import {
  extractStringArg,
  extractWritePreview,
  READ_TOOLS,
  TERMINAL_TOOLS,
  WRITE_TOOLS,
} from "@/features/streaming-args";
import {
  ENTRANCE_DELTA,
  SPRING,
} from "@/design/motion";
import {
  RADIUS_CARD,
  RADIUS_INPUT,
  RADIUS_PILL,
  RADIUS_ROUND,
  fontFamily,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
  TYPE_MICRO,
} from "@/design/tokens";
import { subagentStatusLabel } from "@/features/sessions";
import type { AttachmentView, TranscriptItem } from "@/features/sessions";

// ── the list ────────────────────────────────────────────────────────────────

/** The answer resolver the question cards call (the screen owns the POST). */
export type QuestionAnswerFn = (
  questionId: string,
  answers: string[],
  sources: Array<"option" | "custom">,
) => Promise<boolean>;

/** The plain (non-virtualized) list — small transcripts + tests. */
export function TranscriptList({
  items,
  onApprovalDecide,
  onAnswerQuestion,
}: {
  items: TranscriptItem[];
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
}) {
  return (
    <View style={styles.list} accessibilityLabel="Conversation transcript">
      {items.map((item) => (
        <TranscriptItemView
          key={item.key}
          item={item}
          onApprovalDecide={onApprovalDecide}
          onAnswerQuestion={onAnswerQuestion}
        />
      ))}
    </View>
  );
}

/** One row — exported for the session screen's inverted FlatList. */
export function TranscriptItemView({
  item,
  onApprovalDecide,
  onAnswerQuestion,
}: {
  item: TranscriptItem;
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
}) {
  switch (item.kind) {
    case "user":
      return <UserBubble content={item.content} queued={item.queued} attachments={item.attachments} ts={item.ts} />;
    case "assistant":
      return <AssistantBlock item={item} />;
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalMini item={item} onDecide={onApprovalDecide} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswerQuestion} />;
    case "todo":
      return <TodoCard item={item} />;
    case "subagent":
      return <SubAgentCard item={item} />;
    case "image":
      return <ImageTile item={item} />;
    case "thinking":
      return <ThinkingPlaceholder model={item.model} />;
    case "meta":
      return <MetaLine text={item.text} />;
    case "error":
      return <ErrorCard code={item.code} message={item.message} />;
    case "debug":
      return <DebugBlock content={item.content} live={item.live} />;
  }
}

// ── the collapsible reveal (the house entrance, reused by the new cards) ────

/** A quiet expand/collapse: the content rises in under the ONE spring (the
 * same fade-in-up language the list cards speak — never a hard cut). */
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  const progress = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * ENTRANCE_DELTA }],
  }));
  if (!open) return null;
  return <Animated.View style={animated}>{children}</Animated.View>;
}

// ── user (attachments ride the bubble) ─────────────────────────────────────

function UserBubble({
  content,
  queued,
  attachments,
  ts,
}: {
  content: string;
  queued: boolean;
  attachments: AttachmentView[] | null;
  ts: string | null;
}) {
  const { tokens } = useTheme();
  // R114-d — the chat prefs: density shrinks the bubble's VERTICAL padding;
  // text size scales the body; timestamps gate the quiet clock.
  const prefs = useChatPrefs();
  const pad = densityVerticalPadding(prefs.chatDensity);
  const scale = textSizeScale(prefs.chatTextSize);
  const clock = timestampsVisible(prefs.timestampsMode) ? messageClock(ts) : null;
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
            paddingVertical: pad,
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
            fontSize: Math.round(TYPE_BODY * scale),
            fontFamily: fontFamily.medium,
            lineHeight: Math.round(21 * scale),
          }}
        >
          {content}
        </Text>
        {attachments !== null && (
          <View style={styles.userAttachRow}>
            {attachments.map((a) => (
              <View
                key={`${a.name}-${a.path ?? ""}`}
                accessibilityLabel={`Attachment ${a.name}`}
                style={[
                  styles.userAttachChip,
                  {
                    backgroundColor: queued ? tokens.subtle : "rgba(255,255,255,0.22)",
                    borderColor: queued ? tokens.borderSubtle : "transparent",
                  },
                ]}
              >
                <ImageIcon size={11} color={queued ? tokens.textTertiary : tokens.selectedText} strokeWidth={2.2} />
                <Text
                  style={{
                    color: queued ? tokens.textSecondary : tokens.selectedText,
                    fontSize: TYPE_CAPTION - 1,
                    fontFamily: fontFamily.medium,
                  }}
                  numberOfLines={1}
                >
                  {a.name}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {clock !== null && (
        <TypeCaption
          style={{ color: tokens.textTertiary, fontSize: 10, marginTop: 2, alignSelf: "flex-end" }}
        >
          {clock}
        </TypeCaption>
      )}
    </View>
  );
}

// ── assistant (markdown, live-formatted, the pulsing caret) ─────────────────

function AssistantBlock({ item }: { item: TranscriptItem & { kind: "assistant" } }) {
  const { tokens } = useTheme();
  // R114-d — the prefs: body text scales (mono/micro lines never do —
  // they are the calibration marks); timestamps gate the meta clock.
  const prefs = useChatPrefs();
  const scale = textSizeScale(prefs.chatTextSize);
  const clock = timestampsVisible(prefs.timestampsMode) ? messageClock(item.ts) : null;
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
          <MarkdownText content={liveText} textScale={scale} />
          <Caret color={tokens.accent} />
        </View>
      ) : settled !== null ? (
        <MarkdownText content={settled} textScale={scale} />
      ) : item.live ? (
        <Caret color={tokens.accent} />
      ) : null}
      {/* R114-d — the model line renders LIVE too (turn.started names the
          resolved pair; the owner: "I don't see which model was being used
          in the chat itself"); the clock rides the same quiet meta line. */}
      {(item.model !== null || clock !== null) && (
        <TypeMono style={{ color: tokens.textTertiary, marginTop: spacing.xs, fontSize: 10.5 }}>
          {[item.model, clock].filter((part) => part !== null).join(" · ")}
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

// ── the THINKING PLACEHOLDER (R114-d — "while it is processing it does not
// show me anything"): sits exactly where the assistant message will appear
// while a live turn streams with NO content yet. The house StatusDot pulse
// grammar (three staggered dots), the word "Thinking", and the turn's
// resolved model in micro mono — calm motion, never a spinner. The first
// real delta replaces it (the screen stops emitting the synthetic item). ──

function ThinkingPlaceholder({ model }: { model: string | null }) {
  const { tokens } = useTheme();
  return (
    <View
      accessibilityLabel={
        model !== null ? `The agent is thinking with ${model}` : "The agent is thinking"
      }
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
      <View style={styles.thinkingDots}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.thinkingDotSlot}>
            <ThinkingDot color={tokens.textTertiary} delay={i * 180} />
          </View>
        ))}
        <TypeCaption style={{ color: tokens.textTertiary, marginLeft: spacing.xs }}>
          Thinking
        </TypeCaption>
        {model !== null && (
          // The spec's micro-mono model name (the calibration-mark voice the
          // assistant cards' own model line speaks — scaled never, tertiary
          // always).
          <TypeMono style={{ color: tokens.textTertiary, fontSize: 11 }}>
            {`· ${model}`}
          </TypeMono>
        )}
      </View>
    </View>
  );
}

/** One pulsing dot of the placeholder — the StatusDot's calm 1.2s opacity
 * pulse (the house motion vocabulary), staggered per dot. */
function ThinkingDot({ color, delay }: { color: string; delay: number }) {
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    const total = 600 + 600;
    const sleep = delay % total;
    // Stagger via an initial offset, then the same repeat both dots run —
    // withRepeat has no delay option; a leading timing of `sleep` ms sets
    // the phase.
    opacity.value = withSequence(
      withTiming(0.35, { duration: sleep }),
      withRepeat(
        withSequence(withTiming(1, { duration: 600 }), withTiming(0.35, { duration: 600 })),
        -1,
        false,
      ),
    );
  }, [opacity, delay]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[animated, { width: 6, height: 6, borderRadius: 3, backgroundColor: color }]}
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
      <Reveal open={open}>
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={live ? undefined : 14}>
          {text}
        </TypeMono>
      </Reveal>
    </View>
  );
}

// ── tool (the per-tool dispatcher — R114-d) ─────────────────────────────────
//
// The owner's reports: "'read skill' showed the full view with an ok status
// — ugly"; "writing a file was not shown properly on mobile while PC
// streamed it". One dispatcher, one presentation per tool family, the
// generic card as the fallback for everything unknown:
//   · read_skill (the compact-read family) → ONE quiet line: skill icon +
//     "Skill · <name>" + status; the args dump renders ONLY on manual expand.
//   · write_file / edit_file → the WRITE card: mono path, the live char
//     counter + a quiet 2-3 line content tail WHILE the args stream (the
//     tool-input-delta raw the reducer now accumulates), the result summary
//     once the call settles.
//   · run_command / bash → the TERMINAL card: mono command line, the
//     streamed tool-output tail as a quiet terminal block, status on result.
// The collapsed discipline: every card renders ONE compact line when
// collapsed (icon + humanized name + one-line summary + status); expand
// shows the details. chatDensity shrinks the vertical padding;
// toolActivity=compact pins every card collapsed (no expansion); hidden
// folds the runs away entirely before the list renders (chat-prefs.ts).

type ToolItem = TranscriptItem & { kind: "tool" };

function ToolCard({ item }: { item: ToolItem }) {
  const prefs = useChatPrefs();
  const visibility = toolActivityVisibility(prefs.toolActivity);
  if (visibility.collapsedRows) {
    return <CompactToolRow item={item} />;
  }
  if (WRITE_TOOLS.has(item.toolName)) {
    return <WriteCard item={item} expandable={visibility.expandable} />;
  }
  if (TERMINAL_TOOLS.has(item.toolName)) {
    return <TerminalCard item={item} expandable={visibility.expandable} />;
  }
  if (READ_TOOLS.has(item.toolName)) {
    return <SkillCard item={item} expandable={visibility.expandable} />;
  }
  return <GenericToolCard item={item} expandable={visibility.expandable} />;
}

/** The running/ok/FAIL badge every tool row ends with. */
function ToolStatusBadge({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Badge tone="warning">running</Badge>;
  return ok ? <Badge tone="success">ok</Badge> : <Badge tone="danger">FAIL</Badge>;
}

/** "run_command" → "run command" (the humanized name the rows lead with). */
function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ");
}

/** The write card's file path: the streaming raw's `path` arg first (the
 * tolerant extractor — live, before the args complete), else the settled
 * argsSummary's `path: …` segment. */
function writePath(item: ToolItem): string | null {
  if (item.inputRaw !== null) {
    const preview = extractWritePreview(item.inputRaw);
    if (preview.path !== null) return preview.path;
  }
  return item.argsSummary.match(/^path:\s*([^,]+)/)?.[1] ?? null;
}

/** The one-line summary the collapsed generic row shows. */
function genericOneLineSummary(item: ToolItem): string {
  if (TERMINAL_TOOLS.has(item.toolName)) {
    return item.argsSummary.match(/^command:\s*(.*)$/)?.[1] ?? item.argsSummary;
  }
  return item.argsSummary;
}

/** The shared card shell: the clay tile + the density-aware vertical padding. */
function ToolShell({ item, children }: { item: ToolItem; children: React.ReactNode }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  const failed = item.ok === false;
  return (
    <View
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: failed ? tokens.danger : tokens.borderSubtle,
          boxShadow: tokens.clayShadowSm,
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
        },
      ]}
    >
      {children}
    </View>
  );
}

/** The head row every card leads with: icon + title (mono, one line) +
 * the status badge (+ the chevron while expandable). Tappable as the whole
 * card's expand when `onToggle` is set. */
function ToolHeadRow({
  item,
  icon,
  title,
  expanded,
  expandable,
  onToggle,
}: {
  item: ToolItem;
  icon: React.ReactNode;
  title: string;
  expanded: boolean;
  expandable: boolean;
  onToggle?: () => void;
}) {
  const { tokens } = useTheme();
  const row = (
    <View style={styles.toolHead}>
      {icon}
      <TypeMono
        style={{ color: tokens.text, fontFamily: fontFamily.monoMedium, flex: 1 }}
        numberOfLines={1}
      >
        {title}
      </TypeMono>
      <ToolStatusBadge ok={item.ok} />
      {expandable ? (
        expanded ? (
          <ChevronUp size={15} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={15} color={tokens.textTertiary} strokeWidth={2} />
        )
      ) : null}
    </View>
  );
  if (onToggle === undefined) return row;
  return (
    <Pressable
      accessibilityLabel={`Tool ${item.toolName}${item.ok === null ? " running" : item.ok === false ? " failed" : " succeeded"}${expanded ? ", expanded" : ""}`}
      accessibilityRole="button"
      onPress={onToggle}
    >
      {row}
    </Pressable>
  );
}

/** toolActivity=compact — the ALWAYS-collapsed single-line row (icon +
 * humanized name + one-line summary + status; no expansion, ever). */
function CompactToolRow({ item }: { item: ToolItem }) {
  const { tokens } = useTheme();
  const summary = WRITE_TOOLS.has(item.toolName)
    ? writePath(item)
    : genericOneLineSummary(item);
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<Wrench size={13} color={tokens.textSecondary} strokeWidth={2.2} />}
        title={humanizeToolName(item.toolName)}
        expanded={false}
        expandable={false}
      />
      {summary !== null && summary !== "" && (
        <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={1}>
          {summary}
        </TypeMono>
      )}
    </ToolShell>
  );
}

/** read_skill + the compact-read family — the quiet ONE-line row (the owner:
 * "'read skill' showed the full view with an ok status — ugly"). The args
 * dump renders ONLY on manual expand. */
function SkillCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const name =
    item.inputRaw !== null
      ? extractStringArg(item.inputRaw, "name")
      : { found: false, value: "" };
  const skillName =
    name.found && name.value.trim() !== ""
      ? name.value.trim()
      : item.argsSummary.match(/^name:\s*([^,]+)/)?.[1] ?? "";
  const title =
    item.toolName === "read_skill"
      ? skillName !== ""
        ? `Skill · ${skillName}`
        : "Skill"
      : humanizeToolName(item.toolName);
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<BookOpenText size={13} color={tokens.accent2} strokeWidth={2.2} />}
        title={title}
        expanded={showDetails}
        expandable={expandable}
        onToggle={expandable ? () => setExpanded((v) => !v) : undefined}
      />
      {showDetails && (
        <Reveal open>
          {item.argsSummary !== "" && (
            <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={6}>
              {item.argsSummary}
            </TypeMono>
          )}
          {item.outputSummary !== null && item.outputSummary !== "" && (
            <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={4}>
              {item.outputSummary}
            </TypeMono>
          )}
        </Reveal>
      )}
    </ToolShell>
  );
}

/** write_file / edit_file — the WRITE card: mono path, the LIVE char counter
 * + a quiet content tail while the args stream, the result summary once the
 * call settles. The preview's source is the tool-input-delta raw the
 * reducer accumulates (R114-d — the frames the phone used to ignore). */
function WriteCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const running = item.ok === null;
  const streaming = running && item.inputRaw !== null;
  const preview = extractWritePreview(item.inputRaw ?? "");
  const path = writePath(item);
  const verb = item.toolName === "write_file" ? "Writing" : "Editing";
  const title =
    path !== null
      ? `${verb} ${path}`
      : running
        ? `${verb}…`
        : humanizeToolName(item.toolName);
  // The quiet content tail — the LAST 160 chars of what has arrived (the
  // head lives in the reducer's raw; the tail is what is being typed NOW).
  const tail =
    streaming && preview.content !== ""
      ? preview.content.length > 160
        ? `…${preview.content.slice(preview.content.length - 160)}`
        : preview.content
      : null;
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<FileCode2 size={13} color={tokens.accent} strokeWidth={2.2} />}
        title={title}
        expanded={showDetails}
        expandable={expandable}
        onToggle={expandable ? () => setExpanded((v) => !v) : undefined}
      />
      {streaming && (
        <View style={{ gap: spacing.xs }}>
          <TypeCaption style={{ color: tokens.textTertiary, fontSize: TYPE_MICRO - 0.5 }}>
            {preview.chars.toLocaleString()} chars
          </TypeCaption>
          {tail !== null && (
            <TypeMono
              style={[
                styles.terminalBlock,
                {
                  color: tokens.textTertiary,
                  backgroundColor: tokens.monoBg,
                  borderColor: tokens.borderSubtle,
                },
              ]}
              numberOfLines={3}
            >
              {tail}
            </TypeMono>
          )}
        </View>
      )}
      {!running && item.outputSummary !== null && item.outputSummary !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={showDetails ? undefined : 3}>
          {item.outputSummary}
        </TypeMono>
      )}
      {showDetails && (
        <Reveal open>
          {item.argsSummary !== "" && (
            <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={6}>
              {item.argsSummary}
            </TypeMono>
          )}
          {item.outputTail !== null && item.outputTail !== "" && (
            <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={8}>
              {item.outputTail}
            </TypeMono>
          )}
        </Reveal>
      )}
    </ToolShell>
  );
}

/** run_command / bash — the TERMINAL card: mono command line (the
 * argsSummary), the streamed tool-output tail as a quiet terminal block,
 * the exit status badge on the result. */
function TerminalCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const command = genericOneLineSummary(item);
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<SquareTerminal size={13} color={tokens.accent} strokeWidth={2.2} />}
        title={humanizeToolName(item.toolName)}
        expanded={showDetails}
        expandable={expandable}
        onToggle={expandable ? () => setExpanded((v) => !v) : undefined}
      />
      {command !== "" && (
        <TypeMono
          style={{ color: tokens.textSecondary }}
          numberOfLines={showDetails ? 2 : 1}
        >
          {command}
        </TypeMono>
      )}
      {item.outputTail !== null && item.outputTail !== "" && (
        <TypeMono
          style={[
            styles.terminalBlock,
            {
              color: tokens.textTertiary,
              backgroundColor: tokens.monoBg,
              borderColor: tokens.borderSubtle,
            },
          ]}
          numberOfLines={showDetails ? undefined : 3}
        >
          {item.outputTail}
        </TypeMono>
      )}
      {item.outputSummary !== null && item.outputSummary !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={showDetails ? undefined : 3}>
          {item.outputSummary}
        </TypeMono>
      )}
    </ToolShell>
  );
}

/** The generic fallback — the pre-R114-d card, now with the collapsed
 * discipline (ONE compact line when collapsed) + the density padding. */
function GenericToolCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const summary = genericOneLineSummary(item);
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<Wrench size={13} color={tokens.textSecondary} strokeWidth={2.2} />}
        title={humanizeToolName(item.toolName)}
        expanded={showDetails}
        expandable={expandable}
        onToggle={expandable ? () => setExpanded((v) => !v) : undefined}
      />
      {summary !== "" && (
        <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={showDetails ? undefined : 1}>
          {summary}
        </TypeMono>
      )}
      {showDetails && (
        <Reveal open>
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
        </Reveal>
      )}
    </ToolShell>
  );
}

// ── the ask_user question card (R87) ───────────────────────────────────────

function QuestionCard({
  item,
  onAnswer,
}: {
  item: TranscriptItem & { kind: "question" };
  onAnswer?: QuestionAnswerFn;
}) {
  const { tokens } = useTheme();
  // Draft answers: index → {value, source} (option picks set both; the
  // custom input sets source "custom").
  const [drafts, setDrafts] = useState<Record<number, { value: string; source: "option" | "custom" }>>({});
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});
  const [sending, setSending] = useState(false);
  const [locallyAnswered, setLocallyAnswered] = useState<{
    answers: string[];
    sources: string[];
  } | null>(null);

  const questions = item.questions;
  const allAnswered =
    questions.length > 0 && questions.every((_, i) => drafts[i] !== undefined);

  if (item.resolution === "answered" || locallyAnswered !== null) {
    const answers = locallyAnswered?.answers ?? item.answers ?? [];
    return (
      <View
        style={[
          styles.toolCard,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            borderColor: tokens.success,
            boxShadow: tokens.clayShadowSm,
          },
        ]}
        accessibilityLabel="Answered question"
      >
        <View style={styles.toolHead}>
          <Check size={13} color={tokens.success} strokeWidth={2.6} />
          <TypeMono style={{ color: tokens.text, fontFamily: fontFamily.monoMedium }}>answered</TypeMono>
          <View style={{ flex: 1 }} />
          <Badge tone="success">
            {questions.length} question{questions.length === 1 ? "" : "s"}
          </Badge>
        </View>
        {questions.map((q, i) => (
          <View key={i} style={{ gap: 1 }}>
            <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={2}>
              {q.question}
            </TypeCaption>
            <TypeMono style={{ color: tokens.text }} numberOfLines={3}>
              → {answers[i] ?? "(no answer)"}
            </TypeMono>
          </View>
        ))}
      </View>
    );
  }

  if (item.resolution !== "pending") {
    const note =
      item.resolution === "timeout"
        ? "question unanswered (the 10-minute wait elapsed) — the agent proceeded on a stated assumption"
        : "question cancelled (the turn was stopped before you answered)";
    return (
      <View style={styles.metaRow}>
        <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={2}>
          {note}
        </TypeCaption>
      </View>
    );
  }

  if (onAnswer === undefined) {
    // No resolver wired — the questions read-only (never dead buttons).
    return (
      <View
        style={[
          styles.toolCard,
          { backgroundColor: tokens.card, borderTopColor: tokens.clayTopEdge, borderColor: tokens.accent, boxShadow: tokens.clayShadowSm },
        ]}
      >
        {questions.map((q, i) => (
          <TypeBody key={i} style={{ color: tokens.text, fontFamily: fontFamily.semibold }}>
            {q.question}
          </TypeBody>
        ))}
      </View>
    );
  }

  const submit = (): void => {
    if (!allAnswered || sending) return;
    const answers: string[] = [];
    const sources: Array<"option" | "custom"> = [];
    questions.forEach((_, i) => {
      const draft = drafts[i];
      answers.push(draft?.value.trim() ?? "");
      sources.push(draft?.source === "custom" ? "custom" : "option");
    });
    setSending(true);
    void onAnswer(item.questionId, answers, sources)
      .then((ok) => {
        if (ok) setLocallyAnswered({ answers, sources });
      })
      .finally(() => setSending(false));
  };

  return (
    <View
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: tokens.accent,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
      accessibilityLabel="The agent needs your answer"
    >
      <View style={styles.toolHead}>
        <View style={[styles.questionPulse, { backgroundColor: tokens.accent }]} />
        <TypeMono style={{ color: tokens.text, fontFamily: fontFamily.monoMedium, flex: 1 }}>
          the agent needs your answer{questions.length > 1 ? ` (${questions.length})` : ""}
        </TypeMono>
      </View>
      {questions.map((q, i) => (
        <View key={i} style={{ gap: spacing.xs }}>
          <TypeBody style={{ color: tokens.text, fontFamily: fontFamily.semibold }}>
            {q.question}
          </TypeBody>
          <View style={styles.optionRow}>
            {q.options.map((option) => {
              const picked = drafts[i]?.source === "option" && drafts[i]?.value === option;
              return (
                <Pressable
                  key={option}
                  accessibilityLabel={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: picked === true }}
                  onPress={() => setDrafts((d) => ({ ...d, [i]: { value: option, source: "option" } }))}
                  style={[
                    styles.optionPill,
                    {
                      borderColor: picked ? tokens.accent : tokens.borderStrong,
                      backgroundColor: picked ? tokens.accent : "transparent",
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: picked ? tokens.accentText : tokens.text,
                      fontSize: TYPE_CAPTION - 1,
                      fontFamily: fontFamily.semibold,
                    }}
                    numberOfLines={1}
                  >
                    {option}
                  </Text>
                </Pressable>
              );
            })}
            {q.allowCustom &&
              (customOpen[i] ? (
                <TextInput
                  accessibilityLabel={`Custom answer for: ${q.question}`}
                  autoFocus
                  value={drafts[i]?.source === "custom" ? drafts[i].value : ""}
                  onChangeText={(value) =>
                    setDrafts((d) => ({ ...d, [i]: { value, source: "custom" } }))
                  }
                  onSubmitEditing={() => setCustomOpen((c) => ({ ...c, [i]: false }))}
                  placeholder={q.placeholder ?? "Type your answer…"}
                  placeholderTextColor={tokens.textTertiary}
                  style={[
                    styles.customInput,
                    { borderColor: tokens.accent, backgroundColor: tokens.monoBg, color: tokens.text },
                  ]}
                />
              ) : (
                <Pressable
                  accessibilityLabel="Type a custom answer instead"
                  accessibilityRole="button"
                  onPress={() => setCustomOpen((c) => ({ ...c, [i]: true }))}
                  style={[styles.optionPill, styles.customPill, { borderColor: tokens.borderStrong }]}
                >
                  <Text
                    style={{ color: tokens.textTertiary, fontSize: TYPE_CAPTION - 1, fontFamily: fontFamily.medium }}
                    numberOfLines={1}
                  >
                    {drafts[i]?.source === "custom" && drafts[i]?.value.trim() !== ""
                      ? `“${drafts[i].value.trim().slice(0, 24)}${drafts[i].value.trim().length > 24 ? "…" : ""}”`
                      : "Type instead…"}
                  </Text>
                </Pressable>
              ))}
          </View>
        </View>
      ))}
      <Pressable
        accessibilityLabel={questions.length > 1 ? "Send the answers" : "Send the answer"}
        accessibilityRole="button"
        accessibilityState={{ disabled: !allAnswered || sending }}
        disabled={!allAnswered || sending}
        onPress={submit}
        style={({ pressed }) => [
          styles.answerButton,
          {
            backgroundColor: tokens.accent,
            opacity: !allAnswered || sending ? 0.5 : pressed ? 0.9 : 1,
          },
        ]}
      >
        {sending ? (
          <ActivityIndicator size="small" color={tokens.accentText} />
        ) : (
          <Text style={{ color: tokens.accentText, fontSize: TYPE_CAPTION + 1, fontFamily: fontFamily.bold }}>
            Send answer{questions.length > 1 ? "s" : ""}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

// ── the todo card (todo.update — the agent's progress contract) ────────────

function TodoCard({ item }: { item: TranscriptItem & { kind: "todo" } }) {
  const { tokens } = useTheme();
  const [open, setOpen] = useState(true);
  const done = item.todos.filter((t) => t.status === "completed").length;
  const total = item.todos.length;
  const complete = total > 0 && done === total;
  const accent = complete ? tokens.success : tokens.accent;
  return (
    <View
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: complete ? tokens.success : tokens.borderSubtle,
          boxShadow: tokens.clayShadowSm,
        },
      ]}
      accessibilityLabel={`Task list, ${done} of ${total} done`}
    >
      <Pressable
        accessibilityLabel={open ? "Hide the task list" : "Show the task list"}
        accessibilityRole="button"
        onPress={() => setOpen((v) => !v)}
        style={styles.toolHead}
      >
        <Badge tone={complete ? "success" : "accent"}>TASK LIST</Badge>
        <View style={[styles.todoTrack, { backgroundColor: tokens.subtle }]}>
          <View
            style={[
              styles.todoFill,
              { width: total === 0 ? "0%" : `${(done / total) * 100}%`, backgroundColor: accent },
            ]}
          />
        </View>
        <TypeMono style={{ color: complete ? tokens.success : tokens.textTertiary, fontSize: 11 }}>
          {done}/{total}
        </TypeMono>
        {open ? (
          <ChevronUp size={15} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={15} color={tokens.textTertiary} strokeWidth={2} />
        )}
      </Pressable>
      <Reveal open={open}>
        <View style={{ gap: 3 }}>
          {item.todos.map((todo, i) => {
            const isDone = todo.status === "completed";
            const isActive = todo.status === "in_progress";
            return (
              <View key={i} style={styles.todoRow}>
                <View
                  style={[
                    styles.todoCheckbox,
                    {
                      borderColor: isDone ? tokens.success : isActive ? tokens.accent : tokens.borderStrong,
                      backgroundColor: isDone ? tokens.success : "transparent",
                    },
                  ]}
                >
                  {isDone ? (
                    <Check size={10} color="#FFFFFF" strokeWidth={3.4} />
                  ) : isActive ? (
                    <View style={[styles.todoActiveDot, { backgroundColor: tokens.accent }]} />
                  ) : (
                    <Minus size={0} />
                  )}
                </View>
                <Text
                  style={{
                    color: isDone ? tokens.textTertiary : isActive ? tokens.text : tokens.textSecondary,
                    fontSize: TYPE_CAPTION + 0.5,
                    fontFamily: isActive ? fontFamily.semibold : fontFamily.regular,
                    lineHeight: 18,
                    textDecorationLine: isDone ? "line-through" : "none",
                    flex: 1,
                  }}
                >
                  {todo.content}
                </Text>
              </View>
            );
          })}
        </View>
      </Reveal>
    </View>
  );
}

// ── the sub-agent card (live frames — tap opens the child transcript) ──────

function SubAgentCard({ item }: { item: TranscriptItem & { kind: "subagent" } }) {
  const { tokens } = useTheme();
  const router = useRouter();
  const running = item.status === "running" || item.status === "queued";
  const failed = item.status === "failed";
  const tone = failed ? tokens.danger : running ? tokens.running : tokens.success;
  return (
    <Pressable
      accessibilityLabel={`Sub-agent ${item.role}${item.code !== null ? ` ${item.code}` : ""} — ${item.status}. ${item.task}. Open its transcript.`}
      accessibilityRole="button"
      onPress={() => router.push(`/session/${item.childSessionId}`)}
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
        <View style={[styles.subagentBadge, { backgroundColor: tone }]}>
          {failed ? (
            <CircleX size={12} color="#FFFFFF" strokeWidth={2.4} />
          ) : (
            <Check size={12} color="#FFFFFF" strokeWidth={3} />
          )}
        </View>
        <TypeMono style={{ color: tokens.text, fontFamily: fontFamily.monoMedium, flex: 1 }} numberOfLines={1}>
          {item.role}
          {item.code !== null ? ` ${item.code}` : ""}
        </TypeMono>
        <Badge tone={failed ? "danger" : running ? "running" : "success"}>{subagentStatusLabel(item.status)}</Badge>
      </View>
      <TypeBody style={{ color: tokens.textSecondary }} numberOfLines={2}>
        {item.task !== "" ? item.task : "sub-agent task"}
      </TypeBody>
      {item.model !== null && (
        <TypeMono style={{ color: tokens.textTertiary, fontSize: 10.5 }} numberOfLines={1}>
          {item.model}
        </TypeMono>
      )}
      {failed && item.detail !== null && (
        <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
          {item.detail}
        </TypeCaption>
      )}
      <TypeCaption style={{ color: tokens.textTertiary }}>tap to open its transcript →</TypeCaption>
    </Pressable>
  );
}

// ── the live screenshot tile ────────────────────────────────────────────────

function ImageTile({ item }: { item: TranscriptItem & { kind: "image" } }) {
  const { tokens } = useTheme();
  const [state, setState] = useState<RasterState>({ uri: null, expired: false });
  const [viewerOpen, setViewerOpen] = useState(false);

  // Lazy-fetch the raster once per mount (rasters are EPHEMERAL server-side —
  // a 404 after the 10-minute TTL renders the quiet expired tile, exactly the
  // desktop's honesty limit).
  useEffect(() => {
    let cancelled = false;
    void fetchRasterFile(getLinkManager(), item.frameId).then((outcome) => {
      if (!cancelled) setState(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [item.frameId]);

  return (
    <View style={styles.imageWrapRow}>
      <Pressable
        accessibilityLabel={`Screenshot captured by ${item.tool}${state.uri !== null ? " — tap to view" : ""}`}
        accessibilityRole="button"
        disabled={state.uri === null}
        onPress={() => setViewerOpen(true)}
        style={[
          styles.imageTile,
          { borderColor: tokens.borderSubtle, backgroundColor: tokens.subtle },
        ]}
      >
        {state.uri !== null ? (
          <Image source={{ uri: state.uri }} style={styles.imageTileImage} resizeMode="cover" />
        ) : state.expired ? (
          <View style={styles.imageExpired}>
            <ImageIcon size={14} color={tokens.textTertiary} strokeWidth={2} />
            <TypeCaption style={{ color: tokens.textTertiary, fontSize: 10.5, textAlign: "center" }}>
              screenshot expired (rasters live 10 minutes)
            </TypeCaption>
          </View>
        ) : (
          <View style={styles.imageExpired}>
            <ActivityIndicator size="small" color={tokens.accent} />
          </View>
        )}
      </Pressable>
      {state.uri !== null && (
        <ImageViewer
          uri={state.uri}
          // R114-d — the caption reads the frame's TRUE note (the tool that
          // captured it · the capture's note); the old `ts` field was never
          // on the wire (always the empty string).
          caption={`Captured by ${item.tool}${item.note !== "" ? ` · ${item.note}` : ""}`}
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
        />
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
      <Reveal open={open}>
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={live ? undefined : 16}>
          {content}
        </TypeMono>
      </Reveal>
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
    gap: spacing.xs,
  },
  userAttachRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  userAttachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    maxWidth: 180,
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
  /** R114-d — the thinking placeholder's staggered dot row. */
  thinkingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 32,
  },
  thinkingDotSlot: {
    width: 6,
    height: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  /** R114-d — the quiet terminal block (the write preview's content tail +
   * the command output tail): hairline-bordered, mono-backed at the call
   * site (token-scoped), tertiary ink. */
  terminalBlock: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
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
    minHeight: 32,
  },
  miniLink: {
    minHeight: 32,
    justifyContent: "center",
  },
  metaRow: {
    minHeight: 32,
    justifyContent: "center",
    maxWidth: 320,
    alignSelf: "flex-start",
  },
  questionPulse: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  optionPill: {
    minHeight: 32,
    borderRadius: RADIUS_ROUND,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    justifyContent: "center",
    maxWidth: 240,
  },
  customPill: {
    borderStyle: "dashed",
  },
  customInput: {
    borderWidth: 1,
    borderRadius: RADIUS_ROUND,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    minWidth: 160,
    flex: 1,
    fontSize: TYPE_CAPTION,
    minHeight: 32,
  },
  answerButton: {
    minHeight: 44,
    borderRadius: RADIUS_ROUND,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    alignSelf: "flex-start",
  },
  todoTrack: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    overflow: "hidden",
    marginHorizontal: spacing.xs,
  },
  todoFill: {
    height: "100%",
    borderRadius: 3,
  },
  todoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  todoCheckbox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1.5,
  },
  todoActiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  subagentBadge: {
    width: 18,
    height: 18,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  imageWrapRow: {
    alignSelf: "flex-start",
  },
  imageTile: {
    width: 240,
    height: 120,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  imageTileImage: {
    width: "100%",
    height: "100%",
  },
  imageExpired: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
});
