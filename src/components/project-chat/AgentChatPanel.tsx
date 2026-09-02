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
  Check,
  Copy,
  File,
  FolderOpen,
  GitBranch,
  History,
  ListChecks,
  MessageSquareText,
  Search,
  Square,
  ThumbsDown,
  ThumbsUp,
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
import {
  BareWorkingEntries,
  WorkingSection,
  type ApprovalDecisionChoice,
  type ApprovalRemember,
} from "./WorkingSection";
import { AcuteLogo } from "../shell/Sidebar";
import { ClampedText } from "../shared/ClampedText";
import {
  type AttachmentRef,
  type AssistantTurnItem,
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
  listSessionRatings,
  patchSessionPermissions,
  rateReply,
  toProjectChatItems,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStore } from "../../lib/theme-store";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useActiveStreams } from "../../lib/active-streams";
import { useStreamStore } from "../../lib/stream-store";
import { fmtBytes, fmtTokens, formatTime } from "../../lib/format";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
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
 * 1200px and 2560px, so wide windows never stretch lines nor hug content. */
const CONTENT_COL_CLASS = "mx-auto w-full max-w-[1080px]";

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

/** Hover copy button with a "Copied" flash (round-16 owner request). */
function CopyButton({ text }: { text: string }) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          resetAfter(() => setCopied(false), 1200);
        });
      }}
      aria-label="Copy message"
      title="Copy"
      className="w-6 h-6 rounded-md grid place-items-center transition-colors"
      style={{ color: styles.textTertiary }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {copied ? <Check size={11} style={{ color: SEMANTIC_COLORS.success }} /> : <Copy size={11} />}
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
}: {
  sessionId: string | null;
  /** R59-D rating key — the turn's LAST non-empty assistant text seq
   * (undefined on working-only turns → no rating cluster). */
  assistantSeq: number | undefined;
  copyText: string;
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
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
        <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
          <CopyButton text={copyText} />
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

/** The ts of a working entry (tool entries carry it on the tool). */
function workingEntryTs(entry: WorkingEntry): string {
  return entry.type === "tool" ? entry.tool.ts : entry.ts;
}

/** Split a turn's working entries into ordered segments: intermediate TEXT
 * entries become standalone answer blocks; every contiguous run of the
 * OTHER entries (tool/thinking/approval) becomes one work segment rendered
 * at its timeline position. The final answer keeps rendering last (the
 * caller's finalText) exactly as before. */
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
}: {
  item: AssistantTurnItem;
  sessionId: string | null;
  /** ROUND-40: threaded from AgentChatPanel so the answer renderers +
   * WorkingSection can open files / sub-agents in the right sidebar. */
  projectId: string;
  /** R37 review #4: true when this turn JUST finished while the user
   * watched — it mounts collapsed ("Worked for Ns" + answer). */
  collapseHint?: boolean;
}) {
  const styles = useThemeStyles();
  const segments = segmentWorkingEntries(item.working);
  const hasToolWork = item.working.some((e) => e.type === "tool");
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="group min-w-0">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <IntermediateAnswer key={`seg-text-${i}`} content={seg.content} projectId={projectId} />
        ) : seg.entries.some((e) => e.type === "tool") ? (
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
      <TurnFooter
        sessionId={sessionId}
        assistantSeq={item.lastAssistantSeq}
        copyText={item.finalText}
        usage={item.usage}
        ms={item.ms}
        model={item.model}
      />
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
    Partial<Pick<ErrorTurnItem, "model" | "providerId" | "providerError">>;
  sessionId: string | null;
  /** Zero-arg — the PANEL binds the failed turn's user text before calling. */
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const reason = error.providerError ?? error.message;
  const shortReason = reason.length > 220 ? `${reason.slice(0, 220)}…` : reason;
  const detailsText = [
    "Generation failed",
    `Session: ${sessionId ?? "unknown"}`,
    `Model: ${error.model ?? "unknown"}`,
    ...(error.providerId ? [`Provider: ${error.providerId}`] : []),
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
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
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
          </div>
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
  }
>(function MessageRenderer(
  { item, sessionId, projectId, collapseHint, onRetry, retryDisabled, onRevert, revertDisabled, attachments },
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
    case "turn":
      return (
        <div ref={ref}>
          <AssistantTurn item={item} sessionId={sessionId} projectId={projectId} collapseHint={collapseHint} />
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
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items.length, busy, pendingUser, liveWorkingCount, liveTailText.length]);

  const runTurn = async (content: string, composerAttachments: ComposerAttachment[] = []) => {
    const text = content.trim();
    if (!text || busy || !agent) return;
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
        useStreamStore.getState().setPendingEcho(sid, text);
        await useStreamStore.getState().startStream(sid, text, {
          model: effectiveModel ?? undefined,
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
        // The live turn is now folded into the event log; clear the store's
        // echo + liveTurn for this session (the folded turn owns the render).
        useStreamStore.getState().setPendingEcho(sid, null);
        // ROUND-58 (R58-cf): a USER STOP clears the live turn TOO — unlike an
        // error, the backend FLUSHES the stopped turn's partial text, so the
        // refetched folded log carries it and the frozen live copy would
        // duplicate it. The stop signal is re-armed after the clear so the
        // Stopped card + Continue affordance persist until the next send.
        const slice = useStreamStore.getState().bySession[sid];
        const wasUserStopped = slice?.liveTurn?.stoppedByUser === true;
        if (slice?.liveTurn && (!slice.liveTurn.stopped || wasUserStopped)) {
          // The folded turn owns the render now; clear the live section.
          useStreamStore.getState().clearStream(sid);
          useActiveStreams.getState().stop(sid);
          if (wasUserStopped) {
            useStreamStore.getState().setLastTurnStoppedByUser(sid, true);
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
      // R37 review #1: the session query key is ["session", source, id] —
      // an exact-hash lookup without the source segment never matched.
      const hasResponse = queryClient.getQueryData([
        "session",
        liveMode ? "live" : "demo",
        session?.id ?? sid,
      ]);
      if (!hasResponse) {
        setSendError(err instanceof Error ? err.message : String(err));
      } else {
        setSendError(null);
      }
    } finally {
      // Drop the optimistic local echo (the store's pendingEcho was cleared
      // above for live mode; for demo mode it's the local pendingUser).
      setPendingUser(null);
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
  // The ConfirmDialog body quotes the first ~60 chars of the targeted user
  // message so the owner can see EXACTLY which message the rewind keeps.
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
      // The hook's onSettled invalidates the exact session keys; these
      // prefix-wide invalidations mirror the send path so the folded log +
      // sidebar refresh before the toast lands.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pushLocalToast(
        "Reverted",
        `Removed ${result.removedCount} event${result.removedCount === 1 ? "" : "s"} after message #${target.seq}.`,
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
      const isWork = seg.entries.some((e) => e.type === "tool") || (hasPendingWriteInput && i === lastWorkSegIdx);
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
      {/* ROUND-44 (R44-c): revert confirmation — destructive log truncation. */}
      <ConfirmDialog
        open={revertTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevertTarget(null);
        }}
        title="Revert session?"
        body={`Removes the reply and everything after “${revertSnippet}”. This cannot be undone.`}
        confirmLabel="Revert"
        onConfirm={() => void onRevertConfirm()}
      />
      {/* Scroll body with top fade (demo structure) */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
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
          {/* ROUND-34: density (settings appearance) drives the column padding.
              ROUND-37: the panel fills its width (owner: no dead right side).
              ROUND-39: wrapper is min-h-full + flex-col so SHORT content
              sticks to the bottom (just above the composer) — no dead
              vertical gap below the last message (owner screenshot showed
              big empty space). When content overflows, the spacer collapses
              to 0 and natural scroll takes over.
              ROUND-43 (owner: dead space on the right at LARGE windows): the
              panel root now fills its column (w-full above) AND the reading
              column caps at CONTENT_MAX_WIDTH centered — wide windows get a
              symmetric readable column instead of either stretched lines or
              content-hugging with a void on the right. */}
          <div className={`${density === "compact" ? "px-4 py-4" : "px-5 md:px-10 py-5"} ${CONTENT_COL_CLASS} min-h-full flex flex-col gap-5`}>
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
                {/* The composer itself — centered, slightly below the middle. */}
                <div className={CONTENT_COL_CLASS}>{renderComposer(true)}</div>
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
              {items.map((item) => (
                <MessageRenderer
                  key={itemKey(item)}
                  item={item}
                  sessionId={session?.id ?? null}
                  projectId={projectId}
                  collapseHint={Date.now() - lastLiveEndRef.current < 5000}
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
                />
              ))}
              {pendingEcho !== null ? (
                <MessageRenderer
                  item={{ kind: "user", seq: -1, content: pendingEcho, ts: new Date().toISOString() }}
                  sessionId={null}
                  projectId={projectId}
                  {...(pendingEchoAttachments !== null ? { attachments: pendingEchoAttachments } : {})}
                />
              ) : null}
            </AnimatePresence>

            {/* ── ROUND-37 LIVE TURN: the Working section grows above the
                streaming presumptive-final text (which flows into the
                timeline as a full answer block the moment a tool lands —
                ROUND-64 R64-c segmentation). ── */}
            {liveTurn !== null ? (
              <div aria-live="polite" aria-atomic="false" className="group min-w-0">
                {liveSection}
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
                  />
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
        <div className="shrink-0 px-2.5">
          <div
            role="alert"
            className={`${CONTENT_COL_CLASS} mb-1.5 flex items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px]`}
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
          row, same capped reading column as the messages). */}
      {composerDocked ? (
        <div
          className={`shrink-0 border-t ${compact ? "p-2" : "p-2.5"}`}
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
