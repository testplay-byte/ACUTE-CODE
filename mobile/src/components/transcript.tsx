/**
 * Transcript v4 (R115-J) — the conversation's message grammar per
 * docs/design-language/android/02-patterns/chat.md §Transcript:
 *
 *   - USER BUBBLE (right, maxWidth 88%): an accent-TINTED clay fill (the
 *     accent mixed ~10% over the card — the PC chat's own bubble math, not a
 *     solid accent slab), r20 with the tighter 16px bottom-right corner (the
 *     WhatsApp tail hint), and the CLOCK INSIDE the bubble's bottom-right
 *     corner (10px tertiary, gated by the timestampsMode pref — never
 *     floating below). Image attachments render as proper rounded thumbnails
 *     (r12, ~64% of the column, aspect-kept) — never tiny chips; other
 *     attachments stay chips under the text.
 *   - ASSISTANT = a document (full width, no bubble): the meta line (model ·
 *     time, mono 10.5 tertiary) sits ABOVE the first content chunk and ONLY
 *     when the turn has content; the collapsible dim thinking card rides
 *     above it; the live caret keeps pulsing after the streaming markdown.
 *   - TOOL CARDS: compact, ONE line per state — the write card's head carries
 *     "Writing {file}… · {n} chars" with the live tail preview below, the
 *     terminal card keeps command + tail + summary, the read-skill family is
 *     ONE slim quiet chip ("Read skill · {name}" + a status check, never a
 *     full view; args only behind manual expand), the generic card stays the
 *     humanized fallback. toolActivity detailed/compact/hidden all still
 *     apply (compact = one collapsed line; hidden folds into meta lines).
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
 *     cards keep their logic, restyled to one visual idea per region.
 *
 * One renderer for BOTH sources — the persisted fold and the live stream
 * produce the same TranscriptItem union (features/sessions.ts — the data
 * model is untouched this wave).
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BookOpenText, Check, ChevronDown, ChevronUp, CircleX, FileCode2, ImageIcon, SquareTerminal, Wrench } from "lucide-react-native";
import { useTheme, useChatPrefs } from "@/design/theme";
import { Badge, FadeInUp, Skeleton, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
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
  mixHex,
  spacing,
  TYPE_BODY,
  TYPE_CAPTION,
} from "@/design/tokens";
import { subagentStatusLabel } from "@/features/sessions";
import type { AttachmentView, TranscriptItem } from "@/features/sessions";

// ── local drawing constants (chat.md's own geometry — the file's class) ─────

/** chat.md — the image radius: r12 on thumbnails + screenshot tiles. */
const RADIUS_IMAGE = 12;
/** chat.md — the WhatsApp tail hint: the user bubble's bottom-right corner. */
const RADIUS_BUBBLE_TAIL = 16;
/** One leg of the placeholder's calm ~1.2s breathe + the dots' pulse. */
const BREATHE_LEG_MS = 600;

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
  // chat.md — the accent-TINTED clay fill (never a solid accent slab): the
  // accent mixed ~10% over the card, with a slightly deeper tint edge. This
  // is the PC chat's own bubble math, ported through mixHex.
  const tintedFill = mixHex(tokens.card, tokens.accent, 0.1);
  const tintedEdge = mixHex(tokens.card, tokens.accent, 0.22);
  const chipFill = mixHex(tokens.card, tokens.accent, 0.18);
  const chipEdge = mixHex(tokens.card, tokens.accent, 0.32);
  const images = attachments?.filter(isImageAttachment) ?? [];
  const files = attachments?.filter((a) => !isImageAttachment(a)) ?? [];
  return (
    <View style={styles.userRow}>
      <View
        accessibilityLabel={queued ? "Queued message" : "Your message"}
        testID="transcript-user-bubble"
        style={[
          styles.userBubble,
          {
            backgroundColor: queued ? tokens.card : tintedFill,
            borderTopColor: queued ? tokens.clayTopEdge : tintedEdge,
            borderColor: queued ? tokens.border : tintedEdge,
            boxShadow: tokens.clayShadowSm,
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
            color: tokens.text,
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
            (10px tertiary), never floating below it. */}
        {clock !== null && (
          <View style={styles.userClockRow} testID="transcript-user-clock">
            <TypeCaption style={{ color: tokens.textTertiary, fontSize: 10 }}>{clock}</TypeCaption>
          </View>
        )}
      </View>
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

// ── assistant (the document: meta line ABOVE, markdown, live caret) ─────────

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
  // chat.md — the meta line rides ABOVE the FIRST CONTENT chunk and only
  // when the turn has content (a thinking-only turn keeps its quiet card;
  // the placeholder owned the model naming before the first delta).
  const hasContent = (liveText !== null && liveText !== "") || settled !== null;

  return (
    <View style={styles.block} accessibilityLabel="Assistant message" testID="transcript-assistant">
      {item.thinking !== null && item.thinking !== "" && (
        <ThinkingBlock text={item.thinking} live={item.live} />
      )}
      {hasContent && (item.model !== null || clock !== null) && (
        <TypeMono
          numberOfLines={1}
          style={{ color: tokens.textTertiary, fontSize: 10.5 }}
          testID="transcript-assistant-meta"
        >
          {[item.model, clock].filter((part) => part !== null).join(" · ")}
        </TypeMono>
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
    </View>
  );
}

/** The live cursor — a calm 1.1s pulse marking the stream still flowing
 * (motion.md §3; reduced motion snaps it solid — §5). */
function Caret({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.25, { duration: 550 }), withTiming(1, { duration: 550 })),
      -1,
      false,
    );
  }, [opacity, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel="the agent is still writing"
      style={[animated, { width: 8, height: 15, borderRadius: 2, backgroundColor: color, marginLeft: 2 }]}
    />
  );
}

// ── the THINKING PLACEHOLDER (the processing story, R115-J) ─────────────────
//
// Sits exactly where the assistant message will appear while a live turn
// streams with NO content yet: the three staggered StatusDot-grammar dots,
// the word "Thinking", and the turn's resolved model in micro mono. The card
// itself now BREATHES (opacity 0.85↔1, ~1.2s — calm, never attention-thrash)
// and enters with the house fade-in-up the moment the turn starts; the first
// real delta replaces it (the screen stops emitting the synthetic item —
// that logic is untouched). With the header's breathing accent line (R115-I)
// this card IS the processing story: no spinner anywhere.

function ThinkingPlaceholder({ model }: { model: string | null }) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const breathe = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
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
  }, [reduced, breathe]);
  const breathing = useAnimatedStyle(() => ({ opacity: breathe.value }));
  return (
    <FadeInUp testID="transcript-thinking-placeholder">
      <Animated.View style={breathing}>
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
              // assistant cards' own meta line speaks — scaled never, tertiary
              // always).
              <TypeMono style={{ color: tokens.textTertiary, fontSize: 11 }}>
                {`· ${model}`}
              </TypeMono>
            )}
          </View>
        </View>
      </Animated.View>
    </FadeInUp>
  );
}

/** One pulsing dot of the placeholder — the StatusDot's calm 1.2s opacity
 * pulse (the house motion vocabulary), staggered per dot; reduced motion
 * snaps to a steady mid read (§5). */
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

// ── tool (the per-tool dispatcher — ONE line per state, R115-J) ─────────────
//
// chat.md's tool table, one presentation per family, the generic card as the
// fallback for everything unknown:
//   · write_file / edit_file → the WRITE card: the head line carries
//     "Writing {file}… · {n} chars" while the args stream (the live tail
//     preview below it — the tool-input-delta raw the reducer accumulates),
//     "Wrote {file}" + the result summary once the call settles.
//   · run_command / bash → the TERMINAL card: mono command line, the
//     streamed tool-output tail as a quiet terminal block, status on result.
//   · read_skill + the compact-read family → ONE slim quiet chip:
//     "Read skill · {name}" + the status check — never the full view; the
//     args dump renders ONLY on manual expand.
// The collapsed discipline: every card renders ONE compact line when
// collapsed; expand shows the details. chatDensity shrinks the vertical
// padding; toolActivity=compact pins every card to a single collapsed line;
// hidden folds the runs away entirely before the list renders (chat-prefs.ts).

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

/** The read family's one-line target: the argsSummary's first "key: value"
 * segment, key stripped ("path: src/a.ts" → "src/a.ts"). */
function readTargetSegment(item: ToolItem): string {
  const segment = item.argsSummary.split(",")[0] ?? "";
  return segment.replace(/^[a-zA-Z_]+:\s*/, "").trim();
}

/** The shared card shell: the clay tile + the density-aware vertical padding. */
function ToolShell({ item, children }: { item: ToolItem; children: React.ReactNode }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  const failed = item.ok === false;
  return (
    <View
      testID="transcript-tool-card"
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

/** toolActivity=compact — the ALWAYS-collapsed SINGLE line: icon + humanized
 * verb + target + status in one row (no expansion, ever). */
function CompactToolRow({ item }: { item: ToolItem }) {
  const { tokens } = useTheme();
  const summary = WRITE_TOOLS.has(item.toolName)
    ? writePath(item)
    : genericOneLineSummary(item);
  const label =
    summary !== null && summary !== ""
      ? `${humanizeToolName(item.toolName)} · ${summary}`
      : humanizeToolName(item.toolName);
  return (
    <ToolShell item={item}>
      <ToolHeadRow
        item={item}
        icon={<Wrench size={13} color={tokens.textSecondary} strokeWidth={2.2} />}
        title={label}
        expanded={false}
        expandable={false}
      />
    </ToolShell>
  );
}

/** read_skill + the compact-read family — the ONE slim quiet chip (chat.md:
 * "Read skill · {name} · ✓ — one quiet chip, never a full view"; the owner's
 * R114 report: "'read skill' showed the full view with an ok status —
 * ugly"). The args dump renders ONLY on manual expand. */
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
  const target = readTargetSegment(item);
  const title =
    item.toolName === "read_skill"
      ? skillName !== ""
        ? `Read skill · ${skillName}`
        : "Read skill"
      : target !== ""
        ? `${humanizeToolName(item.toolName)} · ${target}`
        : humanizeToolName(item.toolName);
  const chip = (
    <View
      style={[styles.skillChip, { borderColor: tokens.borderSubtle, backgroundColor: tokens.subtle }]}
    >
      <BookOpenText size={13} color={tokens.accent2} strokeWidth={2.2} />
      <TypeMono style={{ color: tokens.textSecondary, flex: 1 }} numberOfLines={1}>
        {title}
      </TypeMono>
      {item.ok === true ? (
        <Check size={13} color={tokens.success} strokeWidth={2.6} />
      ) : item.ok === false ? (
        <CircleX size={13} color={tokens.danger} strokeWidth={2.2} />
      ) : null}
      {expandable ? (
        expanded ? (
          <ChevronUp size={14} color={tokens.textTertiary} strokeWidth={2} />
        ) : (
          <ChevronDown size={14} color={tokens.textTertiary} strokeWidth={2} />
        )
      ) : null}
    </View>
  );
  if (!expandable) {
    return <View accessibilityLabel={`Tool ${item.toolName}`}>{chip}</View>;
  }
  return (
    <View style={styles.skillWrap}>
      <Pressable
        accessibilityLabel={`Tool ${item.toolName}${item.ok === null ? " running" : item.ok === false ? " failed" : " succeeded"}${expanded ? ", expanded" : ""}`}
        accessibilityRole="button"
        onPress={() => setExpanded((v) => !v)}
        style={styles.skillPress}
      >
        {chip}
      </Pressable>
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
    </View>
  );
}

/** write_file / edit_file — the WRITE card. The head line IS the state:
 * "Writing {file}… · {n} chars" while the args stream, "Wrote {file}" once
 * settled; the live content tail (the LAST 160 chars of what has arrived)
 * previews below the head while streaming. The preview's source is the
 * tool-input-delta raw the reducer accumulates (R114-d). */
function WriteCard({ item, expandable }: { item: ToolItem; expandable: boolean }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const showDetails = expandable && expanded;
  const running = item.ok === null;
  const streaming = running && item.inputRaw !== null;
  const preview = extractWritePreview(item.inputRaw ?? "");
  const path = writePath(item);
  const verbRunning = item.toolName === "write_file" ? "Writing" : "Editing";
  const verbDone = item.toolName === "write_file" ? "Wrote" : "Edited";
  const title = running
    ? path !== null
      ? streaming
        ? `${verbRunning} ${path}… · ${preview.chars.toLocaleString()} chars`
        : `${verbRunning} ${path}…`
      : `${verbRunning}…`
    : path !== null
      ? `${verbDone} ${path}`
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
      {streaming && tail !== null && (
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

/** The generic fallback — the humanized verb + target + status in the head,
 * ONE compact line when collapsed, expand for the details. */
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

function SubAgentCard({ item }: { item: TranscriptItem & { kind: "subagent" } }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
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
          paddingVertical: densityVerticalPadding(prefs.chatDensity),
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

function ErrorCard({ code, message }: { code: string; message: string }) {
  const { tokens } = useTheme();
  const prefs = useChatPrefs();
  return (
    <View
      accessibilityLabel={`Error: ${message}`}
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
  /** The clock's quiet right-aligned line INSIDE the bubble. */
  userClockRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
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
  /** The thinking placeholder's staggered dot row. */
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
  /** The read-skill family's slim quiet chip (never a full card view). */
  skillWrap: {
    gap: spacing.xs,
  },
  skillChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: RADIUS_PILL,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  /** The chip's expand target — the 44px law on the ONE interactive row. */
  skillPress: {
    minHeight: 44,
    justifyContent: "center",
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
