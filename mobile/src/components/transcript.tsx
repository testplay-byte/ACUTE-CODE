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
 *     that logic is untouched). With the header's avatar live-edge ring (the
 *     R123-retired breathing LINE's survivor — see the screen) this is the
 *     whole "processing" story — no spinner anywhere.
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
 * the house 550ms legs — the live caret's rhythm; reduced motion
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
 *
 * ROUND-123 (R123-W-m — the mobile transcript redesign, per the owner's 7
 * reference screenshots + his report): the tool rows become FIRST-CLASS
 * VISIBLE stream elements. (1) THE WELL'S DEFAULT IS OPEN: the R119
 * settle-collapse hid every tool row behind the one-line rail the moment a
 * turn settled — the owner watched his agent's turn settle and "no tool
 * calls were shown to me… No file writes were shown to me". `wellDefaultOpen`
 * (pure, exported) answers the new law: OPEN for every turn whose well
 * renders tool rows (live turns keep today's open behavior; a user's tap
 * still wins for the block's lifetime; a thinking-ONLY well keeps the R119
 * settle-collapse — the §N verdict on the thinking wall stands). (2) THE
 * USER BUBBLE'S IMAGES RIDE ABOVE THE TEXT — the owner: "the image was
 * supposed to be shown at the top of the text… In the PC, it was shown
 * properly" — `userBubbleBodyPlan` (pure, exported) is the ordering contract
 * (images → text → file chips). (3) THE RHYTHM: consecutive assistant text
 * segments inside one TurnBlock carry a consistent extra gap (never one wall
 * of text), and the tool rows' icon+verb+meta grammar gains the web families
 * (Globe icon; browser/search/fetch rows read their own action/query/url
 * targets — see features/turn-block.ts's R123 note). The toolActivity pref
 * and the well's Reveal entrance stay exactly as they were.
 *
 * ROUND-129 (R129-M — the separated-elements rework, per the owner's
 * v0.121.0 device verdict: the R119 TurnBlock "combines everything together
 * in a single session… not managed properly", the tool cards "look way too
 * cramped together", the thinking "is combined with the tool cards", and
 * "the implementation of bubbles for the reply is most definitely not a
 * great option. You should not utilize bubbles for the reply, but just
 * directly writing the text… like how most of the other modern ones handle
 * it. It would give us much more space."): the ONE clay container dies AS A
 * CONTAINER (chat.md §Transcript R129 — the amendment). A turn's elements
 * render as SIBLINGS with real spacing, never inside one shared card:
 *   · the RAIL survives as a PLAIN tertiary line above the cards (the
 *     R120-CM hints law unchanged) — no container, no expand of its own,
 *     no chevron, never a control;
 *   · the THINKING ROW is its own collapsible element between the rail and
 *     the cards (label + chevron, the house disclosure motion, the retired
 *     ThinkingBlock's dim mono voice behind the expand);
 *   · the TOOL CARDS are proper cards — one clay card per call (the house
 *     12px card padding, r12, the card surface + hairline clayRim, 8px
 *     gaps between cards), the retired rows' content logic preserved, body
 *     OPEN by default (R123-W-m's law survives), each independently
 *     collapsible;
 *   · the REPLY is FLAT — the meta line + the MarkdownText directly on the
 *     screen background, full width, the shared LiveCaret while streaming.
 * The well, its rows, and `wellDefaultOpen` are RETIRED; `turnElementsPlan`
 * (pure, exported) is the render contract jest pins. The data model, the
 * grouping, the queued law, the user bubble, and every standalone card are
 * untouched.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BookOpenText, Check, ChevronDown, ChevronUp, CircleX, Copy, FileCode2, Globe, ImageIcon, RefreshCw, Square, SquareTerminal, Wrench } from "lucide-react-native";
import { useTheme, useChatPrefs, type ToolActivity } from "@/design/theme";
import { decisionHaptic, selectionHaptic, warningHaptic } from "@/design/haptics";
import { Badge, LiveCaret, Skeleton, TypeBody, TypeCaption, TypeMicro, TypeMono } from "@/design/primitives";
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
  BROWSER_TOOLS,
  extractWritePreview,
  READ_TOOLS,
  TERMINAL_TOOLS,
  WEB_TOOLS,
  WRITE_TOOLS,
} from "@/features/streaming-args";
import {
  activitySummary,
  groupDisplayRows,
  orderDisplayItems,
  thinkingRowLabel,
  toolRowTitle,
  turnActivityFacts,
  turnBlockA11yLabel,
  turnReplyText,
  turnThinkingText,
  writeLineDiff,
  type DisplayRow,
  type StandaloneTranscriptItem,
  type ToolItem,
  type TurnGroup,
} from "@/features/turn-block";
import {
  DISCLOSURE_COLLAPSE_MS,
  DISCLOSURE_FADE_MS,
  DISCLOSURE_SPRING,
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

/**
 * ROUND-121 (R121-c — the pixels round): the screen-injected image-bytes
 * resolver — fetchAttachmentImageFile over the link, threaded down to the
 * user bubble's image thumbnails. Absent in tests / fixture contexts: the
 * honest frame stands, byte-identical to the pre-R121 render.
 */
export type AttachmentImageResolver = (a: AttachmentView) => Promise<string | null>;

// ── local drawing constants (chat.md's own geometry — the file's class) ─────

/** chat.md — the image radius: r12 on thumbnails + screenshot tiles. */
const RADIUS_IMAGE = 12;
/** chat.md §Transcript R129 — the TOOL CARD's radius: r12, the amendment's
 *  own literal. The tokens ladder's `card` radius is r20, so this stays a
 *  LOCAL chat geometry constant in RADIUS_IMAGE's own class (flagged in the
 *  round's caveats — the amendment's "RADIUS_CARD r12" names a value the
 *  token does not carry). */
const RADIUS_TOOL_CARD = 12;
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
  attachmentImageResolver,
}: {
  items: TranscriptItem[];
  onApprovalDecide?: (approvalId: string) => void;
  onAnswerQuestion?: QuestionAnswerFn;
  /** R117-d2 — the live sub-agent map (the SubAgentCard's live data source). */
  subagentLive?: Record<string, SubAgentLiveEntry>;
  /** R117-d2 — the error card's Retry (the screen owns the re-send). */
  onRetryError?: () => void;
  /** R121-c — the image-bytes resolver (the pixels round); see the type. */
  attachmentImageResolver?: AttachmentImageResolver;
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
          attachmentImageResolver={attachmentImageResolver}
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
  attachmentImageResolver,
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
  /** R121-c — the image-bytes resolver (the pixels round); see the type. */
  attachmentImageResolver?: AttachmentImageResolver;
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
      attachmentImageResolver={attachmentImageResolver}
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
  attachmentImageResolver,
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
  /** R121-c — the image-bytes resolver (the pixels round); see the type. */
  attachmentImageResolver?: AttachmentImageResolver;
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
          attachmentImageResolver={attachmentImageResolver}
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

// ── R129-M — the house DISCLOSURE motion as a measured clip ─────────────────
//
// disclosure.tsx's own grammar, read + reused as its constants + its measured
// clip technique (the brief's "read MOTION/the disclosure component's own
// grammar … if reusable"): expand rides DISCLOSURE_SPRING {180, 24} — one
// soft settle, the bounce the owner likes as a whisper; collapse is
// withTiming 200ms ease-out on the height with the 150ms content fade — a
// timing curve cannot overshoot, so closing NEVER bounces (R118-C §2.7);
// reduced motion snaps. The one extension the live transcript needs over the
// shared Disclosure primitive: an OPEN clip RE-SPRINGS when its measured
// content CHANGES, so a streaming body (the live thinking stream, a running
// tool's growing tail) never clamps behind a stale measured height.

/** The collapse's timing curve — ease-out, zero overshoot by construction
 *  (disclosure.tsx's own COLLAPSE_EASING). */
const COLLAPSE_EASING = Easing.out(Easing.quad);

function DisclosureClip({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);
  const measured = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      height.value = open ? measured.value : 0;
      opacity.value = open ? 1 : 0;
      return;
    }
    if (open) {
      // §2.7 — the expand: the disclosure spring (one soft settle).
      height.value = withSpring(measured.value, DISCLOSURE_SPRING);
      opacity.value = withSpring(1, DISCLOSURE_SPRING);
    } else {
      // §2.7 — the collapse: timing cannot overshoot; the content fades
      // slightly ahead of the height.
      height.value = withTiming(0, { duration: DISCLOSURE_COLLAPSE_MS, easing: COLLAPSE_EASING });
      opacity.value = withTiming(0, { duration: DISCLOSURE_FADE_MS });
    }
  }, [open, reduced, height, opacity, measured]);
  const clip = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));
  return (
    <Animated.View style={[styles.disclosureClip, clip]} pointerEvents={open ? "auto" : "none"}>
      {/* The measurement child: absolutely positioned so a collapsed clip
          height can never clamp its own layout (disclosure.tsx's own Yoga
          fix — the projects-accordion deadlock, avoided by construction).
          The re-measure rides the spring while OPEN (the live stream's
          growth), never a snap — except under reduced motion. */}
      <View
        style={styles.disclosureMeasure}
        onLayout={(event) => {
          const h = event.nativeEvent.layout.height;
          if (h <= 0) return;
          const changed = h !== measured.value;
          measured.value = h;
          if (open && changed) {
            height.value = reduced ? h : withSpring(h, DISCLOSURE_SPRING);
          }
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
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

/**
 * R123-W-m — the user bubble's BODY PLAN (pure, exported for the tests):
 * the bubble's ordered content regions. IMAGES RIDE ABOVE THE TEXT — the
 * owner's report: "the image was supposed to be shown at the top of the
 * text, but it was shown below the text. In the PC, it was shown properly" —
 * and the FILE CHIPS stay below the text (chat.md's own law, unchanged).
 * The component renders the plan's order verbatim; this function IS the
 * ordering contract, so jest pins what the owner demanded.
 */
export type UserBubbleBodyPart =
  | { role: "images"; attachments: AttachmentView[] }
  | { role: "text" }
  | { role: "files"; attachments: AttachmentView[] };

export function userBubbleBodyPlan(
  attachments: AttachmentView[] | null,
): UserBubbleBodyPart[] {
  const images = attachments?.filter(isImageAttachment) ?? [];
  const files = attachments?.filter((a) => !isImageAttachment(a)) ?? [];
  return [
    ...(images.length > 0 ? [{ role: "images" as const, attachments: images }] : []),
    { role: "text" as const },
    ...(files.length > 0 ? [{ role: "files" as const, attachments: files }] : []),
  ];
}

function UserBubble({
  content,
  queued,
  attachments,
  ts,
  status,
  attachmentImageResolver,
}: {
  content: string;
  queued: boolean;
  attachments: AttachmentView[] | null;
  ts: string | null;
  /** R116-m → R118-D — the delivery ladder's rung (optional: undefined =
   *  the settled shape — clean history). */
  status: UserDeliveryStatus | undefined;
  /** R121-c — the image-bytes resolver (the pixels round); see the type. */
  attachmentImageResolver?: AttachmentImageResolver;
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
  // R123-W-m — the bubble's ordered content regions (pure — the images ride
  // ABOVE the text, the file chips below it; the plan is the contract).
  const bodyPlan = userBubbleBodyPlan(attachments);
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
  // (the live caret's rhythm); reduced motion holds the static 0.55
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
  // R123-W-m: the body renders the PLAN's order — the image thumbnails ride
  // ABOVE the message text (the PC's own ordering, the owner's report), the
  // file chips stay below it. The image block carries its own bottom beat so
  // the text never kisses the thumbnail (the bubble's xs gap + the beat =
  // the house 8dp rhythm).
  const body = (
    <>
      {queued && (
        <View style={{ marginBottom: spacing.xs }}>
          <Badge tone="neutral">queued</Badge>
        </View>
      )}
      {bodyPlan.map((part) => {
        if (part.role === "images") {
          return part.attachments.map((a) => (
            <UserImageThumb
              key={`img-${a.name}-${a.path ?? ""}`}
              attachment={a}
              resolveImage={attachmentImageResolver}
            />
          ));
        }
        if (part.role === "files") {
          return (
            <View key="files" style={styles.userAttachRow}>
              {part.attachments.map((a) => (
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
          );
        }
        return (
          <Text
            key="text"
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
        );
      })}
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
 * pixels (a renderable URI on the model, or the R121-c RESOLVER's fetched
 * cache-file URI) the image draws at its measured aspect and taps into the
 * full-screen viewer; without pixels (no resolver, or an honest miss) the
 * same geometry renders the honest image frame — icon + name + size —
 * never a fabricated photo.
 */
function UserImageThumb({
  attachment,
  resolveImage,
}: {
  attachment: AttachmentView;
  /** ROUND-121 (R121-c — the pixels round): the screen-injected bytes
   * resolver (fetchAttachmentImageFile over the link); absent in tests /
   * fixture contexts — the frame stands, exactly as before. */
  resolveImage?: AttachmentImageResolver;
}) {
  const { tokens } = useTheme();
  const wireUri = attachmentImageUri(attachment);
  const [resolvedUri, setResolvedUri] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  // ROUND-121 (R121-c): the seam's second leg — when the wire carries no
  // URI but a resolver is injected, fetch the bytes once per attachment
  // (the resolver's cache-file keying makes re-renders free). A miss or an
  // absent resolver leaves the honest frame — never a fabricated photo.
  useEffect(() => {
    if (wireUri !== null || resolveImage === undefined) return;
    let cancelled = false;
    resolveImage(attachment)
      .then((uri) => {
        if (!cancelled && uri !== null) setResolvedUri(uri);
      })
      .catch(() => {
        // An honest miss — the frame stands (never a crash).
      });
    return () => {
      cancelled = true;
    };
  }, [wireUri, resolveImage, attachment]);

  const uri = wireUri ?? resolvedUri;
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

// ── THE TURN — SEPARATED ELEMENTS (R129-M, per chat.md §Transcript R129) ───
//
// The owner's v0.121.0 device verdict on the R119-A container — it "combines
// everything together", the tool cards are "way too cramped", the thinking
// "is combined with the tool cards", and the reply read as a bubble — retires
// the ONE-clay-container law AS A CONTAINER. A turn's elements render as
// SIBLINGS with real spacing, never inside one shared clay card:
//   · THE RAIL — the plain tertiary glance line ABOVE the cards ("Thought
//     for 8s · 3 actions · src/a.ts, npm test" — the R120-CM hints law
//     unchanged: toolHint/toolHintList, ORDER-PRESERVING dedup, the
//     TOOL_HINT_MAX 3 cap, the honest "+N more" tail): NO container, NO
//     expand of its own, NO chevron, never a control. Live states unchanged
//     (the breathing "Thinking…" with the retired placeholder's own dots +
//     model micro-mono / the RUNNING tool's verb / "Writing…" — ONE line);
//     breathing only while the turn WORKS (once text streams, the shared
//     LiveCaret owns the motion — never two breathing things for one
//     state). A turn with no activity at all renders no rail.
//   · THE THINKING ROW — its own collapsible element between the rail and
//     the tool cards (never inside a shared well with tool rows): the label
//     ("Thinking…" live / "Thought for 8s" settled — the pure
//     `thinkingRowLabel` grammar) + chevron; behind the expand, the dim mono
//     thinking text in the retired ThinkingBlock's own voice (20-line
//     settled cap + "Show all"; live thinking never clamps, live-open), the
//     house DISCLOSURE motion (expand springs, collapse times —
//     DisclosureClip above). A turn with no thinking renders no row.
//   · THE TOOL CARDS — one clay CARD per tool call (NOT one row in a shared
//     well): the house CARD padding (spacing.md = 12px all sides — the
//     density pref's compact rung halves the vertical per its pinned
//     contract), r12, the card surface (tokens.card — never surfaceWell), a
//     hairline clayRim, 8px vertical gaps between cards (the turn column's
//     own beat). The retired rows' content logic is PRESERVED: the head line
//     (icon + verb + target — `toolRowTitle`), the quiet status chip
//     (running = warning; failed = danger + the card's quiet danger wash;
//     interrupted = neutral; success = nothing — the result rides the
//     head/result lines), and the body — OPEN by default (R123-W-m's law
//     survives: the owner must SEE the work), independently collapsible by a
//     head tap (the house disclosure motion); compact pins the card to its
//     one line (no expansion); hidden renders no cards at all.
//   · THE REPLY — FLAT: the meta line (model · time) above the first
//     content chunk, then the MarkdownText directly on the screen
//     background, full width, the shared LiveCaret while streaming — no
//     card, no container, NO bubble ("just directly writing the text… like
//     how most of the other modern ones handle it").
// The turn's outer View carries NO surface — the plain column's only job is
// the sibling spacing. `turnElementsPlan` (pure, exported below) is the
// render contract: which elements exist, in what order, with which geometry —
// the component renders the plan verbatim, jest pins it (the
// userBubbleBodyPlan precedent: the function IS the ordering contract).

/** The plan's RAIL element (the plain glance line). */
export type RailElement = {
  element: "rail";
  summary: string;
  live: boolean;
  /** Breathing only while the turn WORKS — once text streams, the shared
   *  LiveCaret owns the motion (never two breathing things for one state). */
  breathes: boolean;
  /** chat.md R129 — the rail is a PLAIN LINE: never a control, never a
   *  chevron, no expand of its own. */
  isControl: false;
  hasChevron: false;
};

/** The plan's THINKING ROW element (its own collapsible row). */
export type ThinkingElement = {
  element: "thinking";
  text: string;
  label: string;
  live: boolean;
  /** live-open (the stream IS the activity); settled starts collapsed
   *  behind the label (the R124 verdict on the thinking wall stands). */
  defaultOpen: boolean;
};

/** The plan's TOOL CARD element (one clay card per call). */
export type ToolCardElement = {
  element: "tool-card";
  key: string;
  /** detailed = the tap-to-collapse anatomy; compact = no expansion. */
  expandable: boolean;
  /** R123-W-m surviving in the separated grammar: OPEN by default — the
   *  owner must SEE the work (compact renders no body at all). */
  bodyOpen: boolean;
};

/** The plan's REPLY element (FLAT — no card, no container, NO bubble). */
export type ReplyElement = {
  element: "reply";
  /** FLAT: no surface rides the reply's wrapper, ever. */
  surface: null;
};

/** One element of the turn's separated layout. */
export type TurnElementDescriptor =
  | RailElement
  | ThinkingElement
  | ToolCardElement
  | ReplyElement;

/** R129-M — the turn's SEPARATED-ELEMENTS plan (the pure render contract). */
export interface TurnElementsPlan {
  /** The turn container carries NO surface (no clay card, no well, no
   *  bubble) — the elements render directly on the screen background. */
  containerSurface: null;
  /** The turn's ordered sibling elements (rail → thinking → cards → reply;
   *  only the elements the turn actually has — a thinking-less turn renders
   *  no thinking element, a hidden-tools turn renders no cards). */
  elements: TurnElementDescriptor[];
  /** One clay card per tool call — the house CARD padding (spacing.md = 12,
   *  the comfortable literal; the density pref's compact rung halves the
   *  vertical at the component, per its pinned contract). */
  toolCardPadding: number;
  /** chat.md R129 — the tool card's radius (r12). */
  toolCardRadius: number;
  /** The 8px vertical gaps between cards (spacing.sm). */
  toolCardGap: number;
}

/**
 * Build the turn's separated-elements plan off the group + the toolActivity
 * pref (pure — the component renders this verbatim, the tests pin it):
 * presence follows the SAME pure predicates the renderers use (the rail
 * from `activitySummary`, the thinking row from `turnThinkingText`, the
 * cards from the pref's visibility, the reply from `turnReplyText`), and
 * the pref shapes them exactly the way chat.md R129 rules: hidden = no
 * tool cards + the rail only while thinking text exists (the clean
 * document — the summary never teases a count the cards will not show);
 * compact = one-line cards, no expansion; detailed = the full anatomy with
 * the body OPEN by default.
 */
export function turnElementsPlan(group: TurnGroup, activity: ToolActivity): TurnElementsPlan {
  const visibility = toolActivityVisibility(activity);
  const facts = turnActivityFacts(group, activity);
  const summary = activitySummary(facts);
  const thinkingText = turnThinkingText(group.items);
  const elements: TurnElementDescriptor[] = [];
  if (summary !== null) {
    elements.push({
      element: "rail",
      summary,
      live: group.live,
      breathes: group.live && !facts.writing,
      isControl: false,
      hasChevron: false,
    });
  }
  if (thinkingText !== null) {
    elements.push({
      element: "thinking",
      text: thinkingText,
      label: thinkingRowLabel(group.live, facts.thoughtMs),
      live: group.live,
      defaultOpen: group.live,
    });
  }
  if (!visibility.hidden) {
    for (const item of group.items) {
      if (item.kind !== "tool") continue;
      elements.push({
        element: "tool-card",
        key: item.key,
        expandable: visibility.expandable,
        bodyOpen: visibility.expandable,
      });
    }
  }
  if (turnReplyText(group.items) !== "") {
    elements.push({ element: "reply", surface: null });
  }
  return {
    containerSurface: null,
    elements,
    toolCardPadding: spacing.md,
    toolCardRadius: RADIUS_TOOL_CARD,
    toolCardGap: spacing.sm,
  };
}

// ── R128-W6 — the settled tool row's status word (pure, pinned) ────────────

/**
 * The tool row's QUIET status word — the chip's and the a11y label's one
 * vocabulary, pure so jest can pin it: "running" while the call runs,
 * "interrupted" when the turn's terminal frame settled a still-running
 * call (the live overlay's honest marker — sessions.ts's R128-W6 settle; the
 * rehydrate swap remains the truth cure), "failed" when the call itself
 * failed, null on success (the result rides the head line, never a badge).
 */
export function toolStatusWord(
  item: Pick<ToolItem, "ok"> & { interrupted?: true },
): "running" | "failed" | "interrupted" | null {
  if (item.ok === null) return "running";
  if (item.ok === true) return null;
  return item.interrupted === true ? "interrupted" : "failed";
}

// ── R127-W8 — the tools-hidden hint (once per session screen mount) ──────
//
// The R127-Ra research verdict: toolActivity "hidden" is the ONLY render
// path that produces the owner's exact symptom ("conversation text but NO
// tool activity, at all"), and the pick syncs server-side so it survives
// every reconnect. The rung is retired from the picker (appearance.tsx) but
// a persisted value still applies — so the TRANSCRIPT makes the invisible
// state observable: while hidden is active and a turn carries tool items,
// ONE quiet dismissible one-liner renders ("Tool activity is hidden — tap
// to show"; the tap sets detailed — the fix is one press away, the pref is
// never overridden behind the user's back).
//
// ONCE PER SESSION SCREEN MOUNT: the session screen renders TurnBlocks
// through its inverted FlatList; the hint's "generation" runs from the
// first block mount to the LAST block unmount (all blocks gone = the screen
// is gone — the next mount starts a fresh generation). Within a generation
// exactly ONE block owns the hint (the first qualifying render claims it);
// a dismissal (the ✕ or the fix-tap) silences it for the whole generation.
// Honest caveat: a viewport that momentarily shows ZERO turn blocks (a
// window of only standalone cards) also closes a generation — the hint may
// re-appear once when a turn block scrolls back in. That is the cheap cost
// of detecting "screen mount" from inside the row renderer (the screen
// itself is outside this module's ownership).

/** The hint's agreed copy (the spec's exact one-liner — pinned by the tests). */
export const TOOLS_HIDDEN_HINT_COPY = "Tool activity is hidden — tap to show";

let toolsHiddenHintOwner: object | null = null;
let toolsHiddenHintMountedBlocks = 0;
let toolsHiddenHintDismissed = false;

/** Test seam: a fresh generation (the tests mount/unmount blocks directly). */
export function resetToolsHiddenHintForTest(): void {
  toolsHiddenHintOwner = null;
  toolsHiddenHintMountedBlocks = 0;
  toolsHiddenHintDismissed = false;
}

/** The mount leg — EVERY TurnBlock holds its generation open (qualifying or
 * not): the generation ends only when the last block unmounts. */
export function mountToolsHiddenHintBlock(): void {
  toolsHiddenHintMountedBlocks += 1;
}

/** The unmount leg — the last block out closes the generation (a fresh
 * session screen mount starts with the hint available again). */
export function releaseToolsHiddenHintBlock(): void {
  toolsHiddenHintMountedBlocks = Math.max(0, toolsHiddenHintMountedBlocks - 1);
  if (toolsHiddenHintMountedBlocks === 0) {
    toolsHiddenHintOwner = null;
    toolsHiddenHintDismissed = false;
  }
}

/** The dismissal leg — the ✕ or the fix-tap silences the hint for the rest
 * of the generation (the OWNING block also flips its local state so the
 * line disappears immediately, without waiting for a re-render). */
export function dismissToolsHiddenHint(): void {
  toolsHiddenHintDismissed = true;
  toolsHiddenHintOwner = null;
}

/**
 * The claim (called from the block's render): does THIS block render the
 * hint? The first qualifying block of a generation claims it (hidden active
 * + the turn actually carries tool items — a turn with nothing to hide
 * never claims); the owner KEEPS it across its own re-renders while it still
 * qualifies (the claim dies with the fix: once hidden flips false the line
 * is gone). Pure-ish module state — display-only, no data integrity rides
 * it; the pins drive these exact functions.
 */
export function acquireToolsHiddenHint(owner: object, hidden: boolean, toolItemCount: number): boolean {
  if (toolsHiddenHintDismissed) return false;
  if (toolsHiddenHintOwner === owner) return hidden && toolItemCount > 0;
  if (toolsHiddenHintOwner === null && hidden && toolItemCount > 0) {
    toolsHiddenHintOwner = owner;
  }
  return toolsHiddenHintOwner === owner;
}

export function TurnBlock({ group }: { group: TurnGroup }) {
  const { tokens, setToolActivity } = useTheme();
  const prefs = useChatPrefs();
  const reduced = useReducedMotion();
  const visibility = toolActivityVisibility(prefs.toolActivity);
  // R114-d — the prefs: body text scales (mono/micro lines never do — they
  // are the calibration marks); density shrinks the tool cards' vertical
  // padding; timestamps gate the meta clock.
  const scale = textSizeScale(prefs.chatTextSize);

  // ── the members (the group's items, split by role) ──────────────────────
  const toolItems = group.items.filter((item): item is ToolItem => item.kind === "tool");
  const assistantItems = group.items.filter(
    (item): item is TranscriptItem & { kind: "assistant" } => item.kind === "assistant",
  );

  // ── R129-M — the SEPARATED-ELEMENTS plan (pure, exported above): the
  // render contract — which elements exist, in what order, with which
  // geometry. The component renders the plan verbatim (presence comes from
  // the plan's elements; the content below fills each element in). ────────
  const plan = turnElementsPlan(group, prefs.toolActivity);
  const railEl = plan.elements.find((el): el is RailElement => el.element === "rail") ?? null;
  const thinkingEl =
    plan.elements.find((el): el is ThinkingElement => el.element === "thinking") ?? null;
  const toolCardEls = plan.elements.filter(
    (el): el is ToolCardElement => el.element === "tool-card",
  );
  const replyEl = plan.elements.find((el): el is ReplyElement => el.element === "reply") ?? null;

  // ── the rail's facts + ONE summary line (pure — features/turn-block.ts) ──
  const facts = turnActivityFacts(group, prefs.toolActivity);
  const summary = activitySummary(facts);

  // ── R127-W8 — the tools-hidden hint's claim (see the block above): this
  // turn joins the mount generation, and the first qualifying render
  // claims the one-liner. Local hintGone mirrors the module-level dismissal
  // so the line vanishes on the tap itself, not on the next re-render. ──
  const [hintOwner] = useState(() => ({}) as object);
  const [hintGone, setHintGone] = useState(false);
  useEffect(() => {
    mountToolsHiddenHintBlock();
    return () => releaseToolsHiddenHintBlock();
  }, []);
  const showToolsHiddenHint =
    !hintGone && acquireToolsHiddenHint(hintOwner, visibility.hidden, toolItems.length);

  // ── the reply's body (the retired AssistantBlock's grammar, now FLAT —
  // the segments render directly on the screen background, full width) ────
  const textSegments = assistantItems.filter((seg) => {
    const live = seg.live && seg.chunks !== null ? seg.chunks.join("") : "";
    return live !== "" || (!seg.live && seg.content !== "");
  });
  const hasContent = textSegments.length > 0;
  // chat.md — the meta line rides ABOVE the FIRST CONTENT chunk and only
  // when the turn has content (a thinking-only turn keeps its quiet rail).
  const firstContentTs = textSegments[0]?.ts ?? null;
  const clock = timestampsVisible(prefs.timestampsMode) ? messageClock(firstContentTs) : null;

  // ── R129-M — the THINKING ROW's open state (the retired well's own
  // discipline, ported to the separated row): LIVE → open (live thinking
  // never clamps and never collapses — the stream IS the activity); SETTLED
  // → collapsed behind the label (the R124 verdict on the thinking wall
  // stands); an IN-PLACE settle (the live flag flips while the group's keys
  // persist — the terminal frame lands before the rehydrate remount)
  // collapses a thinking-ONLY turn's row exactly the way the retired well
  // collapsed; the user's manual tap always wins for the row's lifetime.
  const [thinkingOpen, setThinkingOpen] = useState(group.live);
  const thinkingUserTouched = useRef(false);
  const prevLive = useRef(group.live);
  useEffect(() => {
    if (!thinkingUserTouched.current) {
      if (group.live) setThinkingOpen(true);
      else if (prevLive.current !== group.live && toolCardEls.length === 0) setThinkingOpen(false);
    }
    prevLive.current = group.live;
  }, [group.live, toolCardEls.length]);

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

  // ── R129-M — THE RAIL is a PLAIN LINE: the turn's ONE glance line renders
  // ABOVE the cards as a plain tertiary row — NO container of its own, NO
  // expand, NO chevron, never a Pressable (the retired rail's control
  // grammar died with the well; the line just states the glance, and the
  // a11y story rides the turn's one container label).
  const rail =
    summary !== null ? (
      <View style={styles.turnRail} testID="transcript-turn-rail">
        <Animated.View style={[styles.turnRailRow, railBreath]}>{railInner}</Animated.View>
      </View>
    ) : null;

  return (
    <View
      accessibilityLabel={turnBlockA11yLabel({ ...facts, replyText: turnReplyText(group.items) })}
      // R129-M — the turn container carries NO surface (no clay card, no
      // well, no bubble): the plain column's only job is the siblings' real
      // spacing (the house 8dp beat — the tool cards' own 8px gaps
      // included).
      style={styles.turnBlock}
      testID="transcript-turn-block"
    >
      {railEl !== null && rail}
      {/* R127-W8 — the retired Hidden rung's observable state: ONE quiet
          dismissible line under the rail (see the hint block above). The
          whole line is the fix — tap → detailed. */}
      {showToolsHiddenHint && (
        <ToolsHiddenHint
          onShow={() => {
            dismissToolsHiddenHint();
            setHintGone(true);
            void selectionHaptic();
            setToolActivity("detailed");
          }}
          onDismiss={() => {
            dismissToolsHiddenHint();
            setHintGone(true);
          }}
        />
      )}
      {thinkingEl !== null && (
        <ThinkingRow
          label={thinkingEl.label}
          live={thinkingEl.live}
          onToggle={() => {
            thinkingUserTouched.current = true;
            setThinkingOpen((value) => !value);
          }}
          open={thinkingOpen}
          text={thinkingEl.text}
        />
      )}
      {/* THE TOOL CARDS — one clay card per call, 8px vertical gaps between
          cards (the turn column's own beat; the plan carries the geometry
          the styles speak). */}
      {toolCardEls.map((el) => {
        const item = toolItems.find((tool) => tool.key === el.key);
        return item === undefined ? null : (
          <ToolCard key={el.key} item={item} expandable={el.expandable} />
        );
      })}
      {/* THE REPLY — FLAT: the meta line above the first content chunk, then
          the markdown directly on the screen background (the retired
          AssistantBlock's grammar minus any container). */}
      {replyEl !== null && (
        <>
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
            // R123-W-m — the rhythm law: consecutive segments of one turn are
            // SEPARATE utterances (the owner: "there was no separation with the
            // elements… it was looking off"), so every segment after the first
            // carries the extra gap — the turn column's own 8dp beat on top of
            // the container gap, double the markdown paragraph's internal
            // rhythm, never one wall of text.
            const segmentGap = index > 0 ? styles.assistantSegmentGap : undefined;
            if (liveText !== "") {
              const isLast = index === textSegments.length - 1;
              return (
                <View key={seg.key} style={[styles.assistantLive, segmentGap]}>
                  <MarkdownText content={liveText} textScale={scale} />
                  {/* R118-B — the shared LiveCaret (the private recipe's exact
                      extraction; reuse, never re-roll). */}
                  {isLast && <LiveCaret color={tokens.accent} label="the agent is still writing" />}
                </View>
              );
            }
            return seg.content !== "" ? (
              <View key={seg.key} style={segmentGap}>
                <MarkdownText content={seg.content} textScale={scale} />
              </View>
            ) : null;
          })}
        </>
      )}
    </View>
  );
}

// ── R127-W8 — the tools-hidden hint row (the quiet one-liner) ────────────

/**
 * The retired Hidden rung's observable state, in the R123 well's own quiet
 * grammar: ONE line under the rail — the message (TypeCaption, tertiary
 * ink — the meta voice, never an alarm) as the whole fix target (tap →
 * setToolActivity("detailed")), plus a small ✕ to dismiss WITHOUT changing
 * the pref (a deliberate hidden pick is a user preference; the hint only
 * says it out loud once). minHeight 32 = the rail's own touch height.
 */
function ToolsHiddenHint({ onShow, onDismiss }: { onShow: () => void; onDismiss: () => void }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.toolsHiddenHint}>
      <Pressable
        accessibilityLabel={`${TOOLS_HIDDEN_HINT_COPY} tool activity`}
        accessibilityRole="button"
        onPress={onShow}
        style={({ pressed }) => [
          styles.toolsHiddenHintPress,
          pressed ? { backgroundColor: tokens.subtleHover } : null,
        ]}
        testID="transcript-tools-hidden-hint"
      >
        <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
          {TOOLS_HIDDEN_HINT_COPY}
        </TypeCaption>
      </Pressable>
      <Pressable
        accessibilityLabel="Dismiss the hidden tool activity hint"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onDismiss}
        testID="transcript-tools-hidden-dismiss"
      >
        <CircleX size={14} color={tokens.textTertiary} strokeWidth={2} />
      </Pressable>
    </View>
  );
}

/**
 * R129-M — THE THINKING ROW: its own collapsible element between the rail
 * and the tool cards (never inside a shared well with tool rows — the
 * owner's "the thoughts or thinking is not shown properly as it should. It
 * is combined with the tool cards" verdict). The label ("Thinking…" live /
 * "Thought for 8s" settled — the pure `thinkingRowLabel` grammar) +
 * chevron; behind the expand, the dim mono thinking text in the retired
 * ThinkingBlock/WellThinking's own voice (the 20-line settled cap + "Show
 * all"; live thinking never clamps, live-open — the stream IS the activity,
 * so the live head carries no toggle and the live body rides unclipped).
 * The settled collapse/expand rides the house DISCLOSURE motion
 * (DisclosureClip — expand springs, collapse times; the R124 settle-collapse
 * law lives in the parent's open-state discipline).
 */
function ThinkingRow({
  text,
  label,
  live,
  open,
  onToggle,
}: {
  text: string;
  label: string;
  live: boolean;
  /** The parent owns the state (the R124 settle discipline + the user's
   *  tap always winning live there). */
  open: boolean;
  onToggle: () => void;
}) {
  const { tokens } = useTheme();
  const [showAll, setShowAll] = useState(false);
  const overCap = !live && text.split("\n").length > THINKING_SETTLED_CAP;
  const chevron = open ? (
    <ChevronUp size={13} color={tokens.textTertiary} strokeWidth={2} />
  ) : (
    <ChevronDown size={13} color={tokens.textTertiary} strokeWidth={2} />
  );
  const labelText = (
    <TypeMono style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
      {label}
    </TypeMono>
  );
  // The dim mono body — the retired ThinkingBlock's own voice: live never
  // clamps (it IS the stream); settled clamps at the 20-line cap until the
  // "Show all" affordance takes over. The label row IS the collapse control
  // now — the retired in-body "Hide" row is redundant under the label +
  // chevron grammar.
  const body = (
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
  if (live) {
    // LIVE — never clamps, live-open, no toggle (the R124 law: collapsing
    // the live moment would hide the very activity the owner asked to see).
    // The head is a plain state line; the chevron shows the open state.
    return (
      <View style={{ gap: spacing.xs }} testID="thinking-row">
        <View style={styles.thinkingRow}>
          {labelText}
          {chevron}
        </View>
        {body}
      </View>
    );
  }
  // SETTLED — the collapsible control: the label row toggles the body
  // behind the house disclosure motion.
  return (
    <View testID="thinking-row">
      <Pressable
        accessibilityLabel={`${label} — show the agent's thinking`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.thinkingRow}
      >
        {labelText}
        {chevron}
      </Pressable>
      <DisclosureClip open={open}>{body}</DisclosureClip>
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

// ── the tool cards (R129-M — one clay CARD per call; the retired rows'
// content logic PRESERVED) ──────────────────────────────────────────────────
//
// THE TOOL CARD: the house card treatment around the retired row's content —
// 12px card padding (spacing.md; the density pref's compact rung halves the
// vertical, its pinned contract), r12 (chat.md R129), the CARD surface
// (tokens.card — never surfaceWell) with a hairline clayRim + the small clay
// shadow, 8px gaps between cards (the turn column's beat). The anatomy: the
// HEAD line (icon + verb + target — `toolRowTitle`; the write family's +A/−B
// diff chips inline; the quiet status chip) + the BODY, OPEN by default
// (R123-W-m's law survives — the owner must SEE the work): the write
// family's streaming tail + "Wrote {file}" + output summary, the terminal
// family's streamed output tail + exit summary, the read family's quiet
// one-liner, the generic fallback's args + output. Tap the head toggles the
// body (the house disclosure motion); compact pins the card to its head
// line — one-line cards, no expansion; hidden never renders cards at all.
//
// The failed call's tell stays the R116-m grammar: the inline danger chip on
// the head line + the card's quiet danger wash; running = the small warning
// chip; success = NOTHING. R128-W6: an INTERRUPTED settle (the turn's
// terminal frame landed before the result — sessions.ts settles the stuck
// running cards) reads NEUTRAL — the quiet "interrupted" chip, no danger
// wash; the rehydrate swap remains the truth.

function ToolCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  // R123-W-m surviving in the separated grammar: the card's body renders
  // OPEN by default (the owner must SEE the work); a user's head tap wins
  // for the card's lifetime.
  const [open, setOpen] = useState(true);
  // R128-W6 — an INTERRUPTED settle (the turn ended before the result frame)
  // is neutral, not a failure: no danger wash, the quiet "interrupted" chip.
  const failed = item.ok === false && item.interrupted !== true;
  const running = item.ok === null;
  const isWrite = WRITE_TOOLS.has(item.toolName);
  const isTerminal = TERMINAL_TOOLS.has(item.toolName);
  const isRead = READ_TOOLS.has(item.toolName);
  // R123-W-m — the WEB families join the card grammar: the web pair
  // (web_search/web_fetch) and the embedded browser (browser_control) are
  // tools the agent ACTUALLY runs, and the generic Wrench + raw key:value
  // dump was the shapeless rendering behind the owner's "no tool calls
  // were shown to me". The families wear the PC's own Globe icon in the
  // read family's accent2 voice (the exploration register the reference
  // screenshots' "Explore" rows speak), and their targets come from the
  // pure extractors (features/turn-block.ts's R123 note).
  const isWeb = WEB_TOOLS.has(item.toolName);
  const isBrowser = BROWSER_TOOLS.has(item.toolName);

  // The head's ONE line — the families' existing grammar, moved from the
  // retired cards: the write family keeps its "Writing {file}… · {n} chars"
  // streaming verb and "Wrote {file}" settle; every other family carries the
  // CompactToolRow's own one-line law, "verb · target". R120-CM: the string
  // lives in the PURE `toolRowTitle` (features/turn-block.ts) — the card's
  // grammar is jest-pinned there, the component stays a renderer.
  const preview = extractWritePreview(item.inputRaw ?? "");
  const streaming = running && isWrite && item.inputRaw !== null;
  const title = toolRowTitle(item);
  const icon = isWrite ? (
    <FileCode2 size={13} color={tokens.accent} strokeWidth={2.2} />
  ) : isTerminal ? (
    <SquareTerminal size={13} color={tokens.accent} strokeWidth={2.2} />
  ) : isRead ? (
    <BookOpenText size={13} color={tokens.accent2} strokeWidth={2.2} />
  ) : isWeb || isBrowser ? (
    <Globe size={13} color={tokens.accent2} strokeWidth={2.2} />
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
        styles.toolCallCard,
        {
          // R129-M — the CARD surface (never surfaceWell) + the failed
          // call's quiet danger wash (donts #37's card-wide tint, translated
          // from the retired row to the card) + the hairline clayRim + the
          // small clay shadow (the chat cards' own weight).
          backgroundColor: failed ? mixHex(tokens.card, tokens.danger, 0.08) : tokens.card,
          borderColor: tokens.clayRim,
          boxShadow: tokens.clayShadowSm,
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
        },
      ]}
      testID="transcript-tool-card"
    >
      <ToolHeadRow
        item={item}
        icon={icon}
        title={title}
        expanded={expandable && open}
        expandable={expandable}
        onToggle={expandable ? () => setOpen((v) => !v) : undefined}
        after={diff !== null ? <WriteDiffChips added={diff.added} removed={diff.removed} /> : undefined}
      />
      {/* The BODY — the retired rows' content logic (the old main lines +
          the old expanded details), OPEN by default behind the house
          disclosure motion; compact renders no body at all (one-line
          cards, no expansion). */}
      {expandable && (
        <DisclosureClip open={open}>
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
            >
              {terminalTail}
            </TypeMono>
          )}
          {!running && !isRead && item.outputSummary !== null && item.outputSummary !== "" && (
            <TypeMono style={{ color: tokens.textTertiary }}>{item.outputSummary}</TypeMono>
          )}
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
        </DisclosureClip>
      )}
    </View>
  );
}

/**
 * R116-m — the head's QUIET status chip (donts #37: the right-side FAIL
 * text badge column is retired): "running" rides a small warning-tinted
 * chip only while the call runs, a compact danger chip when it failed, a
 * quiet neutral chip when the turn ended underneath it (R128-W6's
 * "interrupted" settle) — and NOTHING on success (the result rides the head
 * line itself, never a badge). One quiet chip, never a shouty column.
 */
function ToolStatusChip({ item }: { item: ToolItem }) {
  const { tokens } = useTheme();
  const word = toolStatusWord(item);
  if (word === null) return null;
  if (word === "running") {
    return (
      <View style={[styles.statusChip, { backgroundColor: mixHex(tokens.card, tokens.warning, 0.12) }]}>
        <TypeMono style={{ color: tokens.warning, fontSize: 10, lineHeight: 13 }} numberOfLines={1}>
          running
        </TypeMono>
      </View>
    );
  }
  if (word === "interrupted") {
    return (
      <View style={[styles.statusChip, { backgroundColor: mixHex(tokens.card, tokens.textSecondary, 0.1) }]}>
        <TypeMono style={{ color: tokens.textSecondary, fontSize: 10, lineHeight: 13 }} numberOfLines={1}>
          interrupted
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
  // R128-W6 — the one status-word vocabulary ("interrupted" included — the
  // a11y label hears exactly what the chip shows).
  const statusWord = toolStatusWord(item);
  const statusSuffix = statusWord === null ? " succeeded" : ` ${statusWord}`;
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
      <ToolStatusChip item={item} />
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
      accessibilityLabel={`Tool ${item.toolName}${statusSuffix}${expanded ? ", expanded" : ""}`}
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
   * 88% bubble), aspect-kept, quiet border. R123-W-m: the tile carries its
   * own bottom beat — riding ABOVE the text now, the thumbnail needs the
   * house 8dp rhythm below it (the bubble's xs gap + this beat) so the text
   * never kisses the image. */
  userImageTile: {
    width: "72%",
    alignSelf: "flex-start",
    borderRadius: RADIUS_IMAGE,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    marginBottom: spacing.xs,
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
  /** R129-M — THE TURN: a plain column of SEPARATED elements (chat.md
   *  §Transcript R129 — the R119-A clay container is retired): NO surface,
   *  NO border, NO radius, NO padding — the rail line, the thinking row,
   *  the tool cards, and the flat reply render as siblings at the house 8dp
   *  beat (the cards' own 8px gaps included). */
  turnBlock: {
    gap: spacing.sm,
  },
  /** R129-M — the RAIL: the turn's ONE glance line, a PLAIN tertiary row
   *  above the cards — no container, no control, no chevron (the control
   *  era died with the well; the breathing wrapper rides inside). */
  turnRail: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
  /** R129-M — the THINKING ROW's label row (the retired affordance's own
   *  grammar: the duration word + the chevron, the 44px touch-target law
   *  on the one interactive row). */
  thinkingRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  /** R129-M — the house DISCLOSURE clip's collapsed pose (disclosure.tsx's
   *  own grammar — the animated height/opacity ride on top). */
  disclosureClip: {
    overflow: "hidden",
    height: 0,
  },
  /** The clip's measurement child: absolutely positioned so a collapsed
   *  clip height can never clamp its own layout (disclosure.tsx's own Yoga
   *  fix — the projects-accordion deadlock, avoided by construction). */
  disclosureMeasure: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  /** R127-W8 — the tools-hidden hint row: one quiet line under the rail (the
   *  rail's own 32 touch height; the press target takes the flex, the ✕ rides
   *  the end with hitSlop). */
  toolsHiddenHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 32,
  },
  toolsHiddenHintPress: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: RADIUS_PILL,
  },
  /** R129-M — THE TOOL CARD: one clay card per call — the house CARD
   *  padding (spacing.md = 12px all sides; the density pref's compact rung
   *  halves the VERTICAL at the call site, its pinned contract), r12
   *  (chat.md R129), the card fill + hairline clayRim + the small clay
   *  shadow at the call site. The 8px gaps BETWEEN cards ride the turn
   *  column's own beat (the plan's toolCardGap). */
  toolCallCard: {
    borderRadius: RADIUS_TOOL_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  assistantLive: {
    flexDirection: "row",
    alignItems: "flex-end",
    flexWrap: "wrap",
  },
  /** R123-W-m — the inter-segment beat: every assistant segment after the
   *  first carries this marginTop (the block's own gap rides on top — 8dp +
   *  8dp, double the markdown paragraph's internal rhythm) so consecutive
   *  utterances of one turn read as separate beats, never one wall of
   *  text (the owner's "no separation with the elements" report). */
  assistantSegmentGap: {
    marginTop: spacing.sm,
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
  /** R116-m → R129-M — the thinking row's "Show all" affordance (at the
   * settled cap): the 44px touch-target law on the one interactive row. */
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
