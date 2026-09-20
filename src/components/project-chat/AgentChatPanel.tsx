import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  AlertTriangle,
  Braces,
  Brain,
  Check,
  ChevronDown,
  Clock,
  Copy,
  File,
  FolderOpen,
  GitBranch,
  History,
  Info,
  ListChecks,
  MessageSquareText,
  RefreshCw,
  Search,
  Square,
  ThumbsDown,
  ThumbsUp,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgents } from "../../hooks/use-agents";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { pushLocalToast } from "../../hooks/use-notifications";
import {
  useCreateSession,
  useRevertSession,
  useSendMessage,
  useSession,
  useSessions,
} from "../../hooks/use-sessions";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialog } from "../agents/ConfirmDialog";
import { ChatMarkdown } from "./ChatMarkdown";
// ROUND-66 (R66, C1): the dedicated debug-report section (the context-free
// post-turn analyst — live while it streams, folded from debug.report events).
import { DebugReportCard } from "./DebugReportCard";
// ROUND-66 (R66, A4): the human-verification checkpoint card (bot walls —
// the wait_for_verification countdown the owner solves).
import { BrowserCheckpointCard } from "./BrowserCheckpointCard";
import {
  BareWorkingEntries,
  WorkingSection,
  type ApprovalDecisionChoice,
  type ApprovalRemember,
} from "./WorkingSection";
// R88 (owner: the floating to-do widget — top-right of the chat window).
import { TodoFloat } from "./TodoFloat";
import { AcuteLogo } from "../shell/Sidebar";
import { ClampedText } from "../shared/ClampedText";
import { SkeletonBlock } from "../shared/Skeletons";
import {
  type AttachmentRef,
  type AssistantTurnItem,
  ApiError,
  DIFF_TOOLS,
  type ErrorTurnItem,
  MAX_RATING_NOTE_CHARS,
  type MessageRating,
  type PermissionMode,
  type Project,
  type ProjectChatItem,
  type RatingValue,
  type Session,
  type SessionDetail,
  type ThinkingLevel,
  type WorkingEntry,
  decideApproval,
  deleteRating,
  dequeueSessionMessage,
  fetchDebugSettings,
  // ROUND-92 (R92-B): the picker's self-heal PATCH (an unconfigured agent
  // arms itself from the first chat pick — see onModelChange).
  getAgentsBackend,
  listSessionRatings,
  patchSessionPermissions,
  // ROUND-114 (R114-e): the session's server-side selected model (the
  // pick-becomes-server-truth PATCH — see onModelChange).
  patchSessionSelectedModel,
  queueSessionMessage,
  rateReply,
  resolveAgentQuestion,
  toProjectChatItems,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStore } from "../../lib/theme-store";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
// ROUND-67 (R67-B, the owner's second copy option): the full-turn
// clipboard builder (thinking + tool calls + outputs + final answer).
import { buildFullTurnText } from "../../lib/turn-copy";
import { useActiveStreams } from "../../lib/active-streams";
import {
  useStreamStore,
  type LiveTurnRetry,
  type QueuedMessage,
} from "../../lib/stream-store";
import { fmtBytes, fmtTokens, formatTime } from "../../lib/format";
// ROUND-67 (R67/E3): the chat-session → browser-tab binding (the leak fix).
import { stateKey, useRightSidebarStore } from "../../lib/right-sidebar-store";
import { bindChatBrowserSession, useBrowserTabStore } from "../../lib/browser-store";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { Composer } from "./composer/Composer";
import {
  loadThinkingLevel,
  resolveSessionModelDisplay,
  saveLastUsedModel,
  saveModelOverride,
  saveThinkingLevel,
  shouldArmAgentFromPick,
  toMessageAttachment,
  type ComposerAttachment,
  type ModelOverride,
} from "./composer/composer-utils";

/**
 * ROUND-37 (owner "two states" directive): the chat renders ONE assistant
 * TURN per user message — a collapsible Working section (thoughts, interim
 * narration, one-line tool rows) followed by the FINAL ANSWER below it.
 * No avatar tiles, no name headers, no Sparkles iconography (owner: "I
 * really hate the SVG icons… AI-generated"). The live streaming view builds
 * the same shape: the Working section grows while the presumptive-final text
 * streams beneath it, and collapses to the folded summary when the turn ends.
 * R99-B (the chat-window visual overhaul): turns now open with the compact
 * TURN HEADER (AssistantTurnHeader — a 6px accent dot + the model identity
 * chip + the hover timestamp). It is METADATA, not a persona name header:
 * the R37 ban stands (no avatars, no "ACUTE" labels, no Sparkles) — the
 * header anchors WHO answered (which model) and WHEN, per the research
 * anatomy (model badge on the assistant row, VS Code/Claude convention).
 */

/** R101-D: JUST the graduated horizontal padding leg of CONTENT_COL_CLASS
 * (above), extracted so the TIMELINE SPINE (TimelineSpine below) can carry
 * the exact same inset — the spine is an absolutely-positioned overlay of
 * the items wrapper, and its normal-flow hairline child lands exactly at
 * the reading column's rail center at every tier BY CONSTRUCTION (edit one,
 * both move). Declared FIRST: CONTENT_COL_CLASS composes it at module load.
 * Never use this alone for content — CONTENT_COL_CLASS is the column. */
const CONTENT_H_PAD_CLASS =
  "px-6 md:px-12 xl:px-16 @max-[560px]:px-4 @max-[420px]:px-2.5";

/** ROUND-43 layout contract: the readable width of the chat's content column
 * (messages AND composer share it, centered). The PANEL itself always fills
 * its column edge-to-edge (owner R40 + R43: no dead right side at any window
 * size); beyond this width the reading column just centers — same rule at
 * 1200px and 2560px, so wide windows never stretch lines nor hug content.
 * R87-A1 (owner: at the max chat width there should be comfortable padding
 * on the left and right sides): the column now carries GRADUATED horizontal
 * padding that grows with the panel width (24 → 48 → 64px) INSTEAD of the
 * old density-driven px-5/md:px-10 on the message wrapper — one constant,
 * so the message list, the empty-state composer and the docked composer all
 * stay pixel-aligned at every width (the old dock also offset the composer
 * 10px inward of the messages; that inconsistency is gone). Density now
 * drives the VERTICAL rhythm only.
 * R89-D2 (owner: "the right and left sidebar padding should be reduced when
 * it is squished"): the padding also SHRINKS when the chat column is
 * squished — an @max-[560px] tier steps it down to 16px and @max-[420px] to
 * 10px, so a half-width chat keeps its reading room instead of padding
 * eating it (the min-width floor is 240px; at that width the panel is
 * pill-first, not prose-first).
 * R101-D: the horizontal padding leg is extracted (CONTENT_H_PAD_CLASS just
 * above) so the timeline spine can mirror the EXACT same inset — the column
 * and the spine move together by construction. */
const CONTENT_COL_CLASS = `mx-auto w-full max-w-[1080px] ${CONTENT_H_PAD_CLASS}`;

/** R87-A1: the column WITHOUT the graduated horizontal padding — for NESTED
 * slots that already sit inside the padded column (the empty-state
 * composer), so the inset is applied exactly once while the cap/centering
 * (and the “shares the reading column” layout contract) still hold. */
const CONTENT_COL_PADLESS_CLASS = "mx-auto w-full max-w-[1080px]";

/** R101-D (owner: "I was hoping to see a timeline on the very left side of
 * the chat window area to see the timeline of the things"): the TIMELINE
 * RAIL — every transcript item renders as a two-column grid, a fixed 28px
 * RAIL cell (TimelineNode's dot) + the existing content cell, gap-x-3. The
 * rail narrows to 20px under the 560px container floor alongside the column
 * padding (the spine's offset tracks it — see TimelineSpine). The content
 * itself is NOT otherwise modified — this is additive structure. */
const TIMELINE_ITEM_CLASS =
  "grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 @max-[560px]:grid-cols-[20px_minmax(0,1fr)]";

/** R101-D: the left inset for live-transcript blocks that belong to the
 * timeline COLUMN but carry no node (the stopped-turn status card, the
 * kept-queue notice): 28px rail + 12px gap = ml-10, and 20 + 12 = ml-8 under
 * the 560px floor — the same content edge the railed items align to, so the
 * spine passes cleanly beside them with no layout seam. */
const TIMELINE_INDENT_CLASS = "ml-10 @max-[560px]:ml-8";

const msgVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

/** Round-30 empty-state suggestion chips (fill the composer on click). */
const SUGGESTIONS: Array<{ label: string; prompt: string; icon: LucideIcon }> = [
  {
    label: "Explore this project",
    prompt: "Explore this project: list the top-level structure, then summarize what this codebase does and its tech stack.",
    icon: FolderOpen,
  },
  {
    label: "Find a bug",
    prompt: "Search the code for likely bugs or edge cases and report the top findings with file paths.",
    icon: Search,
  },
  {
    label: "Explain the architecture",
    prompt: "Explain this project's architecture: entry points, main modules, and how data flows between them.",
    icon: GitBranch,
  },
  {
    label: "Write a plan",
    prompt: "Write a short, ordered implementation plan for adding a small feature to this project.",
    icon: ListChecks,
  },
];

/** Hover copy button with a "Copied" flash (round-16 owner request).
 * ROUND-67 (R67-B): label/title/icon are parameterized so the footer can
 * mount a SECOND, visually distinct copy control ("Copy full conversation
 * (debug)" — the Braces glyph) next to the plain message copy. */
function CopyButton({
  text,
  label = "Copy message",
  title = "Copy",
  icon,
}: {
  text: string;
  label?: string;
  title?: string;
  icon?: LucideIcon;
}) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const Icon = icon ?? Copy;
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          resetAfter(() => setCopied(false), 1200);
        });
      }}
      aria-label={label}
      title={title}
      // R100-D: the hover wash is a CSS class (hover:bg-hover — the CSS-var
      // leg); no JS hover painting.
      className="w-6 h-6 rounded-md grid place-items-center transition-colors hover:bg-hover"
      style={{ color: styles.textTertiary }}
    >
      {copied ? <Check size={11} style={{ color: SEMANTIC_COLORS.success }} /> : <Icon size={11} />}
    </button>
  );
}

/** Per-reply stats — R99-B: ONE mono tabular-nums line (time · in · out ·
 * tok/s), middle-dot separated, subtle textTertiary, NO per-stat chip
 * borders (the old chip strip bordered every number; the flattened line is
 * the footer's quiet grammar — the model identity moved to the turn
 * header). tabular-nums holds digit width steady while live values grow. */
function ReplyStats({
  usage,
  ms,
}: {
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
}) {
  const styles = useThemeStyles();
  if (usage === undefined && ms === undefined) return null;
  const seconds = ms !== undefined ? ms / 1000 : undefined;
  const tps =
    usage && seconds && seconds > 0 ? usage.outputTokens / seconds : undefined;
  const parts: string[] = [];
  if (seconds !== undefined) parts.push(`${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`);
  if (usage) {
    parts.push(`↑ ${fmtTokens(usage.inputTokens)}`);
    parts.push(`↓ ${fmtTokens(usage.outputTokens)}`);
  }
  if (tps !== undefined) parts.push(`${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`);
  return (
    <span
      data-reply-stats
      className="ml-auto pl-2 shrink-0 font-mono text-[10px] tabular-nums whitespace-nowrap"
      style={{ color: styles.textTertiary }}
    >
      {parts.join(" · ")}
    </span>
  );
}

/**
 * ROUND-59 (R59-D, owner directive: "add the options to mark the responses
 * as good or bad, and all of these will be tracked and saved"): the
 * assistant turn's FOOTER — the hover actions row (Copy + the good/bad
 * rating cluster) and the reply stats, with the optional "What went wrong?"
 * note editor unfolding BELOW the row after a bad rating (bad ratings get
 * context from the owner; good ratings stay one-click). Extracted from
 * AssistantTurn so ALL the rating state (the ["session-ratings", sessionId]
 * map + the optimistic mutations) lives in ONE place, shared by the folded
 * turn AND the live-completed turn (the same rating key — the turn's last
 * non-empty assistant text seq).
 *
 * Interaction contract (pinned by AgentChatPanel.test.tsx):
 * - click a thumb → optimistic accent fill + POST /sessions/:id/ratings;
 *   a failure REVERTS the fill and shows an honest inline transient message
 *   (no alert()).
 * - click the OTHER thumb → re-rate (the backend upserts on
 *   (session_id, assistant_seq)).
 * - click the SAME thumb again → clear (DELETE /ratings/:id).
 * - turns without a rating key (working-only turns) render no thumbs.
 * - a rated turn's filled thumb renders PERSISTENTLY (not just on hover);
 *   the unrated cluster reveals on hover like CopyButton.
 */
function TurnFooter({
  sessionId,
  assistantSeq,
  copyText,
  usage,
  ms,
  fullCopyText,
}: {
  sessionId: string | null;
  /** R59-D rating key — the turn's LAST non-empty assistant text seq
   * (undefined on working-only turns → no rating cluster). */
  assistantSeq: number | undefined;
  copyText: string;
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  /** ROUND-67 (R67-B, owner directive #2): the FULL-turn export text
   * (thinking + tool calls + outputs + final answer + model — built by
   * lib/turn-copy). Present ONLY when debug mode is enabled in Advanced
   * settings ("This option will only be shown as the other copy option
   * when the debug option in the advanced settings has been turned on")
   * → undefined hides the second copy button entirely. */
  fullCopyText?: string;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  // Demo (fixture) mode has no sidecar → no ratings; the query stays off.
  const liveMode = useConfigStore((s) => !s.demoData);
  // Honest inline transient error (reverts the optimistic fill's verdict).
  const [ratingError, setRatingError] = useState<string | null>(null);
  // The bad-rating note editor: opens ONLY on the fresh bad-rating CLICK
  // transition (a reloaded bad rating renders the filled thumb, no editor).
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");

  const ratingsQuery = useQuery({
    queryKey: ["session-ratings", sessionId],
    queryFn: () => listSessionRatings(sessionId as string),
    enabled: sessionId !== null && liveMode,
  });
  const current = useMemo(
    () =>
      assistantSeq === undefined
        ? undefined
        : (ratingsQuery.data ?? []).find((r) => r.assistantSeq === assistantSeq),
    [ratingsQuery.data, assistantSeq],
  );

  const flashRatingError = (err: unknown): void => {
    setRatingError(err instanceof Error ? err.message : String(err));
    resetAfter(() => setRatingError(null), 4000);
  };

  const writeRows = (rows: MessageRating[]): void => {
    if (sessionId === null) return;
    queryClient.setQueryData<MessageRating[]>(["session-ratings", sessionId], rows);
  };

  /** Refetch after each mutation (the ratings map stays canonical). */
  const refreshRatings = (): void => {
    if (sessionId === null) return;
    void queryClient.invalidateQueries({ queryKey: ["session-ratings", sessionId] });
  };

  const onThumb = (value: RatingValue): void => {
    if (sessionId === null || assistantSeq === undefined) return;
    const snapshot = ratingsQuery.data ?? [];
    // Same thumb again → clear the verdict (optimistic unfill + DELETE).
    // id ≤ 0 marks the in-flight optimistic row — nothing persisted to
    // delete yet, so a click in that window is a no-op (the refetch is
    // already on its way with the real row id).
    if (current !== undefined && current.rating === value && current.id > 0) {
      writeRows(snapshot.filter((r) => r.assistantSeq !== assistantSeq));
      setNoteOpen(false);
      setRatingError(null);
      deleteRating(current.id)
        .then(() => refreshRatings())
        .catch((err) => {
          writeRows(snapshot); // revert
          flashRatingError(err);
        });
      return;
    }
    // New verdict or re-rate → optimistic fill + upsert POST (the backend
    // freezes the full turn context server-side at rate time).
    const optimistic: MessageRating = {
      id: current?.id ?? 0,
      sessionId,
      assistantSeq,
      rating: value,
      note: current?.note ?? null,
      model: current?.model ?? null,
      agentId: current?.agentId ?? null,
      createdAt: current?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeRows([...snapshot.filter((r) => r.assistantSeq !== assistantSeq), optimistic]);
    setRatingError(null);
    // Bad ratings ask for context ("What went wrong?"); good stays 1-click.
    // R60 polish (owner: "maybe we might need to look into the things a bit
    // better"): re-rating a SAVED bad reply opens the editor PRE-FILLED with
    // the existing note — editing context, never losing it. A FRESH bad
    // rating starts empty.
    if (value === "bad") {
      setNoteText(current?.note ?? "");
      setNoteOpen(true);
    } else {
      setNoteOpen(false);
    }
    rateReply(sessionId, { assistantSeq, rating: value })
      .then(() => refreshRatings())
      .catch((err) => {
        writeRows(snapshot); // revert
        flashRatingError(err);
      });
  };

  const onNoteSave = (): void => {
    if (sessionId === null || assistantSeq === undefined) return;
    const text = noteText.trim().slice(0, MAX_RATING_NOTE_CHARS);
    // Re-rate (upsert) carrying the note — the backend overwrites the
    // rating row and refreshes the frozen context with it.
    rateReply(sessionId, { assistantSeq, rating: "bad", ...(text !== "" ? { note: text } : {}) })
      .then(() => {
        setNoteOpen(false);
        // Keep the text for a possible reopen — the chip reopens with it.
        refreshRatings();
      })
      .catch((err) => flashRatingError(err));
  };

  const thumbButton = (value: RatingValue, Icon: typeof ThumbsUp, label: string) => {
    const filled = current?.rating === value;
    return (
      <button
        type="button"
        onClick={() => onThumb(value)}
        aria-label={label}
        aria-pressed={filled}
        title={label}
        data-testid={`rate-${value}`}
        className="w-6 h-6 rounded-md grid place-items-center transition-colors hover:bg-hover"
        style={{ color: filled ? styles.accent : styles.textTertiary }}
      >
        <Icon size={11} style={filled ? { fill: "currentColor" } : undefined} />
      </button>
    );
  };

  return (
    <div className="min-w-0" data-rating-footer>
      {/* R99-B: ONE clean hover row — copy (+ the debug full-turn copy), the
          thumbs cluster, then the stats line right-aligned (ReplyStats is a
          single mono tabular-nums text now, never per-stat chips). The
          timestamp + model identity moved UP to the turn header. */}
      <div className="flex items-center gap-1 min-w-0">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-0.5 flex items-center">
          <CopyButton text={copyText} />
          {/* ROUND-67 (R67-B): the second copy option — the whole turn
              (thinking, tool calls, outputs, final answer) — shown only in
              debug mode (fullCopyText is threaded only when the
              ["debug-settings"] query reports enabled). Distinct glyph
              (Braces) + title/aria-label so screen readers and tooltips
              tell the two apart. */}
          {fullCopyText !== undefined ? (
            <CopyButton
              text={fullCopyText}
              label="Copy full conversation (debug)"
              title="Copy full conversation (debug)"
              icon={Braces}
            />
          ) : null}
        </div>
        {assistantSeq !== undefined ? (
          <div
            data-rating-cluster
            // Unrated → hover-revealed like CopyButton; rated → the filled
            // thumb stays visible (persistent verdict, not just on hover).
            className={`flex items-center gap-0.5 pt-0.5 transition-opacity ${
              current === undefined ? "opacity-0 group-hover:opacity-100" : ""
            }`}
          >
            {thumbButton("good", ThumbsUp, "Rate this reply good")}
            {thumbButton("bad", ThumbsDown, "Rate this reply bad")}
            {/* R60 polish: a SAVED note is visible (a tiny "noted" chip on
                the cluster) and one click reopens the editor pre-filled —
                the owner's feedback loop stays discoverable instead of
                hiding in the DB. */}
            {current?.note != null && current.note !== "" && !noteOpen ? (
              <button
                type="button"
                onClick={() => {
                  setNoteText(current.note ?? "");
                  setNoteOpen(true);
                }}
                aria-label="Edit the saved rating note"
                title={`Saved note: ${current.note}`}
                data-testid="rating-note-chip"
                className="ml-0.5 flex h-5 max-w-[180px] items-center gap-1 rounded-full px-1.5 text-[10px] font-medium"
                style={{ background: styles.subtle, color: styles.textTertiary }}
              >
                <MessageSquareText size={10} aria-hidden />
                <span className="truncate">noted</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <ReplyStats usage={usage} ms={ms} />
      </div>
      {noteOpen ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-rating-note>
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value.slice(0, MAX_RATING_NOTE_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onNoteSave();
              } else if (e.key === "Escape") {
                setNoteOpen(false);
              }
            }}
            // aria-label carries the placeholder's question — screen readers
            // get the intent without the visual text.
            aria-label="What went wrong?"
            placeholder="What went wrong?"
            data-testid="rating-note-input"
            maxLength={MAX_RATING_NOTE_CHARS}
            className="flex-1 min-w-[160px] h-7 rounded-lg px-2.5 text-[12px] border outline-none"
            style={{
              borderColor: styles.border,
              background: styles.bg,
              color: styles.text,
            }}
          />
          <button
            type="button"
            onClick={onNoteSave}
            aria-label="Save rating note"
            data-testid="rating-note-save"
            className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen(false)}
            aria-label="Cancel rating note"
            className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {ratingError !== null ? (
        <div
          role="alert"
          data-rating-error
          className="mt-1 text-[11px] leading-[1.4] break-words"
          style={{ color: SEMANTIC_COLORS.danger }}
        >
          {ratingError}
        </div>
      ) : null}
    </div>
  );
}

const itemKey = (item: ProjectChatItem): string => {
  switch (item.kind) {
    case "user":
      return `u-${item.seq}`;
    // R78: the folded queued chip — the same seq namespace as user items
    // (the event row flips to message.user at delivery, so a delivered
    // queued item's key changes `q-` → `u-` and the chip swaps for the
    // bubble on the refetch — no key collision with the pre-delivery item).
    case "queued":
      return `q-${item.seq}`;
    case "turn":
      return `turn-${item.seq}`;
    case "error":
      return `err-${item.seq}`;
  }
};

/** R97-H (owner: the chat window's "overall functionality, usability,
 * customizability"): the per-message TIMESTAMP — a hover-revealed time chip
 * (Settings → Appearance → Timestamps). The default ("hidden") keeps the
 * pre-R97 clean look byte-identical; "hover" fades the chip in beside the
 * message, reusing the exact 10px-mono tertiary chip the error / stopped /
 * queued cards already speak. Today renders the clock alone; an older day
 * prefixes its short date so a reloaded session still reads unambiguously
 * ("Aug 26 · 10:00"). Reads the timestampsMode straight from the store so
 * call sites stay prop-light. */
function TimestampChip({ ts, className = "" }: { ts: string | undefined; className?: string }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.timestampsMode);
  if (mode !== "hover" || ts === undefined || ts === "") return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date().toDateString() === date.toDateString();
  return (
    <span
      data-chat-timestamp
      title="When this message was sent"
      className={`font-mono text-[10px] tabular-nums shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${className}`}
      style={{ color: styles.textTertiary }}
    >
      {today
        ? formatTime(ts)
        : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} · ${formatTime(ts)}`}
    </span>
  );
}

/** R99-B (owner: the chat window "is not redesigned properly" — the
 * research-driven turn anatomy): the compact TURN HEADER — ONE ~20px
 * identity row at the top of every assistant turn (folded AND live).
 * Anatomy: a 6px accent dot (the neutral minimal mark — avatars, persona
 * name headers and Sparkles stay banned per the owner's R37 verdict) + the
 * turn's MODEL as an identity chip (mono, subtle bg, truncate — the
 * COMPONENTS §2 identity-chip grammar) + the hover timestamp right-aligned
 * (TimestampChip, so the R97-H timestampsMode preference keeps its exact
 * semantics: hidden = nothing, hover = fade in on turn hover).
 *
 * Honesty: a turn with no model AND no hover-renderable timestamp renders
 * NO header at all (nothing to say). Intermediate streaming segments never
 * get headers — this renders once per turn (and once per live block).
 * A11y: the dot + model chip are decorative (aria-hidden) — the timestamp
 * stays perceivable exactly as today. */
function AssistantTurnHeader({ model, ts }: { model?: string; ts?: string }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.timestampsMode);
  const tsValid =
    ts !== undefined && ts !== "" && !Number.isNaN(Date.parse(ts));
  if ((model === undefined || model === "") && !(mode === "hover" && tsValid)) {
    return null;
  }
  return (
    <div
      data-testid="turn-header"
      className="flex items-center gap-1.5 h-5 min-w-0 max-w-full"
    >
      <span
        aria-hidden="true"
        className="flex items-center gap-1.5 min-w-0"
        title={model}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: styles.accent }} />
        {model !== undefined && model !== "" ? (
          <span
            className="shrink-0 min-w-0 truncate max-w-[240px] font-mono text-[10px] px-1.5 py-0.5 rounded-md"
            style={{ background: styles.subtle, color: styles.textTertiary }}
          >
            {model}
          </span>
        ) : null}
      </span>
      <span className="flex-1" aria-hidden="true" />
      <TimestampChip ts={ts} className="shrink-0" />
    </div>
  );
}

/** R97-I: the chat-shaped LOADING state — alternating user (right, accent
 * tint) + assistant (left, subtle) bubble rows stacked toward the composer,
 * mirroring the real transcript's rhythm so the swap to real content reads
 * as continuation, not a flash. Decorative (the container announces
 * "Loading conversation" once). */
function TranscriptSkeleton() {
  const styles = useThemeStyles();
  const bubbleTint = withAlpha(styles.accent, styles.isDark ? 0.16 : 0.11);
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex justify-end">
        <SkeletonBlock className="h-10 w-[38%] max-w-[300px] rounded-xl" style={{ background: bubbleTint }} />
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonBlock className="h-3.5 w-[52%] max-w-[420px] rounded-full" />
        <SkeletonBlock className="h-3.5 w-[44%] max-w-[380px] rounded-full" />
      </div>
      <div className="flex justify-end">
        <SkeletonBlock className="h-10 w-[30%] max-w-[240px] rounded-xl" style={{ background: bubbleTint }} />
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonBlock className="h-3.5 w-[58%] max-w-[460px] rounded-full" />
        <SkeletonBlock className="h-3.5 w-[36%] max-w-[300px] rounded-full" />
      </div>
    </div>
  );
}

/** R97-I: the chat's honest ERROR state — the pre-R97 panel degraded every
 * fetch failure into the cheerful "new chat" greeting. This card (the
 * DESIGN-SYSTEM §6 shape: role=alert, the danger token, the exact cause,
 * one action) replaces it on the empty transcript; a populated transcript
 * with a background-refetch failure still renders normally. */
function ChatLoadErrorCard({ onRetry }: { onRetry: () => void }) {
  const styles = useThemeStyles();
  return (
    <div
      role="alert"
      data-chat-load-error
      className="max-w-md rounded-xl border px-4 py-3.5 text-center"
      style={{
        borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
        background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.08 : 0.05),
      }}
    >
      <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
        Could not load this conversation
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The session history failed to load — the agent sidecar may be down or the connection dropped. Your messages are safe on disk.
      </p>
      <button
        type="button"
        onClick={onRetry}
        aria-label="Retry loading the conversation"
        className="mt-3 h-8 px-3.5 rounded-lg text-[12px] font-semibold border transition-opacity hover:opacity-85"
        style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
      >
        Retry
      </button>
    </div>
  );
}

/**
 * ROUND-44 (R44-c, owner directive: "complete the whole agentic coding
 * environment"): a user bubble's hover actions — Copy (round-16) plus Revert,
 * which rewinds the session's event log to THIS message (the reply and every
 * later turn are deleted server-side). The seq binding happens in the panel
 * (MessageRenderer threads this callback only for persisted items); the
 * optimistic pending echo (seq -1, no session yet) never shows it.
 */
function UserMessage({
  content,
  attachments,
  ts,
  onRevert,
  revertDisabled,
}: {
  content: string;
  /** ROUND-50 (R50-c2): display-only attachment chips (name/path/size) on
   * the user bubble — persisted items carry them from the event log; the
   * optimistic echo carries the staged chips until the refetch lands. */
  attachments?: AttachmentRef[];
  /** R97-H: the event's timestamp — feeds the hover time chip (rendered
   * only when Settings → Appearance → Timestamps is "On hover"). */
  ts?: string;
  onRevert?: () => void;
  revertDisabled?: boolean;
}) {
  const styles = useThemeStyles();
  // ROUND-38 (owner: "the messages which I sent… look bad and ugly. Their
  // interface and the colors kind of do not look good"): the old solid-orange
  // bubble + white text was loud and harsh. Redesigned as a calm, refined
  // accent-tinted bubble with primary text + a soft border + a small tail,
  // medium weight for presence without shouting.
  // ROUND-42 (owner: long prompts "should be minimized to about 10 lines or
  // so… the user has to manually click the expand button to see the full
  // one"): the bubble clamps at 10 lines with a Show more/less toggle —
  // short messages render exactly as before.
  // R100-D (research §C4.3 — THE structural move, the input-row idiom): the
  // messenger tail is DELETED (uniform 12px radius), the row caps at
  // min(65%, 640px), the fill snaps to the accent-soft strengths (9–11%
  // alpha) with a 1px accent@0.18 border, the text is 13px/400 (the
  // font-medium is gone — body weight per the weight law), padding
  // 10px 14px, leading 1.55. The attachment chips go mono 10px rounded-lg.
  const bubbleBg = withAlpha(styles.accent, styles.isDark ? 0.11 : 0.09);
  const bubbleBorder = withAlpha(styles.accent, 0.18);
  return (
    <motion.div
      // R101-D: min-w-0 — the row is a GRID ITEM now (the timeline rail's
      // content cell); flex/grid items clamp at min-width:auto, and the row's
      // own max-w cap + inner min-w-0 already handled the old block parent.
      className="flex justify-end group min-w-0"
      variants={msgVariants}
      initial="initial"
      animate="animate"
    >
      {/* R89-D2: min-w-0 on the row + the bubble (flex children must be
          clampable or long tokens mint width at the 240px chat floor —
          "the content starts to show outside it"), and the bubble gets MORE
          relative room when the panel is squished (92% below 420px:
          the hover actions + the padding tiers already reclaimed the rest).
          R99-B (the research anatomy — user = INPUT, a bubble never a
          document): the row caps at min(75%, 640px) of the reading column —
          wide windows used to stretch the bubble to 82% (~885px), reading
          like a full-width document instead of a message.
          R100-D (§C4.3): the cap tightens to min(65%, 640px) — the input-row
          idiom; 75% let a short prompt read as a document. */}
      <div className="flex items-end gap-1 max-w-[min(65%,640px)] @max-[420px]:max-w-[92%] min-w-0">
        {/* R97-H: the hover time chip joins the actions cluster (the same
            reveal animation — the cluster is already invisible until hover).
            R99-B: ONE unified hover row — timestamp · copy · revert, gap-1,
            tabular-nums on the time (see TimestampChip). */}
        <div className="flex items-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity pb-0.5 shrink-0">
          <TimestampChip ts={ts} className="pb-1 pr-0.5" />
          <CopyButton text={content} />
          {onRevert !== undefined ? (
            <button
              type="button"
              onClick={onRevert}
              disabled={revertDisabled}
              aria-label="Revert to this message"
              title="Revert to this message"
              className="w-6 h-6 rounded-md grid place-items-center transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: styles.textTertiary }}
            >
              <History size={11} />
            </button>
          ) : null}
        </div>
        <div
          className="rounded-xl px-3.5 py-2.5 text-[13px] leading-[1.55] border min-w-0"
          style={{
            background: bubbleBg,
            borderColor: bubbleBorder,
            color: styles.text,
          }}
        >
          {attachments !== undefined && attachments.length > 0 ? (
            <div
              role="group"
              aria-label="Attachments"
              className="flex flex-wrap gap-1 pb-1.5 mb-1.5 border-b"
              style={{ borderColor: bubbleBorder }}
            >
              {attachments.map((a, i) => (
                <span
                  key={`${a.path ?? a.name}-${i}`}
                  title={a.path ?? a.name}
                  className="inline-flex items-center gap-1 h-5 pl-1.5 pr-2 rounded-lg font-mono text-[10px] max-w-[220px]"
                  style={{
                    background: withAlpha(styles.accent, styles.isDark ? 0.14 : 0.1),
                    color: styles.textSecondary,
                  }}
                >
                  <File size={10} className="shrink-0" style={{ color: styles.accent }} />
                  <span className="truncate">
                    {a.name}
                    {a.size !== undefined ? ` · ${fmtBytes(a.size)}` : ""}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          <ClampedText
            text={content}
            lines={6}
            expandLabel="Show full message"
            collapseLabel="Show less"
            className="whitespace-pre-wrap break-words"
          />
        </div>
      </div>
    </motion.div>
  );
}

/** Inline code block renderer with copy button (round-24: Kilo Code parity).
 * ROUND-64 (R64-c): CodeBlock, PathPill + the path-matching helpers MOVED to
 * src/components/project-chat/ChatMarkdown.tsx (the new markdown renderer
 * owns them; nothing here duplicated them) — the old RichText/RichTextInline
 * pair is fully superseded by ChatMarkdown and deleted. */

/** ROUND-64 (R64-c): one ordered slice of a turn's working entries — a
 * contiguous run of non-text entries (→ one WorkingSection, or a bare block
 * when the run has no tools) or a single intermediate assistant text entry
 * (→ a full markdown answer block that is ALWAYS visible, never collapsed).
 * Owner: "It started to think and after thinking it showed me the bottom
 * response only. The above one was not shown." — intermediate assistant
 * text used to fold into the collapsible WorkingSection, so the earlier
 * response vanished behind the folded work summary. Pure; exported for tests. */
export type WorkingSegment =
  | { kind: "text"; content: string; ts: string }
  | { kind: "work"; entries: WorkingEntry[]; firstIndex: number; lastIndex: number; startTs: string; endTs: string };

/** The ts of a working entry (tool entries carry it on the tool; every
 * other kind — thinking/text/approval and the R68-A screenshot capture
 * markers — carries it on the entry itself). */
function workingEntryTs(entry: WorkingEntry): string {
  return entry.type === "tool" ? entry.tool.ts : entry.ts;
}

/** Split a turn's working entries into ordered segments: intermediate TEXT
 * entries become standalone answer blocks; every contiguous run of the
 * OTHER entries (tool/thinking/approval — and, ROUND-68 R68-A, the `screenshot`
 * capture markers) becomes one work segment rendered at its timeline
 * position. The final answer keeps rendering last (the caller's finalText)
 * exactly as before. */
export function segmentWorkingEntries(entries: WorkingEntry[]): WorkingSegment[] {
  const out: WorkingSegment[] = [];
  let run: WorkingEntry[] = [];
  let runStart = -1;
  const flush = (endIndex: number): void => {
    if (run.length === 0) return;
    out.push({
      kind: "work",
      entries: run,
      firstIndex: runStart,
      lastIndex: endIndex,
      startTs: workingEntryTs(run[0]),
      endTs: workingEntryTs(run[run.length - 1]),
    });
    run = [];
    runStart = -1;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "text") {
      flush(i - 1);
      out.push({ kind: "text", content: entry.content, ts: entry.ts });
      continue;
    }
    if (run.length === 0) runStart = i;
    run.push(entry);
  }
  flush(entries.length - 1);
  return out;
}

/** ROUND-64 (R64-c): one intermediate assistant text entry rendered as a
 * FULL markdown answer block in the chat body — always visible, never
 * folded into the collapsible work section (same typography as the final
 * answer; ChatMarkdown per fix 1). */
function IntermediateAnswer({ content, projectId }: { content: string; projectId: string }) {
  const styles = useThemeStyles();
  const trimmed = content.trim();
  if (trimmed === "") return null;
  return (
    <div className="chat-prose mt-1.5 min-w-0 break-words text-[13px] leading-[1.65]" style={{ color: styles.text, ["--chat-base-size" as string]: "13px" } as React.CSSProperties}>
      <ChatMarkdown content={content} projectId={projectId} />
    </div>
  );
}

/**
 * ROUND-37 AssistantTurn: ONE header-less assistant block per user message.
 * Tools (or multiple working entries) → collapsible WorkingSection(s); a
 * tools-free turn renders its thoughts bare. The final answer renders below
 * the section — collapsing the work never hides it (owner directive).
 * ROUND-64 (R64-c): the turn's working entries are now SEGMENTED (see
 * segmentWorkingEntries) — intermediate assistant TEXT entries render as
 * full markdown answer blocks at their timeline position (always visible,
 * never collapsed — the owner's "after thinking it showed me the bottom
 * response only"), and each contiguous run of tool/thinking/approval
 * entries renders as its own WorkingSection between them. The final answer
 * still renders LAST, exactly as before.
 */
function AssistantTurn({
  item,
  sessionId,
  projectId,
  collapseHint,
  debugMode,
}: {
  item: AssistantTurnItem;
  sessionId: string | null;
  /** ROUND-40: threaded from AgentChatPanel so the answer renderers +
   * WorkingSection can open files / sub-agents in the right sidebar. */
  projectId: string;
  /** R37 review #4: true when this turn JUST finished while the user
   * watched — it mounts collapsed (the folded summary + answer). */
  collapseHint?: boolean;
  /** ROUND-67 (R67-B): debug mode (the Functionality tab's settings — R98-I1
   * the advanced tab's label; the URL id stays "advanced") gates the footer's
   * second copy option — the full-turn export. Threaded from the panel's
   * ["debug-settings"] query via MessageRenderer. */
  debugMode?: boolean;
}) {
  const styles = useThemeStyles();
  const segments = segmentWorkingEntries(item.working);
  const hasToolWork = item.working.some((e) => e.type === "tool");
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="group min-w-0">
      {/* R99-B: the TURN HEADER — identity + timestamp above everything the
          turn renders (working sections, intermediate answers, final answer).
          Renders nothing when there is no model and no hover timestamp —
          intermediate segments NEVER get their own header (turn-level only). */}
      <AssistantTurnHeader model={item.model} ts={item.ts} />
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <IntermediateAnswer key={`seg-text-${i}`} content={seg.content} projectId={projectId} />
        ) : seg.entries.some((e) => e.type === "tool") ||
          // ROUND-68 (R68-A): defensive — a capture can only exist after the
          // tool row that took it, but a screenshot-carrying segment must
          // still render as a WorkingSection (the inline rows need the
          // section's column flow), never as a bare block.
          seg.entries.some((e) => e.type === "screenshot") ? (
          <WorkingSection
            key={`seg-work-${i}`}
            entries={seg.entries}
            sessionId={sessionId}
            projectId={projectId}
            ts={seg.startTs}
            endTs={seg.endTs}
            defaultOpen={collapseHint === true ? false : undefined}
          />
        ) : (
          <BareWorkingEntries key={`seg-bare-${i}`} entries={seg.entries} />
        ),
      )}
      {item.finalText.trim() !== "" ? (
        <div
          className={`chat-prose min-w-0 break-words text-[13px] leading-[1.65] ${hasToolWork ? "mt-2" : ""}`}
          style={{ color: styles.text, ["--chat-base-size" as string]: "13px" } as React.CSSProperties}
        >
          {/* ROUND-64 (R64-c): full markdown formatting (headings, lists,
              tables, links…) via ChatMarkdown — the old RichText rendered
              bold/code only and printed everything else as raw text. */}
          <ChatMarkdown content={item.finalText} projectId={projectId} />
        </div>
      ) : null}
      {/* ROUND-59 (R59-D): the footer owns the response-rating cluster
          (Copy + good/bad thumbs + stats + the bad-rating note editor). */}
      {/* ROUND-67 (R67-B, owner directive #2): in debug mode the footer also
          carries "Copy full conversation (debug)" — the whole turn (thinking,
          tool calls + outputs, approval checkpoints, final answer) rendered
          as text by lib/turn-copy. Built lazily ONLY when debug mode is on
          so a normal chat never pays for it. */}
      <TurnFooter
        sessionId={sessionId}
        assistantSeq={item.lastAssistantSeq}
        copyText={item.finalText}
        usage={item.usage}
        ms={item.ms}
        fullCopyText={
          debugMode === true
            ? buildFullTurnText({
                working: item.working,
                finalText: item.finalText,
                model: item.model,
                ms: item.ms,
              })
            : undefined
        }
      />
      {/* ROUND-66 (R66, C1): the DEDICATED debug-report section at the very
          bottom of the turn — the context-free analyst's post-turn report
          (folded from the persisted debug.report event; NEVER part of the
          model-facing history, so follow-up turns exclude it by design). */}
      {item.debugReport !== undefined ? (
        <div className="mt-2 min-w-0">
          <DebugReportCard
            report={{ state: "done", text: item.debugReport.content, model: item.debugReport.model }}
            projectId={projectId}
          />
        </div>
      ) : null}
    </motion.div>
  );
}

/**
 * ROUND-43 (owner: failed turns "outright silently die… no error message, no
 * retry option"): the DISTINCT error card rendered directly below the failed
 * user message — live while the stream errors (from the stream store) AND
 * after any reload (from the persisted `turn.error` event). Carries the
 * model + reason, timestamp, and two actions: Retry (re-sends the same user
 * message as a NEW turn through the normal send path; disabled while the
 * session is mid-stream) and Copy details (model/error/timestamp/session id
 * to the clipboard).
 */
export function TurnErrorCard({
  error,
  sessionId,
  onRetry,
  disabled = false,
}: {
  /** The persisted fold item OR a live shape (code/message/model/ts). */
  error: Pick<ErrorTurnItem, "code" | "message" | "ts"> &
    Partial<
      Pick<
        ErrorTurnItem,
        "model" | "providerId" | "providerError" | "errorClass" | "attempts" | "usage"
      >
    > & {
      /** R93-B1: live-only — the stranded-queue count (the error frame's
       * details). The folded card re-derives it from nothing (the folded
       * queue chips render their own state). */
      queuedKept?: number;
    };
  sessionId: string | null;
  /** Zero-arg — the PANEL binds the failed turn's user text before calling. */
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  // R77 (owner: "show the actual error messages too, which were returned
  // from the API, so that we know what is going on"): the raw provider text
  // is no longer chopped at 220 chars — long errors collapse to a short
  // excerpt with a "Show full error" toggle that expands the COMPLETE text
  // in a scrollable mono block (Copy details always carried the full text).
  const [expanded, setExpanded] = useState(false);
  const reason = error.providerError ?? error.message;
  const isLong = reason.length > 240;
  const shortReason = reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
  const detailsText = [
    "Generation failed",
    `Session: ${sessionId ?? "unknown"}`,
    `Model: ${error.model ?? "unknown"}`,
    ...(error.providerId ? [`Provider: ${error.providerId}`] : []),
    ...(error.errorClass !== undefined ? [`Class: ${error.errorClass}`] : []),
    ...(error.attempts !== undefined ? [`Attempts: ${error.attempts}`] : []),
    // R97-E: the real spend rides the copied details too.
    ...(error.usage
      ? [`Tokens sent: ${error.usage.inputTokens}`, `Tokens received: ${error.usage.outputTokens}`]
      : []),
    `Code: ${error.code}`,
    `Error: ${reason}`,
    `Time: ${error.ts}`,
  ].join("\n");
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        role="alert"
        className="rounded-xl border px-3.5 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4),
          background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.09 : 0.05),
        }}
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
            Generation failed
            {error.attempts !== undefined ? (
              <span className="ml-1.5" style={{ color: styles.textSecondary }}>
                after {error.attempts} attempt{error.attempts === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {error.errorClass !== undefined ? (
              <span
                className="text-[10px] font-mono px-1.5 py-0.5 rounded-md shrink-0 uppercase tracking-wide"
                style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.12), color: SEMANTIC_COLORS.danger }}
                title={`provider error class: ${error.errorClass}`}
              >
                {error.errorClass.replace(/_/g, " ")}
              </span>
            ) : null}
            {error.model ? (
              <span
                className="font-mono text-[10px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[240px] truncate"
                style={{ background: styles.subtle, color: styles.textTertiary }}
                title={error.model}
              >
                {error.model}
              </span>
            ) : null}
            {/* R97-E: the failed turn's REAL spend — the owner: "if a model
                fails, then it does not show me the total number of tokens
                sent, total number of tokens received… It should show that
                info properly." Rendered whenever any usage accumulated
                (completed iterations + the failed call's so-far). */}
            {error.usage ? (
              <span
                data-error-usage
                className="font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-md shrink-0"
                style={{ background: styles.subtle, color: styles.textSecondary }}
                title="The tokens this failed turn actually spent (completed iterations + the failed call's streamed-so-far)"
              >
                {fmtTokens(error.usage.inputTokens)} sent ↑ · {fmtTokens(error.usage.outputTokens)} received ↓
              </span>
            ) : null}
            <span className="text-[12px] leading-[1.5] min-w-0 break-words" style={{ color: styles.textSecondary }}>
              {shortReason}
            </span>
            {/* R93-B1: the stranded queue is never silent — the card says
                the messages are KEPT (they pre-flip into the next send),
                matching the owner's "it does not silently fail" directive. */}
            {error.queuedKept !== undefined ? (
              <span
                data-error-queued-kept
                className="text-[11px] font-medium px-2 py-0.5 rounded-md shrink-0"
                style={{ background: withAlpha(SEMANTIC_COLORS.warning, 0.12), color: SEMANTIC_COLORS.warning }}
                title="They stay queued server-side and send with your next message"
              >
                {error.queuedKept} message{error.queuedKept === 1 ? "" : "s"} kept — they&apos;ll send with your next message
              </span>
            ) : null}
            {/* R77: the full-error toggle — long provider payloads (the raw
                OpenRouter body can run hundreds of chars) collapse to the
                excerpt; the toggle reveals everything, scrollable. */}
            {isLong ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                data-error-expand
                className="h-6 px-2 rounded-lg text-[11px] font-semibold border transition-colors shrink-0"
                style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4), color: SEMANTIC_COLORS.danger }}
                title={expanded ? "Collapse the error text" : "Show the complete error message returned by the API"}
              >
                {expanded ? "Show less" : "Show full error"}
              </button>
            ) : null}
          </div>
          {expanded ? (
            <pre
              data-error-full-text
              className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-[10px] leading-[1.55] whitespace-pre-wrap break-words min-w-0"
              style={{
                borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3),
                background: styles.subtle,
                color: styles.textSecondary,
              }}
            >
              {reason}
            </pre>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
              {formatTime(error.ts)}
            </span>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={disabled}
                aria-label="Retry the failed message"
                title={disabled ? "Wait for the current turn to finish" : "Send the same message again"}
                className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
              >
                Retry
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(detailsText).then(() => {
                  setCopied(true);
                  resetAfter(() => setCopied(false), 1200);
                });
              }}
              aria-label="Copy error details"
              className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-colors"
              style={{ borderColor: styles.border, color: styles.textSecondary }}
            >
              {copied ? "Copied" : "Copy details"}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ROUND-97 (R97-D): the THINKING-STOPPED card — the thinking-loop guard's OWN
 * presentation, deliberately NOT TurnErrorCard. The owner: "The thinking loop
 * stopping and other things like that should not be shown as errors like
 * 'generation failed.' These should be highlighted in a separate way." So:
 * amber (never red), role=status (never alert), a Brain icon (never the
 * warning triangle), "Thinking stopped" (never "Generation failed"), and the
 * copy explains WHAT the guard is + WHERE to turn it off — the guard firing
 * is a configured intervention, not a provider failure.
 */
export function ThinkingStoppedCard({
  error,
  onRetry,
  disabled = false,
}: {
  /** The persisted error fold item OR the live error shape (the same subset
   * TurnErrorCard accepts — code/message/ts + the optional detail fields). */
  error: Pick<ErrorTurnItem, "code" | "message" | "ts"> &
    Partial<Pick<ErrorTurnItem, "model" | "providerId" | "providerError" | "errorClass" | "attempts">>;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const styles = useThemeStyles();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        role="status"
        data-testid="thinking-stopped-card"
        className="rounded-xl border px-3.5 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4),
          background: withAlpha(SEMANTIC_COLORS.warning, styles.isDark ? 0.09 : 0.05),
        }}
      >
        <Brain size={14} className="mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.warning }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold" style={{ color: SEMANTIC_COLORS.warning }}>
            Thinking stopped by the guard
          </div>
          <div className="mt-1 text-[12px] leading-[1.5] min-w-0 break-words" style={{ color: styles.textSecondary }}>
            The model kept reasoning with no text, tool call, or finish past your thresholds, so the thinking-loop
            guard stopped it (one de-escalating retry was attempted first). This is not a provider failure — the
            guard is a setting you control.
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {error.model ? (
              <span
                className="font-mono text-[10px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[240px] truncate"
                style={{ background: styles.subtle, color: styles.textTertiary }}
                title={error.model}
              >
                {error.model}
              </span>
            ) : null}
            <span className="text-[11px]" style={{ color: styles.textTertiary }}>
              Turn it off or tune it in{" "}
              <Link to="/settings?tab=advanced" className="font-semibold underline" style={{ color: SEMANTIC_COLORS.warning }}>
                {/* R98-I1: the label follows the honest rename ("General" →
                    "Functionality", the owner's word) — the URL id stays
                    "advanced" (the load-bearing deep-link contract). */}
                Settings → Functionality
              </Link>
              .
            </span>
            {onRetry !== undefined ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={disabled}
                className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border transition-colors disabled:opacity-50"
                style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4), color: SEMANTIC_COLORS.warning }}
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ROUND-75 (R75, owner: transient API failures should retry visibly — "it
 * will set up a timer… it will stop, notify the user, and show the error
 * message"): the LIVE status card shown while the transient-API retry
 * ladder waits out a rate limit / network error / timeout. Amber, not red
 * — the turn is ALIVE and working automatically; this is reassurance, not
 * an alarm. Shows the cause (the class message), the attempt number
 * (2/6…6/6), and a live countdown to the next attempt. Any content frame
 * (text, thinking, tool) clears it — the retry succeeded.
 *
 * ROUND-78 (R78-A, owner: "show the actual error messages too, which were
 * returned from the API"): when the meta.retry frame carries the scrubbed
 * providerError (the REAL API text, not the generic class one-liner), the
 * card renders it under the class chip in mono with a ~3-line clamp (long
 * payloads get the R77 Show-full-error toggle) — the owner sees exactly
 * what the provider said while the ladder waits.
 */
export function RetryStatusCard({ retry }: { retry: LiveTurnRetry }) {
  const styles = useThemeStyles();
  // The live countdown — ticks once a second locally (the backend's 60 s
  // heartbeat refreshes the anchor; the local tick keeps it smooth).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  // R78: the provider text's expand toggle — the TurnErrorCard (R77) pattern:
  // payloads over ~240 chars collapse to an excerpt; the toggle reveals the
  // complete raw text in a scrollable mono block.
  const [providerExpanded, setProviderExpanded] = useState(false);
  const remainingMs = Math.max(0, retry.retryAt - nowMs);
  const remainingLabel =
    remainingMs <= 1_000
      ? "now"
      : remainingMs < 60_000
        ? `${Math.ceil(remainingMs / 1000)}s`
        : `${Math.floor(remainingMs / 60_000)}m ${Math.round((remainingMs % 60_000) / 1000)}s`;
  const classLabel = retry.errorClass.replace(/_/g, " ");
  // R78: the REAL provider text — mono, clamped to ~3 lines; long payloads
  // (>240 chars) collapse to the excerpt + the R77 expand-toggle treatment.
  const providerText = retry.providerError ?? null;
  const providerIsLong = providerText !== null && providerText.length > 240;
  const providerShort =
    providerText !== null && providerIsLong ? `${providerText.slice(0, 240)}…` : providerText;
  // R77: the wait's fill fraction for the countdown bar — 0 the moment the
  // rung starts, 1 as the next attempt fires (waitMs = the FULL rung).
  const waitFraction = Math.min(1, Math.max(0, 1 - remainingMs / Math.max(1, retry.waitMs)));
  // R77 (owner: "The retrying rate limit attempt was apparently not looking
  // good. Its UI was bad"): the attempt DOT-LADDER — one dot per attempt;
  // failed-and-done dots sit dim, the upcoming attempt breathes (the
  // ac-retry-pulse keyframes), future dots stay hollow.
  const attemptDots = Array.from({ length: retry.totalAttempts }, (_, i) => i + 1);
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        role="status"
        data-retry-status-card
        // R100-D: the card's 135° amber GRADIENT is retired (TOKENS §5 —
        // gradient fills are wizard + primary-CTA only); the flat amber wash
        // matches every other status card. 16px radius via the scale utility.
        className="rounded-2xl border px-3.5 py-3 flex items-start gap-3"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4),
          background: withAlpha(SEMANTIC_COLORS.warning, styles.isDark ? 0.09 : 0.05),
        }}
      >
        {/* The spinner badge — the slow patient rotation (R75) now inside a
            soft circular chip instead of a bare floating glyph. */}
        <div
          className="w-7 h-7 rounded-full grid place-items-center shrink-0 mt-0.5"
          style={{ background: withAlpha(SEMANTIC_COLORS.warning, 0.16) }}
          aria-hidden
        >
          <RefreshCw size={13} className="ac-retry-spin" style={{ color: SEMANTIC_COLORS.warning }} />
        </div>
        <div className="min-w-0 flex-1">
          {/* Header + the attempt dot-ladder. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-semibold" style={{ color: SEMANTIC_COLORS.warning }}>
              Retrying — attempt {retry.attempt} of {retry.totalAttempts}
            </span>
            <span className="flex items-center gap-[3px]" aria-hidden data-retry-dots>
              {attemptDots.map((n) => {
                const isCurrent = n === retry.attempt;
                const isDone = n < retry.attempt;
                return (
                  <span
                    key={n}
                    className={isCurrent ? "rounded-full ac-retry-pulse" : "rounded-full"}
                    style={{
                      width: isCurrent ? 7 : 5,
                      height: isCurrent ? 7 : 5,
                      background: isDone
                        ? withAlpha(SEMANTIC_COLORS.warning, 0.55)
                        : isCurrent
                          ? SEMANTIC_COLORS.warning
                          : "transparent",
                      border: isCurrent || isDone ? "none" : `1px solid ${withAlpha(SEMANTIC_COLORS.warning, 0.45)}`,
                    }}
                  />
                );
              })}
            </span>
          </div>
          {/* The cause — class chip (rounded-full now) + the class message. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <span
              className="text-[10px] font-mono px-2 py-0.5 rounded-full shrink-0 uppercase tracking-wide"
              style={{ background: withAlpha(SEMANTIC_COLORS.warning, 0.14), color: SEMANTIC_COLORS.warning }}
              title={`provider error class: ${retry.errorClass}`}
            >
              {classLabel}
            </span>
            <span className="text-[12px] leading-[1.5] min-w-0 break-words" style={{ color: styles.textSecondary }}>
              {retry.classMessage}
            </span>
          </div>
          {/* ROUND-78 (R78-A, owner: "show the actual error messages too,
              which were returned from the API, so that we know what is going
              on"): the API's REAL words, verbatim — mono, ~3-line clamp,
              break-words. The class line above stays the one-glance summary;
              THIS line is the evidence. Long payloads (the raw OpenRouter
              body can run hundreds of chars) collapse to a 240-char excerpt
              with the R77 TurnErrorCard expand-toggle (Show full error → the
              complete text, scrollable). Absent (pre-R78 sidecar) → nothing
              renders here; the class message above stands alone exactly as
              before. */}
          {providerShort !== null ? (
            <div className="mt-1.5 min-w-0" data-retry-provider-error>
              <div
                className={`font-mono text-[10px] leading-[1.55] min-w-0 break-words ${
                  providerExpanded ? "" : "line-clamp-3"
                }`}
                style={{ color: styles.textSecondary }}
              >
                {providerExpanded ? providerText : providerShort}
              </div>
              {providerIsLong ? (
                <>
                  <button
                    type="button"
                    onClick={() => setProviderExpanded((v) => !v)}
                    aria-expanded={providerExpanded}
                    data-retry-provider-expand
                    className="mt-1 h-6 px-2 rounded-lg text-[11px] font-semibold border transition-colors shrink-0"
                    style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4), color: SEMANTIC_COLORS.warning }}
                    title={
                      providerExpanded
                        ? "Collapse the provider text"
                        : "Show the complete error text returned by the API"
                    }
                  >
                    {providerExpanded ? "Show less" : "Show full error"}
                  </button>
                  {providerExpanded ? (
                    <pre
                      data-retry-provider-error-full
                      className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-[10px] leading-[1.55] whitespace-pre-wrap break-words min-w-0"
                      style={{
                        borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.3),
                        background: styles.subtle,
                        color: styles.textSecondary,
                      }}
                    >
                      {providerText}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {/* The countdown — a mono label + a thin fill bar that empties
              into the next attempt (progress IS the reassurance). */}
          <div className="mt-2 flex items-center gap-2">
            <Timer size={11} className="shrink-0" style={{ color: SEMANTIC_COLORS.warning }} aria-hidden />
            <span className="text-[11px] font-mono shrink-0 tabular-nums" style={{ color: SEMANTIC_COLORS.warning }}>
              next attempt in {remainingLabel}
            </span>
            <div
              className="flex-1 min-w-[48px] h-1 rounded-full overflow-hidden"
              style={{ background: withAlpha(SEMANTIC_COLORS.warning, 0.16) }}
              aria-hidden
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${waitFraction * 100}%`,
                  background: SEMANTIC_COLORS.warning,
                  transition: "width 1s linear",
                }}
              />
            </div>
          </div>
          {/* The reassurance line. */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Info size={10} className="shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
            <span className="text-[10px] min-w-0" style={{ color: styles.textTertiary }}>
              the agent keeps working automatically — no action needed
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ROUND-58 (R58-cf, owner: stopping showed "Generation failed" + "body stream
 * buffer was aborted" instead of a clean stop): the QUIET status card for a
 * deliberate user stop — NOT TurnErrorCard, no red, no error semantics. The
 * partial streamed text/section above it stays visible; after the refetch
 * the persisted partial (the backend flushes it on stop) replaces the live
 * text seamlessly and the card stays until the next send. The composer's
 * Continue affordance rides the same store signal. Icon: the plain Square
 * glyph (the Stop control's own visual, muted) — no error-flavored mark.
 */
export function TurnStoppedCard({ ts }: { ts: string }) {
  const styles = useThemeStyles();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        role="status"
        data-stopped-card
        className="rounded-xl border px-3.5 py-2.5 flex items-center gap-2.5"
        style={{ borderColor: styles.borderSubtle, background: styles.subtle }}
      >
        <Square size={12} strokeWidth={2.5} className="mt-0.5 shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-[12px] font-semibold" style={{ color: styles.textSecondary }}>
            Stopped by user
          </span>
          <span className="text-[10px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
            {formatTime(ts)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — while the agent is
 * responding/running tools the user can still send): the QUEUED MESSAGE
 * CHIP — a compact amber card (the RetryStatusCard language: amber = alive
 * and waiting, never red) rendered below the working section for every
 * message sitting in the session's queue. A Clock glyph + the "sends after
 * the current step" label + the content clamped to 2 lines + two
 * affordances: X (remove → DELETE /sessions/:id/queue/:seq, optimistic) and
 * "Send now" (only while NOT busy → dequeue + a normal send of the content
 * — no waiting for the current step, which already finished). Renders from
 * BOTH sources: the live store's `queued` array (mid-stream, pushed by the
 * user.queued frame) and the folded log's `queued` items (after the
 * stream ends — message.queued events fold there; the panel dedupes by seq
 * so the handoff never double-renders).
 */
export function QueuedMessageChip({
  entry,
  busy,
  onRemove,
  onSendNow,
}: {
  entry: Pick<QueuedMessage, "seq" | "content" | "ts" | "attachments">;
  /** Hides "Send now" while a turn runs (the queue itself will deliver). */
  busy: boolean;
  /** Live-mode remove affordance (undefined in fixture mode). */
  onRemove?: () => void;
  /** Live-mode send-now affordance (undefined while busy / fixture mode). */
  onSendNow?: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        data-testid="queued-chip"
        data-queued-seq={entry.seq}
        className="rounded-xl border px-3.5 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4),
          background: withAlpha(SEMANTIC_COLORS.warning, styles.isDark ? 0.08 : 0.05),
        }}
      >
        <Clock size={13} className="mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.warning }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold" style={{ color: SEMANTIC_COLORS.warning }}>
            Queued — sends after the current step
          </div>
          {/* The message text, clamped to two lines (the full text lives in
              the event log / the send-now round-trip — the chip is a glance,
              not the transcript). */}
          <div
            className="mt-0.5 line-clamp-2 break-words text-[12px] leading-[1.5]"
            style={{ color: styles.textSecondary }}
          >
            {entry.content}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
              {formatTime(entry.ts)}
            </span>
            {!busy && onSendNow !== undefined ? (
              <button
                type="button"
                onClick={onSendNow}
                aria-label="Send the queued message now"
                title="Stop waiting — send this message as a new turn right away"
                data-queued-send-now
                className="h-6 px-2 rounded-lg text-[11px] font-semibold border transition-colors shrink-0"
                style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.45), color: SEMANTIC_COLORS.warning }}
              >
                Send now
              </button>
            ) : null}
          </div>
        </div>
        {onRemove !== undefined ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove the queued message"
            title="Remove the queued message"
            data-queued-remove
            className="w-6 h-6 rounded-md grid place-items-center shrink-0 transition-colors hover:bg-hover"
            style={{ color: styles.textTertiary }}
          >
            <X size={11} />
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

/** R101-D: the rail node's accessible label — the item's identity plus the
 * same "Aug 26 · 10:00" timestamp grammar TimestampChip speaks (today
 * renders the clock alone), falling back to the kind alone when the item
 * carries no usable ts. Pure; feeds the dot's title and the sr-only span. */
function timelineNodeLabel(kind: ProjectChatItem["kind"], ts: string | undefined): string {
  const kindLabel =
    kind === "user"
      ? "You"
      : kind === "turn"
        ? "Assistant turn"
        : kind === "queued"
          ? "Queued message"
          : "Error";
  if (ts === undefined || ts === "") return kindLabel;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return kindLabel;
  const today = new Date().toDateString() === date.toDateString();
  const time = today
    ? formatTime(ts)
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} · ${formatTime(ts)}`;
  return `${kindLabel}, ${time}`;
}

/** ── ROUND-101 (R101-D): the timeline RAIL NODE ─────────────────────────────
 * The 9px dot at the top of every transcript item's rail cell (mt-[7px] —
 * level with the item's first line). One dot per item kind:
 *   user    → SOLID accent (you spoke)
 *   turn    → HOLLOW accent — 2px accent border on the card background
 *   error   → SOLID danger (SEMANTIC_COLORS — the documented exception set)
 *   queued  → HOLLOW muted (text-tertiary border on the card background)
 * EVERY dot carries a 2.5px punch-out ring in the transcript's background
 * (the panel paints styles.card — the same value --ac-card bridges) so the
 * spine visually TERMINATES at the dot instead of passing through it.
 *
 * A11y: the dot is decorative (aria-hidden) but the rail cell also renders
 * an sr-only span with the label, and the dot carries a native title (hover
 * affordance) — the timeline is perceivable without the visuals. */
function TimelineNode({ kind, ts }: { kind: ProjectChatItem["kind"]; ts?: string }) {
  const styles = useThemeStyles();
  const label = timelineNodeLabel(kind, ts);
  // The punch-out ring: the page background the transcript actually paints.
  const punchOut = `0 0 0 2.5px ${styles.card}`;
  const dotStyle: React.CSSProperties =
    kind === "user"
      ? { background: styles.accent, boxShadow: punchOut }
      : kind === "error"
        ? { background: SEMANTIC_COLORS.danger, boxShadow: punchOut }
        : kind === "queued"
          ? { background: styles.card, border: `2px solid ${styles.textTertiary}`, boxShadow: punchOut }
          : { background: styles.card, border: `2px solid ${styles.accent}`, boxShadow: punchOut };
  return (
    <div data-timeline-node data-timeline-kind={kind}>
      {/* mx-auto centers the dot on the rail column's axis (the spine). */}
      <span
        aria-hidden="true"
        title={label}
        className="mx-auto mt-[7px] block size-[9px] rounded-full"
        style={dotStyle}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** ── ROUND-101 (R101-D): the timeline SPINE ─────────────────────────────────
 * One continuous 1px vertical hairline (var(--ac-border) — the same token
 * every hairline speaks) running the height of the items wrapper, centered
 * under the rail column, BOTH ENDS FADED by a 32px gradient mask so the line
 * never hard-cuts at the top/bottom of the scroll content (it dissolves
 * under the top fade and above the composer).
 *
 * Alignment, by construction: the outer overlay carries the SAME graduated
 * horizontal padding as the reading column (CONTENT_H_PAD_CLASS), so its
 * normal-flow child sits exactly 14px into the content box — the 28px rail
 * column's center, where TimelineNode's dot lives — at every padding tier
 * (24/48/64px) and in both squish tiers (the 560px floor narrows the rail
 * to 20px and the offset to ml-2.5 in lockstep). -translate-x-1/2 centers
 * the 1px line exactly on that axis.
 *
 * aria-hidden + pointer-events-none: pure decoration, never a hit target.
 * The panel renders it ONLY when the transcript has content (an empty chat
 * is a greeting, not a timeline). */
function TimelineSpine() {
  return (
    <div
      aria-hidden="true"
      data-timeline-spine
      className={`pointer-events-none absolute bottom-3 top-3 left-0 right-0 ${CONTENT_H_PAD_CLASS}`}
    >
      <div
        className="h-full w-px -translate-x-1/2 ml-3.5 @max-[560px]:ml-2.5"
        style={{
          background: "var(--ac-border)",
          maskImage:
            "linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent)",
        }}
      />
    </div>
  );
}

/** Direct child of AnimatePresence mode="popLayout": framer-motion attaches a
 * measurement ref to this element (React 18 requires forwardRef — the demo
 * could skip it on React 19). The wrapper div is the presence child. */
const MessageRenderer = forwardRef<
  HTMLDivElement,
  {
    item: ProjectChatItem;
    sessionId: string | null;
    projectId: string;
    collapseHint?: boolean;
    /** ROUND-43: error-card actions. Zero-arg retry — the text is bound by
     * the panel (the failed turn's user message). */
    onRetry?: () => void;
    retryDisabled?: boolean;
    /** ROUND-44 (R44-c): user-bubble revert — rewinds the session to THIS
     * message's event seq (bound by the panel; absent on items that cannot
     * revert, e.g. the optimistic pending echo). */
    onRevert?: () => void;
    revertDisabled?: boolean;
    /** ROUND-50 (R50-c2): display-only attachment chips for user items —
     * from the persisted event log OR the optimistic pending echo. */
    attachments?: AttachmentRef[];
    /** ROUND-67 (R67-B): debug mode (the Functionality tab's settings —
     * R98-I1's rename of the old Advanced/General label) — threaded to
     * AssistantTurn so its footer can mount the second, full-turn copy
     * button (gated on the ["debug-settings"] query upstream). */
    debugMode?: boolean;
    /** ROUND-78 (R78-D): the queued chip's affordances — bound by the panel
     * for FOLDED queued items (live-mode only; the busy flag rides the
     * dedicated prop). */
    onQueuedRemove?: (seq: number) => void;
    onQueuedSendNow?: (entry: QueuedMessage) => void;
    queuedBusy?: boolean;
  }
>(function MessageRenderer(
  { item, sessionId, projectId, collapseHint, onRetry, retryDisabled, onRevert, revertDisabled, attachments, debugMode, onQueuedRemove, onQueuedSendNow, queuedBusy },
  ref,
) {
  switch (item.kind) {
    // R101-D: EVERY item renders in the TIMELINE RAIL grid (TIMELINE_ITEM_
    // CLASS): the 28px rail cell (TimelineNode's dot, kind-coded) + the
    // existing content cell, untouched. The wrapper div stays the
    // AnimatePresence popLayout child (the ref is framer-motion's measurement
    // hook — display:grid composes with its absolute exit positioning).
    case "user":
      return (
        <div ref={ref} className={TIMELINE_ITEM_CLASS}>
          <TimelineNode kind="user" ts={item.ts} />
          <UserMessage
            content={item.content}
            ts={item.ts}
            onRevert={onRevert}
            revertDisabled={revertDisabled}
            attachments={attachments ?? item.attachments}
          />
        </div>
      );
    case "queued":
      // R78: the folded queued chip (message.queued event) — the SAME chip
      // the live store renders mid-stream, with the panel-bound affordances.
      return (
        <div ref={ref} className={TIMELINE_ITEM_CLASS}>
          <TimelineNode kind="queued" ts={item.ts} />
          <QueuedMessageChip
            entry={item}
            busy={queuedBusy ?? false}
            onRemove={onQueuedRemove !== undefined ? () => onQueuedRemove(item.seq) : undefined}
            onSendNow={onQueuedSendNow !== undefined ? () => onQueuedSendNow(item) : undefined}
          />
        </div>
      );
    case "turn":
      return (
        <div ref={ref} className={TIMELINE_ITEM_CLASS}>
          <TimelineNode kind="turn" ts={item.ts} />
          <AssistantTurn
            item={item}
            sessionId={sessionId}
            projectId={projectId}
            collapseHint={collapseHint}
            debugMode={debugMode}
          />
        </div>
      );
    case "error":
      return (
        <div ref={ref} className={TIMELINE_ITEM_CLASS}>
          <TimelineNode kind="error" ts={item.ts} />
          {/* R97-D: the thinking-loop guard's stop is NOT an error — the amber
              ThinkingStoppedCard replaces the red TurnErrorCard for the
              thinking_loop class (the owner's "should not be shown as errors
              like 'generation failed'" directive). */}
          {item.errorClass === "thinking_loop" ? (
            <ThinkingStoppedCard error={item} onRetry={onRetry} disabled={retryDisabled} />
          ) : (
            <TurnErrorCard error={item} sessionId={sessionId} onRetry={onRetry} disabled={retryDisabled} />
          )}
        </div>
      );
  }
});

/** ROUND-39: LiveTurn now lives in src/lib/stream-store.ts so the streaming
 * state survives panel remounts (background sessions). The interface is
 * re-exported from there. */

/** R94-D2: the stick-to-bottom NEAR-BOTTOM threshold — a viewport within
 * this many pixels of the transcript bottom counts as PINNED. Generous
 * enough that a growing last element doesn't instantly detach the follower,
 * strict enough that reading mid-history does. */
const STICK_TO_BOTTOM_PX = 96;

/** R94-D2: the keys that scroll the transcript when focus sits inside it
 * (PageUp/Home/ArrowUp leave the bottom; the down-keys only end any in-
 * flight programmatic scroll and let the resulting scroll events decide). */
const SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);

/** R95-D (owner: "The Jump to Latest button was showing even though I was
 * at the very bottom" while reading the live thinking tail): the selector
 * for NESTED scrollers that may consume an upward wheel before the
 * transcript ever sees it — the app's own scrollable convention (the
 * `.auto-scroll` class marks every long scrollable rendered inside the
 * chat: the live thinking block, the diff/terminal/output details…), the
 * thinking scroller's explicit data-thinking-scroll marker (a stable hook
 * for tests — WorkingSection owns it), and `pre` (markdown code blocks;
 * their horizontal scrollers sit at scrollTop 0, so they only ever match
 * for completeness — the walk below skips anything already at its top). */
const NESTED_SCROLLABLE_SELECTOR = ".auto-scroll, [data-thinking-scroll], pre";

export function AgentChatPanel({
  projectId,
  project,
  compact = false,
}: {
  projectId: string;
  project: Project;
  /** Freeform (experimental) windows host a denser variant. */
  compact?: boolean;
}) {
  const styles = useThemeStyles();

  // ROUND-30 FIX (owner bug: "All of the sessions are exactly the same"):
  // the ?session= URL param — written by the sidebar's session rows and the
  // New Session button — is now the AUTHORITATIVE selection. The panel used
  // to always bind the project's MOST-RECENTLY-UPDATED session, so clicking
  // a different session showed the same conversation and every message went
  // into the latest one. Now: param session wins; fallback (no param) is the
  // latest session, matching the sidebar's default navigation target.
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionIdParam = searchParams.get("session");
  // R97-I (owner: "I want the UI to be aware of its states"): the query
  // OBJECTS are captured (not just .data) so the transcript can render its
  // honest loading / error states instead of a false greeting while the
  // log arrives — see chatHistoryLoading / chatHistoryError below.
  const sessionsQuery = useSessions();
  const sessions = sessionsQuery.data ?? [];
  const projectSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, projectId],
  );
  const session = useMemo(() => {
    if (sessionIdParam !== null) {
      const fromParam = projectSessions.find((s) => s.id === sessionIdParam);
      // Param points at a session in ANOTHER project (or a deleted one):
      // fall through to the latest of THIS project rather than rendering
      // a foreign conversation.
      if (fromParam !== undefined) return fromParam;
    }
    return projectSessions[0] ?? null;
  }, [projectSessions, sessionIdParam]);
  const sessionDetail = useSession(session?.id ?? null);
  // R97-I: the three-state gate. LOADING = the sessions list is still
  // arriving OR a session is selected and its log is (a fresh session's
  // detail query is disabled — session null → not loading). ERROR = a fetch
  // actually failed with NOTHING to render (stale data from a background
  // refetch failure still renders the transcript normally). Both flags are
  // only consulted on the empty-transcript branch — a populated transcript
  // always wins.
  const chatHistoryLoading =
    sessionsQuery.isPending || (session !== null && sessionDetail.isPending);
  const chatHistoryError =
    (sessionsQuery.isError && sessionsQuery.data === undefined) ||
    (session !== null && sessionDetail.isError && sessionDetail.data === undefined);
  const retryChatLoad = () => {
    void sessionsQuery.refetch();
    if (session !== null) void sessionDetail.refetch();
  };

  // Agent resolution (round-14): the SESSION's bound agent wins; for NEW
  // sessions the hamburger picker's choice (persisted) applies; else first.
  // R97-I: the query object is captured so the empty state never flashes the
  // FALSE "Create an agent in Settings first" line while the list is still
  // in flight (it used to paint on every first mount, then vanish).
  const agentsQuery = useAgents(false);
  const agents = agentsQuery.data ?? [];
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const agent =
    agents.find((a) => a.id === session?.agentId) ??
    agents.find((a) => a.id === selectedAgentId) ??
    agents[0] ??
    null;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = useThemeStore((s) => s.density);
  // R97-H: the chat customizability pair — the text size rides a CSS var on
  // the transcript root; the timestamps mode is read by TimestampChip
  // itself (user bubbles + turn footers).
  const chatTextSize = useThemeStore((s) => s.chatTextSize);

  // ⌘K / Ctrl+K opens the CommandPalette (WS-H).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ROUND-39: the right sidebar's quick-menu "File" option requests the file
  // picker via the events store (the palette lives here, not in the sidebar).
  // The counter pattern lets consecutive requests each fire.
  //
  // ROUND-41 (owner: "whenever I try to switch the session, it opens up the
  // search symbol menu every single time" + "when I click the file, it opens
  // up this search symbol file too… a glitch kind of thing"). ROOT CAUSE:
  // `useRef(0)` initialized the prev-counter to 0 on every remount, but the
  // store's counter survives remounts — so any non-zero counter from a PRIOR
  // session/project made the effect fire `setPaletteOpen(true)` on the very
  // first render of the new mount. FIX: initialize the ref to the CURRENT
  // store value (`useRef(filePickerRequest)`) so the effect only fires on
  // SUBSEQUENT increments, not on the first render after a remount.
  const filePickerRequest = useRightSidebarEvents((s) => s.filePickerRequest);
  const prevFilePickerRef = useRef(filePickerRequest);
  useEffect(() => {
    if (filePickerRequest !== prevFilePickerRef.current && filePickerRequest > 0) {
      prevFilePickerRef.current = filePickerRequest;
      setPaletteOpen(true);
    }
  }, [filePickerRequest]);

  const createSession = useCreateSession();
  const sendMessage = useSendMessage();
  // ── ROUND-44 (R44-c): revert-to-message. The hovered user bubble records
  // its event seq (toProjectChatItems already carries it on {kind:"user"}
  // items — no mapping change needed); the ConfirmDialog guards the
  // destructive truncation.
  const revertSessionMutation = useRevertSession();
  const [revertTarget, setRevertTarget] = useState<Extract<ProjectChatItem, { kind: "user" }> | null>(
    null,
  );

  // ROUND-37: the turn fold carries stats turn-level — the old R33
  // interim-reply stat-strip pass is GONE (superseded by the fold).
  const items = useMemo(() => {
    if (!sessionDetail.data) return [];
    return toProjectChatItems(sessionDetail.data.events);
  }, [sessionDetail.data]);

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // ROUND-50 (R50-c2): the staged chips of the IN-FLIGHT optimistic echo —
  // shown on the pending user bubble until the refetched event log carries
  // the persisted (display-only) attachments.
  const [pendingEchoAttachments, setPendingEchoAttachments] = useState<
    AttachmentRef[] | null
  >(null);

  // ── ROUND-39: live streaming state moved to src/lib/stream-store.ts so
  //    sessions keep streaming in the background across panel remounts
  //    (project switch / settings nav). The panel just reads its session's
  //    slice; the store handles the AbortController + event mutations.
  const activeSessionId = session?.id ?? null;
  const streamSlice = useStreamStore((s) =>
    activeSessionId !== null ? s.bySession[activeSessionId] : undefined,
  );
  const liveTurn = streamSlice?.liveTurn ?? null;
  const streamBusy = streamSlice?.streamBusy ?? false;
  // R113-b: a REMOTE mirror is in flight — another device's turn on THIS
  // session, replayed by the events stream. Keyed on the slice's remote
  // flag (NOT "liveTurn != null && !streamBusy" — that would also match
  // the own-turn post-done window where liveTurn lingers a beat before the
  // panel clears it, and busy/flicker would regress). Drives busy (a send
  // while a remote turn runs must take the QUEUE path — the stream POST
  // would 409 "a turn is already in flight") and the sidebar spinner below.
  const remoteRunning =
    streamSlice?.remote === true && liveTurn !== null && !liveTurn.stopped;
  // ROUND-43: the LIVE turn error — renders the error card immediately when a
  // stream fails; the persisted `turn.error` event takes over after the
  // refetch (matched by errorTs) so the card survives reloads.
  const liveError = streamSlice?.liveError ?? null;
  const streamPendingEcho = streamSlice?.pendingEcho ?? null;
  const lastLiveEndMs = streamSlice?.lastLiveEndMs ?? 0;
  // ROUND-78 (R78-D): the session's live message QUEUE — chips (not yet
  // delivered) + delivered bubbles. The frames keep them fresh mid-stream;
  // startStream resets them and the stream-end finally clears them (the
  // refetched folded log owns the render after that — message.queued events
  // fold as `queued` items, delivered ones as ordinary user items).
  const liveQueued = streamSlice?.queued ?? [];
  const deliveredQueued = streamSlice?.deliveredQueued ?? [];
  // R93-B1: the KEPT-QUEUE notice — how many messages stayed queued when the
  // stream ended (the cap's honest break, or a failure that stranded them
  // without the recovery). Rendered as a calm amber strip so the queue is
  // never silently stranded; startStream clears it (the pre-flip folds
  // them into the new turn's history).
  const queueKeptNotice = streamSlice?.queueKeptNotice ?? null;
  // ROUND-58 (R58-cf): the last live turn ended by a USER STOP — the quiet
  // Stopped card below the (folded or still-live) partial + the composer's
  // Continue affordance both key off this signal (it survives the live-turn
  // clear after the refetch and resets on the next send).
  const lastTurnStoppedByUser = streamSlice?.lastTurnStoppedByUser ?? false;
  const lastTurnStoppedTs = streamSlice?.lastTurnStoppedTs ?? null;
  // R37 review #4: turns that JUST finished while the user watched start
  // collapsed (the folded summary + answer); cold-loaded sessions use the
  // Detailed preference.
  const lastLiveEndRef = useRef(0);
  // Keep the ref in sync so MessageRenderer's collapseHint logic works
  // against the live store value.
  useEffect(() => {
    lastLiveEndRef.current = lastLiveEndMs;
  }, [lastLiveEndMs]);

  const queryClient = useQueryClient();
  const liveMode = useConfigStore((s) => !s.demoData);
  const dataSource = liveMode ? "live" : "demo";

  // ROUND-67 (R67-B, the owner's second copy option): debug mode (Settings →
  // Functionality, R98-I1's rename of the old Advanced/General tab — the URL
  // id stays "advanced") gates the "Copy full conversation (debug)" button on
  // assistant replies. SHARED cache key ["debug-settings"] — the same one
  // SettingsPage's DebugModeCard uses, so flipping the switch there updates
  // this panel on the next focus (react-query refetch-on-window-focus) with
  // ONE sidecar call. Mirrors the ratings-query conditioning (liveMode off →
  // demo mode has no sidecar → the query stays disabled and the gate reads
  // false, hiding the button).
  const debugSettingsQuery = useQuery({
    queryKey: ["debug-settings"],
    queryFn: fetchDebugSettings,
    enabled: liveMode,
  });
  const debugMode = debugSettingsQuery.data?.enabled === true;

  // ── ROUND-50 (R50-c2): the composer's per-session state ──────────────────
  // Model override + thinking level PERSIST PER SESSION (localStorage
  // acute-model:<id> / acute-thinking:<id>) and ride every send; the
  // permission mode starts from the session's own permissionMode ("ask"
  // before the session exists) and PATCHes the backend on change.
  //
  // ROUND-89 (R89-B4, the owner: "it should remember the last used model
  // and that model should be the default one for the next chats"): a
  // session with NO persisted override of its own starts from the GLOBAL
  // last-used model (saved by every pick + every send) instead of the
  // agent template's default — no more GLM-by-default once another model
  // has actually been used.
  //
  // ROUND-114 (R114-e, owner: "the phone showed Auto while the PC had a
  // model selected"): the seed grew a SERVER tier — the display ladder is
  // now per-session localStorage override → session.selectedModel (the
  // cross-device truth PATCH /sessions/:id {model} maintains; a phone-side
  // pick rides the meta frame's immediate invalidation into the refetched
  // session row) → global last-used. DISPLAY-LEVEL ONLY: the per-send
  // override logic below keeps its override-first semantics exactly.
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(() =>
    resolveSessionModelDisplay(session?.id ?? null, session?.selectedModel ?? null),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    loadThinkingLevel(session?.id ?? null),
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => session?.permissionMode ?? "ask",
  );
  const effectiveModel = modelOverride?.model ?? agent?.model ?? null;
  // ROUND-82 (R82, the owner's custom-provider routing fix): the override's
  // PROVIDER rides the send wire with its model (see the startStream call —
  // send carries modelOverride?.providerId only, so a no-override send keeps
  // the pre-R82 agent-provider behavior exactly). The picker is
  // provider-grouped (R64-d) and ModelOverride has carried the providerId
  // since then — it was captured in the UI and dropped at send time, so a
  // custom-provider model went verbatim to the AGENT's provider (default
  // agent = openrouter → "unknown model" with the wrong provider named).

  // Session switch → reload each session's own persisted composer state
  // (runTurn saves the fresh session's values at creation, so a first send
  // carries the choices made pre-session into the new session's keys).
  // R114-e: the seed runs through the FULL display ladder (override →
  // session.selectedModel → last-used) and ALSO re-runs when the session's
  // selectedModel CHANGES (same session id) while no local override is
  // persisted — that is exactly how a phone-side pick lands here: the meta
  // frame's immediate invalidation refetches the session row, the new
  // selectedModel flows in, and the pill follows the phone. A session with
  // a LOCAL override never re-seeds (tier 1 wins; a local pick made on
  // THIS device keeps displaying what this device picked).
  const sessionSelectedModel = session?.selectedModel ?? null;
  const sessionSelectedModelKey =
    sessionSelectedModel !== null
      ? `${sessionSelectedModel.providerId}/${sessionSelectedModel.model}`
      : "none";
  useEffect(() => {
    // R90-A4 (the owner: in a new chat "the provider was OpenRouter, even
    // though I did not have OpenRouter added to it, and the model was not
    // the previous one which I had selected"): the session-switch effect
    // used to load ONLY the session's own override — a session with none
    // fell straight to the agent template's default (openrouter/GLM, the
    // ghost). The INITIAL useState below already fell back to the global
    // last-used model (R89-B4); this effect now does the same, so a new
    // chat keeps the last-used model instead of regressing to the seed.
    setModelOverride(
      resolveSessionModelDisplay(
        activeSessionId,
        // The captured session row's pair — the effect re-runs when the
        // KEY changes (see the dep array), so a remote pick's fresh row is
        // always the one seeded here.
        sessionSelectedModelKey === "none"
          ? null
          : sessionSelectedModel,
      ),
    );
    // Deps note (no react-hooks lint runs here — the intent stands in
    // prose): sessionSelectedModel is captured via its STABLE string key
    // (an object dep would re-fire on every refetch's new row identity);
    // activeSessionId + the key together are the full trigger.
  }, [activeSessionId, sessionSelectedModelKey]);
  useEffect(() => {
    setThinkingLevel(loadThinkingLevel(activeSessionId));
  }, [activeSessionId]);
  useEffect(() => {
    setPermissionMode(session?.permissionMode ?? "ask");
  }, [session?.id, session?.permissionMode]);
  const onModelChange = (v: ModelOverride | null): void => {
    setModelOverride(v);
    saveModelOverride(activeSessionId, v);
    // R89-B4: every explicit pick is also the new GLOBAL default for the
    // next chats (clearing the override back to the agent default does not
    // un-remember it — the agent default becomes what's sent, and the send
    // path re-saves the EFFECTIVE pair there).
    if (v !== null) saveLastUsedModel(v);
    // ROUND-114 (R114-e, owner: "the phone showed Auto while the PC had a
    // model selected"): the pick is now SERVER TRUTH too — fire-and-forget
    // PATCH /sessions/:id {model} (the persistent tier between the per-send
    // override and the agent row). The other devices' composers follow it
    // through the meta frame (immediate invalidation); this device's own
    // display never moves (the localStorage override above already won).
    // A clear (v === null — the agent-default pick) clears the session tier
    // too, so "Auto" means Auto everywhere. A failed PATCH is a quiet
    // warn-and-keep: the pick still rides every send as the per-send
    // override (the backend's override-first gate), so nothing breaks.
    if (liveMode && activeSessionId !== null) {
      const sid = activeSessionId;
      void patchSessionSelectedModel(
        sid,
        v !== null ? { providerId: v.providerId, model: v.model } : null,
      )
        .then(() => {
          // Queue the refetch AFTER the write (fire-and-forget ordering:
          // the events-bus meta frame ALSO invalidates — duplicate
          // invalidation is a cheap no-op for react-query).
          void queryClient.invalidateQueries({ queryKey: ["session"] });
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        })
        .catch((err: unknown) => {
          console.warn("[chat] session model PATCH failed (the pick still rides the send)", err);
        });
    }
    // ROUND-92 (R92-B): the picker's SELF-HEAL — an UNCONFIGURED agent
    // (providerId/model null on the row: the R91-A force-delete reset
    // state, or a template that never had one) arms itself from the first
    // chat pick. The R91-A force-delete promise finally kept: the owner
    // deletes the provider, picks a new provider's model in chat, and the
    // AGENT ROW follows (not just the per-send override) — the Agents
    // screen shows a real pair, the next no-override send works, and the
    // 409 dead end cannot re-appear. A CONFIGURED agent keeps today's
    // localStorage-only override semantics EXACTLY (shouldArmAgentFromPick
    // is the one decision — tested in composer-utils/Composer suites).
    // Fire-and-forget (the wizard's ModelSummary precedent): the send
    // itself carries the override regardless (the backend's override-first
    // gate, R92-B), so a failed PATCH degrades to today's behavior, never
    // a broken pick.
    if (liveMode && shouldArmAgentFromPick(v, agent)) {
      const agentId = agent.id;
      const picked = v;
      void getAgentsBackend()
        .update(agentId, { providerId: picked.providerId, model: picked.model })
        .then(() => {
          // The agents react-query cache invalidation covers every list
          // variant (["agents", source, includeTemplates]) — the Agents
          // screen, the sidebar picker, and this panel's own agent row all
          // refetch and see the armed pair.
          void queryClient.invalidateQueries({ queryKey: ["agents"] });
        })
        .catch((err: unknown) => {
          console.warn("[chat] agent self-heal PATCH failed (the pick still rides the send)", err);
        });
    }
  };
  const onThinkingLevelChange = (level: ThinkingLevel): void => {
    setThinkingLevel(level);
    saveThinkingLevel(activeSessionId, level);
  };

  /** Mode switch: optimistic session-cache update + PATCH
   * /sessions/:id/permissions; a transient failure rolls BOTH back and
   * surfaces the error. No session yet → local only, applied at creation
   * (runTurn). Demo mode → local only (no sidecar). */
  const onModeChange = async (mode: PermissionMode): Promise<void> => {
    const prev = permissionMode;
    if (mode === prev) return;
    setPermissionMode(mode);
    if (activeSessionId === null || !liveMode) return;
    const sid = activeSessionId;
    const listKey = ["sessions", dataSource] as const;
    const detailKey = ["session", dataSource, sid] as const;
    const patchCache = (value: PermissionMode): void => {
      queryClient.setQueryData<Session[]>(listKey, (old) =>
        old === undefined
          ? old
          : old.map((s) => (s.id === sid ? { ...s, permissionMode: value } : s)),
      );
      queryClient.setQueryData<SessionDetail>(detailKey, (old) =>
        old === undefined ? old : { ...old, permissionMode: value },
      );
    };
    patchCache(mode);
    try {
      await patchSessionPermissions(sid, mode);
    } catch (err) {
      setPermissionMode(prev);
      patchCache(prev);
      pushLocalToast(
        "Mode change failed",
        err instanceof Error ? err.message : String(err),
        "task_failed",
      );
    }
  };

  // ROUND-39: file-mutation invalidation moved into the stream store so it
  // fires even when no panel is mounted (background session writes refresh
  // the explorer live).

  // R113-b: remoteRunning joins the busy union — the session is OCCUPIED
  // (server-side) even though this device owns no fetch: Enter routes to
  // the queue path (onQueue), Stop reaches the server's /stop, and the
  // turn-scoped affordances (revert, queued-send-now) wait like any busy
  // turn.
  const busy =
    createSession.isPending || sendMessage.isPending || pendingUser !== null || streamBusy || remoteRunning;

  // Optimistic echo lives only until the refetched log contains it (ChatView pattern).
  // ROUND-39: prefer the stream store's pendingEcho (survives remounts); fall
  // back to local pendingUser for fixture mode.
  const pendingEcho =
    (streamPendingEcho !== null && !items.some((it) => it.kind === "user" && it.content === streamPendingEcho))
      ? streamPendingEcho
      : pendingUser !== null && !items.some((it) => it.kind === "user" && it.content === pendingUser)
        ? pendingUser
        : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useScrollFade(scrollRef);

  // ── R94-D2 (owner: "While the agent is doing its work, I should be able
  //    to scroll the chat up and down without it automatically re-scrolling
  //    to the very bottom. It should only auto-scroll if I have moved to
  //    the very bottom."): STICK-TO-BOTTOM. The panel tracks whether the user
  //    is PINNED at (or near — STICK_TO_BOTTOM_PX) the bottom of the
  //    transcript; the auto-scroll effect below only follows while pinned,
  //    and a floating "Jump to latest" pill (above the composer) offers the
  //    way back down.
  //
  //    DETECTION (why it looks like this): a naive "is near bottom?" check
  //    on every scroll event is flipped by the intermediate positions of
  //    the panel's OWN programmatic SMOOTH scrolls — scrollTo({behavior:
  //    "smooth"}) emits a stream of scroll events on the way down, which
  //    would detach the user mid-stream without them touching anything. So:
  //      • a scroll that lands within STICK_TO_BOTTOM_PX of the bottom PINS
  //        (however it got there — our follow landing, or the user arriving);
  //      • while a programmatic scroll is in flight, intermediate positions
  //        are IGNORED — except one moving UP: our follows only ever target
  //        the maximum scrollTop and never move away from it, so an upward
  //        move during a flight is the user fighting the auto-scroll →
  //        detach immediately (a content-shrink clamp lands AT the bottom,
  //        caught by the pin rule first);
  //      • explicit user gestures detach outright and end the flight: wheel
  //        up, keyboard PageUp/Home/ArrowUp on the transcript; touchstart
  //        hands control to the scroll events that follow;
  //      • `scrollend` (Chromium 114+/Safari 17.4+/Firefox 109+; a silent
  //        no-op listener elsewhere) ends the flight when the browser
  //        settles, so a follow that landed short of a newly-grown bottom
  //        can never leave the flight stuck armed;
  //      • container-box RESIZE (ResizeObserver — sidebar toggles and window
  //        resizes alike) re-evaluates: a pinned view KEEPS FOLLOWING (the
  //        layout moved the bottom); a detached one re-pins only if the
  //        resize actually brought it near the bottom.
  //    jsdom/happy-dom note: no layout exists there (scrollHeight and
  //    clientHeight are 0), so every position reads as "at the bottom" and
  //    pinned starts true — the old always-follow behavior for suites that
  //    never dispatch scroll events.
  const [pinned, setPinned] = useState(true);
  // "new content landed at the bottom while the user reads higher up" — arms
  // the jump pill after a turn ends and the user never came back down.
  const [missedContent, setMissedContent] = useState(false);
  const pinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const applyPinned = (next: boolean): void => {
    pinnedRef.current = next;
    setPinned((prev) => (prev === next ? prev : next));
    if (next) setMissedContent(false);
  };

  /** The one scroll primitive: marks the flight, then scrolls to the current
   * bottom. Every auto-follow, send re-pin, and pill jump goes through it. */
  const scrollToBottom = (behavior: ScrollBehavior = "smooth"): void => {
    const el = scrollRef.current;
    if (el === null) return;
    programmaticScrollRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  /** Re-pin + follow in one step — the user's own send, a session switch,
   *  and the jump pill all call this (they ASK for the bottom). */
  const pinToBottom = (): void => {
    applyPinned(true);
    scrollToBottom();
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance < STICK_TO_BOTTOM_PX) {
        // Arrived at (or near) the bottom — our follow landing or the user.
        programmaticScrollRef.current = false;
        applyPinned(true);
      } else if (programmaticScrollRef.current) {
        // Our own smooth scroll on the way down: only an UPWARD move is the
        // user fighting it (follows never move away from the bottom).
        if (el.scrollTop < lastScrollTopRef.current) {
          programmaticScrollRef.current = false;
          applyPinned(false);
        }
      } else {
        applyPinned(false);
      }
      lastScrollTopRef.current = el.scrollTop;
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY >= 0) return; // toward the bottom is fine (arrival pins)
      // R95-D: NESTED-SCROLLER CHAINING — the wheel event BUBBLES from every
      // nested scroller it passes over (the live thinking block, a diff or
      // terminal detail, a code block), so an upward wheel INSIDE such a
      // block used to detach the TRANSCRIPT pin even though the inner
      // scroller — not the transcript — consumed it: the jump pill appeared
      // while the user was still at the very bottom (the owner's report).
      // The standard chaining rule: an upward wheel belongs to the
      // transcript only once EVERY scrollable between the cursor and it is
      // at its own top (scrollTop 0 — exactly when the browser chains the
      // scroll outward). Walk from the wheel target up to (but never
      // including) the transcript; the first scrollable that can still
      // consume the wheel owns the gesture — the transcript stays pinned.
      let cursor: Element | null = e.target instanceof Element ? e.target : null;
      while (cursor !== null && cursor !== el) {
        if (cursor.matches(NESTED_SCROLLABLE_SELECTOR) && cursor.scrollTop > 0) {
          return; // the nested scroller consumes the wheel
        }
        cursor = cursor.parentElement;
      }
      programmaticScrollRef.current = false;
      applyPinned(false);
    };
    const onTouchStart = (): void => {
      // The user grabs the transcript: the scroll events that follow decide.
      programmaticScrollRef.current = false;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(e.key)) return;
      programmaticScrollRef.current = false;
      if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") {
        applyPinned(false);
      }
    };
    const onScrollEnd = (): void => {
      // The browser settled the scroll (ours or the user's): the flight is
      // over — from here every scroll event is user/layout movement.
      programmaticScrollRef.current = false;
    };
    const onLayoutResize = (): void => {
      if (pinnedRef.current) {
        scrollToBottom("auto"); // keep following: the layout moved the bottom
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX) {
        applyPinned(true); // the resize brought the view near the bottom
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scrollend", onScrollEnd);
    // R94-D2: RESIZE — observed on the CONTAINER (not window) so sidebar
    // toggles and column resizes re-evaluate too, not just window resizes
    // (the repo's GutterScrollbar/PopoutApp convention). Content growth
    // never fires this: the scroller is absolute inset-0, so its box only
    // changes when the LAYOUT around it does.
    const resizeObserver = new ResizeObserver(() => onLayoutResize());
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scrollend", onScrollEnd);
      resizeObserver.disconnect();
    };
    // The listeners only touch refs + state setters (stable across renders)
    // and the scroll container lives for the panel's lifetime — mount-once
    // is the contract.
  }, []);

  // ROUND-38 (owner: sessions mixing across projects): declare this project
  // active so the per-project scoped state (selectedFileId/Agent/folders)
  // swaps in — opening a file in project A never re-opens it in B.
  const setActiveProject = useProjectChatStore((s) => s.setActiveProject);
  useEffect(() => {
    setActiveProject(projectId);
  }, [projectId, setActiveProject]);

  // ROUND-39 (owner: "It should keep the sessions going in the background
  // even if I change any pages"). The session's streaming state now lives in
  // the global stream store — switching sessions or unmounting the panel
  // does NOT abort the stream. We only clear LOCAL composer state
  // (input/lastSent/pendingUser) so the composer is fresh for the new
  // session. The previous session's stream keeps running.
  const prevSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === activeSessionId) return;
    // Local composer state reset only — the store's per-session state
    // persists so the user can switch back to a running session and see
    // its live progress.
    setPendingUser(null);
    setLastSent(null);
    setInput("");
    prevSessionIdRef.current = activeSessionId;
    // R94-D2: a session switch starts the new view PINNED at the bottom
    // (pre-R94 the unconditional effect scrolled on the items swap; the
    // stick-to-bottom gate must not inherit the previous session's
    // detached state into the fresh one).
    pinToBottom();
  }, [activeSessionId]);

  // ROUND-38/39 (owner: running session shows a pixelated animation in the
  // sidebar). The stream store already marks the session active when
  // startStream begins; here we keep the indicator in sync with the panel's
  // view of streamBusy + sendMessage. Note: the stream store's
  // active-streams.start fires when the stream BEGINS (so the sidebar
  // animates even when the panel isn't mounted). The stop here fires only
  // when streamBusy transitions to false AND the panel is still mounted —
  // if the panel unmounted, the store's abort/clear path handles the stop.
  const startStream = useActiveStreams((s) => s.start);
  const stopStream = useActiveStreams((s) => s.stop);
  // R113-b: remoteRunning joins isRunning — a session switch onto a
  // remotely-running session must (re)mark the sidebar spinner itself: the
  // ingest path's mark only fires on the FIRST mirrored frame, and this
  // effect's stop(activeSessionId) on the switch would otherwise kill it.
  // start/stop are idempotent, so the own-stream marks and the remote marks
  // compose cleanly.
  const isRunning = streamBusy || sendMessage.isPending || remoteRunning;
  useEffect(() => {
    if (activeSessionId === null) return;
    if (isRunning) startStream(activeSessionId);
    else stopStream(activeSessionId);
  }, [isRunning, activeSessionId, startStream, stopStream]);

  // Auto-scroll: new items, busy transitions, the live section's entry count,
  // and the growing streaming text (review fix #4 + R37 amendment #11).
  // ROUND-64 (R64-c): this count doubles as the context donut's `liveTick`
  // (the panel re-renders on every stream-store patch, so it bumps as tool
  // calls land — the donut's report refetches instead of waiting for the
  // turn to end).
  const liveWorkingCount = liveTurn?.working.length ?? 0;
  const liveTailText = liveTurn?.streamText ?? "";
  // R78: the queue lengths join the auto-scroll deps — a new chip / a
  // delivered bubble is new content at the bottom, exactly like a working
  // entry (the owner should see the chip land without scrolling).
  // R94-D2: STICK-TO-BOTTOM — the effect only follows while the user is
  // PINNED (at/near the bottom). While the user reads higher up, new
  // content must NOT move their viewport: the run is skipped and the
  // jump-to-latest pill is armed instead. The pinned contracts the pre-R94
  // effect served unconditionally are preserved by RE-PINNING at their
  // sources — the user's own send (runTurn → pinToBottom, which also owns
  // the pendingUser optimistic echo) and session switches (the session
  // effect) — and re-pinning is natural: scroll back to the bottom and the
  // next tick follows again.
  useEffect(() => {
    if (!pinnedRef.current) {
      setMissedContent(true);
      return;
    }
    scrollToBottom();
  }, [
    items.length,
    busy,
    pendingUser,
    liveWorkingCount,
    liveTailText.length,
    liveQueued.length,
    deliveredQueued.length,
  ]);

  const runTurn = async (content: string, composerAttachments: ComposerAttachment[] = []) => {
    const text = content.trim();
    if (!text || !agent) return;
    // ── R94-D2: the user's own send ALWAYS re-pins + follows — their message
    // is the new bottom (the optimistic echo renders there a beat later and
    // the pinned effect takes over). Retry / Send-now route through runTurn
    // too, so every user-initiated turn gets the same treatment. ──
    pinToBottom();
    // ── ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — send while the
    // agent works): a LIVE stream is running on this session → QUEUE the
    // message instead of refusing it. The POST validates server-side and
    // the user.queued SSE frame renders the chip; the optimistic push below
    // is belt-and-suspenders for a missed frame (deduped by seq in the
    // store). The one honest race: the turn can END between the Enter and
    // the POST — the sidecar answers 409 {code:"NO_LIVE_TURN"} and we FALL
    // THROUGH to the normal send path below exactly as if not busy (the
    // stale `busy` closure must not block the retry). Runs BEFORE the busy
    // guard for that reason.
    // R93-B1: the gate no longer requires `streamBusy` — the LOCAL store
    // can lag the server's registration (the send POST just resolved, the
    // SSE reader hasn't opened yet) and the old `streamBusy` requirement
    // SILENTLY DROPPED the message in that window (the owner's "queued
    // messages were not being handled properly"). The SERVER is the truth:
    // its 409 NO_LIVE_TURN is exactly the "no live turn, send normally"
    // answer, and the handler below falls through to the normal send. ──
    const liveSid = session?.id;
    if (busy && liveMode && liveSid !== undefined) {
      const queueAttachments = composerAttachments.map(toMessageAttachment);
      try {
        // ROUND-82 (R82): the queue entry carries the picker state at queue
        // time — the follow-up's continuation turn routes to the provider
        // the user picked HERE (not the agent default, the pre-R82 drop).
        const queued = await queueSessionMessage(liveSid, {
          content: text,
          ...(queueAttachments.length > 0 ? { attachments: queueAttachments } : {}),
          ...(modelOverride?.model !== undefined ? { model: modelOverride.model } : {}),
          ...(modelOverride?.providerId !== undefined
            ? { providerId: modelOverride.providerId }
            : {}),
        });
        // Optimistic chip (the frame owns it normally; pushQueuedMessage
        // dedupes by seq so this never doubles).
        useStreamStore.getState().pushQueuedMessage(liveSid, {
          seq: queued.seq,
          content: text,
          ts: new Date().toISOString(),
          ...(queueAttachments.length > 0
            ? {
                attachments: queueAttachments.map((a) => ({
                  name: a.name,
                  ...(a.path !== undefined ? { path: a.path } : {}),
                  ...(a.size !== undefined ? { size: a.size } : {}),
                })),
              }
            : {}),
        });
        // Clear the local staged state exactly like a normal send (the
        // composer already dropped its chips + @ token; NO pendingEcho —
        // the chip IS the optimistic render for a queued message).
        setInput("");
        setSendError(null);
        setPendingEchoAttachments(null);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.code === "NO_LIVE_TURN") {
          // The turn ended mid-POST — the LOCAL reader usually learns a hair
          // later (the server closes the SSE when it ends the turn; the 409
          // round-trip beats the close event by milliseconds). startStream
          // refuses while streamBusy is still true and force-clearing would
          // abort a possibly-live reader, so WAIT BRIEFLY for the store to
          // settle, then fall through to the NORMAL send (the busy guard is
          // skipped: this closure captured busy before the stream ended).
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            if (useStreamStore.getState().bySession[liveSid]?.streamBusy !== true) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } else {
          // Any other failure (validation / auth / network) surfaces through
          // the existing send-error banner path.
          setSendError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
    } else if (busy) {
      // Legacy guard: busy without a queueable live stream (demo mode, a
      // create/send in flight, a stale closure) — the pre-R78 no-op stands.
      return;
    }
    setInput("");
    setLastSent(text);
    setPendingUser(text);
    setSendError(null);
    // ROUND-50 (R50-c2): staged chips ride the send (persisted on the
    // message.user event server-side) and display on the optimistic echo
    // until the refetched log takes over.
    const messageAttachments = composerAttachments.map(toMessageAttachment);
    setPendingEchoAttachments(
      messageAttachments.length > 0
        ? messageAttachments.map((a) => ({
            name: a.name,
            ...(a.path !== undefined ? { path: a.path } : {}),
            ...(a.size !== undefined ? { size: a.size } : {}),
          }))
        : null,
    );
    let sid = session?.id;
    try {
      if (!sid) {
        const created = await createSession.mutateAsync({
          mode: "single" as const,
          agentId: agent.id,
          projectId,
          title: project.name,
        });
        sid = created.id;
        // Round-30: the URL is the authoritative session selection — pin the
        // freshly created session so a later "New Session" elsewhere doesn't
        // steal this conversation mid-turn.
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("session", sid as string);
            return next;
          },
          { replace: true },
        );
        // ROUND-50: carry the composer choices made BEFORE the session
        // existed onto the fresh session — persist the per-session keys and
        // apply the picked permission mode (sessions are created "ask").
        saveModelOverride(sid, modelOverride);
        saveThinkingLevel(sid, thinkingLevel);
        if (permissionMode !== "ask") {
          try {
            await patchSessionPermissions(sid, permissionMode);
          } catch {
            // Non-fatal to the turn — the composer still shows the picked
            // mode; the next explicit change retries the PATCH.
          }
        }
      }
      if (liveMode) {
        // ROUND-39: the streaming fetch + state mutations live in the global
        // stream store so the session keeps streaming in the BACKGROUND when
        // the panel unmounts (project switch / settings nav). The store
        // handles the AbortController + every SSE event → liveTurn update;
        // we just await the stream's end and then invalidate queries.
        //
        // ROUND-67 (R67/E3): BEFORE the turn starts, declare which browser
        // tab THIS chat session drives — the active browser tab of this
        // session's right-sidebar slice (its sidecar session id), or null so
        // the browser_control tool mints its own agent tab. The binding is
        // what keeps sessions isolated: a new session can never inherit the
        // previous session's tab (the owner's leak report). Fire-and-forget
        // (the stream POST itself races ahead); a failed bind falls back to
        // the tool's own minting — honest, never fatal.
        try {
          const rs = useRightSidebarStore.getState();
          const sliceTabs = rs.byProject[stateKey(projectId, sid)]?.tabs ?? [];
          const activeBrowserTab =
            sliceTabs.find((t) => t.id === (rs.byProject[stateKey(projectId, sid)]?.activeTabId ?? null) && t.type === "browser") ??
            sliceTabs.find((t) => t.type === "browser") ??
            null;
          const browserSessionId =
            activeBrowserTab !== null
              ? useBrowserTabStore.getState().tabs[activeBrowserTab.id]?.sessionId ?? activeBrowserTab.id
              : null;
          void bindChatBrowserSession(sid, browserSessionId).catch(() => {
            // Best-effort: the tool mints its own tab when unbound.
          });
        } catch {
          // Store access must never break a turn.
        }
        useStreamStore.getState().setPendingEcho(sid, text);
        await useStreamStore.getState().startStream(sid, text, {
          model: effectiveModel ?? undefined,
          // ROUND-82: the override's provider — see effectiveProviderId.
          providerId: modelOverride?.providerId ?? undefined,
          // ROUND-65 (R65): scopes the agent-browser auto-open signal to
          // THIS project's right sidebar (review fix #2).
          projectId,
          // ROUND-50: the composer's per-send extras (R50-c1 threaded them
          // through streamSessionMessage's POST body).
          thinkingLevel,
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
        });
        // R89-B4: the turn actually ran with the EFFECTIVE pair — remember
        // it as the next chats' default (the owner's "remember the last
        // used model"; a no-override turn remembers the agent's own
        // provider+model, which is what was really used).
        if (
          effectiveModel !== null &&
          (modelOverride?.providerId ?? agent?.providerId) !== undefined &&
          (modelOverride?.providerId ?? agent?.providerId) !== null
        ) {
          saveLastUsedModel({
            model: effectiveModel,
            providerId: (modelOverride?.providerId ?? agent?.providerId) as string,
          });
        }
        // The store's startStream resolved — the stream ended (or errored).
        // Invalidate so the canonical folded turn renders from the event log.
        await queryClient.invalidateQueries({ queryKey: ["session"] });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        await queryClient.invalidateQueries({ queryKey: ["usage"] });
        void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
        // ROUND-50: the context donut refreshes with the new transcript.
        void queryClient.invalidateQueries({ queryKey: ["session-context"] });
        // ROUND-77 (R77, owner: "tried sending a message, but it was not
        // that successful"): a turn that failed WITHOUT a persisted
        // turn.error — pre-hijack rejections (validation / auth / 409 /
        // PROVIDER_DISABLED — none ever mint errorTs) — used to hit BOTH
        // wipes below (clearStream + setPendingEcho(null) + the finally's
        // setPendingUser(null)): the error card AND the user's message
        // bubble vanished together and the transcript looked like the send
        // never happened. Now the live error card + the optimistic echo
        // SURVIVE (freezeFailedTurn keeps them; the next send resets both
        // in startStream), so the owner sees exactly what the API said.
        const streamSlice = useStreamStore.getState().bySession[sid];
        const failedUnpersisted =
          streamSlice?.liveError != null && streamSlice.liveError.errorTs === undefined;
        if (!failedUnpersisted) {
          // The folded turn owns the render now; clear the store's echo.
          useStreamStore.getState().setPendingEcho(sid, null);
        }
        if (failedUnpersisted) {
          // Keep liveError + pendingEcho; freeze/drop the live turn by its
          // content; stop the sidebar animation (the turn is over).
          useStreamStore.getState().freezeFailedTurn(sid);
        } else {
          // ROUND-58 (R58-cf): a USER STOP clears the live turn TOO — unlike an
          // error, the backend FLUSHES the stopped turn's partial text, so the
          // refetched folded log carries it and the frozen live copy would
          // duplicate it. The stop signal is re-armed after the clear so the
          // Stopped card + Continue affordance persist until the next send.
          const liveSlice = useStreamStore.getState().bySession[sid];
          const wasUserStopped = liveSlice?.liveTurn?.stoppedByUser === true;
          if (liveSlice?.liveTurn && (!liveSlice.liveTurn.stopped || wasUserStopped)) {
            // The folded turn owns the render now; clear the live section.
            useStreamStore.getState().clearStream(sid);
            useActiveStreams.getState().stop(sid);
            if (wasUserStopped) {
              useStreamStore.getState().setLastTurnStoppedByUser(sid, true);
            }
          }
        }
      } else {
        // Fixture/demo mode: no sidecar → sync hook (canned reply).
        await sendMessage.mutateAsync({
          sessionId: sid,
          content: text,
          thinkingLevel,
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
        });
      }
    } catch (err) {
      // The stream may have errored client-side (network, CORS, abort) while
      // the backend actually completed the turn. Always re-fetch the session
      // so the canonical response appears even after a stream failure.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
      // ROUND-77 (R77, owner: error handling must "show the actual error
      // messages too, which were returned from the API"): the old
      // hasResponse-discard branch was VESTIGIAL — live-mode stream errors
      // stopped propagating into this catch in R39 (the stream store owns
      // them), so the only arrivals here are create-session failures and
      // demo-mode send failures, where the turn NEVER landed on the server.
      // Always surface the real ApiError message (the envelope's code +
      // message ride the thrown error from the request wrapper) — the
      // banner clears on the next send.
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      // Drop the optimistic local echo — EXCEPT when the live failure path
      // above kept it on purpose (failedUnpersisted keeps the store's
      // pendingEcho; this local pendingUser is the demo-mode echo and only
      // survives when its session query has no cached response to fold
      // from). For live mode the store's echo owns the bubble; for demo
      // mode a failed send leaves no folded record either, so keep the
      // local echo visible under the banner (the R77 vanish fix).
      const liveKeptEcho =
        liveMode && typeof sid === "string"
          ? (useStreamStore.getState().bySession[sid]?.pendingEcho ?? null) !== null
          : false;
      if (!liveKeptEcho) setPendingUser(null);
      setPendingEchoAttachments(null);
    }
  };

  const onApprovalDecision = async (
    approvalId: string,
    decision: ApprovalDecisionChoice,
    remember: ApprovalRemember,
  ) => {
    try {
      await decideApproval(approvalId, { decision, remember });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  // ROUND-87 (R87): resolve a pending ask_user card — the answers POST to
  // /agent-questions/:id/resolve and the tool's pending promise settles;
  // the agent-question.resolved SSE frame patches the card to its answered
  // state (a failed POST surfaces the honest error; a 404 means the ask
  // already timed out — the frame/refetch will show it).
  const onQuestionAnswer = async (
    questionId: string,
    answers: string[],
    sources: Array<"option" | "custom">,
  ) => {
    try {
      await resolveAgentQuestion(questionId, answers, sources);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── ROUND-78 (R78-D): the queued chips' affordances (live mode only —
  // fixture mode never queues: onQueue is undefined there) ────────────────
  /** The chip's X: optimistically remove the chip from the live store, then
   * DELETE the queued event server-side. A failed DELETE toasts honestly
   * (the refetch re-syncs — a 404 means it was already delivered/removed,
   * which is success in every way that matters). */
  const removeQueuedMessage = async (seq: number): Promise<void> => {
    if (activeSessionId === null) return;
    useStreamStore.getState().removeQueuedMessage(activeSessionId, seq);
    try {
      await dequeueSessionMessage(activeSessionId, seq);
      // The folded log still carries the message.queued event until the next
      // refetch — invalidate so the chip disappears from the fold too.
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      pushLocalToast(
        "Could not remove the queued message",
        err instanceof Error ? err.message : String(err),
        "task_failed",
      );
    }
  };

  /** The chip's "Send now" (only rendered while !busy): dequeue the event
   * (so it never double-delivers at the next turn), then run the content
   * through the NORMAL send path — the user decided not to wait. A failed
   * dequeue (404 = already gone) never blocks the send: the message goes
   * out either way. */
  const sendQueuedNow = async (entry: QueuedMessage): Promise<void> => {
    if (activeSessionId === null || busy) return;
    useStreamStore.getState().removeQueuedMessage(activeSessionId, entry.seq);
    try {
      await dequeueSessionMessage(activeSessionId, entry.seq);
    } catch {
      // Already delivered/removed server-side — the normal send below still
      // fires; the refetch reconciles the transcript.
    }
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    await runTurn(entry.content, []);
  };

  // ── ROUND-43: error-card retry plumbing ─────────────────────────────────
  // Retry re-sends the FAILED turn's user message as a new turn through the
  // normal send path (runTurn). The text resolves from the folded log via
  // the error item's userSeq; the last user bubble is the fallback.
  const lastUserContent = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") return it.content;
    }
    return pendingEcho ?? lastSent ?? "";
  })();
  const retryTextForError = (item: ErrorTurnItem): string => {
    if (item.userSeq !== undefined) {
      const bySeq = items.find((it) => it.kind === "user" && it.seq === item.userSeq);
      if (bySeq !== undefined && bySeq.kind === "user") return bySeq.content;
    }
    return lastUserContent;
  };
  // The LIVE error card hides the moment the folded log carries the SAME
  // persisted turn.error (matched by the backend-minted errorTs) — no flash,
  // no duplicate, and the card survives reloads via the event log.
  const liveErrorSuperseded =
    liveError?.errorTs !== undefined &&
    items.some((it) => it.kind === "error" && it.ts === liveError.errorTs);

  // ── ROUND-44 (R44-c): revert-to-message confirm flow ───────────────────
  // ROUND-77 (R77, owner: "when I click on the revert option on any one of
  // the chats, it should revert to that session, and that message which was
  // on that should be pasted in the message area. That message should be
  // deleted from the chat itself with the agent"): the rewind now REMOVES
  // the target message (backend: seq >= target), and the ConfirmDialog body
  // quotes the first ~60 chars so the owner sees EXACTLY which message
  // returns to the composer.
  const revertSnippet = (() => {
    if (revertTarget === null) return "";
    const content = revertTarget.content;
    return content.length > 60 ? `${content.slice(0, 60)}…` : content;
  })();
  const onRevertConfirm = async (): Promise<void> => {
    if (revertTarget === null || activeSessionId === null) return;
    if (revertSessionMutation.isPending) return; // double-click guard
    const target = revertTarget;
    try {
      const result = await revertSessionMutation.mutateAsync({
        sessionId: activeSessionId,
        keepThroughSeq: target.seq,
      });
      // R77: the reverted message's text RETURNS TO THE COMPOSER — set it
      // BEFORE awaiting the invalidations so the text is in place the
      // moment the truncated transcript re-renders (the item vanishes from
      // `items` on the refetch — `target` is the snapshot that survives).
      // The send-clear (runTurn) and the session-switch reset are the only
      // things that wipe it, exactly like a hand-typed draft.
      setInput(target.content);
      requestAnimationFrame(() => inputRef.current?.focus());
      // The hook's onSettled invalidates the exact session keys; these
      // prefix-wide invalidations mirror the send path so the folded log +
      // sidebar refresh before the toast lands.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pushLocalToast(
        "Reverted",
        `Removed ${result.removedCount} event${result.removedCount === 1 ? "" : "s"} — the message is back in the composer for editing.`,
      );
    } catch (err) {
      // 409 CONFLICT (running session) / 404 (deleted elsewhere) — surface as
      // a persistent toast; the sendError banner requires a lastSent draft
      // and may not be visible here.
      pushLocalToast(
        "Revert failed",
        err instanceof Error ? err.message : String(err),
        "task_failed",
      );
    } finally {
      setRevertTarget(null);
    }
  };

  // ── ROUND-50 (R50-c2): composer placement + props ─────────────────────────
  // Empty transcript (no items, no optimistic echo) → the composer renders
  // centered INSIDE the scroll column, pushed below the middle; otherwise it
  // docks at the panel's bottom edge.
  const composerDocked = items.length > 0 || pendingEcho !== null;
  // ROUND-58 (R58-cf): the deliberate-stop grace timer. abortStream asks the
  // SIDECAR to resolve the turn and normally the {type:"stopped"} frame ends
  // the stream cleanly; if the server never answers, this fires ~2.5s later
  // and hard-aborts the LOCAL controller (the store's catch then classifies
  // the abort as a stop via the armed flag — never NETWORK_ERROR).
  // useTimeoutClear owns the handle (the R57-a no-bare-setTimeout rule); the
  // delayed hard abort is a NO-OP once the stream ended (the controller map
  // entry is gone) or a new turn replaced the stopped one.
  const stopGraceTimer = useTimeoutClear();
  const renderComposer = (autoFocus: boolean): ReactNode => (
    <Composer
      agent={agent}
      projectId={projectId}
      sessionId={activeSessionId}
      liveMode={liveMode}
      input={input}
      onInputChange={setInput}
      busy={busy}
      onSend={(content, attachments) => void runTurn(content, attachments)}
      // ROUND-78 (R78-D): the queue-send wire — LIVE MODE ONLY (fixture mode
      // omits it so the composer keeps the legacy busy behavior: Stop only,
      // Enter a no-op). The composer calls this while busy; runTurn itself
      // decides queue-vs-send at the top (busy + liveMode + streamBusy →
      // POST /sessions/:id/queue; a NO_LIVE_TURN 409 falls back to a normal
      // send — the turn just ended).
      onQueue={
        liveMode ? (content, attachments) => void runTurn(content, attachments) : undefined
      }
      // ROUND-58 (R58-cf): the Continue affordance — only after the last turn
      // ended via user stop (the backend persisted the partial + tool
      // results, so a follow-up message resumes the response).
      showContinue={lastTurnStoppedByUser && !busy}
      onStop={() => {
        // ROUND-39: stop routes through the stream store so it works
        // regardless of which panel is mounted (background sessions can be
        // stopped from their sidebar row, too).
        if (activeSessionId !== null) {
          useStreamStore.getState().abortStream(activeSessionId);
          // ROUND-58 (R58-cf): the grace net (see the comment above).
          stopGraceTimer(() => {
            useStreamStore.getState().hardAbortStream(activeSessionId);
          }, 2500);
        }
      }}
      permissionMode={permissionMode}
      onModeChange={(m) => void onModeChange(m)}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={onThinkingLevelChange}
      modelOverride={modelOverride}
      onModelChange={onModelChange}
      transcriptLength={items.length}
      liveTick={liveWorkingCount}
      // R113-b: a REMOTE turn streams too — the context donut live-polls
      // (streaming → zero staleTime + live refetch) exactly like an own
      // turn, so the meter tracks the phone's turn as it grows.
      streaming={streamBusy || remoteRunning}
      autoFocus={autoFocus}
      inputRef={inputRef}
    />
  );

  // ── Live-turn rendering (same shape as the folded AssistantTurn) ──────────
  // ROUND-64 (R64-c): the live turn SEGMENTS its working entries exactly like
  // the folded AssistantTurn (segmentWorkingEntries) — intermediate assistant
  // text entries render as always-visible markdown answer blocks between the
  // work sections (the stream-store flushes streamText into working entries
  // whenever a tool call lands), so nothing vanishes when the section
  // auto-collapses on completion and the live/folded handoff is seamless.
  // The LIVE streaming answer text still renders at the BOTTOM with the
  // caret, exactly as before.
  const liveSection = (() => {
    if (liveTurn === null) return null;
    const entries: WorkingEntry[] = [
      ...liveTurn.working,
      ...(liveTurn.streamThinking.trim() !== ""
        ? [{ type: "thinking" as const, text: liveTurn.streamThinking, ts: new Date().toISOString() }]
        : []),
    ];
    // ROUND-58 (R58-cf): an in-flight tool-arg write (tool-input-start frame
    // landed, no ToolUseEntry yet) counts as tool work — the section renders
    // (with its pending write row + live preview) instead of the bare
    // thoughts-only shape.
    const hasPendingWriteInput = liveTurn.streamingToolInputs.some((s) =>
      DIFF_TOOLS.has(s.toolName),
    );
    const liveEntryIdx = liveTurn.streamThinking.trim() !== "" ? entries.length - 1 : undefined;
    const segments = segmentWorkingEntries(entries);
    // ROUND-58 (R58-cf): the pending-write rows (live file-write previews)
    // render INSIDE a live WorkingSection — when no tool entry exists yet but
    // a write's args are streaming, the LAST work segment (or an empty
    // trailing section when the turn ends on flushed text) hosts them, so
    // the owner still sees the file being written the moment it starts.
    const lastWorkSegIdx = segments.map((s) => s.kind === "work").lastIndexOf(true);
    const rendered = segments.map((seg, i) => {
      if (seg.kind === "text") {
        return (
          <IntermediateAnswer
            key={`live-seg-text-${i}`}
            content={seg.content}
            projectId={projectId}
          />
        );
      }
      // ROUND-68 (R68-A): defensive — a capture can only exist after the tool
      // row that took it, but a screenshot-carrying segment must still
      // render as a WorkingSection (the inline rows need the section's
      // column flow), never as a bare block.
      const isWork =
        seg.entries.some((e) => e.type === "tool") ||
        seg.entries.some((e) => e.type === "screenshot") ||
        (hasPendingWriteInput && i === lastWorkSegIdx) ||
        // ROUND-96 (R96-E, owner: "the thinking was still not proper. It was
        // not auto-scrolling to the very bottom"): the segment carrying the
        // STILL-STREAMING thought renders as a LIVE WorkingSection too —
        // before, a thinking-first segment (no tool entries YET — the norm
        // at every turn's start) fell to BareWorkingEntries, which never
        // passes `live` down: no auto-expand, no stick-to-bottom, no jump
        // pill. The thought's own section header reads "Working", exactly
        // like any live work.
        (liveEntryIdx !== undefined && liveEntryIdx >= seg.firstIndex && liveEntryIdx <= seg.lastIndex);
      if (isWork) {
        // liveEntryIndex is an index into the FULL entries array — translate
        // it into this segment's own coordinates (only the segment that
        // actually contains the still-streaming thought marks it live).
        const segLiveIdx =
          liveEntryIdx !== undefined && liveEntryIdx >= seg.firstIndex && liveEntryIdx <= seg.lastIndex
            ? liveEntryIdx - seg.firstIndex
            : undefined;
        return (
          <WorkingSection
            key={`live-seg-work-${i}`}
            entries={seg.entries}
            sessionId={session?.id ?? null}
            projectId={projectId}
            live
            startedAtMs={liveTurn.startedAtMs}
            stopped={liveTurn.stopped}
            liveEntryIndex={segLiveIdx}
            onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
            onQuestionAnswer={(id, answers, sources) => void onQuestionAnswer(id, answers, sources)}
          />
        );
      }
      return (
        <BareWorkingEntries
          key={`live-seg-bare-${i}`}
          entries={seg.entries}
          onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
        />
      );
    });
    if (hasPendingWriteInput && (segments.length === 0 || segments[segments.length - 1].kind === "text")) {
      rendered.push(
        <WorkingSection
          key="live-seg-write-tail"
          entries={[]}
          sessionId={session?.id ?? null}
          projectId={projectId}
          live
          startedAtMs={liveTurn.startedAtMs}
          stopped={liveTurn.stopped}
          onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
        />,
      );
    }
    return rendered;
  })();

  // R101-D: the timeline spine renders ONLY when the transcript has content —
  // the greeting/skeleton/load-error empty states carry no timeline (an empty
  // chat is a welcome, not a line of dots). Every source of a railed row
  // counts: folded items, the optimistic echo, delivered-queued bubbles, the
  // live turn, and the live error card.
  const hasTimelineContent =
    items.length > 0 ||
    pendingEcho !== null ||
    deliveredQueued.length > 0 ||
    liveTurn !== null ||
    (liveError !== null && !liveErrorSuperseded);

  return (
    <div
      className="flex flex-col h-full w-full min-w-0 rounded-2xl overflow-hidden @container"
      style={{ backgroundColor: styles.card }}
    >
      {/* ⌘K / Ctrl+K CommandPalette (files/symbols/content search — WS-H) */}
      <CommandPalette
        projectId={projectId}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPickFile={(path) => {
          // ROUND-38: open picked files in the right sidebar's Files tab.
          useRightSidebarStore.getState().openFile(projectId, path);
          setPaletteOpen(false);
        }}
      />
      {/* ROUND-44 (R44-c): revert confirmation — destructive log truncation.
          R77 copy: the target message itself is removed and RETURNS to the
          composer for editing (the owner's edit-and-resend flow). */}
      <ConfirmDialog
        open={revertTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevertTarget(null);
        }}
        title="Revert session?"
        body={`Rewinds to before “${revertSnippet}” — removes that message and its reply from the chat, and puts the message text back in the composer for editing. This cannot be undone.`}
        confirmLabel="Revert"
        onConfirm={() => void onRevertConfirm()}
      />
      {/* Scroll body with top fade (demo structure) */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* R88 (owner: "it will show at the top-right corner of the chat
            window, and it will be a floating view"): the FLOATING TODO
            WIDGET — collapsed = the task at hand, one click = the full list
            (10 rows visible, scroll for more), the pencil = the manual edit
            whose saved snapshot the agent's next turn sees in its CURRENT
            TODO LIST prompt section. Sits above the top fade (z-20) and is
            position:fixed relative to THIS container — the transcript
            scrolls under it. */}
        <TodoFloat sessionId={activeSessionId} />
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10 pointer-events-none"
          style={{ background: `linear-gradient(to bottom, ${styles.card}, transparent)` }}
        />
        {/* ROUND-43 (owner: bottom horizontal scrollbar + right-side dead
            space): overflow-x is now EXPLICITLY hidden — `overflow-y-auto`
            alone COMPUTES to overflow-x:auto, so any wide token used to mint a
            horizontal scrollbar at the bottom of the chat. Long tokens now
            wrap at the text level (break-words below); code blocks keep their
            OWN internal pre scroll. */}
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden auto-scroll">
          {/* ROUND-34: density (settings appearance) drives the column's
              VERTICAL rhythm. ROUND-37: the panel fills its width (owner: no
              dead right side). ROUND-39: wrapper is min-h-full + flex-col so
              SHORT content sticks to the bottom (just above the composer) —
              no dead vertical gap below the last message (owner screenshot
              showed big empty space). When content overflows, the spacer
              collapses to 0 and natural scroll takes over.
              ROUND-43 (owner: dead space on the right at LARGE windows): the
              panel root now fills its column (w-full above) AND the reading
              column caps at CONTENT_MAX_WIDTH centered — wide windows get a
              symmetric readable column instead of either stretched lines or
              content-hugging with a void on the right.
              R87-A1: horizontal padding lives IN CONTENT_COL_CLASS now
              (graduated px-6/md:px-12/xl:px-16 — see its doc note), so the
              density classes here carry py only.
              R101-D: the wrapper is `relative` and hosts the TIMELINE SPINE —
              one continuous hairline behind every item's rail column (see
              TimelineSpine; rendered only while the transcript has content). */}
          <div
            className={`${density === "compact" ? "py-4" : "py-5"} ${CONTENT_COL_CLASS} relative min-h-full flex flex-col gap-5`}
            style={
              {
                "--ac-chat-scale": chatTextSize === "small" ? "0.92" : chatTextSize === "large" ? "1.12" : "1",
              } as React.CSSProperties
            }
            data-chat-size={chatTextSize}
          >
            {/* R101-D: the timeline spine — FIRST child so every rail dot
                paints above it (the punch-out rings terminate the line AT
                each node). aria-hidden decoration; never with an empty
                transcript. */}
            {hasTimelineContent ? <TimelineSpine /> : null}
            {/* ROUND-50 (R50-c2, owner: "When there is nothing, the very first
                chat… almost centered but a bit more towards the bottom half of
                the screen"): the greeting + suggestion chips sit ABOVE the
                composer; the composer is centered horizontally and pushed
                below the vertical middle by the 45/55 flex spacers (it
                reflows with the pane — never absolutely positioned); the
                bottom spacer keeps filling so there is no dead gap below.
                R97-I (owner: "aware of its states"): the greeting is now the
                THIRD state, not the only one — while the log loads a
                chat-shaped skeleton holds the column, and a fetch failure
                renders the retryable error card. The false greeting on a
                project WITH history (then the messages popping in over it)
                is dead. */}
            {items.length === 0 && !pendingEcho ? (
              chatHistoryLoading ? (
                <div
                  className="flex-1 min-h-0 flex flex-col justify-end pb-6"
                  role="status"
                  aria-label="Loading conversation"
                  data-transcript-skeleton
                >
                  <TranscriptSkeleton />
                </div>
              ) : chatHistoryError ? (
                <div className="flex-1 min-h-0 grid place-items-center">
                  <ChatLoadErrorCard onRetry={retryChatLoad} />
                </div>
              ) : (
              <div
                data-empty-state
                className="flex-1 min-h-0 flex flex-col items-center text-center"
              >
                <div className="flex-[0.45] min-h-8" aria-hidden />
                <div className="flex flex-col items-center gap-4">
                  <AcuteLogo size={52} ariaLabel="Acute" />
                  <div className="min-w-0 max-w-md">
                    {/* R100-D (ladder): the greeting title snaps to the `title`
                        tier — 24px/600 (font-black is wizard-only; §C4.7's one
                        borrowed wizard element stays unused — no dot-grid, no
                        glow: the greeting stays clean). */}
                    <div className="text-[24px] font-semibold leading-[1.2]" style={{ color: styles.text }}>
                      How can I help with {project.name}?
                    </div>
                    <div className="text-[13px] mt-2 leading-relaxed" style={{ color: styles.textSecondary }}>
                      {agent?.name ?? "Acute"} · {agent?.model ?? "no model"} · streaming replies with live tool calls
                    </div>
                    {agents.length === 0 && !agentsQuery.isPending && !agentsQuery.isError ? (
                      <div className="text-[12px] mt-3" style={{ color: styles.textSecondary }}>
                        Create an agent in{" "}
                        <Link to="/settings" style={{ color: styles.accent }}>
                          Settings
                        </Link>{" "}
                        first
                      </div>
                    ) : null}
                  </div>
                  {agents.length > 0 ? (
                    <div className="flex flex-wrap items-center justify-center gap-2 max-w-lg">
                      {/* R99-B (the empty-state anatomy): the suggestions are
                          PILL-CARDS — 1.5px border-line, 12px inner-control
                          radius, icon + label — with the hover on the CSS-var
                          leg (hover:border-accent + hover:bg-accent-soft +
                          hover:text-ink), retiring the row's old JS hover
                          handlers (the TOKENS §1 rule-4 preference). Real
                          buttons; click fills the composer exactly as before. */}
                      {SUGGESTIONS.map((s) => (
                        <button
                          key={s.label}
                          data-testid="suggestion-card"
                          onClick={() => {
                            setInput(s.prompt);
                            inputRef.current?.focus();
                          }}
                          className="flex items-center gap-2 h-9 px-3.5 rounded-xl border-[1.5px] border-line bg-bg text-muted text-[12px] font-medium transition-colors duration-150 hover:border-accent hover:bg-accent-soft hover:text-ink active:scale-95"
                        >
                          <s.icon size={12} className="shrink-0 text-accent" aria-hidden />
                          {s.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="h-6 shrink-0" aria-hidden />
                {/* The composer itself — centered, slightly below the middle.
                    R87-A1: the wrapper above already carries the padded
                    content column, so this nested slot uses the PADLESS
                    variant — same cap/centering, no double horizontal inset. */}
                <div className={CONTENT_COL_PADLESS_CLASS}>{renderComposer(true)}</div>
                <div className="flex-[0.55] min-h-8" aria-hidden />
              </div>
              )
            ) : null}

            {/* ROUND-39: top spacer grows when content is short, pushing
                messages down to the composer (no dead gap below). Collapses
                to 0 when content overflows the viewport. */}
            {(items.length > 0 || pendingEcho !== null) && (
              <div className="flex-1 min-h-0" aria-hidden />
            )}

            <AnimatePresence mode="popLayout">
              {items.map((item) => {
                // R78: a folded queued chip whose seq is still LIVE-rendered
                // (a window-focus refetch raced the running stream) — skip it
                // here; the live queue's chip with the same seq owns the
                // render until the stream ends (never a double chip).
                if (item.kind === "queued" && liveQueued.some((q) => q.seq === item.seq)) {
                  return null;
                }
                return (
                  <MessageRenderer
                    key={itemKey(item)}
                    item={item}
                    sessionId={session?.id ?? null}
                    projectId={projectId}
                    collapseHint={Date.now() - lastLiveEndRef.current < 5000}
                    // ROUND-67 (R67-B): the debug-gated full-turn copy rides
                    // every assistant turn's footer.
                    debugMode={debugMode}
                    {...(item.kind === "error"
                      ? {
                          onRetry: () => void runTurn(retryTextForError(item)),
                          retryDisabled: busy,
                        }
                      : {})}
                    // ROUND-44 (R44-c): persisted user bubbles (seq >= 0, session
                    // bound) can rewind the log; the button is disabled while a
                    // turn streams (busy = streamBusy | send | create | echo).
                    {...(item.kind === "user" && item.seq >= 0 && activeSessionId !== null
                      ? {
                          onRevert: () => setRevertTarget(item),
                          revertDisabled: busy,
                        }
                      : {})}
                    // ROUND-78 (R78-D): FOLDED queued chips (message.queued
                    // events from the refetch — the stream has ended or the
                    // panel remounted). The SAME chip component the live area
                    // renders, with the panel-bound affordances.
                    {...(item.kind === "queued" && liveMode && activeSessionId !== null
                      ? {
                          queuedBusy: busy,
                          onQueuedRemove: (seq) => void removeQueuedMessage(seq),
                          onQueuedSendNow: (entry) => void sendQueuedNow(entry),
                        }
                      : {})}
                  />
                );
              })}
              {pendingEcho !== null ? (
                <MessageRenderer
                  item={{ kind: "user", seq: -1, content: pendingEcho, ts: new Date().toISOString() }}
                  sessionId={null}
                  projectId={projectId}
                  {...(pendingEchoAttachments !== null ? { attachments: pendingEchoAttachments } : {})}
                />
              ) : null}
            </AnimatePresence>

            {/* ── ROUND-78 (R78-D): queued messages DELIVERED mid-stream — the
                loop-top flip landed (the event row is message.user now) but
                the refetch hasn't folded it yet: render the ordinary user
                bubble from the frame's content+ts, with the pendingEcho dedup
                trick (once the folded log carries the same content, the live
                copy drops out — no double bubble). ── */}
            {deliveredQueued
              .filter((d) => !items.some((it) => it.kind === "user" && it.content === d.content))
              .map((d) => (
                <MessageRenderer
                  key={`delivered-q-${d.seq}`}
                  item={{ kind: "user", seq: -1, content: d.content, ts: d.ts }}
                  sessionId={null}
                  projectId={projectId}
                />
              ))}

            {/* ── ROUND-114 (R114-e, owner: "after sending from mobile, the PC
                send button status does not change; no processing/thinking
                status"): the REMOTE turn's user bubble. turn.started opened
                the mirror carrying the phone's message text
                (liveTurn.userText — the store never sets it on an OWN turn,
                where the optimistic pendingEcho already rendered the
                identical bubble), so the message is visible the INSTANT the
                frame lands instead of after the debounced folded-log
                refetch. Same content-dedupe trick as pendingEcho/delivered:
                the moment the refetched event log carries the persisted
                message.user row, this live copy drops out — never a double
                bubble. ── */}
            {remoteRunning &&
            liveTurn?.userText !== undefined &&
            liveTurn.userText !== "" &&
            !items.some((it) => it.kind === "user" && it.content === liveTurn.userText) ? (
              <MessageRenderer
                key="remote-turn-user"
                item={{
                  kind: "user",
                  seq: -1,
                  content: liveTurn.userText,
                  ts: new Date(liveTurn.startedAtMs).toISOString(),
                }}
                sessionId={null}
                projectId={projectId}
              />
            ) : null}

            {/* ── ROUND-37 LIVE TURN: the Working section grows above the
                streaming presumptive-final text (which flows into the
                timeline as a full answer block the moment a tool lands —
                ROUND-64 R64-c segmentation). ── */}
            {liveTurn !== null ? (
              // R101-D: the LIVE turn rides the SAME rail grid as the folded
              // items — without it the streaming block would start at the
              // reading column's left edge (40px wider than every other row)
              // and the spine would slice through its cards. The node is the
              // assistant-turn dot (hollow accent) pinned to the turn's
              // wall-clock start, so the live→folded handoff keeps the exact
              // same dot + column (header → header, node → node).
              <div className={TIMELINE_ITEM_CLASS}>
                <TimelineNode kind="turn" ts={new Date(liveTurn.startedAtMs).toISOString()} />
                <div aria-live="polite" aria-atomic="false" className="group min-w-0">
                {/* ROUND-68 (R68-A): the R67-D screenshot THUMBNAIL strip that
                    rendered here is GONE — captures now ride INSIDE liveSection
                    as `screenshot` WorkingEntry rows, rendered by WorkingSection
                    at their capture moment (the owner: "When the screenshots
                    were taken they should be shown at that specific time."). */}
                {/* ROUND-75 (R75): the transient-API retry wait — the ladder
                    card sits ABOVE everything (the owner should always see
                    WHY the stream is quiet and that it is handling itself). */}
                {liveTurn.retry !== null ? (
                  <div className="mb-2 min-w-0">
                    <RetryStatusCard retry={liveTurn.retry} />
                  </div>
                ) : null}
                {/* ROUND-75 (R75): the R71 overflow-recovery line, finally
                    visible (previously an untyped fall-through frame). */}
                {liveTurn.note !== null ? (
                  <div
                    className="mb-2 min-w-0 text-[12px] font-mono px-3 py-1.5 rounded-lg border"
                    style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.35), color: styles.textSecondary, background: withAlpha(SEMANTIC_COLORS.warning, 0.05) }}
                  >
                    {liveTurn.note}
                  </div>
                ) : null}
                {/* R99-B: the LIVE turn's header — the same identity row the
                    folded turn renders (the live→folded handoff is seamless:
                    header → header). R114-e: the model is the turn.started
                    frame's RESOLVED one first (the three-tier ladder's
                    verdict — identical on the own path and the phone-started
                    mirror; absent on an older sidecar, where the panel's
                    EFFECTIVE pick stays the fallback, exactly the pre-R114
                    label); the timestamp is the turn's wall-clock start. */}
                <AssistantTurnHeader
                  model={liveTurn.model ?? effectiveModel ?? undefined}
                  ts={new Date(liveTurn.startedAtMs).toISOString()}
                />
                {liveSection}
                {/* ── ROUND-78 (R78-D): the QUEUED chips — below the working
                    section (the messages wait BEHIND the current work), above
                    the streaming answer. Live-store entries only here — the
                    stream is OPEN, so the LIVE chip owns the render even when
                    a window-focus refetch already folded the same seq into
                    `items` (the items loop skips a folded queued chip whose
                    seq is live-rendered — exactly ONE chip, never two, and
                    never the zero-chip hole the mutual-skip would leave). The
                    stream-end finally clears the live array, and the folded
                    log's `queued` items take over in the items loop above. ── */}
                {liveQueued.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-2 min-w-0" data-queued-live-list>
                    {liveQueued.map((q) => (
                      <QueuedMessageChip
                        key={`live-q-${q.seq}`}
                        entry={q}
                        busy={busy}
                        onRemove={
                          liveMode && activeSessionId !== null
                            ? () => void removeQueuedMessage(q.seq)
                            : undefined
                        }
                        onSendNow={
                          liveMode && activeSessionId !== null
                            ? () => void sendQueuedNow(q)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                ) : null}
                {/* ROUND-66 (R66, A4): the human-verification checkpoint — the
                    browser tool hit a bot wall and is WAITING for the owner.
                    Rendered ABOVE the streaming text (the agent is paused;
                    this card is the thing that needs the owner's eyes) with
                    the live countdown + Mark as done / Stop waiting. */}
                {liveTurn.browserCheckpoint !== null ? (
                  <div className="mb-2 min-w-0">
                    <BrowserCheckpointCard checkpoint={liveTurn.browserCheckpoint} />
                  </div>
                ) : null}
                {liveTurn.streamText !== "" ? (
                  <div
                    className={`chat-prose min-w-0 break-words text-[13px] leading-[1.65] ${liveTurn.working.length > 0 ? "mt-2" : ""}`}
                    style={{ color: styles.text, ["--chat-base-size" as string]: "13px" } as React.CSSProperties}
                  >
                    {/* ROUND-64 (R64-c): ChatMarkdown — the LIVE answer also
                        renders full markdown; partial markdown mid-stream is
                        fine (the parser is line-based, so the text renders
                        line-by-line as it arrives). */}
                    <ChatMarkdown content={liveTurn.streamText} projectId={projectId} />
                    {/* R113-b: the caret pulses for REMOTE turns too — a
                        mirror in flight is just as "generating" as an own
                        stream (remoteRunning already implies !stopped). */}
                    {(streamBusy || remoteRunning) && !liveTurn.stopped ? (
                      /* R99-B: the thin streaming caret — a 2px accent bar,
                         ~1em tall, breathing 1s ease opacity 1↔0.4
                         (ac-caret-pulse — the MOTION registry's stream-caret
                         slot). Removed the moment the stream completes or
                         stops: the settled answer keeps plain text. */
                      <span
                        data-testid="streaming-caret"
                        className="inline-block w-[2px] h-[1em] ml-0.5 align-middle ac-caret-pulse"
                        style={{ background: styles.accent }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                ) : liveTurn.streamThinking.trim() === "" && liveTurn.working.length === 0 ? (
                  <span className="text-[12px] font-mono" style={{ color: styles.textSecondary }}>
                    Thinking<span className="ac-ellipsis" aria-hidden />
                  </span>
                ) : null}
                {/* ROUND-59 (R59-D): the live turn's rating key lands with the
                    done frame (LiveTurn.lastAssistantSeq) — the SAME footer
                    component renders, so a live-completed turn can be rated
                    immediately, before the refetched folded log takes over
                    (the key is identical: the turn's last non-empty assistant
                    text seq, so the optimistic verdict carries over). While
                    the turn is still in flight there is no key → no cluster. */}
                {liveTurn.lastAssistantSeq !== undefined && !streamBusy ? (
                  <TurnFooter
                    sessionId={session?.id ?? null}
                    assistantSeq={liveTurn.lastAssistantSeq}
                    copyText={liveTurn.streamText}
                    fullCopyText={
                      // ROUND-67 (R67-B): the live-completed turn gets the
                      // same second copy option. R114-e: the model is the
                      // turn.started frame's RESOLVED one first
                      // (LiveTurn.model — honest for a REMOTE mirror too,
                      // where the phone's send carried a model this
                      // composer never picked), the panel's effective pick
                      // as the fallback (an older sidecar never sent the
                      // frame; the refetched folded turn carries the
                      // authoritative event-log model either way). Duration
                      // is measured from the live turn's clock.
                      debugMode
                        ? buildFullTurnText({
                            working: liveTurn.working,
                            finalText: liveTurn.streamText,
                            model: liveTurn.model ?? effectiveModel ?? undefined,
                            ms: Date.now() - liveTurn.startedAtMs,
                          })
                        : undefined
                    }
                  />
                ) : null}
                {/* ROUND-66 (R66, C1): the LIVE debug-report section — the
                    turn's answer is complete (the analyst runs AFTER the
                    outcome, BEFORE the done frame) and the context-free
                    analyst is streaming below it: spinner while it starts,
                    live markdown while it streams. The refetch folds it into
                    AssistantTurnItem.debugReport when done lands. */}
                {liveTurn.debugReport !== null ? (
                  <div className="mt-2 min-w-0">
                    <DebugReportCard report={liveTurn.debugReport} projectId={projectId} />
                  </div>
                ) : null}
                </div>
              </div>
            ) : null}

            {/* ── ROUND-58 (R58-cf): the deliberate user stop — a QUIET status
                card (never TurnErrorCard, no red): the partial above stays
                visible, the backend flushed the persisted partial on stop,
                and the composer grew a Continue affordance. Hidden while a
                new turn streams (startStream resets the signal). ── */}
            {lastTurnStoppedByUser && !streamBusy && lastTurnStoppedTs !== null ? (
              // R101-D: live-only status chrome — aligned to the timeline
              // COLUMN (no node of its own; the spine passes beside it).
              <div className={TIMELINE_INDENT_CLASS}>
                <TurnStoppedCard ts={lastTurnStoppedTs} />
              </div>
            ) : null}

            {/* ── ROUND-43: LIVE error card — the stream failed. Rendered
                immediately (before the refetch lands); the persisted
                turn.error item takes over once the folded log carries it
                (errorTs match above). User stops never set liveError.
                R97-D: the thinking_loop class renders the AMBER
                ThinkingStoppedCard instead (never "generation failed"). ── */}
            {liveError !== null && !liveErrorSuperseded ? (
              // R101-D: the live error rides the SAME rail + error node as the
              // folded turn.error item that replaces it on refetch — the swap
              // is seamless (same column, same dot) instead of a 40px jump.
              <div className={TIMELINE_ITEM_CLASS}>
                <TimelineNode kind="error" ts={liveError.ts} />
                {liveError.errorClass === "thinking_loop" ? (
                  <ThinkingStoppedCard
                    error={liveError}
                    onRetry={() => void runTurn(lastUserContent)}
                    disabled={busy}
                  />
                ) : (
                  <TurnErrorCard
                    error={liveError}
                    sessionId={activeSessionId}
                    onRetry={() => void runTurn(lastUserContent)}
                    disabled={busy}
                  />
                )}
              </div>
            ) : null}

            {/* ── R93-B1: the KEPT-QUEUE notice — the stream ended with
                messages still queued (the continuation cap's honest break,
                or a failure the recovery could not save). A calm amber
                strip, never a silent strand: the messages ARE safe, they
                pre-flip into the next send's history. Cleared by the next
                startStream. ── */}
            {queueKeptNotice !== null && queueKeptNotice > 0 && !streamBusy ? (
              <div
                data-testid="queue-kept-notice"
                // R101-D: live-only notice chrome — aligned to the timeline
                // COLUMN like TurnStoppedCard (no node; the spine passes
                // beside it).
                className={`${TIMELINE_INDENT_CLASS} mt-2 rounded-xl border px-3 py-2 text-[12px] font-semibold flex items-center gap-2`}
                style={{
                  borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.35),
                  background: withAlpha(SEMANTIC_COLORS.warning, styles.isDark ? 0.08 : 0.05),
                  color: SEMANTIC_COLORS.warning,
                }}
              >
                <Clock size={13} className="shrink-0" aria-hidden />
                {queueKeptNotice} message{queueKeptNotice === 1 ? "" : "s"} stayed queued — they&apos;ll send
                with your next message
              </div>
            ) : null}
          </div>
        </div>

        {/* ── R94-D2 (owner: "It should only auto-scroll if I have moved to
            the very bottom"): the JUMP-TO-LATEST pill — floats near the
            bottom of the transcript area (above the composer; the transcript
            scrolls UNDER it — same frosted-pill language as the TodoFloat
            widget, z-20 like every float in this wrapper), only while the
            user is DETACHED and there is something to come back to: a turn
            is running, or content landed below since they left the bottom.
            Clicking re-pins + follows; arriving at the bottom hides it.
            The mousedown preventDefault keeps the focus wherever it was
            (usually the composer — the pill must never steal focus or
            interrupt typing). ── */}
        {!pinned && (busy || missedContent) ? (
          <button
            type="button"
            data-testid="jump-to-latest"
            aria-label="Jump to the latest message"
            title="Jump to the latest message"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pinToBottom()}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full border-[1.5px] pl-3 pr-2 py-1.5 shadow-md transition-all hover:shadow-lg"
            style={{
              borderColor: withAlpha(styles.accent, 0.28),
              // R98-C2: the frosted pill rides the CSS-var leg (--ac-frosted, bridged
        // in themes.ts — one spelling for both chat surfaces).
        background: "var(--ac-frosted)",
              backdropFilter: "blur(12px) saturate(1.15)",
              WebkitBackdropFilter: "blur(12px) saturate(1.15)",
              color: styles.text,
            }}
          >
            <span className="text-[11px] font-semibold">Jump to latest</span>
            <ChevronDown size={12} style={{ color: styles.accent }} aria-hidden />
          </button>
        ) : null}
      </div>

      {/* Error banner (ChatView pattern): keeps the failed text for Retry.
          ROUND-43: LOCAL send errors only (create/send rejection, approval
          failure, demo mode) — turn-level stream failures now render the
          timeline error card instead (they used to die silently with the
          banner's lastSent dependency lost on remount). */}
      {sendError && lastSent ? (
        <div className="shrink-0">
          {/* R87-A1: the error banner rides the content column directly —
              CONTENT_COL_CLASS now owns the horizontal inset, so no extra
              px here (the alert box spans the reading column). */}
          <div
            role="alert"
            className={`${CONTENT_COL_CLASS} mb-1.5 flex items-start gap-2 rounded-xl border py-2 text-[12px]`}
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            <span className="min-w-0 flex-1 break-words">{sendError}</span>
            <button
              onClick={() => void runTurn(lastSent)}
              className="shrink-0 underline font-medium"
              style={{ color: styles.accent }}
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {/* ── ROUND-50 (R50-c2) composer placement ─────────────────────────────
          Owner: "When there is nothing, the very first chat with the agent on
          that screen… it will show them almost centered but a bit more towards
          the bottom half of the screen." EMPTY transcript → the composer lives
          INSIDE the scroll column, horizontally centered and pushed below the
          vertical middle (flex spacers — reflow-safe, never absolutely
          positioned), with the greeting + suggestion chips ABOVE it. Once the
          conversation exists, the composer docks at the bottom edge (border-t
          row, same capped reading column as the messages).
          R87-A1: the dock keeps only VERTICAL padding — the column class on
          the inner wrapper carries the same graduated horizontal padding as
          the messages, so the docked composer aligns EXACTLY with the
          reading column (the old p-2/p-2.5 also offset it 10px inward). */}
      {composerDocked ? (
        <div
          className={`shrink-0 border-t ${compact ? "py-2" : "py-2.5"}`}
          style={{ borderColor: styles.borderSubtle }}
        >
          <div className={CONTENT_COL_CLASS} data-composer-dock>
            {renderComposer(false)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
