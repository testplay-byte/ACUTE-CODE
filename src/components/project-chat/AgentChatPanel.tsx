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
  Check,
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
  listSessionRatings,
  patchSessionPermissions,
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
  loadModelOverride,
  loadThinkingLevel,
  saveModelOverride,
  saveThinkingLevel,
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
 * streams beneath it, and collapses to "Worked for Ns" when the turn ends.
 */

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
 * drives the VERTICAL rhythm only. */
const CONTENT_COL_CLASS = "mx-auto w-full max-w-[1080px] px-6 md:px-12 xl:px-16";

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
      className="w-6 h-6 rounded-md grid place-items-center transition-colors"
      style={{ color: styles.textTertiary }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {copied ? <Check size={11} style={{ color: SEMANTIC_COLORS.success }} /> : <Icon size={11} />}
    </button>
  );
}

/** Per-reply stats chips (owner spec: time · in · out · tok/s). */
function ReplyStats({
  usage,
  ms,
  model,
}: {
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
}) {
  const styles = useThemeStyles();
  if (usage === undefined && ms === undefined) return null;
  const seconds = ms !== undefined ? ms / 1000 : undefined;
  const tps =
    usage && seconds && seconds > 0 ? usage.outputTokens / seconds : undefined;
  const chips: string[] = [];
  if (seconds !== undefined) chips.push(`${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`);
  if (usage) {
    chips.push(`↑ ${fmtTokens(usage.inputTokens)}`);
    chips.push(`↓ ${fmtTokens(usage.outputTokens)}`);
  }
  if (tps !== undefined) chips.push(`${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`);
  if (model) chips.push(model);
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
      {chips.map((c) => (
        <span
          key={c}
          className="text-[9.5px] font-mono px-1.5 py-0.5 rounded-md"
          style={{ color: styles.textTertiary, background: styles.subtle }}
        >
          {c}
        </span>
      ))}
    </div>
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
  model,
  fullCopyText,
}: {
  sessionId: string | null;
  /** R59-D rating key — the turn's LAST non-empty assistant text seq
   * (undefined on working-only turns → no rating cluster). */
  assistantSeq: number | undefined;
  copyText: string;
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
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
        className="w-6 h-6 rounded-md grid place-items-center transition-colors"
        style={{ color: filled ? styles.accent : styles.textTertiary }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon size={11} style={filled ? { fill: "currentColor" } : undefined} />
      </button>
    );
  };

  return (
    <div className="min-w-0" data-rating-footer>
      <div className="flex items-center gap-1">
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
                className="ml-0.5 flex h-5 max-w-[180px] items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold"
                style={{ background: styles.subtle, color: styles.textTertiary }}
              >
                <MessageSquareText size={10} aria-hidden />
                <span className="truncate">noted</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <ReplyStats usage={usage} ms={ms} model={model} />
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
            className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen(false)}
            aria-label="Cancel rating note"
            className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border"
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
  onRevert,
  revertDisabled,
}: {
  content: string;
  /** ROUND-50 (R50-c2): display-only attachment chips (name/path/size) on
   * the user bubble — persisted items carry them from the event log; the
   * optimistic echo carries the staged chips until the refetch lands. */
  attachments?: AttachmentRef[];
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
  const bubbleBg = withAlpha(styles.accent, styles.isDark ? 0.18 : 0.1);
  const bubbleBorder = withAlpha(styles.accent, styles.isDark ? 0.32 : 0.22);
  return (
    <motion.div
      className="flex justify-end group"
      variants={msgVariants}
      initial="initial"
      animate="animate"
    >
      <div className="flex items-end gap-1 max-w-[82%]">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity pb-0.5">
          <CopyButton text={content} />
          {onRevert !== undefined ? (
            <button
              type="button"
              onClick={onRevert}
              disabled={revertDisabled}
              aria-label="Revert to this message"
              title="Revert to this message"
              className="w-6 h-6 rounded-md grid place-items-center transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: styles.textTertiary }}
              onMouseEnter={(e) => {
                if (!revertDisabled) e.currentTarget.style.background = styles.subtleHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <History size={11} />
            </button>
          ) : null}
        </div>
        <div
          className="rounded-[16px] rounded-br-[5px] px-3.5 py-2.5 text-[13px] leading-[1.55] font-medium border"
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
                  className="inline-flex items-center gap-1 h-5 pl-1.5 pr-2 rounded-md font-mono text-[9.5px] max-w-[220px]"
                  style={{
                    background: withAlpha(styles.accent, styles.isDark ? 0.14 : 0.1),
                    color: styles.textSecondary,
                  }}
                >
                  <File size={9} className="shrink-0" style={{ color: styles.accent }} />
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
 * response vanished behind "Worked for Ns". Pure; exported for tests. */
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
    <div className="mt-1.5 min-w-0 break-words text-[13px] leading-[1.65]" style={{ color: styles.text }}>
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
   * watched — it mounts collapsed ("Worked for Ns" + answer). */
  collapseHint?: boolean;
  /** ROUND-67 (R67-B): debug mode (the General tab's settings — R78 renamed
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
        <div className={`min-w-0 break-words text-[13px] leading-[1.65] ${hasToolWork ? "mt-2" : ""}`} style={{ color: styles.text }}>
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
        model={item.model}
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
    Partial<Pick<ErrorTurnItem, "model" | "providerId" | "providerError" | "errorClass" | "attempts">>;
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
    `Code: ${error.code}`,
    `Error: ${reason}`,
    `Time: ${error.ts}`,
  ].join("\n");
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="min-w-0">
      <div
        role="alert"
        className="rounded-[14px] border px-3.5 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4),
          background: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.09 : 0.05),
        }}
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
            Generation failed
            {error.attempts !== undefined ? (
              <span className="ml-1.5 font-semibold" style={{ color: styles.textSecondary }}>
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
                className="font-mono text-[10.5px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[240px] truncate"
                style={{ background: styles.subtle, color: styles.textTertiary }}
                title={error.model}
              >
                {error.model}
              </span>
            ) : null}
            <span className="text-[11.5px] leading-[1.5] min-w-0 break-words" style={{ color: styles.textSecondary }}>
              {shortReason}
            </span>
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
              className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap break-words min-w-0"
              style={{
                borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3),
                background: styles.isDark ? "rgba(255,255,255,0.04)" : styles.subtle,
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
                className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
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
              className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border transition-colors"
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
        className="rounded-[16px] border px-3.5 py-3 flex items-start gap-3"
        style={{
          borderColor: withAlpha("#f59e0b", 0.4),
          background: `linear-gradient(135deg, ${withAlpha("#f59e0b", styles.isDark ? 0.1 : 0.07)} 0%, ${withAlpha(
            "#f59e0b",
            styles.isDark ? 0.05 : 0.03,
          )} 100%)`,
        }}
      >
        {/* The spinner badge — the slow patient rotation (R75) now inside a
            soft circular chip instead of a bare floating glyph. */}
        <div
          className="w-7 h-7 rounded-full grid place-items-center shrink-0 mt-0.5"
          style={{ background: withAlpha("#f59e0b", 0.16) }}
          aria-hidden
        >
          <RefreshCw size={13} className="ac-retry-spin" style={{ color: "#d97706" }} />
        </div>
        <div className="min-w-0 flex-1">
          {/* Header + the attempt dot-ladder. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-bold" style={{ color: "#d97706" }}>
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
                        ? withAlpha("#d97706", 0.55)
                        : isCurrent
                          ? "#f59e0b"
                          : "transparent",
                      border: isCurrent || isDone ? "none" : `1px solid ${withAlpha("#f59e0b", 0.45)}`,
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
              style={{ background: withAlpha("#f59e0b", 0.14), color: "#d97706" }}
              title={`provider error class: ${retry.errorClass}`}
            >
              {classLabel}
            </span>
            <span className="text-[11.5px] leading-[1.5] min-w-0 break-words" style={{ color: styles.textSecondary }}>
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
                className={`font-mono text-[10.5px] leading-[1.55] min-w-0 break-words ${
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
                    style={{ borderColor: withAlpha("#f59e0b", 0.4), color: "#d97706" }}
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
                      className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-[10.5px] leading-[1.55] whitespace-pre-wrap break-words min-w-0"
                      style={{
                        borderColor: withAlpha("#f59e0b", 0.3),
                        background: styles.isDark ? "rgba(255,255,255,0.04)" : styles.subtle,
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
            <Timer size={11} className="shrink-0" style={{ color: "#d97706" }} aria-hidden />
            <span className="text-[11px] font-mono shrink-0 tabular-nums" style={{ color: "#d97706" }}>
              next attempt in {remainingLabel}
            </span>
            <div
              className="flex-1 min-w-[48px] h-1 rounded-full overflow-hidden"
              style={{ background: withAlpha("#f59e0b", 0.16) }}
              aria-hidden
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${waitFraction * 100}%`,
                  background: "#f59e0b",
                  transition: "width 1s linear",
                }}
              />
            </div>
          </div>
          {/* The reassurance line. */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Info size={10.5} className="shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
            <span className="text-[10.5px] min-w-0" style={{ color: styles.textTertiary }}>
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
        className="rounded-[14px] border px-3.5 py-2.5 flex items-center gap-2.5"
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
        className="rounded-[14px] border px-3.5 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: withAlpha("#f59e0b", 0.4),
          background: withAlpha("#f59e0b", styles.isDark ? 0.08 : 0.05),
        }}
      >
        <Clock size={13} className="mt-0.5 shrink-0" style={{ color: "#d97706" }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold" style={{ color: "#d97706" }}>
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
                style={{ borderColor: withAlpha("#f59e0b", 0.45), color: "#d97706" }}
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
            className="w-6 h-6 rounded-md grid place-items-center shrink-0 transition-colors"
            style={{ color: styles.textTertiary }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <X size={11} />
          </button>
        ) : null}
      </div>
    </motion.div>
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
    /** ROUND-67 (R67-B): debug mode (the General tab's settings — R78's
     * rename of the old Advanced label) — threaded to
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
    case "user":
      return (
        <div ref={ref}>
          <UserMessage
            content={item.content}
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
        <div ref={ref}>
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
        <div ref={ref}>
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
        <div ref={ref}>
          <TurnErrorCard
            error={item}
            sessionId={sessionId}
            onRetry={onRetry}
            disabled={retryDisabled}
          />
        </div>
      );
  }
});

/** ROUND-39: LiveTurn now lives in src/lib/stream-store.ts so the streaming
 * state survives panel remounts (background sessions). The interface is
 * re-exported from there. */

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
  const sessions = useSessions().data ?? [];
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

  // Agent resolution (round-14): the SESSION's bound agent wins; for NEW
  // sessions the hamburger picker's choice (persisted) applies; else first.
  const agents = useAgents(false).data ?? [];
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const agent =
    agents.find((a) => a.id === session?.agentId) ??
    agents.find((a) => a.id === selectedAgentId) ??
    agents[0] ??
    null;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = useThemeStore((s) => s.density);

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
  // ROUND-58 (R58-cf): the last live turn ended by a USER STOP — the quiet
  // Stopped card below the (folded or still-live) partial + the composer's
  // Continue affordance both key off this signal (it survives the live-turn
  // clear after the refetch and resets on the next send).
  const lastTurnStoppedByUser = streamSlice?.lastTurnStoppedByUser ?? false;
  const lastTurnStoppedTs = streamSlice?.lastTurnStoppedTs ?? null;
  // R37 review #4: turns that JUST finished while the user watched start
  // collapsed ("Worked for Ns" + answer); cold-loaded sessions use the
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
  // General, R78's label rename of the old Advanced tab — the URL id stays
  // "advanced") gates the "Copy full conversation (debug)" button on assistant
  // replies. SHARED cache key ["debug-settings"] — the same one
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
  const [modelOverride, setModelOverride] = useState<ModelOverride | null>(() =>
    loadModelOverride(session?.id ?? null),
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
  useEffect(() => {
    setModelOverride(loadModelOverride(activeSessionId));
  }, [activeSessionId]);
  useEffect(() => {
    setThinkingLevel(loadThinkingLevel(activeSessionId));
  }, [activeSessionId]);
  useEffect(() => {
    setPermissionMode(session?.permissionMode ?? "ask");
  }, [session?.id, session?.permissionMode]);
  const onModelChange = (v: ModelOverride | null): void => {
    setModelOverride(v);
    saveModelOverride(activeSessionId, v);
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

  const busy = createSession.isPending || sendMessage.isPending || pendingUser !== null || streamBusy;

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
  const isRunning = streamBusy || sendMessage.isPending;
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
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
    // ── ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — send while the
    // agent works): a LIVE stream is running on this session → QUEUE the
    // message instead of refusing it. The POST validates server-side and
    // the user.queued SSE frame renders the chip; the optimistic push below
    // is belt-and-suspenders for a missed frame (deduped by seq in the
    // store). The one honest race: the turn can END between the Enter and
    // the POST — the sidecar answers 409 {code:"NO_LIVE_TURN"} and we FALL
    // THROUGH to the normal send path below exactly as if not busy (the
    // stale `busy` closure must not block the retry). Runs BEFORE the busy
    // guard for that reason. ──
    const liveSid = session?.id;
    if (busy && liveMode && streamBusy && liveSid !== undefined) {
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
      streaming={streamBusy}
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
        (hasPendingWriteInput && i === lastWorkSegIdx);
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

  return (
    <div
      className="flex flex-col h-full w-full min-w-0 rounded-[16px] overflow-hidden"
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
              density classes here carry py only. */}
          <div className={`${density === "compact" ? "py-4" : "py-5"} ${CONTENT_COL_CLASS} min-h-full flex flex-col gap-5`}>
            {/* ROUND-50 (R50-c2, owner: "When there is nothing, the very first
                chat… almost centered but a bit more towards the bottom half of
                the screen"): the greeting + suggestion chips sit ABOVE the
                composer; the composer is centered horizontally and pushed
                below the vertical middle by the 45/55 flex spacers (it
                reflows with the pane — never absolutely positioned); the
                bottom spacer keeps filling so there is no dead gap below. */}
            {items.length === 0 && !pendingEcho ? (
              <div
                data-empty-state
                className="flex-1 min-h-0 flex flex-col items-center text-center"
              >
                <div className="flex-[0.45] min-h-8" aria-hidden />
                <div className="flex flex-col items-center gap-4">
                  <AcuteLogo size={52} ariaLabel="Acute" />
                  <div className="min-w-0 max-w-md">
                    <div className="text-[22px] font-black tracking-tight leading-tight" style={{ color: styles.text }}>
                      How can I help with {project.name}?
                    </div>
                    <div className="text-[12.5px] mt-2 leading-relaxed" style={{ color: styles.textSecondary }}>
                      {agent?.name ?? "Acute"} · {agent?.model ?? "no model"} · streaming replies with live tool calls
                    </div>
                    {agents.length === 0 ? (
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
                      {SUGGESTIONS.map((s) => (
                        <button
                          key={s.label}
                          onClick={() => {
                            setInput(s.prompt);
                            inputRef.current?.focus();
                          }}
                          className="flex items-center gap-2 h-9 px-3.5 rounded-full border text-[12px] font-medium transition-all hover:-translate-y-px"
                          style={{
                            borderColor: styles.border,
                            background: styles.bg,
                            color: styles.textSecondary,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
                            e.currentTarget.style.color = styles.text;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = styles.border;
                            e.currentTarget.style.color = styles.textSecondary;
                          }}
                        >
                          <s.icon size={12} style={{ color: styles.accent }} className="shrink-0" />
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

            {/* ── ROUND-37 LIVE TURN: the Working section grows above the
                streaming presumptive-final text (which flows into the
                timeline as a full answer block the moment a tool lands —
                ROUND-64 R64-c segmentation). ── */}
            {liveTurn !== null ? (
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
                    className="mb-2 min-w-0 text-[11.5px] font-mono px-3 py-1.5 rounded-[10px] border"
                    style={{ borderColor: withAlpha("#f59e0b", 0.35), color: styles.textSecondary, background: withAlpha("#f59e0b", 0.05) }}
                  >
                    {liveTurn.note}
                  </div>
                ) : null}
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
                  <div className={`min-w-0 break-words text-[13px] leading-[1.65] ${liveTurn.working.length > 0 ? "mt-2" : ""}`} style={{ color: styles.text }}>
                    {/* ROUND-64 (R64-c): ChatMarkdown — the LIVE answer also
                        renders full markdown; partial markdown mid-stream is
                        fine (the parser is line-based, so the text renders
                        line-by-line as it arrives). */}
                    <ChatMarkdown content={liveTurn.streamText} projectId={projectId} />
                    {streamBusy && !liveTurn.stopped ? (
                      <span
                        className="inline-block w-[7px] h-[14px] ml-0.5 align-middle rounded-sm ac-caret-blink"
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
                      // same second copy option. The model is the panel's
                      // effective one (the send carried it — LiveTurn has no
                      // model of its own; the refetched folded turn carries
                      // the authoritative event-log model). Duration is
                      // measured from the live turn's clock.
                      debugMode
                        ? buildFullTurnText({
                            working: liveTurn.working,
                            finalText: liveTurn.streamText,
                            model: effectiveModel ?? undefined,
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
              <TurnStoppedCard ts={lastTurnStoppedTs} />
            ) : null}

            {/* ── ROUND-43: LIVE error card — the stream failed. Rendered
                immediately (before the refetch lands); the persisted
                turn.error item takes over once the folded log carries it
                (errorTs match above). User stops never set liveError. ── */}
            {liveError !== null && !liveErrorSuperseded ? (
              <TurnErrorCard
                error={liveError}
                sessionId={activeSessionId}
                onRetry={() => void runTurn(lastUserContent)}
                disabled={busy}
              />
            ) : null}
          </div>
        </div>
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
            className={`${CONTENT_COL_CLASS} mb-1.5 flex items-start gap-2 rounded-[12px] border py-2 text-[12px]`}
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
