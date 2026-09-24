import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  AlertTriangle,
  ArrowUp,
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
  Image as ImageIcon,
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
// ROUND-120 (R120-C-PC, item 34): the MESSAGE TIMELINE — the slim bar strip
// that replaces the R101-D dot rail + spine (one bar per user exchange,
// hover-proximity growth, the current exchange highlighted, hover previews,
// click-to-scroll).
import { MessageTimeline, type TimelineExchange } from "./MessageTimeline";
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
  // ROUND-120 (R120-C-PC, items 37+38 — the sync/state law): the backend
  // live-turn truth read (GET /sessions/:id/live — the turn registry).
  fetchSessionLive,
  // ROUND-121 (R121-b — the pixels round): the user-sent image attachment's
  // display bytes + the client-side image test (the bytes route's mirror).
  fetchAttachmentBytes,
  isDisplayableImageAttachment,
  resolveAgentQuestion,
  toProjectChatItems,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
// ROUND-125 (R125-3): the per-session composer drafts (the owner's "switch
// to another section, remember which message was typed there").
import { clearSessionDraft, loadSessionDraft, saveSessionDraft } from "../../lib/draft-store";
// R125-2: the pending-write owner threads the live-tail section's inputs as
// a typed prop (the type's home is the stream store).
import type { StreamingToolInput } from "../../lib/stream-store";
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

/** R87-A1/R101-D: JUST the graduated horizontal padding leg of
 * CONTENT_COL_CLASS (above). It stays a named constant because the composer
 * dock + the empty-state slot compose against it (one spelling, one place
 * to step the tiers). Never use this alone for content — CONTENT_COL_CLASS
 * is the column. */
const CONTENT_H_PAD_CLASS =
  // R124 (the quick-nav verdict 4): the LEFT leg carries a floor that
  // clears the timeline rail at EVERY window size — the rail hugs the
  // viewport's left border (left-1, chips anchored at 10px, magnified to
  // 28px wide), so the reading column's minimum left padding (pl-11 =
  // 44px at the narrowest, pl-12 = 48px at base) always leaves daylight
  // between the widest pill and the text ("the conversation pills start
  // showing on top of the text… not ideal" — dead). The RIGHT leg keeps
  // the graduated tiers (nothing rides it).
  "pl-12 pr-6 md:pl-14 md:pr-12 xl:px-16 @max-[560px]:pl-11 @max-[560px]:pr-4 @max-[420px]:pl-11 @max-[420px]:pr-2.5";

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
 * above) so nested slots compose against the column's inset exactly once. */
const CONTENT_COL_CLASS = `mx-auto w-full max-w-[1080px] ${CONTENT_H_PAD_CLASS}`;

/** R87-A1: the column WITHOUT the graduated horizontal padding — for NESTED
 * slots that already sit inside the padded column (the empty-state
 * composer), so the inset is applied exactly once while the cap/centering
 * (and the “shares the reading column” layout contract) still hold. */
const CONTENT_COL_PADLESS_CLASS = "mx-auto w-full max-w-[1080px]";

const msgVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

/** ROUND-119 (R119-C): the stable EMPTY queue array — `streamSlice?.queued
 * ?? []` mints a fresh [] identity on every render while no stream slice
 * exists, which would defeat the items memo's dependency (a per-keystroke
 * re-fold of the whole event log while the composer types). A module-level
 * constant keeps "no queue" referentially stable. */
const NO_QUEUED_MESSAGES: QueuedMessage[] = [];

/**
 * ROUND-120 (R120-C-PC, items 37+38): the live-truth poll interval (ms).
 * Long enough that an idle panel costs ~nothing against the local sidecar,
 * short enough that a refresh mid-turn reopens the working state (stop
 * button + working section) within a beat — and that a remote mirror whose
 * terminal frame was missed retires before the owner wonders why the spinner
 * persists. The poll skips itself while an own stream runs (the SSE reader
 * is fresher) and only ever READS; the store's rehydrateLiveTurn owns every
 * state move.
 */
const SESSION_LIVE_POLL_MS = 5_000;

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

/** ROUND-120 (R120-C-PC, item 36): the turn's ONE consolidated "how it ran"
 * block — "Ran 4m 12s · 23 actions · 18.2k tokens". The owner's verdict was
 * the "8-9 separate right-side blocks": every segmented work section painted
 * its own right-aligned duration (plus the old per-section folded chips),
 * so one turn read as a stack of tiny clocks. Now the SECTION headers carry
 * no duration at all (folded) and ONE live clock (the panel gates it with
 * clockVisible on the turn's first live section), and THIS block at the
 * turn's foot answers "how long did this run" once: duration + actions +
 * total tokens, middle-dot separated, mono tabular-nums, textTertiary — the
 * R99-B flattened-line grammar, superseded in content only. The full
 * breakdown (input ↑ / output ↓ / tok/s — the old line's whole payload)
 * rides the title so no data is lost to the consolidation. */
export function formatRanDuration(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 10) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  if (m < 60) return `${m}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function ReplyStats({
  usage,
  ms,
  actions,
}: {
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  /** R120-C-PC (item 36): the turn's tool-call count ("23 actions") — the
   * same count the live header's actions counter speaks. */
  actions?: number;
}) {
  const styles = useThemeStyles();
  if (usage === undefined && ms === undefined && actions === undefined) return null;
  const seconds = ms !== undefined ? ms / 1000 : undefined;
  const tps =
    usage && seconds && seconds > 0 ? usage.outputTokens / seconds : undefined;
  const parts: string[] = [];
  if (ms !== undefined) parts.push(`Ran ${formatRanDuration(ms)}`);
  if (actions !== undefined && actions > 0) {
    parts.push(`${actions} ${actions === 1 ? "action" : "actions"}`);
  }
  if (usage) parts.push(`${fmtTokens(usage.inputTokens + usage.outputTokens)} tokens`);
  // The full detail on hover — nothing is lost to the one-line consolidation.
  const detail: string[] = [];
  if (seconds !== undefined) detail.push(`${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`);
  if (usage) {
    detail.push(`↑ ${fmtTokens(usage.inputTokens)}`);
    detail.push(`↓ ${fmtTokens(usage.outputTokens)}`);
  }
  if (tps !== undefined) detail.push(`${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`);
  return (
    <span
      data-reply-stats
      className="ml-auto pl-2 shrink-0 font-mono text-[10px] tabular-nums whitespace-nowrap"
      style={{ color: styles.textTertiary }}
      title={detail.length > 0 ? detail.join(" · ") : undefined}
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
  actions,
  fullCopyText,
}: {
  sessionId: string | null;
  /** R59-D rating key — the turn's LAST non-empty assistant text seq
   * (undefined on working-only turns → no rating cluster). */
  assistantSeq: number | undefined;
  copyText: string;
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  /** R120-C-PC (item 36): the turn's tool-call count — the consolidated
   * "Ran … · N actions · … tokens" block's middle segment. */
  actions?: number;
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
        <ReplyStats usage={usage} ms={ms} actions={actions} />
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

// ─── ROUND-117 (R117-f): DELIVERY TICKS on user messages (mobile R116-m) ────

/**
 * R117-f (deliverable 2): has the live turn produced EVIDENCE that it
 * started — the honest generalization of mobile's "turn.started ack" rung.
 * On current sidecars the turn.started frame stamps LiveTurn.model the
 * instant the server accepts the message (R114-e); an older sidecar never
 * sends it, but its first content frame (thinking/text/tool) is the same
 * verdict. Pure; exported for tests.
 */
export function liveTurnAcked(liveTurn: {
  model?: string;
  working: unknown[];
  streamText: string;
  streamThinking: string;
  streamingToolInputs: unknown[];
} | null): boolean {
  if (liveTurn === null) return false;
  return (
    liveTurn.model !== undefined ||
    liveTurn.working.length > 0 ||
    liveTurn.streamText !== "" ||
    liveTurn.streamThinking.trim() !== "" ||
    liveTurn.streamingToolInputs.length > 0
  );
}

/**
 * R117-f (deliverable 2 — mobile parity, the minimal honest PC version): the
 * delivery glyph beside the timestamp in the user bubble's hover row.
 *   · "sending" — the live optimistic echo with NO evidence the turn took
 *     the message yet (the POST is in flight; a subtle "…" beat)
 *   · "sent"    — the single check (the turn.started ack / first frame
 *     landed; the message is with the agent)
 *   · undefined — a PERSISTED message.user row: NO glyph (the fold is the
 *     receipt; the PC deliberately does NOT over-build the double-check
 *     rung — there is no per-message delivery wire past the fold).
 * The failed rung (mobile's danger alert) rides the send-error banner +
 * the TurnErrorCard the PC already owns — never duplicated here.
 */
function DeliveryTick({ status }: { status: "sending" | "sent" }) {
  const styles = useThemeStyles();
  if (status === "sending") {
    return (
      <span
        data-testid="user-delivery-tick"
        data-delivery="sending"
        title="Sending…"
        aria-label="Sending"
        className="shrink-0 font-mono text-[10px] leading-none select-none"
        style={{ color: styles.textTertiary }}
      >
        …
      </span>
    );
  }
  return (
    <span
      data-testid="user-delivery-tick"
      data-delivery="sent"
      title="Sent"
      aria-label="Sent"
      className="shrink-0 grid place-items-center leading-none"
    >
      <Check size={12} strokeWidth={2.4} style={{ color: styles.textTertiary }} aria-hidden />
    </span>
  );
}

/**
 * ROUND-121 (R121-b — the pixels round): one user-sent IMAGE attachment,
 * rendered with pixels. The bytes come from GET
 * /projects/:id/attachments/bytes (the R67 law keeps bytes OFF the message
 * wire — the display route is the door they come back out of), fetched
 * LAZY on mount through an object URL that is REVOKED on unmount (the
 * ScreenshotRow lifecycle law — no leaks across refetches).
 *
 * The frame-first shape mirrors the mobile UserImageThumb grammar exactly:
 * until the bytes land (and honestly, forever if they never do — a deleted
 * file, a foreign project) the SAME geometry renders the calm placeholder
 * (icon + name), never a fabricated photo and never a layout shift when
 * the pixels arrive.
 */
function AttachmentImageThumb({
  projectId,
  attachment,
}: {
  projectId: string;
  attachment: AttachmentRef;
}) {
  const styles = useThemeStyles();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const path = attachment.path ?? attachment.name;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetchAttachmentBytes(projectId, path)
      .then((blob) => {
        if (cancelled || blob.size === 0) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        // Honest no-pixels (404 / network) — the placeholder frame stands.
      });
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);

  if (objectUrl !== null) {
    return (
      <img
        data-testid="attachment-image-thumb"
        src={objectUrl}
        alt={attachment.name}
        title={`${attachment.name}${attachment.size !== undefined ? ` · ${fmtBytes(attachment.size)}` : ""}`}
        className="rounded-lg max-w-[220px] max-h-[160px] object-cover"
        style={{ border: `1px solid ${withAlpha(styles.accent, 0.18)}` }}
      />
    );
  }
  // The placeholder frame — the mobile UserImageThumb's no-pixels leg,
  // ported: a quiet bordered frame with the image glyph + the name.
  return (
    <span
      data-testid="attachment-image-frame"
      title={`${attachment.name}${attachment.size !== undefined ? ` · ${fmtBytes(attachment.size)}` : ""}`}
      className="inline-flex items-center gap-1.5 h-9 px-2 rounded-lg font-mono text-[10px] max-w-[220px]"
      style={{
        border: `1px dashed ${withAlpha(styles.accent, 0.25)}`,
        color: styles.textTertiary,
      }}
    >
      <ImageIcon size={12} className="shrink-0" aria-hidden style={{ color: styles.accent }} />
      <span className="truncate">{attachment.name}</span>
    </span>
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
  delivery,
  hoverActions,
  projectId,
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
  /** R117-f (deliverable 2): the optimistic echo's delivery rung —
   * "sending" until the turn acks, "sent" (the single check) after;
   * a persisted bubble leaves it undefined (no glyph). */
  delivery?: "sending" | "sent";
  /** ROUND-119 (R119-C): an extra node rendered INSIDE the hover cluster
   * (the timestamp · copy · revert row). The queued-user message is the
   * first consumer — its clock+"queued" state indicator and its Send-now /
   * Remove affordances ride the SAME reveal the cluster already owns, so a
   * queued bubble keeps the exact input-row idiom (hover reveals the acts,
   * the body stays a message) instead of the old amber banner's always-on
   * chrome. Optional + last so every existing call site is untouched. */
  hoverActions?: ReactNode;
  /** ROUND-121 (R121-b — the pixels round): the owning project's id — when
   * present, IMAGE attachments render through AttachmentImageThumb (bytes
   * from the display route); absent (fixture/echo contexts without a
   * project), images fall back to the ordinary chips. */
  projectId?: string;
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
      // min-w-0 — the row is a flex item of the transcript column; flex
      // items clamp at min-width:auto, and the row's own max-w cap + inner
      // min-w-0 handled the old block parent.
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
          {/* R117-f: the delivery tick joins the cluster (mobile R116-m's
              beside-the-clock placement) — only on the optimistic echo's
              rungs; a persisted bubble renders none. */}
          {delivery !== undefined ? <DeliveryTick status={delivery} /> : null}
          <TimestampChip ts={ts} className="pb-1 pr-0.5" />
          <CopyButton text={content} />
          {/* R119-C: the queued bubble's state indicator + affordances ride
              the SAME cluster (see the prop's docblock above). */}
          {hoverActions !== undefined ? hoverActions : null}
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
              {/* ROUND-121 (R121-b — the pixels round): IMAGE attachments
                  render with pixels (the bytes route's display door); every
                  other attachment stays the ordinary chip. The split keeps
                  the group's a11y label honest — both rows are attachments. */}
              {projectId !== undefined
                ? attachments
                    .filter((a) => isDisplayableImageAttachment(a.path, a.name))
                    .map((a, i) => (
                      <AttachmentImageThumb
                        key={`${a.path ?? a.name}-img-${i}`}
                        projectId={projectId}
                        attachment={a}
                      />
                    ))
                : null}
              {attachments
                .filter((a) => !isDisplayableImageAttachment(a.path, a.name))
                .map((a, i) => (
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
  | { kind: "work"; entries: WorkingEntry[]; firstIndex: number; lastIndex: number };

/** The ts of a working entry (tool entries carry it on the tool; every
 * other kind — thinking/text/approval and the R68-A screenshot capture
 * markers — carries it on the entry itself). */
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
  // R120-C-PC (item 36): the turn's tool-call count — the consolidated
  // "Ran … · N actions · … tokens" block's middle segment (the same count
  // the live header's actions counter speaks, so live→folded reads alike).
  const actionCount = item.working.filter((e) => e.type === "tool").length;
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
        actions={actionCount}
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
 * responding/running tools the user can still send): the QUEUED MESSAGE —
 * rendered from BOTH sources: the live store's `queued` array (mid-stream,
 * pushed by the user.queued frame) and the folded log's `queued` items (after
 * the stream ends — message.queued events fold there; the panel dedupes by seq
 * so the handoff never double-renders).
 *
 * ROUND-119 (R119-C, owner: the queued message "does not appear as a message,
 * but rather as a notification or error message… not a good experience"):
 * the old amber `QueuedMessageChip` banner (bordered warning card, Clock +
 * "Queued — sends after the current step", line-clamp-2, mono timestamp,
 * Send-now/X always on) is RETIRED. A queued message now renders through the
 * SAME `UserMessage` bubble every sent message uses — accent-soft, right-
 * aligned, full content with the bubble's own clamp + Show more — with the
 * queue state expressed as CHROME AROUND the bubble, never as warning
 * coloring ON it (waiting, not an error):
 *   · the bubble renders at a reduced 0.75 opacity (visibly "not sent yet");
 *   · a tiny Clock + "queued" caption rides the hover cluster (beside the
 *     timestamp/copy/revert row) together with the two affordances —
 *     Send-now (the Composer's own ArrowUp send glyph, one tap = dequeue +
 *     a normal send, only while NOT busy) and Remove (X → DELETE
 *     /sessions/:id/queue/:seq, optimistic). Their handlers, aria-labels and
 *     data-queued-send-now / data-queued-remove test hooks are unchanged;
 *   · because hover-only state hides on touch, the SAME clock+queued caption
 *     also renders BELOW the bubble, right-aligned, mono 10px textTertiary —
 *     always visible, never louder than the message it waits behind.
 * R120-C-PC (item 34): the old rail's queued dot is retired with the rail —
 * the MESSAGE TIMELINE renders no bar for a queued chip (it is not an
 * exchange yet); the bar appears when the message is delivered and folds as
 * its own user row.
 */
export function QueuedUserMessage({
  entry,
  busy,
  onRemove,
  onSendNow,
  projectId,
}: {
  entry: Pick<QueuedMessage, "seq" | "content" | "ts" | "attachments">;
  /** Hides "Send now" while a turn runs (the queue itself will deliver). */
  busy: boolean;
  /** Live-mode remove affordance (undefined in fixture mode). */
  onRemove?: () => void;
  /** Live-mode send-now affordance (undefined while busy / fixture mode). */
  onSendNow?: () => void;
  /** ROUND-121 (R121-b — the pixels round): threaded to UserMessage so a
   * queued image attachment also renders pixels (absent in fixture mode). */
  projectId?: string;
}) {
  const styles = useThemeStyles();
  // The queued state's hover cluster node — one ReactNode threaded into
  // UserMessage's existing reveal row (timestamp · copy · HERE · revert), so
  // the bubble's internals stay single-sourced (no fork of the input idiom).
  const hoverActions: ReactNode = (
    <>
      {/* The state indicator: tiny clock + lowercase mono "queued" — a
          waiting state, deliberately NOT the amber warning spelling. */}
      <span
        data-testid="queued-hover-state"
        title="Sends after the current step"
        className="flex items-center gap-1 pb-1 pr-0.5 shrink-0 font-mono text-[10px]"
        style={{ color: styles.textTertiary }}
      >
        <Clock size={10} aria-hidden style={{ color: styles.textTertiary }} />
        queued
      </span>
      {!busy && onSendNow !== undefined ? (
        <button
          type="button"
          onClick={onSendNow}
          aria-label="Send the queued message now"
          title="Stop waiting — send this message as a new turn right away"
          data-queued-send-now
          className="w-6 h-6 rounded-md grid place-items-center shrink-0 transition-colors hover:bg-hover"
          style={{ color: styles.textTertiary }}
        >
          {/* The Composer's own send glyph (ArrowUp) — "send this now" reads
              in the same vocabulary as the composer's send button. */}
          <ArrowUp size={11} strokeWidth={2.5} />
        </button>
      ) : null}
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
    </>
  );
  return (
    <motion.div
      variants={msgVariants}
      initial="initial"
      animate="animate"
      className="min-w-0"
      data-testid="queued-chip"
      data-queued-seq={entry.seq}
    >
      {/* The bubble itself — the plain UserMessage idiom at a reduced
          opacity (waiting), full content (the bubble's own clamp handles
          long text; the old banner's line-clamp-2 is gone). */}
      <div className="min-w-0" style={{ opacity: 0.75 }}>
        <UserMessage
          content={entry.content}
          attachments={entry.attachments}
          ts={entry.ts}
          hoverActions={hoverActions}
          projectId={projectId}
        />
      </div>
      {/* The always-visible waiting caption — BELOW the bubble, right-aligned
          to the message column, mono 10px textTertiary. Hover reveals the
          fuller affordances; this line alone keeps the state honest on
          touch, where hover never fires. */}
      <div
        data-testid="queued-state-caption"
        title="Sends after the current step"
        className="mt-1 flex items-center justify-end gap-1 min-w-0"
      >
        <Clock size={10} className="shrink-0" aria-hidden style={{ color: styles.textTertiary }} />
        <span className="font-mono text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
          queued
        </span>
      </div>
    </motion.div>
  );
}

/** Direct child of AnimatePresence mode="popLayout": framer-motion attaches a
 * measurement ref to this element (React 18 requires forwardRef — the demo
 * could skip it on React 19). The wrapper div is the presence child.
 *
 * R117-f (deliverable 7b — the perf leg): the renderer is MEMOIZED. The
 * panel re-renders on every SSE delta (the stream-store patch), but the
 * FOLDED items are immutable snapshots (toProjectChatItems over react-query's
 * structurally-shared data — verified), so a prop-identical re-render is pure
 * waste: every folded AssistantTurn re-rendered its WorkingSection + TurnFooter
 * and re-rendered ChatMarkdown (which re-PARSED markdown — now separately
 * memoized too, deliverable 7a). The stable-props discipline:
 *   · item — the memoized fold snapshot (identity holds across deltas);
 *   · primitives only elsewhere (sessionId/projectId/collapseHint/debugMode/
 *     busy flags/delivery) — booleans flip exactly when the UI must change;
 *   · callbacks are ITEM-TAKING and panel-stable (onRetryError/onRevertMessage/
 *     onQueuedRemove/onQueuedSendNow) — the per-item zero-arg closures are
 *     bound INSIDE this component, so they refresh exactly when a prop change
 *     re-renders it, never per panel tick. The panel's handlersRef hands the
 *     latest panel closures to the stable wrappers (see the call site). */
const MessageRenderer = memo(
  forwardRef<
    HTMLDivElement,
    {
      item: ProjectChatItem;
      sessionId: string | null;
      projectId: string;
      collapseHint?: boolean;
      /** ROUND-43: the error-card retry — the panel-bound item-taking form
       * (the failed turn's user message is resolved from the item). */
      onRetryError?: (item: Extract<ProjectChatItem, { kind: "error" }>) => void;
      retryDisabled?: boolean;
      /** ROUND-44 (R44-c): user-bubble revert — rewinds the session to THIS
       * message's event seq (panel-stable, item-taking; applies only to
       * persisted user rows with a bound session). */
      onRevertMessage?: (item: Extract<ProjectChatItem, { kind: "user" }>) => void;
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
      /** R78: the folded queued affordances' gate (live mode + a bound
       * session) — a primitive so the memo tracks it. */
      queuedLive?: boolean;
      /** R117-f (deliverable 2): the optimistic echo's delivery rung. */
      delivery?: "sending" | "sent";
      /** ROUND-120 (R120-C-PC, item 34): the row's MESSAGE-TIMELINE anchor —
       * the id the timeline bar's click scrolls to (the exchange's user
       * bubble). Folded rows stamp `chat-item-${seq}` automatically; the
       * LIVE rows (echo / remote opener / delivered-queued) pass their own
       * stable ids. */
      anchorId?: string;
    }
  >(function MessageRenderer(
    {
      item,
      sessionId,
      projectId,
      collapseHint,
      onRetryError,
      retryDisabled,
      onRevertMessage,
      revertDisabled,
      attachments,
      debugMode,
      onQueuedRemove,
      onQueuedSendNow,
      queuedBusy,
      queuedLive,
      delivery,
      anchorId,
    },
    ref,
  ) {
    // R120-C-PC (item 34): the R101-D rail grid is RETIRED — every row is a
    // plain min-w-0 block in the reading column again (the dot rail + spine
    // died with the owner's round-120 verdict). The wrapper div stays the
    // AnimatePresence popLayout child (the ref is framer-motion's
    // measurement hook); scroll-mt-1 keeps a timeline jump from parking a
    // row flush under the scroller's edge.
    const rowId = anchorId ?? (item.seq >= 0 ? `chat-item-${item.seq}` : undefined);
    const rowClass = "min-w-0 scroll-mt-1";
    switch (item.kind) {
      case "user":
        return (
          <div ref={ref} id={rowId} className={rowClass}>
            <UserMessage
              content={item.content}
              ts={item.ts}
              onRevert={
                item.seq >= 0 && sessionId !== null && onRevertMessage !== undefined
                  ? () => onRevertMessage(item)
                  : undefined
              }
              revertDisabled={revertDisabled}
              attachments={attachments ?? item.attachments}
              delivery={delivery}
              projectId={projectId}
            />
          </div>
        );
      case "queued":
        // R78: the folded queued row (message.queued event) — the SAME
        // queued-user bubble the live store renders mid-stream, with the
        // panel-bound affordances riding its hover cluster (R119-C).
        return (
          <div ref={ref} id={rowId} className={rowClass}>
            <QueuedUserMessage
              entry={item}
              busy={queuedBusy ?? false}
              projectId={projectId}
              onRemove={
                queuedLive === true && onQueuedRemove !== undefined
                  ? () => onQueuedRemove(item.seq)
                  : undefined
              }
              onSendNow={
                queuedLive === true && onQueuedSendNow !== undefined
                  ? () => onQueuedSendNow(item)
                  : undefined
              }
            />
          </div>
        );
      case "turn":
        return (
          <div ref={ref} id={rowId} className={rowClass}>
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
          <div ref={ref} id={rowId} className={rowClass}>
            {/* R97-D: the thinking-loop guard's stop is NOT an error — the amber
                ThinkingStoppedCard replaces the red TurnErrorCard for the
                thinking_loop class (the owner's "should not be shown as errors
                like 'generation failed'" directive). */}
            {item.errorClass === "thinking_loop" ? (
              <ThinkingStoppedCard
                error={item}
                onRetry={onRetryError !== undefined ? () => onRetryError(item) : undefined}
                disabled={retryDisabled}
              />
            ) : (
              <TurnErrorCard
                error={item}
                sessionId={sessionId}
                onRetry={onRetryError !== undefined ? () => onRetryError(item) : undefined}
                disabled={retryDisabled}
              />
            )}
          </div>
        );
    }
  }),
);

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

  // ── ROUND-125 (R125-3): the PER-SESSION composer drafts ────────────────
  // The owner's ask (verbatim): "the message should be remembered for each
  // one of the sessions separately, like if I write a message and then
  // switch to another section, then it should remember which message was
  // typed there." The draft now belongs to the CONVERSATION, not the user's
  // position: switching sessions flushes the outgoing draft to the store
  // and restores the incoming one; typing persists on a trailing debounce;
  // a send (normal or queued) clears the entry. See src/lib/draft-store.ts.
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
  // R125-3: the debounced DRAFT writer — fires 400ms after the last
  // keystroke (a synchronous write per key would churn localStorage on
  // fast typists; the session-switch effect below flushes synchronously so
  // a fast switch loses nothing).
  useEffect(() => {
    if (activeSessionId === null) return;
    const timer = window.setTimeout(() => {
      saveSessionDraft(activeSessionId, input);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [input, activeSessionId]);
  // R119-C: the LIVE-overlay gates as PRIMITIVES (boolean/string), read once
  // here so the items memo below never depends on the liveTurn OBJECT —
  // the store patches liveTurn on every SSE delta, and a per-delta re-fold
  // of the whole event log would regress R117-f's memoization exactly where
  // it matters most (long sessions mid-stream).
  const liveOverlayActive = liveTurn !== null;
  // R119-C: REMOTE mirror flag WITHOUT remoteRunning's !stopped narrowing —
  // a frozen/stopped mirror still suppresses the folded copy of ITS turn
  // until the retire timer clears it (the fold takes over then).
  const remoteMirror = streamSlice?.remote === true;
  const streamBusy = streamSlice?.streamBusy ?? false;
  // R113-b: a REMOTE mirror is in flight — another device's turn on THIS
  // session, replayed by the events stream. Keyed on the slice's remote
  // flag (NOT "liveTurn != null && !streamBusy" — that would also match
  // the own-turn post-done window where liveTurn lingers a beat before the
  // panel clears it, and busy/flicker would regress). Drives busy (a send
  // while a remote turn runs must take the QUEUE path — the stream POST
  // would 409 "a turn is already in flight") and the sidebar spinner below.
  const remoteRunning = remoteMirror && liveTurn !== null && !liveTurn.stopped;
  // ROUND-43: the LIVE turn error — renders the error card immediately when a
  // stream fails; the persisted `turn.error` event takes over after the
  // refetch (matched by errorTs) so the card survives reloads.
  const liveError = streamSlice?.liveError ?? null;
  const streamPendingEcho = streamSlice?.pendingEcho ?? null;
  const lastLiveEndMs = streamSlice?.lastLiveEndMs ?? 0;
  // ROUND-78 (R78-D): the session's live message QUEUE — queued bubbles (not
  // yet delivered) + delivered bubbles. The frames keep them fresh
  // mid-stream; startStream resets them and the stream-end finally clears
  // them (the refetched folded log owns the render after that —
  // message.queued events fold as `queued` items, delivered ones as ordinary
  // user items). R119-C: the empty fallback is the module-level
  // NO_QUEUED_MESSAGES constant — a fresh `?? []` here would mint a new array
  // identity on every panel render and defeat the items memo's dependency.
  const liveQueued = streamSlice?.queued ?? NO_QUEUED_MESSAGES;
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
  // ── ROUND-125 (R125-B, owner: "it did not actually show me the processing
  //    of the feedback ledger. It did not show me the info of when it was
  //    being written or other stuff like that"): the ledger's live status —
  //    the slice-level field survives the live turn's teardown, so BOTH the
  //    mid-turn checkpoint line (rendered at the live block's bottom edge)
  //    AND the post-turn written/failed toast key off this one read.
  const feedbackEvent = streamSlice?.feedbackEvent ?? null;

  // ── ROUND-125 (R125-B): the post-turn toast — the turn-end frames ride the
  //    events bus AFTER the own stream closed (no live turn to render a line
  //    under), so the completion surfaces as a quiet toast the moment the
  //    frame lands. Mid-turn frames render the live line instead (below) —
  //    a toast mid-stream would interrupt the watching reader.
  const feedbackToastRef = useRef<number>(0);
  useEffect(() => {
    if (feedbackEvent === null) return;
    if (feedbackEvent.ts === feedbackToastRef.current) return;
    feedbackToastRef.current = feedbackEvent.ts;
    if (feedbackEvent.phase !== "turn-end") return;
    if (feedbackEvent.stage === "written") {
      pushLocalToast(
        "Self-feedback ledger updated",
        feedbackEvent.entries !== null
          ? `${feedbackEvent.entries} entries — Settings → Self-Feedback to read`
          : "Settings → Self-Feedback to read",
        "task_complete",
      );
    } else if (feedbackEvent.stage === "failed") {
      pushLocalToast(
        "Self-feedback ledger write failed",
        feedbackEvent.detail ?? "the reporter failed — see the sidecar logs",
        "task_failed",
      );
    }
  }, [feedbackEvent]);

  // ── ROUND-119 (R119-C, owner: while a queued message waited, the transcript
  //    showed "the exact same thought process… the exact same reply" as the
  //    previous exchange — a folded/live DOUBLE render that self-cleared once
  //    the queued message was processed): THE FOLD/LIVE INTERLOCK. Mechanism:
  //    POST /queue appends the message.queued row → the session-events frame
  //    fans out to the always-on events stream → scheduleSessionInvalidation
  //    (300ms trailing debounce, events-stream.ts) → invalidateQueries
  //    (["session"]) → this panel's useSession refetches MID-TURN →
  //    toProjectChatItems folds the log INCLUDING the in-flight turn's
  //    already-persisted events and flushes the trailing OPEN turn at
  //    end-of-log → the items loop rendered that folded partial turn AND the
  //    liveSection rendered the same content again. The fix is CLIENT-side
  //    only (the server is untouched): while the live overlay is showing a
  //    turn, the folded turn items that BELONG to that same live stream are
  //    suppressed; when the overlay clears (post-stream clearStream on the
  //    own path, the retire timer on a remote mirror), nothing is filtered
  //    and the folded turn renders exactly once.
  //
  //    THE ANCHOR — why content, not a seq on the store: the task's first
  //    choice was liveTurn.userSeq, but the wire genuinely carries NO such
  //    seq anywhere (turn.started is {text, model, providerId} — a live-only
  //    announcement, no event seq; the stream POST is SSE with no seq return;
  //    the events-stream session frames carry a seq but not the event TYPE,
  //    so "which append was the message.user" is unknowable there), and the
  //    server is out of this round's reach. The minimal honest path is the
  //    one the panel already trusts three times (pendingEcho, deliveredQueued,
  //    remoteUserItem — "the moment the refetched event log carries the
  //    persisted message.user row, the live copy drops out"): the LIVE turn's
  //    opening user CONTENT (the store's pendingEcho on the own path — set at
  //    send, kept until the post-stream clear; liveTurn.userText on a remote
  //    mirror — stamped from turn.started) is matched against the folded
  //    user items, and the LAST match's seq is the live turn's opener. From
  //    there the suppression is `startedBySeq >= anchorSeq`: >= (not ===)
  //    because a DELIVERED queued message flips its message.queued row to
  //    message.user IN PLACE mid-turn, splitting the fold into a second turn
  //    item whose opener seq is the flipped row — that continuation is still
  //    the SAME live stream (the live overlay renders its content too), so
  //    every folded turn opened at-or-after the anchor is the live stream's;
  //    earlier turns are past exchanges and always render. Edge cases stay
  //    honest: a refetch that raced persistence (the opener's row not yet in
  //    the log) finds no anchor and suppresses nothing (there is nothing to
  //    duplicate yet); a sent-twice identical text anchors on the LAST match
  //    (the current turn); the folded `queued` rows mirrored by the live
  //    overlay's queue (same seq — pushQueuedMessage dedupes by it) drop out
  //    here instead of in the render loop, so exactly ONE queued bubble owns
  //    the render while the stream is open. ──
  const liveOpenUserText = remoteMirror ? (liveTurn?.userText ?? null) : streamPendingEcho;
  // R125-2: the live turn's START CLOCK as a primitive (the positional
  // fallback's freshness gate below — read once here so the items memo's
  // dependency list stays primitive-only, the R119-C discipline).
  const liveTurnStartedAtMs = liveTurn?.startedAtMs ?? null;
  // ROUND-37: the turn fold carries stats turn-level — the old R33
  // interim-reply stat-strip pass is GONE (superseded by the fold).
  const items = useMemo(() => {
    const folded = sessionDetail.data ? toProjectChatItems(sessionDetail.data.events) : [];
    if (!liveOverlayActive && liveQueued.length === 0) return folded;
    // The anchor: the LAST folded user item whose content is the live turn's
    // opening message (see the interlock block above for why content).
    let anchorSeq: number | null = null;
    if (liveOverlayActive && liveOpenUserText !== null && liveOpenUserText !== "") {
      for (const it of folded) {
        if (it.kind === "user" && it.content === liveOpenUserText) anchorSeq = it.seq;
      }
    }
    // ── R125-2: THE POSITIONAL FALLBACK. When the content anchor missed —
    //    a queued message DELIVERED mid-turn (no pendingEcho: the queue
    //    route's flip is the opener), a rehydrated mirror whose userText
    //    landed before the fold refetched, an own turn whose echo was
    //    consumed by the detach path — the folded trailing copy of the LIVE
    //    stream rendered BESIDE the overlay (every tool row twice). The
    //    fallback anchors on the LAST folded user row instead, GATED ON
    //    FRESHNESS: the row's ts must be within 30s of the live turn's own
    //    start clock. Both clocks are the SAME machine's wall clock (the
    //    sidecar writes the row's ts, the store stamps startedAtMs at the
    //    opening frame), so an in-flight opener is milliseconds fresh while
    //    the PREVIOUS exchange's user row is minutes stale — the stale row
    //    never anchors, so a refetch that raced the opener's persist (a
    //    focus-refetch inside the POST window) suppresses nothing instead of
    //    hiding the previous turn. The trade is honest: the 30s window can
    //    transiently suppress a JUST-previous exchange in a pathological
    //    clock-skew case, and the handoff always renders everything once the
    //    overlay clears. ──
    if (liveOverlayActive && anchorSeq === null && liveTurnStartedAtMs !== null) {
      let lastUserSeq: number | null = null;
      let lastUserTsMs: number | null = null;
      for (const it of folded) {
        if (it.kind === "user") {
          lastUserSeq = it.seq;
          const parsed = Date.parse(it.ts);
          lastUserTsMs = Number.isNaN(parsed) ? null : parsed;
        }
      }
      if (
        lastUserSeq !== null &&
        lastUserTsMs !== null &&
        lastUserTsMs + 30_000 >= liveTurnStartedAtMs
      ) {
        anchorSeq = lastUserSeq;
      }
    }
    if (anchorSeq === null && liveQueued.length === 0) return folded;
    return folded.filter((it) => {
      // R78 (moved here by R119-C): a folded queued row whose seq the live
      // overlay's queue already mirrors — the LIVE bubble owns the render
      // until the stream ends (exactly one, never two, never zero).
      if (it.kind === "queued" && liveQueued.some((q) => q.seq === it.seq)) return false;
      // R119-C: the folded trailing turn(s) of the LIVE stream — suppressed
      // while the overlay renders them; the handoff renders them once.
      if (it.kind === "turn" && anchorSeq !== null && it.startedBySeq >= anchorSeq) {
        return false;
      }
      return true;
    });
    // Deps are PRIMITIVES + stable references on purpose (see the R119-C
    // gates above the memo): the liveTurn object itself is patched per SSE
    // delta and must never re-fold the log. R125-2 adds liveTurnStartedAtMs
    // (a primitive that changes once per turn) for the positional fallback.
  }, [sessionDetail.data, liveOverlayActive, liveOpenUserText, liveQueued, liveTurnStartedAtMs]);

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

  // R113-b/R120-C-PC: the REMOTE mirror's opener text — hoisted above the
  // echo computation so the two live-render sources for the SAME message can
  // never double (a DETACHED mirror carries the echo's content as its
  // userText; each source dedupes against the FOLD, not against each other).
  const remoteUserText = remoteRunning ? liveTurn?.userText : undefined;
  const remoteStartedMs = liveTurn?.startedAtMs;
  // Optimistic echo lives only until the refetched log contains it (ChatView pattern).
  // ROUND-39: prefer the stream store's pendingEcho (survives remounts); fall
  // back to local pendingUser for fixture mode.
  // R120-C-PC: a mirror whose userText IS the echo's content owns the
  // opener's live render — the echo (store OR local) drops out so exactly
  // ONE bubble paints until the fold's persisted row takes over.
  const mirrorOwnsEcho =
    remoteUserText !== undefined &&
    (remoteUserText === streamPendingEcho || remoteUserText === pendingUser);
  const pendingEcho = mirrorOwnsEcho
    ? null
    : (streamPendingEcho !== null && !items.some((it) => it.kind === "user" && it.content === streamPendingEcho))
      ? streamPendingEcho
      : pendingUser !== null && !items.some((it) => it.kind === "user" && it.content === pendingUser)
        ? pendingUser
        : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── R117-f (deliverables 2 + 7b): the LIVE user rows' ITEM snapshots,
  //    memoized so the memoized MessageRenderer holds across SSE deltas (the
  //    old inline objects + a fresh Date.now() ts re-rendered these rows on
  //    every panel tick). The echo carries its DELIVERY RUNG — "sending"
  //    until the turn acks (liveTurnAcked — the turn.started stamp or the
  //    first content frame), "sent" (the single check) after; the REMOTE
  //    bubble is born from the ack frame itself, so it enters at "sent"
  //    (mobile's exact rule); the DELIVERED-queued bubbles are persisted
  //    server-side (the queue pre-flip) — no glyph, like any fold. ──
  const echoDelivery: "sending" | "sent" = liveTurnAcked(liveTurn) ? "sent" : "sending";
  const pendingEchoItem = useMemo(
    () =>
      pendingEcho !== null
        ? { kind: "user" as const, seq: -1, content: pendingEcho, ts: new Date().toISOString() }
        : null,
    [pendingEcho],
  );
  const deliveredQueuedItems = useMemo(
    () =>
      deliveredQueued
        .filter((d) => !items.some((it) => it.kind === "user" && it.content === d.content))
        .map((d) => ({ kind: "user" as const, seq: -1, content: d.content, ts: d.ts })),
    [deliveredQueued, items],
  );
  const remoteUserItem = useMemo(() => {
    if (remoteUserText === undefined || remoteUserText === "") return null;
    if (items.some((it) => it.kind === "user" && it.content === remoteUserText)) return null;
    return {
      kind: "user" as const,
      seq: -1,
      content: remoteUserText,
      ts: new Date(remoteStartedMs ?? Date.now()).toISOString(),
    };
  }, [remoteUserText, remoteStartedMs, items]);

  // ── ROUND-120 (R120-C-PC, item 34): the MESSAGE TIMELINE's bars — ONE
  //    exchange per user message. The fold walks in order: every folded
  // `user` row opens an exchange (a delivered queued message is an ordinary
  // user row by then — its own exchange, honestly); the FIRST response
  // block after it (the answering turn's finalText — or its first working
  // narration when the answer never landed — / the error card's message)
  // becomes that exchange's agent preview. Queued rows are chips, not
  // exchanges — skipped. The LIVE opener (own echo or remote mirror — at
  // most one renders, the mirrorOwnsEcho law) opens the CURRENT exchange
  // carrying the live stream's partial answer; when NO live opener renders
  // (a rehydrated mirror anchored on the fold's own user row — the fold
  // owns the opener), the LAST folded exchange IS the live one and takes
  // the live response. Delivered-queued live bubbles ride after it (user
  // messages mid-flight, their response not started). ──
  const timelineExchanges = useMemo<TimelineExchange[]>(() => {
    const list: TimelineExchange[] = [];
    for (const it of items) {
      if (it.kind === "user") {
        list.push({
          anchorId: `chat-item-${it.seq}`,
          userText: it.content,
          ts: it.ts,
          agentText: "",
        });
        continue;
      }
      const owner = list.length > 0 ? list[list.length - 1] : null;
      if (owner === null || owner.agentText !== "") continue;
      if (it.kind === "turn") {
        owner.agentText =
          it.finalText !== ""
            ? it.finalText
            : (it.working.find((w) => w.type === "text")?.content ?? "");
        if (it.model !== undefined) owner.agentLabel = it.model;
      } else if (it.kind === "error") {
        owner.agentText = it.message;
      }
    }
    const liveOpener = pendingEchoItem ?? remoteUserItem;
    if (liveOpener !== null) {
      list.push({
        anchorId: liveOpener === remoteUserItem ? "chat-item-remote" : "chat-item-echo",
        userText: liveOpener.content,
        ts: liveOpener.ts,
        agentText: liveTurn !== null ? liveTurn.streamText : "",
        ...(liveTurn?.model !== undefined ? { agentLabel: liveTurn.model } : {}),
      });
    } else if (liveOverlayActive) {
      // The fold owns the opener row (the rehydrated-mirror anchor case):
      // the last folded exchange is the running one.
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last !== null && last.agentText === "") {
        last.agentText = liveTurn?.streamText ?? "";
        if (liveTurn?.model !== undefined) last.agentLabel = liveTurn.model;
      }
    }
    for (let i = 0; i < deliveredQueuedItems.length; i++) {
      const d = deliveredQueuedItems[i];
      list.push({ anchorId: `chat-item-dq-${i}`, userText: d.content, ts: d.ts, agentText: "" });
    }
    return list;
    // Primitives + memoized snapshots only (the R119-C/R117-f discipline —
    // a per-SSE-delta liveTurn object dependency would rebuild this list on
    // every frame; the two primitive lenses carry everything that changes).
  }, [items, pendingEchoItem, remoteUserItem, deliveredQueuedItems, liveOverlayActive, liveTurn?.streamText, liveTurn?.model]);
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
    const outgoing = prevSessionIdRef.current;
    // R125-3: flush the OUTGOING session's draft FIRST — the `input` state
    // still holds that conversation's text at this beat (the reset below
    // hasn't re-rendered yet), so the typed message stays with the session
    // it was written for instead of following the user.
    if (outgoing !== null) {
      saveSessionDraft(outgoing, input);
    }
    // Local composer state reset only — the store's per-session state
    // persists so the user can switch back to a running session and see
    // its live progress.
    setPendingUser(null);
    setLastSent(null);
    setInput("");
    // R125-3: restore the INCOMING session's draft (its own typed message,
    // sent-drafts were cleared at send; a never-typed session answers "").
    if (activeSessionId !== null) {
      const restored = loadSessionDraft(activeSessionId);
      if (restored !== "") {
        setInput(restored);
      }
    }
    prevSessionIdRef.current = activeSessionId;
    // R94-D2: a session switch starts the new view PINNED at the bottom
    // (pre-R94 the unconditional effect scrolled on the items swap; the
    // stick-to-bottom gate must not inherit the previous session's
    // detached state into the fresh one).
    pinToBottom();
  }, [activeSessionId, input]);

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

  // ── ROUND-120 (R120-C-PC, items 37+38 — the sync/state law): the LIVE
  //    truth poll. The working/stop state must derive from the BACKEND's
  //    turn registry (GET /sessions/:id/live — registerTurn/
  //    unregisterTurn's map), never from "no SSE frames arrived lately":
  //    a refresh mid-turn used to render a finished transcript (the fold
  //    owns the persisted partial) while the backend kept working, and the
  //    stop button vanished until the next agent frame happened to arrive.
  //    The poll runs on session switch + every SESSION_LIVE_POLL_MS while
  //    THIS panel is live-mode mounted, and reconciles through the store's
  //    rehydrateLiveTurn: live:true + no local liveTurn → the REHYDRATED
  //    remote mirror (working state + stop button + the interlock that
  //    kills the fold's copy of the running turn — no split halves);
  //    live:false + a mirror still open → the missed-terminal-frame retire.
  //    Skipped while an OWN stream runs (its reader owns the render) and in
  //    demo mode (no sidecar). A failed poll is silent — the next tick
  //    retries; nothing here can claim completion on its own. ──
  // The poll re-fires when the folded log FIRST lands (a cold start right
  // into a running turn: the opening poll ran before the detail query
  // resolved, so the store opened the MINIMAL mirror — this flip upgrades
  // it with the fold's content + the interlock anchor). Later refetches
  // (identity churn during streaming) do NOT re-arm — hasDetail stays true.
  const hasSessionDetail = sessionDetail.data !== undefined;
  useEffect(() => {
    if (!liveMode || activeSessionId === null) return;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      // The own stream's SSE reader is the freshest possible truth — skip
      // the round-trip while it holds the session (rehydrateLiveTurn
      // no-ops on streamBusy anyway; this just saves the fetch).
      if (useStreamStore.getState().bySession[activeSessionId]?.streamBusy === true) return;
      fetchSessionLive(activeSessionId)
        .then((truth) => {
          if (cancelled) return;
          useStreamStore.getState().rehydrateLiveTurn(activeSessionId, truth.live);
        })
        .catch(() => {
          /* sidecar unreachable — the next tick retries */
        });
    };
    poll();
    const timer = setInterval(poll, SESSION_LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveMode, activeSessionId, hasSessionDetail]);

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
        // R125-3: a QUEUED message is as sent as a normal one — its draft
        // entry goes (the queue chip owns the render from here).
        if (liveSid !== undefined) clearSessionDraft(liveSid);
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
    // R125-3: the sent message is not a draft — clear the session's entry
    // (a reload or a switch back must find an empty composer, not the text
    // that just left).
    if (activeSessionId !== null) clearSessionDraft(activeSessionId);
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
          // R120-C-PC (item 37): a DETACHED mirror (remote:true — the own
          // fetch died but the backend turn survived; see the store's
          // rehydrateLiveTurn) owns its own lifecycle now: the events bus's
          // mirrored frames keep rendering it and the retire machinery (the
          // terminal frame's timer + the live poll) closes it. Clearing it
          // here would strand the running turn's transcript twice — the
          // frozen failure the detach just retracted, back as a vanishing
          // overlay while the backend still works.
          if (
            liveSlice?.liveTurn &&
            liveSlice.remote !== true &&
            (!liveSlice.liveTurn.stopped || wasUserStopped)
          ) {
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

  // ── R117-f (deliverable 7b): STABLE item-level callbacks for the memoized
  //    MessageRenderer. The panel re-renders on every SSE delta, but the
  //    folded rows only need the LATEST closures AT CLICK TIME — this ref
  //    (synced after every render) hands them over without re-rendering a
  //    single prop-identical row. Zero staleness by construction: a click
  //    always reads the post-render state of the current panel. ──
  const itemHandlersRef = useRef({ runTurn, retryTextForError, removeQueuedMessage, sendQueuedNow });
  useEffect(() => {
    itemHandlersRef.current = { runTurn, retryTextForError, removeQueuedMessage, sendQueuedNow };
  });
  const onRetryError = useCallback((item: ErrorTurnItem) => {
    const h = itemHandlersRef.current;
    void h.runTurn(h.retryTextForError(item));
  }, []);
  const onRevertMessage = useCallback(
    (item: Extract<ProjectChatItem, { kind: "user" }>) => setRevertTarget(item),
    [],
  );
  const onQueuedRemove = useCallback((seq: number) => {
    void itemHandlersRef.current.removeQueuedMessage(seq);
  }, []);
  const onQueuedSendNow = useCallback((entry: QueuedMessage) => {
    void itemHandlersRef.current.sendQueuedNow(entry);
  }, []);
  // R78: the queued affordances' gate as a PRIMITIVE (live mode + a bound
  // session) — the memo tracks its flips without per-render closures.
  const queuedLive = liveMode && activeSessionId !== null;

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
  //
  // ROUND-125 (R125-2, owner: "it was showing me multiple writing at the
  // same time… the exact same ones… one much earlier in the conversation,
  // the other one showing further"): the PENDING streaming writes now render
  // in EXACTLY ONE place — the section that owns the LIVE TAIL. Before,
  // every mounted live work section read the store's streamingToolInputs
  // through its own selector and painted the same "Writing…" row, so a
  // segmented turn (tools → narration text → a new write) showed the
  // identical pending row in EACH section plus the synthetic tail — the
  // duplicate the owner watched. The panel now derives the inputs ONCE and
  // threads them as a prop to the single owning section below.
  const liveSection = (() => {
    if (liveTurn === null) return null;
    const entries: WorkingEntry[] = [
      ...liveTurn.working,
      ...(liveTurn.streamThinking.trim() !== ""
        ? [{ type: "thinking" as const, text: liveTurn.streamThinking, ts: new Date().toISOString() }]
        : []),
    ];
    // R125-2: the pending write inputs derive ONCE (the panel is the single
    // owner now); the DIFF filter is the old selector's law, kept verbatim.
    const pendingWriteInputs: StreamingToolInput[] = liveTurn.streamingToolInputs.filter((s) =>
      DIFF_TOOLS.has(s.toolName),
    );
    const hasPendingWriteInput = pendingWriteInputs.length > 0;
    const liveEntryIdx = liveTurn.streamThinking.trim() !== "" ? entries.length - 1 : undefined;
    const segments = segmentWorkingEntries(entries);
    // R125-2: THE OWNER RULE. The pending writes render at the LIVE TAIL —
    // after every settled entry. When the LAST segment renders as a live
    // work section (tool/screenshot entries, or the still-streaming thought
    // rides in it) that section owns them; otherwise the synthetic tail
    // section below the last block renders them. Exactly ONE section ever
    // receives the prop — the duplicate-render fix.
    const lastSeg = segments.length > 0 ? segments[segments.length - 1] : undefined;
    const lastSegRendersAsSection =
      lastSeg !== undefined &&
      lastSeg.kind === "work" &&
      (lastSeg.entries.some((e) => e.type === "tool" || e.type === "screenshot") ||
        (liveEntryIdx !== undefined && liveEntryIdx >= lastSeg.firstIndex && liveEntryIdx <= lastSeg.lastIndex));
    const tailOwnsPendingWrites = hasPendingWriteInput && !lastSegRendersAsSection;
    // R120-C-PC (item 36): ONE live clock per turn — the prior design let
    // every segmented live work section paint its own right-aligned elapsed
    // clock (the owner's "8-9 separate right-side blocks"); now the FIRST
    // rendered live work section owns the single clock (clockVisible), the
    // rest render their headers + rows without it.
    let liveClockTaken = false;
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
        // R120-C-PC (item 36): the FIRST live work section owns the turn's
        // ONE elapsed clock.
        const clockVisible = !liveClockTaken;
        liveClockTaken = true;
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
            clockVisible={clockVisible}
            // R125-2: the pending writes ride ONLY the live-tail owner (the
            // LAST segment when it renders as a section); every earlier
            // section renders none — one "Writing…" row per turn, at the
            // live position.
            pendingWrites={
              hasPendingWriteInput && i === segments.length - 1 && lastSegRendersAsSection
                ? pendingWriteInputs
                : undefined
            }
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
    // R125-2: the synthetic tail — renders when the live tail is NOT a work
    // section (no segments, the last segment is a text answer, or a
    // thinking-only bare block) so the pending writes still land at the
    // live position. Exactly one owner: this OR the last section above,
    // never both.
    if (tailOwnsPendingWrites) {
      rendered.push(
        <WorkingSection
          key="live-seg-write-tail"
          entries={[]}
          sessionId={session?.id ?? null}
          projectId={projectId}
          live
          startedAtMs={liveTurn.startedAtMs}
          stopped={liveTurn.stopped}
          // R120-C-PC (item 36): the tail section owns the clock ONLY when no
          // earlier live work section rendered (segments.length === 0 — a
          // write started before anything else).
          clockVisible={!liveClockTaken}
          pendingWrites={pendingWriteInputs}
          onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
        />,
      );
    }
    return rendered;
  })();

  // R120-C-PC (item 34): the message timeline renders ONLY when the
  // transcript has content — the greeting/skeleton/load-error empty states
  // carry no timeline (an empty chat is a welcome, not a stack of bars).
  // Every source of a user row counts: folded items, the optimistic echo,
  // delivered-queued bubbles, the live turn, and the live error card.
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
              R120-C-PC (item 34): the old R101-D rail/spine are RETIRED —
              the reading column hosts the rows directly, and the MESSAGE
              TIMELINE (the bar strip) docks over the scroll viewport's left
              edge from the scroll-body wrapper below). */}
          <div
            className={`${density === "compact" ? "py-4" : "py-5"} ${CONTENT_COL_CLASS} relative min-h-full flex flex-col gap-5`}
            style={
              {
                "--ac-chat-scale": chatTextSize === "small" ? "0.92" : chatTextSize === "large" ? "1.12" : "1",
              } as React.CSSProperties
            }
            data-chat-size={chatTextSize}
          >
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
                // R78 → R119-C: the folded/live queued dedupe (a window-focus
                // refetch raced the running stream) moved UP into the items
                // memo — the suppressed rows never reach this loop, so the
                // map stays a pure render of `items`.
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
                    // R117-f (the perf leg): STABLE item-taking callbacks +
                    // primitive gates — the memo now holds across every SSE
                    // delta (the per-item closures bind INSIDE the renderer;
                    // the error/user/queued gates moved there with them).
                    // ROUND-43's retry, ROUND-44's revert, and ROUND-78's
                    // queued affordances are byte-identical at the surface.
                    onRetryError={onRetryError}
                    retryDisabled={busy}
                    onRevertMessage={onRevertMessage}
                    revertDisabled={busy}
                    onQueuedRemove={onQueuedRemove}
                    onQueuedSendNow={onQueuedSendNow}
                    queuedBusy={busy}
                    queuedLive={queuedLive}
                  />
                );
              })}
              {pendingEchoItem !== null ? (
                <MessageRenderer
                  key="pending-echo"
                  item={pendingEchoItem}
                  sessionId={null}
                  projectId={projectId}
                  delivery={echoDelivery}
                  anchorId="chat-item-echo"
                  {...(pendingEchoAttachments !== null ? { attachments: pendingEchoAttachments } : {})}
                />
              ) : null}
            </AnimatePresence>

            {/* ── ROUND-78 (R78-D): queued messages DELIVERED mid-stream — the
                loop-top flip landed (the event row is message.user now) but
                the refetch hasn't folded it yet: render the ordinary user
                bubble from the frame's content+ts, with the pendingEcho dedup
                trick (once the folded log carries the same content, the live
                copy drops out — no double bubble). R117-f: the item snapshot
                is memoized (deliveredQueuedItems) — persisted rows, no glyph. ── */}
            {deliveredQueuedItems.map((d, i) => (
              <MessageRenderer
                key={`delivered-q-${d.seq}`}
                item={d}
                sessionId={null}
                projectId={projectId}
                anchorId={`chat-item-dq-${i}`}
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
                bubble. R117-f: memoized snapshot + the "sent" rung (the
                bubble is born from the ack frame itself — mobile's rule). ── */}
            {remoteUserItem !== null ? (
              <MessageRenderer
                key="remote-turn-user"
                item={remoteUserItem}
                sessionId={null}
                projectId={projectId}
                delivery="sent"
                anchorId="chat-item-remote"
              />
            ) : null}

            {/* ── ROUND-37 LIVE TURN: the Working section grows above the
                streaming presumptive-final text (which flows into the
                timeline as a full answer block the moment a tool lands —
                ROUND-64 R64-c segmentation). ── */}
            {liveTurn !== null ? (
              // R120-C-PC (item 34): the rail grid is retired — the live
              // block is a plain min-w-0 child of the reading column, the
              // exact same geometry every folded row renders in (the
              // live→folded handoff stays seamless: header → header).
              <div aria-live="polite" aria-atomic="false" className="group min-w-0">
                {/* ROUND-68 (R68-A): the R67-D screenshot THUMBNAIL strip that
                    rendered here is GONE — captures now ride INSIDE liveSection
                    as `screenshot` WorkingEntry rows, rendered by WorkingSection
                    at their capture moment (the owner: "When the screenshots
                    were taken they should be shown at that specific time."). */}
                {/* ROUND-75 (R75) → ROUND-124 (the owner: "the retrying
                    attempts… are apparently shown at the very top of the
                    conversation rather than showing at the very bottom"): the
                    transient-API retry ladder + the overflow-recovery note
                    moved to the live block's BOTTOM EDGE — right where the
                    pinned reader sits (R75's top placement buried the card
                    thousands of pixels above during long agentic turns;
                    the R124 verdict supersedes it). */}
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
                {/* ── ROUND-78 (R78-D): the QUEUED messages — below the working
                    section (they wait BEHIND the current work), above the
                    streaming answer. Live-store entries only here — the
                    stream is OPEN, so the LIVE bubble owns the render even
                    when a window-focus refetch already folded the same seq
                    into `items` (the items memo drops a folded queued row
                    whose seq is live-rendered — R119-C moved that skip from
                    the render loop into the memo, so exactly ONE bubble,
                    never two, and never the zero-bubble hole the mutual-skip
                    would leave). The stream-end finally clears the live
                    array, and the folded log's `queued` items take over in
                    the items loop above. R119-C: these are the SAME
                    QueuedUserMessage bubbles the folded rows render — the
                    right-aligned user-message idiom with the hover-cluster
                    affordances, not the retired amber banner. ── */}
                {liveQueued.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-2 min-w-0" data-queued-live-list>
                    {liveQueued.map((q) => (
                      <QueuedUserMessage
                        key={`live-q-${q.seq}`}
                        entry={q}
                        busy={busy}
                        projectId={projectId}
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
                  /* R117-f (deliverable 3, mobile R115-J parity): the plain
                     mono "Thinking…" line became the BREATHING placeholder —
                     a small pulsing accent dot (ac-pulse — the app's shared
                     live-dot animation, reduced-motion aware) + "Thinking" +
                     the turn's resolved model in micro mono (the same
                     model the header above labels the turn with; absent on
                     pre-R114 sidecars). The first real delta replaces it. */
                  <div
                    className="flex items-center gap-1.5 h-5 min-w-0"
                    data-testid="thinking-placeholder"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0"
                      style={{ background: styles.accent }}
                      aria-hidden
                    />
                    <span className="text-[12px] font-medium shrink-0" style={{ color: styles.textSecondary }}>
                      Thinking
                    </span>
                    {(() => {
                      const phModel = liveTurn.model ?? effectiveModel ?? undefined;
                      return phModel !== undefined && phModel !== "" ? (
                        <span
                          className="min-w-0 truncate font-mono text-[10px]"
                          style={{ color: styles.textTertiary }}
                          title={phModel}
                        >
                          · {phModel}
                        </span>
                      ) : null;
                    })()}
                  </div>
                ) : null}
                {/* ── R124 (the owner: "the retrying attempts… at the very
                    top… rather than… the very bottom"): the retry ladder
                    card + the overflow-recovery note now ride the live
                    block's BOTTOM EDGE — under the streaming text / the
                    thinking placeholder, right where the pinned reader
                    watches. A retry wait is exactly when the stream goes
                    quiet; the "why" belongs where the eyes are. ── */}
                {liveTurn.retry !== null ? (
                  <div className="mt-2 mb-1 min-w-0">
                    <RetryStatusCard retry={liveTurn.retry} />
                  </div>
                ) : null}
                {liveTurn.note !== null ? (
                  <div
                    className="mb-1 min-w-0 text-[12px] font-mono px-3 py-1.5 rounded-lg border"
                    style={{ borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.35), color: styles.textSecondary, background: withAlpha(SEMANTIC_COLORS.warning, 0.05) }}
                  >
                    {liveTurn.note}
                  </div>
                ) : null}
                {/* ── R125-B (owner: "it did not actually show me the processing
                    of the feedback ledger"): the MID-TURN ledger checkpoint's
                    live status line — the same bottom-edge position the retry
                    card + the recovery note ride, so the owner WATCHES the
                    ledger being written while the troubled turn still runs
                    (the turn-end phase surfaces as the post-turn toast + the
                    Settings → Self-Feedback strip instead). Quiet by design:
                    accent-tinted, one line, the failure excerpt title-attr'd. ── */}
                {feedbackEvent !== null && feedbackEvent.phase === "mid-turn" ? (
                  <div
                    data-testid="live-feedback-line"
                    className="mb-1 min-w-0 flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-lg border"
                    title={feedbackEvent.detail ?? undefined}
                    style={{
                      borderColor: withAlpha(styles.accent, 0.28),
                      color: styles.textSecondary,
                      background: withAlpha(styles.accent, 0.05),
                    }}
                  >
                    {feedbackEvent.stage === "writing" ? (
                      <span
                        className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0"
                        style={{ background: styles.accent }}
                        aria-hidden
                      />
                    ) : null}
                    <span className="min-w-0 truncate">
                      {feedbackEvent.stage === "writing"
                        ? "writing the self-feedback checkpoint…"
                        : feedbackEvent.stage === "written"
                          ? `self-feedback checkpoint written${feedbackEvent.entries !== null ? ` · ${feedbackEvent.entries} entries` : ""}`
                          : "self-feedback checkpoint failed"}
                    </span>
                  </div>
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
                    // R120-C-PC (item 36): the consolidated "Ran …" block gets
                    // real numbers on the live-completed turn too — the live
                    // clock's own duration + the working entries' tool count
                    // (the refetched folded log takes over with the persisted
                    // usage shortly; until then the block stays honest).
                    ms={Date.now() - liveTurn.startedAtMs}
                    actions={liveTurn.working.filter((e) => e.type === "tool").length}
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
            ) : null}

            {/* ── ROUND-58 (R58-cf): the deliberate user stop — a QUIET status
                card (never TurnErrorCard, no red): the partial above stays
                visible, the backend flushed the persisted partial on stop,
                and the composer grew a Continue affordance. Hidden while a
                new turn streams (startStream resets the signal). ── */}
            {lastTurnStoppedByUser && !streamBusy && lastTurnStoppedTs !== null ? (
              // R120-C-PC: live-only status chrome — a plain min-w-0 row in
              // the reading column (the rail indent died with the rail).
              <div className="min-w-0">
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
              // R120-C-PC: the live error rides the same plain column the
              // folded turn.error item that replaces it on refetch renders
              // in — the swap is seamless (same column) instead of a jump.
              <div className="min-w-0">
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
                // R120-C-PC: live-only notice chrome — a plain row in the
                // reading column (the rail indent died with the rail).
                className="mt-2 rounded-xl border px-3 py-2 text-[12px] font-semibold flex items-center gap-2"
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

        {/* ── ROUND-120 (R120-C-PC, item 34): the MESSAGE TIMELINE — the slim
            bar strip that REPLACES the old left rail. Docked at the transcript
            viewport's left edge (NOT inside the scroller — it is a fixed
            navigational minimap: every exchange stays reachable while reading
            deep history), one bar per user exchange, hover-proximity growth
            (R124: width-dominant — the pill gets WIDER, never a circle), the
            SCROLL-OWNED current-exchange highlight + click-set (R124),
            click-dismissed previews (R124), and click-to-scroll through the
            chat-item-* anchors the rows stamp. Never rendered on an empty
            transcript (hasTimelineContent). ── */}
        {hasTimelineContent ? (
          <MessageTimeline exchanges={timelineExchanges} scrollContainer={scrollRef} />
        ) : null}

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
