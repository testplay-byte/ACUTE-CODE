/**
 * Transcript v5 (R116-m) — the conversation's message grammar per
 * docs/design-language/android/02-patterns/chat.md §Transcript + its
 * Round-116 amendments (the delivery ticks + the compact tool cards):
 *
 *   - USER BUBBLE (right, maxWidth 88%): an accent-TINTED clay fill (the
 *     accent mixed ~10% over the card — the PC chat's own bubble math, not a
 *     solid accent slab), r20 with the tighter 16px bottom-right corner (the
 *     WhatsApp tail hint), and the CLOCK INSIDE the bubble's bottom-right
 *     corner (10px tertiary, gated by the timestampsMode pref — never
 *     floating below). Image attachments render as proper rounded
 *     thumbnails (r12, ~64% of the column, aspect-kept) — never tiny chips;
 *     other attachments stay chips under the text.
 *   - ASSISTANT = a document (full width, no bubble): the meta line (model ·
 *     time, mono 10.5 tertiary) sits ABOVE the first content chunk and ONLY
 *     when the turn has content; the collapsible dim thinking card rides
 *     above it (settled cap 20 lines + a "Show all" affordance past the cap);
 *     the live caret keeps pulsing after the streaming markdown.
 *   - TOOL CARDS (R116-m compaction, donts #37): the right-side status badge
 *     column is RETIRED — the head row carries verb + target on ONE line, the
 *     status rides a small quiet chip only while RUNNING (warning-tinted) or
 *     FAILED (compact danger chip + the whole card tints danger: border + a
 *     5% wash); on success there is NO badge — the head line itself carries
 *     the result (the write card's +A/−B line-count chips, mono 11px, parsed
 *     from the server's edit summary). toolActivity detailed/compact/hidden
 *     all still apply (compact = one collapsed line; hidden folds into meta
 *     lines). The read-skill family stays ONE slim quiet chip; the task-list
 *     card is FROZEN (the owner's explicit favorite).
 *   - IMAGES: screenshot tiles keep the lazy 240×120 geometry but render
 *     rounded r12 with a quiet border and a SKELETON while loading (never a
 *     spinner); expired keeps its honest line; the full-screen viewer keeps
 *     the zoom spring and now measures the image's true aspect.
 *   - PROCESSING: the three-dot Thinking card BREATHES (opacity 0.85↔1,
 *     ~1.2s cycle) and enters with the house fade-in-up the moment the turn
 *     starts; the first real delta retires it (the screen's synthetic item —
 *     that logic is untouched). With the header's breathing accent line this
 *     is the whole "processing" story — no spinner anywhere.
 *   - question / todo / subagent / approval-mini / meta / error / debug
 *     cards keep their logic, restyled to one visual idea per region (the
 *     error card is compact: one-line code head + the message clamped to 3
 *     lines with the expand grammar behind it).
 *
 * ROUND-117 (R117-d2 — the multi-agent parity leg): the SubAgentCard grows
 * up — a LIVE leg while the child streams (a 2px BREATHING accent rule at
 * the card's top + a single last-activity line off the live turn's
 * subagentLive map: the latest tool step, the thinking flag, the tool-call
 * count), a STOP affordance while it runs (POST /sessions/:childId/stop on
 * the CHILD directly — R52-b), and a RETRY affordance once it failed or
 * was stopped (POST /sessions/:parent/subagents/:child/retry — ADR-0022's
 * resume-from-the-event-log); both are single-line decision rows with
 * honest busy states + failure notes, OUTSIDE the tap-to-open region. The
 * ErrorCard gains the PC's honesty set where the wire already carries the
 * data — the errorClass chip + the attempts line ("after N attempts" — the
 * wire rides the exhausted count), Copy details (the platform clipboard),
 * and Retry (a callback prop — the SCREEN owns the re-send). The cards stay
 * COMPACT (R116-m grammar): the richness is in the LINES, not the size.
 *
 * One renderer for BOTH sources — the persisted fold and the live stream
 * produce the same TranscriptItem union (features/sessions.ts — the data
 * model's status rung is this wave's only addition there).
 *
 * ROUND-118 (R118-D — the delivery states ride the message body): the
 * DeliveryTick ladder (clock / check / double-check / alert) is RETIRED —
 * four glyphs duplicated what the body itself can carry. The clock row
 * renders ONLY the clock now, and the FIVE delivery rungs shape the BUBBLE
 * (spec §2.7): sending = the queued arm's neutral clay + textSecondary +
 * the 12% bg VEIL (the RN-honest “grayscale + slight blur” — no View blur
 * filter exists and expo-blur is not installed); sent/delivered = the
 * settled tint byte-identical to today; processing = the normal fill with
 * a BREATHING accent edge (borderColor mixHex(card, accent, 0.34)↔0.62 at
 * the house 550ms legs — the caret/LiveHeaderLine rhythm; reduced motion
 * holds the static 0.55 mix); failed = the normal fill + the 0.22 danger
 * edge with NO glyph (the error card below carries the alert + Retry). The
 * a11y label appends the rung word; `deliveryVisualRung` is exported for
 * the tests. The assistant's live caret is now the SHARED LiveCaret
 * primitive (R118-B's extraction — reuse, never re-roll).
 *
 * ROUND-119 (R119-A — the §N center-section rethink): the owner's verdict —
 * thinking / tool call / failed tool call "each get a proper card of
 * itself, which makes the whole interface bad… everything looks ugly" —
 * retires the per-narration card stack. ONE VISUAL TURN PER EXCHANGE now:
 * the `TurnBlock` (below) wraps a turn's assistant/thinking/tool items in
 * ONE clay container — the collapsible ACTIVITY RAIL above the text
 * ("Thought for 8s · 3 actions ▾"; live: the breathing "Thinking…" / the
 * running tool's verb — ONE line, never both cards), the recessed ACTIVITY
 * WELL it expands (surfaceWell + the R118 strong-Hairline divider: the
 * thinking text in the retired ThinkingBlock's own mono-dim voice with its
 * 20-line settled cap + Show all, then the TOOL ROWS — one compact row per
 * call, icon + verb + target + status, failed = the inline danger chip +
 * the row's danger wash, tap to expand the retired cards' content logic
 * (streaming write previews, +A/−B diff chips, terminal tails, output
 * summaries) as the row's body), and the REPLY as the block's body (the
 * retired AssistantBlock's meta line + MarkdownText + LiveCaret grammar;
 * live text streams in place). The standalone ThinkingPlaceholder card,
 * ThinkingBlock card, AssistantBlock, ToolCard and its Write/Terminal/
 * Skill/Generic/Compact shells are RETIRED as list items — their content
 * logic moved INSIDE the block (the dots/breath became the rail's live
 * state; `thinkingPlaceholderVisible`'s honesty rules survive in the
 * screen's synthetic marker, which the grouping consumes). The dispatch
 * renders STANDALONE kinds only (user / approval / question / todo /
 * subagent / image / meta / error / debug — the interactive + terminal
 * surfaces, not narration); the grouping itself is features/turn-block.ts
 * (pure: `orderDisplayItems`'s queued-after-turn law + `groupDisplayRows`'
 * partition + `activitySummary`'s pinned strings). The toolActivity pref
 * applies INSIDE the block: hidden = no tool rows + no rail unless the
 * turn carries thinking text (the clean document); compact = one-line rows,
 * no expansion; detailed = the full anatomy.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BookOpenText, Check, ChevronDown, ChevronUp, CircleX, Copy, FileCode2, ImageIcon, RefreshCw, Square, SquareTerminal, Wrench } from "lucide-react-native";
import { useTheme, useChatPrefs } from "@/design/theme";
import { decisionHaptic, selectionHaptic, warningHaptic } from "@/design/haptics";
import { Badge, Hairline, LiveCaret, Skeleton, TypeBody, TypeCaption, TypeMicro, TypeMono } from "@/design/primitives";
import { MarkdownText } from "@/components/markdown-text";
import { ImageViewer } from "@/components/image-viewer";
import { getLinkManager } from "@/link/runtime";
import { fetchRasterFile, type RasterState } from "@/features/raster";
import { formatAttachmentSize } from "@/features/attachments";
import {
  densityVerticalPadding,
  messageClock,
  textSizeScale,
  timestampsVisible,
  toolActivityVisibility,
} from "@/features/chat-prefs";
import {
  extractWritePreview,
  READ_TOOLS,
  TERMINAL_TOOLS,
  WRITE_TOOLS,
} from "@/features/streaming-args";
import {
  activitySummary,
  genericOneLineSummary,
  groupDisplayRows,
  humanizeToolName,
  orderDisplayItems,
  readTargetSegment,
  turnActivityFacts,
  turnBlockA11yLabel,
  turnReplyText,
  turnThinkingText,
  writeLineDiff,
  writePath,
  type DisplayRow,
  type StandaloneTranscriptItem,
  type ToolItem,
  type TurnGroup,
} from "@/features/turn-block";
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
  mixHex,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
} from "@/design/tokens";
import { postStop, postSubAgentRetry, subagentStatusLabel } from "@/features/sessions";
import type {
  AttachmentView,
  SubAgentLiveEntry,
  TranscriptItem,
  UserDeliveryStatus,
} from "@/features/sessions";

// ── local drawing constants (chat.md's own geometry — the file's class) ─────

/** chat.md — the image radius: r12 on thumbnails + screenshot tiles. */
const RADIUS_IMAGE = 12;
/** chat.md — the WhatsApp tail hint: the user bubble's bottom-right corner. */
const RADIUS_BUBBLE_TAIL = 16;
/** One leg of the placeholder's calm ~1.2s breathe + the dots' pulse. */
const BREATHE_LEG_MS = 600;
/** chat.md (R116 amendment) — the settled thinking block's clamp before the
 * "Show all" affordance takes over (live thinking never clamps). */
const THINKING_SETTLED_CAP = 20;
/** The error card's collapsed message clamp (3 lines) and the character
 * budget past which the expand affordance appears (a message that cannot
 * tail-truncate at 3 lines never offers a dead toggle). */
const ERROR_MESSAGE_CLAMP_LINES = 3;
const ERROR_MESSAGE_EXPAND_CHARS = 180;

/**
 * R119-P — the error card's BODY SELECTION (pure, exported for the tests):
 * the provider's RAW error text is the honest PRIMARY line when the wire
 * carried one (the round-119 §1 item F fix — the owner's TokenHarbor
 * report: a region_blocked answer read as a generic "provider call failed"
 * on the phone because BOTH mobile reducers dropped providerError); the
 * generic machine message becomes the SECONDARY line (context, never the
 * headline). No providerError → the generic line stays the only body
 * (older sidecars, validation refusals). A blank/whitespace providerError
 * is treated as absent (never an empty headline).
 */
export function errorCardLines(
  providerError: string | null | undefined,
  message: string,
): { primary: string; secondary: string | null } {
  const raw = providerError !== null && providerError !== undefined ? providerError.trim() : "";
  if (raw === "") return { primary: message, secondary: null };
  return { primary: raw, secondary: message };
}

/** R119-review WARN — the card's ACCESSIBILITY label, capped for TalkBack.
 * The body selection above is honest on screen (3-line clamp + expand), but
 * the raw providerError can carry a 4000-char multiline JSON body — reading
 * that verbatim through the screen reader is a wall in exactly the
 * TokenHarbor case the raw line exists for. The label carries the code + the
 * first ~120 chars of the primary + the "expand for the full details" cue;
 * multiline bodies collapse to their first line before the cap. Pure +
 * exported for the tests. */
const ERROR_A11Y_CAP = 120;

export function errorCardA11yLabel(code: string, primary: string): string {
  const firstLine = primary.split("\n", 1)[0] ?? primary;
  const clipped =
    firstLine.length > ERROR_A11Y_CAP ? `${firstLine.slice(0, ERROR_A11Y_CAP)}…` : firstLine;
  return `Error ${code}: ${clipped} — expand for the full details`;
}
/** R117-d2 — the sub-agent card's live accent rule + the copied-word flip's
 * quiet dwell (ms): the live caret's own 550ms rhythm and the PC's ~1.2s
 * "Copied" window, widened a beat for the smaller type. */
const SUBAGENT_LIVE_LEG_MS = 550;
const COPY_STATE_DWELL_MS = 1_600;

// ── R118-D — the delivery rung's visual grammar (spec §2.7) ──────────────────

/** The rung word the a11y label appends ("Your message — processing"). */
const DELIVERY_RUNG_WORDS: Record<UserDeliveryStatus, string> = {
  sending: "sending",
  sent: "sent",
  processing: "processing",
  delivered: "delivered",
  failed: "failed",
};

/**
 * The rung's a11y word — null for an undefined status (clean history from
 * producers the ladder never touched). Exported for the tests.
 */
export function deliveryVisualRung(status: UserDeliveryStatus | undefined): string | null {
  if (status === undefined) return null;
  return DELIVERY_RUNG_WORDS[status] ?? null;
}

/** §2.7 (a) — the sending veil: bg at 12% over the whole bubble (the
 *  RN-honest “grayscale + slight blur”; exported for the tests). */
export const DELIVERY_VEIL_OPACITY = 0.12;
/** §2.7 (c) — the processing edge's breathing mix depths (0.34 ↔ 0.62, the
 *  static 0.55 reduced-motion hold; exported for the tests). */
export const DELIVERY_EDGE_LOW = 0.34;
export const DELIVERY_EDGE_HIGH = 0.62;
export const DELIVERY_EDGE_STATIC = 0.55;
/** §2.7 (d) — the failed tell: the danger edge's mix depth over card. */
export const DELIVERY_FAILED_EDGE = 0.22;
/** §2.7 (c) — the breathing edge's one leg (the house 550ms live rhythm). */
const DELIVERY_EDGE_LEG_MS = 550;

// ── the list ────────────────────────────────────────────────────────────────

/** The answer resolver the question cards call (the screen owns the POST). */
export type QuestionAnswerFn = (
  questionId: string,
  answers: string[],
  sources: Array<"option" | "custom">,
) => Promise<boolean>;

/** The plain (non-virtualized) list — small transcripts + tests. R119-A: it
 *  speaks the SAME grammar as the screen's FlatList — order (the queued
 *  law) + group (the turn partition) + the row renderer — so both lists
 *  can never disagree about the anatomy. */
export function TranscriptList({
  items,
  onApprovalDecide,
  onAnswerQuestion,
  subagentLive,
  onRetryError,
}: {
  items: TranscriptItem[];
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
  /** R117-d2 — the live sub-agent map (the SubAgentCard's live data source). */
  subagentLive?: Record<string, SubAgentLiveEntry>;
  /** R117-d2 — the error card's Retry (the screen owns the re-send). */
  onRetryError?: () => void;
}) {
  const rows = groupDisplayRows(orderDisplayItems(items));
  return (
    <View style={styles.list} accessibilityLabel="Conversation transcript">
      {rows.map((row) => (
        <TranscriptRowView
          key={row.key}
          row={row}
          onApprovalDecide={onApprovalDecide}
          onAnswerQuestion={onAnswerQuestion}
          subagentLive={subagentLive}
          onRetryError={onRetryError}
        />
      ))}
    </View>
  );
}

/** One rendered ROW — exported for the session screen's inverted FlatList
 *  (R119-A: the list's data is the GROUPED stream — turn blocks + the
 *  standalone cards; the row's key is the group's first item's key, so
 *  recycling stays stable). */
export function TranscriptRowView({
  row,
  onApprovalDecide,
  onAnswerQuestion,
  subagentLive,
  onRetryError,
}: {
  row: DisplayRow;
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
  /** R117-d2 — the live sub-agent map (the SubAgentCard's live data source).
   * Absent on a settled transcript (no live overlay) — the card renders its
   * quiet settled shape. */
  subagentLive?: Record<string, SubAgentLiveEntry>;
  /** R117-d2 — the error card's Retry (zero-arg: the SCREEN binds the failed
   * turn's user message before calling — the PC's own contract). */
  onRetryError?: () => void;
}) {
  if (row.kind === "turn") {
    return <TurnBlock group={row} />;
  }
  return (
    <TranscriptItemView
      item={row.item}
      onApprovalDecide={onApprovalDecide}
      onAnswerQuestion={onAnswerQuestion}
      subagentLive={subagentLive}
      onRetryError={onRetryError}
    />
  );
}

/** One STANDALONE item row — the interactive + terminal surfaces only
 *  (R119-A: the assistant/thinking/tool kinds belong to the TurnBlock; the
 *  narrowed prop type enforces it at compile time — a caller feeding an
 *  ungrouped item simply cannot compile). */
export function TranscriptItemView({
  item,
  onApprovalDecide,
  onAnswerQuestion,
  subagentLive,
  onRetryError,
}: {
  item: StandaloneTranscriptItem;
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
  /** R117-d2 — the live sub-agent map (the SubAgentCard's live data source).
   * Absent on a settled transcript (no live overlay) — the card renders its
   * quiet settled shape. */
  subagentLive?: Record<string, SubAgentLiveEntry>;
  /** R117-d2 — the error card's Retry (zero-arg: the SCREEN binds the failed
   * turn's user message before calling — the PC's own contract). */
  onRetryError?: () => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <UserBubble
          content={item.content}
          queued={item.queued}
          attachments={item.attachments}
          ts={item.ts}
          status={item.status}
        />
      );
    case "approval":
      return <ApprovalMini item={item} onDecide={onApprovalDecide} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswerQuestion} />;
    case "todo":
      return <TodoCard item={item} />;
    case "subagent":
      return <SubAgentCard item={item} live={subagentLive?.[item.childSessionId]} />;
    case "image":
      return <ImageTile item={item} />;
    case "meta":
      return <MetaLine text={item.text} />;
    case "error":
      return (
        <ErrorCard
          code={item.code}
          message={item.message}
          errorClass={item.errorClass ?? null}
          attempts={item.attempts ?? null}
          providerError={item.providerError ?? null}
          classMessage={item.classMessage ?? null}
          onRetry={onRetryError}
        />
      );
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

// ── user (the WhatsApp-shaped bubble — chat.md §Transcript) ─────────────────

/** The image-extension test (name OR the persisted path). */
const IMAGE_ATTACHMENT_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

function isImageAttachment(a: AttachmentView): boolean {
  return IMAGE_ATTACHMENT_RE.test(a.name) || (a.path !== undefined && IMAGE_ATTACHMENT_RE.test(a.path));
}

/**
 * The attachment's RENDERABLE image bytes, when the model carries them: a
 * data/file/content/http URI riding `path`. The wire's MessageAttachment is
 * name/path/size today, so this stays null for now — it is exactly the hook
 * the frozen data model grows into (the thumbnail already knows how to draw
 * pixels the moment one rides here). A project-relative "attachments/foo.png"
 * path is NOT bytes and never pretends to be.
 */
function attachmentImageUri(a: AttachmentView): string | null {
  const p = a.path;
  if (p === undefined) return null;
  return /^(data:|file:|content:|https?:)/i.test(p) ? p : null;
}

function UserBubble({
  content,
  queued,
  attachments,
  ts,
  status,
}: {
  content: string;
  queued: boolean;
  attachments: AttachmentView[] | null;
  ts: string | null;
  /** R116-m → R118-D — the delivery ladder's rung (optional: undefined =
   *  the settled shape — clean history). */
  status: UserDeliveryStatus | undefined;
}) {
  const { tokens } = useTheme();
  // R114-d — the chat prefs: density shrinks the bubble's VERTICAL padding;
  // text size scales the body; timestamps gate the quiet clock.
  const prefs = useChatPrefs();
  const pad = densityVerticalPadding(prefs.chatDensity);
  const scale = textSizeScale(prefs.chatTextSize);
  const clock = timestampsVisible(prefs.timestampsMode) ? messageClock(ts) : null;
  // chat.md — the accent-TINTED clay fill (never a solid accent slab): the
  // accent mixed ~10% over the card, with a slightly deeper tint edge. This
  // is the PC chat's own bubble math, ported through mixHex.
  // round-117-elevation §2.2: the tint deepens (0.16 fill / 0.34 edge) — the
  // bubble reads as the sender's accent clay, not a near-card wash.
  const tintedFill = mixHex(tokens.card, tokens.accent, 0.16);
  const tintedEdge = mixHex(tokens.card, tokens.accent, 0.34);
  // R118-D (d) — the failed rung's subtle danger border tint (the same mix
  // depth family the accent edge uses, danger over card — the fill stays
  // honest; NO glyph — the error card below carries the alert + Retry).
  const failedEdge = mixHex(tokens.card, tokens.danger, DELIVERY_FAILED_EDGE);
  const chipFill = mixHex(tokens.card, tokens.accent, 0.18);
  const chipEdge = mixHex(tokens.card, tokens.accent, 0.32);
  const images = attachments?.filter(isImageAttachment) ?? [];
  const files = attachments?.filter((a) => !isImageAttachment(a)) ?? [];
  // R118-D (§2.7) — the four body treatments, keyed on the STATUS (the old
  // code keyed its neutral arm on the queued FLAG):
  //   (a) sending — the queued arm's neutral clay (card fill, border edge,
  //       clay top edge) + textSecondary text + the veil below;
  //   (b) sent/delivered — the settled tint, byte-identical to today;
  //   (c) processing — the normal fill + the BREATHING accent edge (below);
  //   (d) failed — the normal fill + the danger edge.
  const sending = status === "sending";
  const failed = status === "failed";
  const processing = status === "processing";
  const fill = sending ? tokens.card : tintedFill;
  const edge = failed ? failedEdge : sending ? tokens.border : tintedEdge;
  const topEdge = failed ? failedEdge : sending ? tokens.clayTopEdge : tintedEdge;
  const rung = deliveryVisualRung(status);
  const bubbleLabel = queued ? "Queued message" : "Your message";
  const accessibilityLabel = rung !== null ? `${bubbleLabel} — ${rung}` : bubbleLabel;

  // R118-D (c) — the processing edge's breath: the bubble's borderColor
  // interpolates mixHex(card, accent, 0.34) ↔ 0.62 on the house 550ms legs
  // (the caret/LiveHeaderLine rhythm); reduced motion holds the static 0.55
  // mix. The bubble's View becomes an Animated.View for this row only —
  // every other rung renders the plain View, byte-identical to R117.
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!processing) return;
    if (reduced) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: DELIVERY_EDGE_LEG_MS }),
        withTiming(0, { duration: DELIVERY_EDGE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [processing, reduced, pulse]);
  const processingEdgeLow = mixHex(tokens.card, tokens.accent, DELIVERY_EDGE_LOW);
  const processingEdgeHigh = mixHex(tokens.card, tokens.accent, DELIVERY_EDGE_HIGH);
  const processingEdgeStatic = mixHex(tokens.card, tokens.accent, DELIVERY_EDGE_STATIC);
  const processingEdgeStyle = useAnimatedStyle(() => ({
    borderColor: reduced
      ? processingEdgeStatic
      : interpolateColor(pulse.value, [0, 1], [processingEdgeLow, processingEdgeHigh]),
  }));

  // The bubble's content — shared by the plain and the animated shells.
  const body = (
    <>
      {queued && (
        <View style={{ marginBottom: spacing.xs }}>
          <Badge tone="neutral">queued</Badge>
        </View>
      )}
      <Text
        style={{
          // (a) sending — textSecondary (the desaturation half of the dull
          // arm; the veil below is the other half).
          color: sending ? tokens.textSecondary : tokens.text,
          fontSize: Math.round(TYPE_BODY * scale),
          fontFamily: fontFamily.regular,
          lineHeight: Math.round(22 * scale),
        }}
      >
        {content}
      </Text>
      {images.map((a) => (
        <UserImageThumb key={`img-${a.name}-${a.path ?? ""}`} attachment={a} />
      ))}
      {files.length > 0 && (
        <View style={styles.userAttachRow}>
          {files.map((a) => (
            <View
              key={`${a.name}-${a.path ?? ""}`}
              accessibilityLabel={`Attachment ${a.name}`}
              style={[
                styles.userAttachChip,
                {
                  backgroundColor: queued ? tokens.subtle : chipFill,
                  borderColor: queued ? tokens.borderSubtle : chipEdge,
                },
              ]}
            >
              <ImageIcon size={11} color={queued ? tokens.textTertiary : tokens.accent} strokeWidth={2.2} />
              <Text
                style={{
                  color: tokens.textSecondary,
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
      {/* chat.md — the clock lives INSIDE the bubble's bottom-right corner
          (10px tertiary), never floating below it. R118-D — the clock row
          renders ONLY the clock (the tick ladder is retired; the timestampsMode
          pref gates the row as always). */}
      {clock !== null && (
        <View style={styles.userClockRow} testID="transcript-user-clock">
          <TypeCaption style={{ color: tokens.textTertiary, fontSize: 10 }}>{clock}</TypeCaption>
        </View>
      )}
      {/* (a) sending — the VEIL: the RN-honest “grayscale + slight blur” —
          bg at 12% over the whole bubble, the bubble's own radii, pointer
          events off (RN has no View blur filter and expo-blur is not
          installed; the desaturated palette + this haze read as the same
          soft dim the owner drew). Last child = paints over everything. */}
      {sending && (
        <View
          pointerEvents="none"
          style={[styles.userVeil, { backgroundColor: tokens.bg, opacity: DELIVERY_VEIL_OPACITY }]}
          testID="transcript-user-veil"
        />
      )}
    </>
  );

  return (
    <View style={styles.userRow}>
      {processing ? (
        <Animated.View
          accessibilityLabel={accessibilityLabel}
          testID="transcript-user-bubble"
          style={[
            styles.userBubble,
            {
              backgroundColor: fill,
              borderTopColor: topEdge,
              boxShadow: tokens.clayShadowSm,
              paddingVertical: pad,
            },
            // The static pose — the reduced-motion 0.55 mix, and the
            // pre-attach fallback (last-wins: the worklet's borderColor wins
            // once it reports).
            { borderColor: processingEdgeStatic },
            processingEdgeStyle,
          ]}
        >
          {body}
        </Animated.View>
      ) : (
        <View
          accessibilityLabel={accessibilityLabel}
          testID="transcript-user-bubble"
          style={[
            styles.userBubble,
            {
              backgroundColor: fill,
              borderTopColor: topEdge,
              borderColor: edge,
              boxShadow: tokens.clayShadowSm,
              paddingVertical: pad,
            },
          ]}
        >
          {body}
        </View>
      )}
    </View>
  );
}

/**
 * One image attachment — a PROPER rounded thumbnail (chat.md: r12, ~64% of
 * the column, aspect-kept; donts #16 bans the squinted tiny tile). With
 * pixels (a renderable URI on the model) the image draws at its measured
 * aspect and taps into the full-screen viewer; without pixels (today's
 * name/path/size wire) the same geometry renders the honest image frame —
 * icon + name + size — never a fabricated photo.
 */
function UserImageThumb({ attachment }: { attachment: AttachmentView }) {
  const { tokens } = useTheme();
  const uri = attachmentImageUri(attachment);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  // Aspect-kept: measure the image's TRUE ratio once per uri (fallback 4:3
  // covers a failed measure — the tile never guesses wrong twice).
  useEffect(() => {
    if (uri === null) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => {
        if (!cancelled && h > 0) setAspect(w / h);
      },
      () => {
        // measure failed — the 4:3 fallback stands (never a crash)
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);
  const ratio = aspect ?? 4 / 3;

  const tile = (
    <View
      style={[
        styles.userImageTile,
        { borderColor: tokens.borderSubtle, backgroundColor: tokens.subtle },
      ]}
    >
      {uri !== null ? (
        <Image
          source={{ uri }}
          style={[styles.userImageFill, { aspectRatio: ratio }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.userImageFrame, { aspectRatio: ratio }]}>
          <ImageIcon size={20} color={tokens.textTertiary} strokeWidth={1.8} />
          <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
            {attachment.name}
            {attachment.size !== undefined ? ` · ${formatAttachmentSize(attachment.size)}` : ""}
          </TypeCaption>
        </View>
      )}
    </View>
  );

  if (uri === null) {
    // No pixels on the wire — the honest frame, not tappable (nothing to show).
    return <View accessibilityLabel={`Image attachment ${attachment.name}`}>{tile}</View>;
  }
  return (
    <View>
      <Pressable
        accessibilityLabel={`Open the image ${attachment.name}`}
        accessibilityRole="button"
        onPress={() => setViewerOpen(true)}
      >
        {tile}
      </Pressable>
      <ImageViewer
        uri={uri}
        caption={attachment.name}
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />
    </View>
  );
}

// ── THE TURN BLOCK (R119-A — one visual turn per exchange) ──────────────────
//
// The §N verdict's answer: a turn's assistant/thinking/tool items render as
// ONE clay container —
//   · the ACTIVITY RAIL, the collapsible head row above the text: collapsed
//     it carries the ONE summary line ("Thought for 8s · 3 actions ▾", the
//     pure `activitySummary`); live it carries the breathing "Thinking…"
//     word (the retired placeholder's own dots + model micro-mono) or the
//     RUNNING TOOL's verb ("Reading src/a.ts…") — one line, never the
//     thinking card AND a tool card stacked;
//   · the ACTIVITY WELL the rail expands: the recessed surfaceWell container
//     (the usage-cards' own recipe: surfaceWell + hairline clayRim +
//     RADIUS_INPUT) carrying the thinking text (the retired ThinkingBlock's
//     mono-dim voice, its 20-line settled cap + Show all) over the R118
//     strong-Hairline divider, then the TOOL ROWS — one compact row per
//     call (icon + verb + target + status), the retired cards' content
//     logic as each row's expandable body;
//   · the REPLY as the block's body below the rail (the retired
//     AssistantBlock's grammar: the meta line above the first content
//     chunk, the MarkdownText, the shared LiveCaret while streaming).
// The toolActivity pref applies INSIDE (hidden: no tool rows, the rail only
// while thinking text exists — the clean document; compact: one-line rows,
// no expansion; detailed: the full anatomy). The well's open state rides the
// PC's own discipline (WorkingSection): live → open (the work streams into
// view), the settle → collapse, a user's tap always wins.

export function TurnBlock({ group }: { group: TurnGroup }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  const reduced = useReducedMotion();
  const visibility = toolActivityVisibility(prefs.toolActivity);
  // R114-d — the prefs: body text scales (mono/micro lines never do — they
  // are the calibration marks); density shrinks the block's vertical
  // padding; timestamps gate the meta clock.
  const scale = textSizeScale(prefs.chatTextSize);

  // ── the members (the group's items, split by role) ──────────────────────
  const thinkingText = turnThinkingText(group.items);
  const toolItems = group.items.filter((item): item is ToolItem => item.kind === "tool");
  const assistantItems = group.items.filter(
    (item): item is TranscriptItem & { kind: "assistant" } => item.kind === "assistant",
  );

  // ── the rail's facts + ONE summary line (pure — features/turn-block.ts) ──
  const facts = turnActivityFacts(group, prefs.toolActivity);
  const summary = activitySummary(facts);
  const showToolRows = !visibility.hidden;
  const wellHasContent = thinkingText !== null || (showToolRows && toolItems.length > 0);

  // ── the body (the retired AssistantBlock's grammar, over the segments) ──
  const textSegments = assistantItems.filter((seg) => {
    const live = seg.live && seg.chunks !== null ? seg.chunks.join("") : "";
    return live !== "" || (!seg.live && seg.content !== "");
  });
  const hasContent = textSegments.length > 0;
  // chat.md — the meta line rides ABOVE the FIRST CONTENT chunk and only
  // when the turn has content (a thinking-only turn keeps its quiet rail).
  const firstContentTs = textSegments[0]?.ts ?? null;
  const clock = timestampsVisible(prefs.timestampsMode) ? messageClock(firstContentTs) : null;

  // ── the well's open state — the PC's discipline, verbatim in spirit:
  // live → open, the settle → collapse, a user's tap wins (userTouched).
  const [open, setOpen] = useState(group.live);
  const userTouched = useRef(false);
  const prevLive = useRef(group.live);
  useEffect(() => {
    if (!userTouched.current) {
      if (group.live) setOpen(true);
      else if (prevLive.current !== group.live) setOpen(false);
    }
    prevLive.current = group.live;
  }, [group.live]);
  const toggleWell = (): void => {
    userTouched.current = true;
    setOpen((value) => !value);
  };

  // ── the live rail's breath — the retired placeholder's own 0.85↔1 ~1.2s
  // cycle, calm, only while the turn WORKS (once text streams, the shared
  // LiveCaret owns the motion — never two breathing things for one state).
  const railBreathes = group.live && !facts.writing;
  const breathe = useSharedValue(1);
  useEffect(() => {
    if (!railBreathes || reduced) {
      breathe.value = 1;
      return;
    }
    breathe.value = withRepeat(
      withSequence(
        withTiming(0.85, { duration: BREATHE_LEG_MS }),
        withTiming(1, { duration: BREATHE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [railBreathes, reduced, breathe]);
  const railBreath = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, breathe.value)),
  }));

  // The live rail's THINKING word carries the placeholder's full grammar —
  // the three staggered dots + the word + the resolved model in micro mono
  // (the calibration-mark voice the meta line speaks).
  const railThinkingWord = group.live && facts.runningToolWord === null && !facts.writing;
  const railInner = railThinkingWord ? (
    <View style={styles.turnRailDots}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.thinkingDotSlot}>
          <ThinkingDot color={tokens.textTertiary} delay={i * 180} />
        </View>
      ))}
      <TypeCaption style={{ color: tokens.textTertiary, marginLeft: spacing.xs }} numberOfLines={1}>
        {summary}
      </TypeCaption>
      {group.model !== null && (
        <TypeMono style={{ color: tokens.textTertiary, fontSize: 11 }} numberOfLines={1}>
          {`· ${group.model}`}
        </TypeMono>
      )}
    </View>
  ) : (
    <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
      {summary}
    </TypeCaption>
  );
  const railChevron = open ? (
    <ChevronUp size={15} color={tokens.textTertiary} strokeWidth={2} />
  ) : (
    <ChevronDown size={15} color={tokens.textTertiary} strokeWidth={2} />
  );
  // The rail is a CONTROL only while the well has something to show; the
  // pending state (dots, no content yet) is a state line, never a dead button.
  const rail =
    summary !== null ? (
      wellHasContent ? (
        <Pressable
          accessibilityLabel={open ? "Hide the turn's activity" : "Show the turn's activity"}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={toggleWell}
          style={styles.turnRail}
        >
          <Animated.View style={[styles.turnRailRow, railBreath]}>{railInner}</Animated.View>
          {railChevron}
        </Pressable>
      ) : (
        <View style={styles.turnRail}>
          <Animated.View style={[styles.turnRailRow, railBreath]}>{railInner}</Animated.View>
        </View>
      )
    ) : null;

  return (
    <View
      accessibilityLabel={turnBlockA11yLabel({ ...facts, replyText: turnReplyText(group.items) })}
      style={[
        styles.turnBlock,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: tokens.borderSubtle,
          boxShadow: tokens.clayShadowSm,
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
        },
      ]}
      testID="transcript-turn-block"
    >
      {rail}
      {wellHasContent && (
        <Reveal open={open}>
          <View
            style={[styles.turnWell, { backgroundColor: tokens.surfaceWell, borderColor: tokens.clayRim }]}
          >
            {thinkingText !== null && <WellThinking text={thinkingText} live={group.live} />}
            {thinkingText !== null && showToolRows && toolItems.length > 0 && <Hairline strong />}
            {showToolRows &&
              toolItems.map((item) => (
                <ToolRow key={item.key} item={item} expandable={visibility.expandable} />
              ))}
          </View>
        </Reveal>
      )}
      {hasContent && (group.model !== null || clock !== null) && (
        <TypeMono
          numberOfLines={1}
          style={{ color: tokens.textTertiary, fontSize: 10.5 }}
          testID="transcript-assistant-meta"
        >
          {[group.model, clock].filter((part) => part !== null).join(" · ")}
        </TypeMono>
      )}
      {textSegments.map((seg, index) => {
        const liveText = seg.live && seg.chunks !== null ? seg.chunks.join("") : "";
        if (liveText !== "") {
          const isLast = index === textSegments.length - 1;
          return (
            <View key={seg.key} style={styles.assistantLive}>
              <MarkdownText content={liveText} textScale={scale} />
              {/* R118-B — the shared LiveCaret (the private recipe's exact
                  extraction; reuse, never re-roll). */}
              {isLast && <LiveCaret color={tokens.accent} label="the agent is still writing" />}
            </View>
          );
        }
        return seg.content !== "" ? (
          <MarkdownText key={seg.key} content={seg.content} textScale={scale} />
        ) : null;
      })}
    </View>
  );
}

/**
 * The well's thinking text — the retired ThinkingBlock's own body, moved
 * inside (R116-m's settled cap 20 + the "Show all" affordance at the cap;
 * live thinking never clamps — it IS the stream). The block-level rail owns
 * the collapse; this is the TEXT alone.
 */
function WellThinking({ text, live }: { text: string; live: boolean }) {
  const { tokens } = useTheme();
  const [showAll, setShowAll] = useState(false);
  const overCap = !live && text.split("\n").length > THINKING_SETTLED_CAP;
  return (
    <View style={{ gap: spacing.xs }}>
      <TypeMono
        style={{ color: tokens.textTertiary }}
        numberOfLines={live ? undefined : showAll ? undefined : THINKING_SETTLED_CAP}
      >
        {text}
      </TypeMono>
      {overCap && (
        <Pressable
          accessibilityLabel={showAll ? "Show less of the agent's thinking" : "Show all of the agent's thinking"}
          accessibilityRole="button"
          onPress={() => setShowAll((value) => !value)}
          style={styles.thinkingShowAll}
          testID="thinking-show-all"
        >
          <TypeMicro style={{ color: tokens.accent }} numberOfLines={1}>
            {showAll ? "Show less" : "Show all"}
          </TypeMicro>
        </Pressable>
      )}
    </View>
  );
}

/** One pulsing dot of the live rail's thinking word — the StatusDot's calm
 * 1.2s opacity pulse (the house motion vocabulary), staggered per dot;
 *  reduced motion snaps to a steady mid read (§5). R119-A: the dots moved
 *  from the retired ThinkingPlaceholder card INTO the rail's live state. */
function ThinkingDot({ color, delay }: { color: string; delay: number }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    if (reduced) {
      opacity.value = 0.6;
      return;
    }
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
  }, [opacity, delay, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[animated, { width: 6, height: 6, borderRadius: 3, backgroundColor: color }]}
    />
  );
}

/** The quiet breathing dot the question card leads with (the same calm
 * 1.2s pulse grammar — the card asks for attention once, calmly). */
function PulseDot({ color, size }: { color: string; size: number }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    if (reduced) {
      opacity.value = 0.7;
      return;
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: BREATHE_LEG_MS }),
        withTiming(0.35, { duration: BREATHE_LEG_MS }),
      ),
      -1,
      false,
    );
  }, [opacity, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[animated, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}
    />
  );
}

// ── the tool rows (R119-A — the retired cards' content logic, moved INSIDE
// the TurnBlock's well) ──────────────────────────────────────────────────────
//
// ONE compact row per call: icon + verb + target + status (the head row the
// cards always led with), the retired card families' content riding below —
// the write family's streaming tail + "Wrote {file}" + +A/−B diff chips, the
// terminal family's streamed output tail + exit summary, the read family's
// quiet one-liner, the generic fallback's humanized verb + target. Tapping a
// row expands its detail (args dump + output tail + output summary) while
// toolActivity=detailed; compact pins every row to its one line; hidden never
// renders the rows at all (the block's rail collapses with them).
//
// The failed call's tell stays the R116-m grammar: the inline danger chip on
// the head row + the row's quiet danger wash (visible at a glance inside the
// well); running = the small warning chip; success = NOTHING.

function ToolRow({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const failed = item.ok === false;
  const running = item.ok === null;
  const isWrite = WRITE_TOOLS.has(item.toolName);
  const isTerminal = TERMINAL_TOOLS.has(item.toolName);
  const isRead = READ_TOOLS.has(item.toolName);

  // The head's ONE line — the families' existing grammar, moved from the
  // retired cards: the write family keeps its "Writing {file}… · {n} chars"
  // streaming verb and "Wrote {file}" settle; every other family carries the
  // CompactToolRow's own one-line law, "verb · target".
  const preview = extractWritePreview(item.inputRaw ?? "");
  const path = writePath(item);
  const streaming = running && isWrite && item.inputRaw !== null;
  let title: string;
  if (isWrite) {
    const verbRunning = item.toolName === "write_file" ? "Writing" : "Editing";
    const verbDone = item.toolName === "write_file" ? "Wrote" : "Edited";
    title = running
      ? path !== null
        ? streaming
          ? `${verbRunning} ${path}… · ${preview.chars.toLocaleString()} chars`
          : `${verbRunning} ${path}…`
        : `${verbRunning}…`
      : path !== null
        ? `${verbDone} ${path}`
        : humanizeToolName(item.toolName);
  } else {
    const summary = isRead ? readTargetSegment(item) : genericOneLineSummary(item);
    title =
      summary !== null && summary !== ""
        ? `${humanizeToolName(item.toolName)} · ${summary}`
        : humanizeToolName(item.toolName);
  }
  const icon = isWrite ? (
    <FileCode2 size={13} color={tokens.accent} strokeWidth={2.2} />
  ) : isTerminal ? (
    <SquareTerminal size={13} color={tokens.accent} strokeWidth={2.2} />
  ) : isRead ? (
    <BookOpenText size={13} color={tokens.accent2} strokeWidth={2.2} />
  ) : (
    <Wrench size={13} color={tokens.textSecondary} strokeWidth={2.2} />
  );
  // R116-m — the settled edit's +A/−B chips ride the head line (null while
  // running, on failures, and for plain writes — the byte summary line below
  // carries those stories honestly).
  const diff = isWrite ? writeLineDiff(item) : null;
  // The quiet content tail — the LAST 160 chars of what has arrived (the
  // R58-c streamed-args preview: the head lives in the reducer's raw; the
  // tail is what is being typed NOW).
  const writeTail =
    streaming && preview.content !== ""
      ? preview.content.length > 160
        ? `…${preview.content.slice(preview.content.length - 160)}`
        : preview.content
      : null;
  // The terminal family's streamed output tail (tool-output frames; the
  // persisted fold never carries one — live-only, exactly the old card).
  const terminalTail = isTerminal && item.outputTail !== null && item.outputTail !== "" ? item.outputTail : null;

  return (
    <View
      style={[
        styles.turnToolRow,
        // The failed row's quiet danger wash (donts #37's card-wide tint,
        // translated to the row inside the well).
        failed ? { backgroundColor: mixHex(tokens.surfaceWell, tokens.danger, 0.08) } : null,
      ]}
    >
      <ToolHeadRow
        item={item}
        icon={icon}
        title={title}
        expanded={showDetails}
        expandable={expandable}
        onToggle={expandable ? () => setExpanded((v) => !v) : undefined}
        after={diff !== null ? <WriteDiffChips added={diff.added} removed={diff.removed} /> : undefined}
      />
      {writeTail !== null && (
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
          {writeTail}
        </TypeMono>
      )}
      {terminalTail !== null && (
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
          {terminalTail}
        </TypeMono>
      )}
      {!running && !isRead && item.outputSummary !== null && item.outputSummary !== "" && (
        <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={showDetails ? undefined : 1}>
          {item.outputSummary}
        </TypeMono>
      )}
      {showDetails && (
        <Reveal open>
          {!isTerminal && item.argsSummary !== "" && (
            <TypeMono style={{ color: tokens.textSecondary }} numberOfLines={6}>
              {item.argsSummary}
            </TypeMono>
          )}
          {!isTerminal && !isWrite && item.outputTail !== null && item.outputTail !== "" && (
            <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={8}>
              {item.outputTail}
            </TypeMono>
          )}
          {isRead && item.outputSummary !== null && item.outputSummary !== "" && (
            <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={4}>
              {item.outputSummary}
            </TypeMono>
          )}
        </Reveal>
      )}
    </View>
  );
}

/**
 * R116-m — the head's QUIET status chip (donts #37: the right-side FAIL
 * text badge column is retired): "running" rides a small warning-tinted
 * chip only while the call runs, a compact danger chip when it failed —
 * and NOTHING on success (the result rides the head line itself, never a
 * badge). One quiet chip, never a shouty column.
 */
function ToolStatusChip({ ok }: { ok: boolean | null }) {
  const { tokens } = useTheme();
  if (ok === true) return null;
  if (ok === null) {
    return (
      <View style={[styles.statusChip, { backgroundColor: mixHex(tokens.card, tokens.warning, 0.12) }]}>
        <TypeMono style={{ color: tokens.warning, fontSize: 10, lineHeight: 13 }} numberOfLines={1}>
          running
        </TypeMono>
      </View>
    );
  }
  return (
    <View style={[styles.statusChip, { backgroundColor: mixHex(tokens.card, tokens.danger, 0.1) }]}>
      <TypeMono style={{ color: tokens.danger, fontSize: 10, lineHeight: 13 }} numberOfLines={1}>
        failed
      </TypeMono>
    </View>
  );
}

/** The +A/−B count chips (mono 11px, inline in the settled head row): the
 * added count on a quiet success tint, the removed count on a quiet danger
 * tint — the PC chat's own diff-chip grammar, ported through mixHex. The
 * removed label carries the server's own minus glyph (U+2212). */
function WriteDiffChips({ added, removed }: { added: number; removed: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.diffChips}>
      <View style={[styles.diffChip, { backgroundColor: mixHex(tokens.card, tokens.success, 0.12) }]}>
        <TypeMono style={{ color: tokens.success, fontSize: 11, lineHeight: 14 }} numberOfLines={1}>
          {`+${added}`}
        </TypeMono>
      </View>
      <View style={[styles.diffChip, { backgroundColor: mixHex(tokens.card, tokens.danger, 0.1) }]}>
        <TypeMono style={{ color: tokens.danger, fontSize: 11, lineHeight: 14 }} numberOfLines={1}>
          {`−${removed}`}
        </TypeMono>
      </View>
    </View>
  );
}

/** The head row every card leads with: icon + title (mono, one line) +
 * the optional inline result (the write card's +A/−B chips) + the QUIET
 * status chip + the chevron while expandable (R116-m — the badge column is
 * retired). Tappable as the whole card's expand when `onToggle` is set. */
function ToolHeadRow({
  item,
  icon,
  title,
  expanded,
  expandable,
  onToggle,
  after,
}: {
  item: ToolItem;
  icon: React.ReactNode;
  title: string;
  expanded: boolean;
  expandable: boolean;
  onToggle?: () => void;
  /** R116-m — inline content between the title and the status chip (the
   * settled write card's line-count chips; nothing for every other card). */
  after?: React.ReactNode;
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
      {after}
      <ToolStatusChip ok={item.ok} />
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
        <PulseDot color={tokens.accent} size={7} />
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
  const prefs = useChatPrefs();
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
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
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
        <Badge tone={complete ? "success" : "accent"} textStyle={{ textTransform: "uppercase" }}>
          Task list
        </Badge>
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
                  ) : null}
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

/**
 * R117-d2 — the card grows up (the mobile multi-agent parity leg):
 *   · LIVE — while the child streams, a 2px BREATHING accent rule rides the
 *     card's top (the header live-line's own rhythm) and ONE last-activity
 *     line names what the child is doing right now (the subagentLive
 *     entry's word: the latest tool step, else the thinking flag, else
 *     "writing…"/"waiting…" — with the current attempt's tool-call count).
 *   · STOP — a single danger decision row while the child runs
 *     (POST /sessions/:childId/stop on the CHILD directly, R52-b: the
 *     parent turn continues); optimistic busy ("Stopping…") that holds
 *     until the terminal status frame settles the card, exactly the PC
 *     panel's own semantics.
 *   · RETRY — a single accent decision row once the child failed or was
 *     stopped (POST /sessions/:parent/subagents/:child/retry — the event
 *     log IS the resume point); the retried child's queued/running frames
 *     flip the card back to its live shape.
 * Both rows sit OUTSIDE the tap-to-open region (a decision is not a
 * navigation — the ToolCard/TodoCard grammar of a pressable head over a
 * plain body), carry honest busy states + failure notes, and fire the
 * decision haptic on tap.
 */
function SubAgentCard({
  item,
  live,
}: {
  item: TranscriptItem & { kind: "subagent" };
  /** R117-d2 — the child's LIVE entry (the screen passes the live turn's
   * subagentLive map; undefined on a settled transcript — no live overlay). */
  live?: SubAgentLiveEntry;
}) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  const router = useRouter();
  const running = item.status === "running" || item.status === "queued";
  const failed = item.status === "failed";
  const tone = failed ? tokens.danger : running ? tokens.running : tokens.success;

  // ── the LIVE leg: the breathing rule + the last-activity word ─────────────
  const liveAttached = running && live !== undefined;
  const activityWord =
    live === undefined
      ? null
      : live.lastActivity !== null
        ? live.lastActivity
        : live.thinking !== "" && live.text === ""
          ? "thinking…"
          : live.text !== ""
            ? "writing its reply…"
            : "waiting for its first response";
  const activityLine =
    activityWord === null || live === undefined
      ? null
      : live.toolCalls > 0
        ? `${activityWord} · ${live.toolCalls} call${live.toolCalls === 1 ? "" : "s"}`
        : activityWord;

  // ── STOP (R52-b: the route aborts the child's OWN turn registration) ──────
  // Optimistic, the PC panel's exact semantics: the row flips to "Stopping…"
  // immediately and the terminal subagent-status frame settles the card; the
  // busy state clears only on a refusal (the honest note) or the settle.
  const [stopSent, setStopSent] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const stopping = stopSent && running;
  const doStop = (): void => {
    if (stopSent) return;
    void decisionHaptic();
    setStopSent(true);
    setStopNote(null);
    void postStop(getLinkManager(), item.childSessionId)
      .then((outcome) => {
        if (!outcome.ok) {
          setStopNote(`couldn't stop — ${outcome.error.message}`);
          setStopSent(false);
        }
        // ok → the failed status frame (detail "stopped by the owner") lands
        // on the stream and settles the card; the busy state holds until it
        // does (the effect below clears it on the flip).
      })
      .catch(() => {
        setStopNote("couldn't stop — the host is offline");
        setStopSent(false);
      });
  };

  // ── RETRY (ADR-0022: the event log is the resume point) ───────────────────
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const doRetry = (): void => {
    if (retrying) return;
    const parentId = live?.parentSessionId ?? null;
    if (parentId === null || parentId === "") {
      setRetryNote("couldn't retry — the parent session is unknown");
      return;
    }
    void decisionHaptic();
    setRetrying(true);
    setRetryNote(null);
    void postSubAgentRetry(getLinkManager(), parentId, item.childSessionId)
      .then((outcome) => {
        if (!outcome.ok) {
          setRetryNote(`couldn't retry — ${outcome.error.message}`);
          setRetrying(false);
        }
        // ok → retryChild's own first status frame (running) lands on the
        // stream and flips the card back to its live shape; the busy state
        // holds until it does (the effect above spends it on the flip).
      })
      .catch(() => {
        setRetryNote("couldn't retry — the host is offline");
        setRetrying(false);
      });
  };

  // The child's live status settles the optimistic busy states: a fresh
  // attempt (queued/running — a retry took; retryChild's own first frame)
  // spends the retrying state, and a settle (completed/failed — the stop's
  // terminal frame) spends the stopping state. The rows re-derive from the
  // real status either way.
  useEffect(() => {
    if (item.status === "running" || item.status === "queued") {
      setRetrying(false);
    } else {
      setStopSent(false);
    }
  }, [item.status]);

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
      {liveAttached && <SubAgentLiveLine color={tokens.accent} />}
      <Pressable
        accessibilityLabel={`Sub-agent ${item.role}${item.code !== null ? ` ${item.code}` : ""} — ${item.status}. ${item.task}. Open its transcript.`}
        accessibilityRole="button"
        onPress={() => router.push(`/session/${item.childSessionId}`)}
        style={styles.subagentPressBody}
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
        {activityLine !== null && (
          <TypeCaption
            style={{ color: tokens.textTertiary }}
            numberOfLines={1}
            testID="subagent-live-activity"
          >
            {activityLine}
          </TypeCaption>
        )}
        <TypeCaption style={{ color: tokens.textTertiary }}>tap to open its transcript →</TypeCaption>
      </Pressable>
      {running && (
        <Pressable
          accessibilityLabel={stopping ? "Stopping the sub-agent" : "Stop this sub-agent — the parent turn continues"}
          accessibilityRole="button"
          accessibilityState={{ disabled: stopping }}
          disabled={stopping}
          onPress={doStop}
          style={styles.subagentActionRow}
          testID="subagent-stop"
        >
          <Square size={11} color={tokens.danger} strokeWidth={2.2} />
          <TypeCaption
            style={{ color: tokens.danger, fontFamily: fontFamily.bold }}
            numberOfLines={1}
          >
            {stopping ? "Stopping…" : "Stop"}
          </TypeCaption>
          <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
            the parent turn continues
          </TypeCaption>
        </Pressable>
      )}
      {stopNote !== null && (
        <TypeCaption style={{ color: tokens.danger }} numberOfLines={2}>
          {stopNote}
        </TypeCaption>
      )}
      {failed && (
        <Pressable
          accessibilityLabel={retrying ? "Retrying the sub-agent" : "Retry the sub-agent — it resumes from where it stopped"}
          accessibilityRole="button"
          accessibilityState={{ disabled: retrying }}
          disabled={retrying}
          onPress={doRetry}
          style={styles.subagentActionRow}
          testID="subagent-retry"
        >
          <RefreshCw size={11} color={tokens.accent} strokeWidth={2.2} />
          <TypeCaption
            style={{ color: tokens.accent, fontFamily: fontFamily.bold }}
            numberOfLines={1}
          >
            {retrying ? "Retrying…" : "Retry"}
          </TypeCaption>
          <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
            resumes from where it stopped
          </TypeCaption>
        </Pressable>
      )}
      {retryNote !== null && (
        <TypeCaption style={{ color: tokens.danger }} numberOfLines={2}>
          {retryNote}
        </TypeCaption>
      )}
    </View>
  );
}

/**
 * R117-d2 — the card's LIVE rule: a 2px accent line riding the card's top,
 * breathing while the child streams (the live caret's own rhythm — motion.md
 * §3, opacity 0.25↔1; reduced motion snaps it solid — §5). The style's
 * negative margin mounts it flush above the head row.
 */
function SubAgentLiveLine({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.25, { duration: SUBAGENT_LIVE_LEG_MS }), withTiming(1, { duration: SUBAGENT_LIVE_LEG_MS })),
      -1,
      false,
    );
  }, [opacity, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel="the sub-agent is streaming"
      style={[animated, styles.subagentLiveLine, { backgroundColor: color }]}
    />
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
        testID="transcript-image-tile"
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
          // The quiet skeleton tile (donts #14 — skeletons, never spinners).
          <Skeleton style={styles.imageSkeleton} />
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
  const prefs = useChatPrefs();
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
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
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

/**
 * R116-m — the COMPACT error card: the danger border + a ONE-LINE head (the
 * code, mono danger) + the message clamped to 3 lines collapsed, expanded
 * behind the house's head-tap + chevron grammar (the thinking/debug block's
 * own affordance). The expand chevron appears ONLY when the message
 * plausibly exceeds the clamp — more than 3 newlines, or long enough to
 * tail-truncate (~180 chars ≈ 3 body lines) — a message that fits never
 * offers a dead toggle.
 *
 * R117-d2 — the PC's honesty set, wherever the wire already carries the data
 * (the turn.error payload + the live error frame's details have ridden these
 * fields since R43/R71/R75): the errorClass chip (a quiet danger chip, the
 * class spelled with spaces), the attempts line ("after N attempts" — the
 * wire carries the retry ladder's exhausted COUNT, never a pair), a
 * Copy-details row (code + class + attempts + message to the platform
 * clipboard — expo-clipboard, manual.tsx's own carrier — with a quiet
 * "Copied" dwell), and a Retry row wired to the screen's callback (the
 * screen re-sends the failed turn's user message through the normal send
 * path; absent callback → no row, exactly the PC's optional-onRetry). The
 * card stays COMPACT — the richness is in the LINES, not the size.
 *
 * R119-P (round-119 §1 item F — the owner's TokenHarbor report: a
 * region_blocked provider answer read as an unexplained generic failure on
 * the phone): the BODY now prefers the provider's RAW error text
 * (providerError, ≤4000 chars on the wire since R78/R80) as the headline —
 * the PC's TurnErrorCard already did `providerError ?? message`; mobile now
 * matches, with the generic machine message demoted to the dim secondary
 * line (errorCardLines, exported for the tests). Copy details carries BOTH
 * texts + the live frame's classified human line (classMessage). The clamp,
 * the expand law, the chips, and the Retry row are untouched.
 */
function ErrorCard({
  code,
  message,
  errorClass,
  attempts,
  providerError,
  classMessage,
  onRetry,
}: {
  code: string;
  message: string;
  /** The classified provider-error class (null = none rode the wire). */
  errorClass?: string | null;
  /** The retry ladder's exhausted attempt count (rendered only when > 1). */
  attempts?: number | null;
  /** R119-P — the provider's RAW error text (null = the wire carried none;
   * the card then keeps the generic message as its only body). */
  providerError?: string | null;
  /** R119-P — the classified human one-liner (live frames only); rides Copy
   * details, never the body. */
  classMessage?: string | null;
  /** Zero-arg — the SCREEN binds the failed turn's user message. */
  onRetry?: () => void;
}) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  const [expanded, setExpanded] = useState(false);
  // R119-P — the body selection (errorCardLines above): the RAW provider
  // text is the headline when present; the generic machine message demotes
  // to the secondary line. The clamp + expand law is computed on the
  // PRIMARY (the line the owner actually reads).
  const { primary, secondary } = errorCardLines(providerError, message);
  const expandable =
    primary.split("\n").length > ERROR_MESSAGE_CLAMP_LINES || primary.length > ERROR_MESSAGE_EXPAND_CHARS;
  const cls = errorClass ?? null;
  const attemptCount =
    attempts !== null && attempts !== undefined && attempts > 1 ? attempts : null;
  // The copied-dwell's reset timer — cleared on unmount (a late setState on
  // a dead card is noise, never a crash, but the cleanup is free).
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
    };
  }, []);
  // R119-P — Copy details carries BOTH texts (the raw provider line + the
  // generic machine message) plus the classified human line when the live
  // frame carried one — the full honest story on the clipboard.
  const detailsText = [
    "Generation failed",
    `Code: ${code}`,
    ...(cls !== null ? [`Class: ${cls}`] : []),
    ...(attemptCount !== null ? [`Attempts: ${attemptCount}`] : []),
    ...(secondary !== null ? [`Provider error: ${primary}`, `Error: ${secondary}`] : [`Error: ${primary}`]),
    ...(classMessage !== null && classMessage !== undefined && classMessage.trim() !== ""
      ? [`Class message: ${classMessage.trim()}`]
      : []),
  ].join("\n");
  const onCopy = (): void => {
    void Clipboard.setStringAsync(detailsText)
      .then((ok) => {
        if (ok) {
          setCopyState("copied");
          void selectionHaptic();
        } else {
          setCopyState("failed");
          void warningHaptic();
        }
        if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopyState("idle"), COPY_STATE_DWELL_MS);
      })
      .catch(() => {
        setCopyState("failed");
        void warningHaptic();
        if (copyResetRef.current !== null) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopyState("idle"), COPY_STATE_DWELL_MS);
      });
  };
  const head = (
    <View style={styles.toolHead}>
      <TypeMono
        style={{ color: tokens.danger, fontFamily: fontFamily.monoMedium, flex: 1 }}
        numberOfLines={1}
      >
        {code}
      </TypeMono>
      {expandable ? (
        expanded ? (
          <ChevronUp size={15} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={15} color={tokens.textTertiary} strokeWidth={2} />
        )
      ) : null}
    </View>
  );
  return (
    <View
      accessibilityLabel={errorCardA11yLabel(code, primary)}
      style={[
        styles.toolCard,
        {
          backgroundColor: tokens.card,
          borderTopColor: tokens.clayTopEdge,
          borderColor: tokens.danger,
          boxShadow: tokens.clayShadowSm,
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
        },
      ]}
    >
      {expandable ? (
        <Pressable
          accessibilityLabel={`${code} error${expanded ? ", expanded" : ""}`}
          accessibilityRole="button"
          onPress={() => setExpanded((v) => !v)}
        >
          {head}
        </Pressable>
      ) : (
        head
      )}
      {(cls !== null || attemptCount !== null) && (
        <View style={styles.errorChipsRow}>
          {cls !== null && (
            <View
              accessibilityLabel={`provider error class ${cls}`}
              style={[styles.errorChip, { backgroundColor: mixHex(tokens.card, tokens.danger, 0.12) }]}
              testID="error-class-chip"
            >
              <TypeMono style={{ color: tokens.danger, fontSize: 10 }} numberOfLines={1}>
                {cls.replace(/_/g, " ")}
              </TypeMono>
            </View>
          )}
          {attemptCount !== null && (
            <View
              accessibilityLabel={`after ${attemptCount} attempts`}
              style={[styles.errorChip, { backgroundColor: tokens.subtle }]}
              testID="error-attempts"
            >
              <TypeMono style={{ color: tokens.textSecondary, fontSize: 10 }} numberOfLines={1}>
                after {attemptCount} attempt{attemptCount === 1 ? "" : "s"}
              </TypeMono>
            </View>
          )}
        </View>
      )}
      {/* R119-P — the body: the RAW provider text as the headline (the
          honest line — e.g. TokenHarbor's region_blocked message verbatim),
          the generic machine message demoted to the dim secondary line
          (context, never the headline). No providerError → the generic
          line stays the only body, exactly the R117-d2 card. */}
      <TypeBody
        style={{ color: tokens.textSecondary }}
        numberOfLines={expanded ? undefined : ERROR_MESSAGE_CLAMP_LINES}
      >
        {primary}
      </TypeBody>
      {secondary !== null ? (
        <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
          {secondary}
        </TypeCaption>
      ) : null}
      <View style={styles.errorActionsRow}>
        <Pressable
          accessibilityLabel="Copy the error details"
          accessibilityRole="button"
          onPress={onCopy}
          style={styles.errorAction}
          testID="error-copy"
        >
          <Copy size={12} color={tokens.textSecondary} strokeWidth={2.1} />
          <TypeCaption
            style={{
              color: copyState === "copied" ? tokens.accent : tokens.textSecondary,
              fontFamily: fontFamily.semibold,
            }}
            numberOfLines={1}
          >
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "couldn't copy" : "Copy details"}
          </TypeCaption>
        </Pressable>
        {onRetry !== undefined && (
          <Pressable
            accessibilityLabel="Retry the failed message"
            accessibilityRole="button"
            onPress={onRetry}
            style={styles.errorAction}
            testID="error-retry"
          >
            <RefreshCw size={12} color={tokens.danger} strokeWidth={2.1} />
            <TypeCaption style={{ color: tokens.danger, fontFamily: fontFamily.bold }} numberOfLines={1}>
              Retry
            </TypeCaption>
          </Pressable>
        )}
      </View>
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
  /** chat.md — r20 with the tighter 16px bottom-right corner (the tail hint). */
  userBubble: {
    maxWidth: "88%",
    borderRadius: RADIUS_CARD,
    borderBottomRightRadius: RADIUS_BUBBLE_TAIL,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.xs,
  },
  /** The clock's quiet right-aligned line INSIDE the bubble (R118-D — the
   *  tick ladder is retired; ONLY the clock renders here). */
  userClockRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 4,
  },
  /** R118-D (a) — the sending VEIL: bg at 12% over the whole bubble, the
   *  bubble's own radii (r20 + the 16px tail corner), pointer events off. */
  userVeil: {
    ...StyleSheet.absoluteFill,
    borderRadius: RADIUS_CARD,
    borderBottomRightRadius: RADIUS_BUBBLE_TAIL,
  },
  userAttachRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
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
  /** chat.md — the user image thumbnail: r12, ~64% of the COLUMN (72% of the
   * 88% bubble), aspect-kept, quiet border. */
  userImageTile: {
    width: "72%",
    alignSelf: "flex-start",
    borderRadius: RADIUS_IMAGE,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  userImageFill: {
    width: "100%",
    aspectRatio: 4 / 3,
  },
  /** The honest no-pixels frame (icon + name + size) inside the tile. */
  userImageFrame: {
    width: "100%",
    aspectRatio: 4 / 3,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  /** R119-A — THE TURN BLOCK: one clay container per assistant turn (the
   *  existing card grammar, subtle — the retired document's weight):
   *  RADIUS_INPUT, card fill, hairline borderSubtle + clayTopEdge, the
   *  small clay shadow, density-aware vertical padding. */
  turnBlock: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  /** The block's ACTIVITY RAIL — the collapsible head row (minHeight 32,
   *  the toolHead's own quiet target height; the chevron rides outside the
   *  breathing word so it never pulses). */
  turnRail: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 32,
  },
  /** The rail's breathing content wrapper (the retired placeholder's own
   *  0.85↔1 cycle rides here; steady at opacity 1 once text streams). */
  turnRailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  /** The live rail's THINKING word — the retired placeholder's staggered
   *  dots row (gap 5, the word + the model micro-mono in tow). */
  turnRailDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flex: 1,
  },
  /** The recessed ACTIVITY WELL — the usage-cards' own recipe (surfaceWell
   *  fill + hairline clayRim + RADIUS_INPUT), tight rows (gap xs). */
  turnWell: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  /** One tool row inside the well (a failed call's quiet danger wash rides
   *  inline; the rows are flush lines, never nested cards). */
  turnToolRow: {
    gap: spacing.xs,
    borderRadius: 10,
    paddingHorizontal: spacing.sm,
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
  /** The live rail's dot slot (the retired placeholder's own 6×6 slot). */
  thinkingDotSlot: {
    width: 6,
    height: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  /** The quiet terminal block (the write preview's content tail + the
   * command output tail): hairline-bordered, mono-backed at the call
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
  /** R116-m — the head's QUIET status chip (donts #37): a small tinted pill
   * (fill inline per tone — warning while running, danger when failed);
   * NEVER a full-width badge column. */
  statusChip: {
    borderRadius: RADIUS_PILL,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  /** R116-m — the settled write card's inline +A/−B pair. */
  diffChips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  diffChip: {
    borderRadius: RADIUS_PILL,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  /** R116-m → R119-A — the well's thinking text's "Show all" affordance (at
   * the settled cap): the 44px touch-target law on the one interactive row. */
  thinkingShowAll: {
    minHeight: 44,
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  miniLink: {
    minHeight: 44,
    justifyContent: "center",
  },
  metaRow: {
    minHeight: 32,
    justifyContent: "center",
    maxWidth: 320,
    alignSelf: "flex-start",
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
    gap: spacing.xs,
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
  /** R117-d2 — the card's LIVE rule: 2px full-width accent, breathing while
   * the child streams (the header live-line's own geometry). The negative
   * bottom margin cancels the card's row gap so the rule sits flush above
   * the head — flipping the state moves the card's content by exactly its
   * own 2px. */
  subagentLiveLine: {
    height: 2,
    borderRadius: 1,
    marginBottom: -spacing.sm,
  },
  /** R117-d2 — the tap-to-open region's own column gap (the card's gap now
   * separates the region from the action rows, so the region carries its
   * own). */
  subagentPressBody: {
    gap: spacing.sm,
  },
  /** R117-d2 — the Stop/Retry decision rows: ONE line (icon + bold verdict +
   * a tertiary tail), the 44px touch-target law, never inside the
   * tap-to-open region. */
  subagentActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 44,
  },
  /** R117-d2 — the error card's honesty chips row (class + attempts): the
   * quiet chip grammar — small tinted pills, never badges. */
  errorChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  errorChip: {
    borderRadius: RADIUS_PILL,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  /** R117-d2 — the error card's action row: Copy details + Retry side by
   * side, each the 44px law, quiet text buttons (icon + caption). */
  errorActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  errorAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 44,
  },
  imageWrapRow: {
    alignSelf: "flex-start",
  },
  /** chat.md — the ephemeral screenshot's lazy tile: 240×120, r12, quiet border. */
  imageTile: {
    width: 240,
    height: 120,
    borderRadius: RADIUS_IMAGE,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  imageTileImage: {
    width: "100%",
    height: "100%",
  },
  imageSkeleton: {
    width: "100%",
    height: "100%",
    borderRadius: RADIUS_IMAGE,
  },
  imageExpired: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
});
