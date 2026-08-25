import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  FileCode2,
  Globe,
  Settings2,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import {
  DIFF_TOOLS,
  parseDiffArgs,
  resolveSnapshotForTool,
  type DiffLine,
  type ToolUseEntry,
  type WorkingEntry,
  computeUnifiedDiff,
  fetchSessionCheckpoints,
  fetchSnapshot,
} from "../../lib/api";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { SubAgentCard } from "./SubAgentCard";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
// ROUND-38 (owner: "outright remove that option completely"): the
// Detailed/Compact/Hidden ActivityMode toggle is GONE from the chat. The
// store field remains for the Settings appearance page, but the Working
// section always renders detailed + collapses per the live/auto rules.

/**
 * WorkingSection (ROUND-37 — the owner's "two states" directive):
 *
 * > "In the working state it will show me the working progress… It will be a
 * > collapsible section. At the very top it will show me info like this:
 * > 'Working of 4' and then the timer will start continuing… When I click
 * > that it will expand it downwards and it will show me all the working
 * > progress… The thoughts will be only one line by default… while that
 * > thought is actually happening it will stay expanded and when the thought
 * > has been completed then it will collapse by itself. The same goes for
 * > the commands… one line too and I can click them and I will see the
 * > expanded view."
 *
 * Replaces the R32 ActivityBlock card: NO card chrome, NO icon tile, NO
 * "Completed N actions" banner — a borderless muted header
 * ("Working · 0:07" live / "Worked for 8s · 3 actions" done) over one-line
 * expandable rows (ThoughtRow / ToolLine / ApprovalRow / narration).
 * The turn's FINAL ANSWER renders OUTSIDE this section (in AgentChatPanel),
 * so collapsing the work never hides the answer.
 *
 * Sparkles/emoji iconography is deliberately absent (owner R37: "I really
 * hate the SVG icons… it looks ugly, bad, AI-generated").
 */

const TOOL_ICONS: Record<string, LucideIcon> = {
  list_dir: FileCode2,
  read_file: FileCode2,
  write_file: FileCode2,
  edit_file: FileCode2,
  create_dir: FileCode2,
  delete_file: FileCode2,
  web_search: Globe,
  web_fetch: Globe,
  search_code: FileCode2,
  search_files: FileCode2,
  git_status: FileCode2,
  git_diff: FileCode2,
  git_log: FileCode2,
  run_command: Terminal,
  todo_write: Settings2,
  index_project: Terminal,
  delegate_task: Terminal,
};

/** Past-tense verb labels (proposed2.PNG: "Analyzed …" one-liners). */
const TOOL_LABELS: Record<string, string> = {
  list_dir: "Listed",
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  create_dir: "Created",
  delete_file: "Deleted",
  search_files: "Searched",
  search_code: "Searched",
  git_status: "Checked",
  git_diff: "Diffed",
  git_log: "Logged",
  run_command: "Ran",
  todo_write: "Planned",
  web_search: "Searched",
  web_fetch: "Fetched",
  index_project: "Indexed",
  delegate_task: "Delegated",
};

/** Elapsed seconds between two ISO stamps (0 when unparseable). */
function elapsedSeconds(start: string, end: string): number {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

/** mm:ss for live timers; plain seconds for the folded label. */
function formatClock(totalMs: number): string {
  const s = Math.max(0, Math.floor(totalMs / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Ticking elapsed-seconds hook for LIVE sections (cleaned up on stop/unmount). */
function useLiveSeconds(startedAtMs: number | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAtMs === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAtMs]);
  if (startedAtMs === undefined || !running) return 0;
  return Math.max(0, Math.round((now - startedAtMs) / 1000));
}

// ─── ThoughtRow: one-line thought, click to expand ───────────────────────────

/**
 * Owner spec: "The thoughts will be only one line by default and when I tap
 * on them then it will expand and show me the full thoughts… While that
 * thought is actually happening it will stay expanded and when the thought
 * has been completed then it will collapse by itself."
 * → live rows auto-expand; completing (live→false) auto-collapses; a manual
 * tap always wins over the automation.
 */
export function ThoughtRow({
  text,
  thinkingMs,
  live = false,
}: {
  text: string;
  thinkingMs?: number;
  live?: boolean;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const userTouched = useRef(false);
  const prevLive = useRef(live);

  useEffect(() => {
    if (!userTouched.current) {
      if (live) setOpen(true); // in-flight → expanded
      else if (prevLive.current) setOpen(false); // just completed → collapse
    }
    prevLive.current = live;
  }, [live]);

  const trimmed = text.trim();
  if (trimmed === "") return null;
  const preview = trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed;
  const durationLabel =
    thinkingMs !== undefined && !live
      ? `Thought for ${Math.max(1, Math.round(thinkingMs / 1000))}s`
      : live
        ? "Thinking"
        : "Thought";

  return (
    <div className="min-w-0">
      <button
        onClick={() => {
          userTouched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} thought`}
        className="flex items-center gap-1.5 h-6 max-w-full px-1 -ml-1 rounded-md transition-colors"
        style={{ color: styles.textTertiary }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <ChevronDown
          size={10}
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
        <span className="text-[11px] font-semibold italic shrink-0">{durationLabel}</span>
        {live && <span className="ac-ellipsis" aria-hidden />}
        {!open && !live && (
          <span className="text-[10.5px] font-mono italic truncate max-w-[420px]" style={{ color: styles.textTertiary }}>
            {preview}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div
              className="mt-0.5 mb-1 rounded-[10px] pl-3 py-1.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-words max-h-64 overflow-y-auto auto-scroll border-l-2"
              style={{ borderColor: withAlpha(styles.accent, 0.25), color: styles.textSecondary }}
            >
              {trimmed}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Narration row: interim commentary inside the working area ──────────────

function NarrationRow({ content }: { content: string }) {
  const styles = useThemeStyles();
  // ROUND-38 (owner: the interim narration like "I'll research on this
  // topic for you" was faded/dulled — textTertiary — and should read as
  // normal body text). Slight weight to distinguish it from the final
  // answer, but full-opacity primary color.
  return (
    <div className="py-0.5 text-[12.5px] leading-[1.6]" style={{ color: styles.text }}>
      {content}
    </div>
  );
}

// ─── Diff detail (write_file / edit_file expanded body) ─────────────────────

function DiffDetail({ tool, sessionId }: { tool: ToolUseEntry; sessionId: string | null }) {
  const styles = useThemeStyles();
  // ROUND-38: open files in the right sidebar's Files tab (not the old center
  // Code panel). The active project is set by ChatFocusLayout.
  const openFileInSidebar = useRightSidebarStore((s) => s.openFile);
  const activeProjectId = useRightSidebarStore((s) => s.activeProjectId);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  const { path } = parseDiffArgs(tool.argsSummary);

  const checkpointsQuery = useQuery({
    queryKey: ["session-checkpoints", sessionId],
    queryFn: () => fetchSessionCheckpoints(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });

  const loadDiff = async () => {
    if (diffLines !== null || !sessionId) return;
    setLoading(true);
    try {
      const snapMeta = resolveSnapshotForTool(checkpointsQuery.data ?? [], path, tool.seq);
      const snap = snapMeta ? await fetchSnapshot(sessionId, snapMeta.seq) : null;
      setDiffLines(snap ? computeUnifiedDiff(snap.beforeContent, snap.afterContent) : []);
    } catch {
      setDiffLines([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDiff();
    // loadDiff depends on query state; mount is the trigger we care about.
  }, [checkpointsQuery.data]);

  const added = diffLines?.filter((l) => l.type === "add").length;
  const removed = diffLines?.filter((l) => l.type === "del").length;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1">
        {path ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]" style={{ color: styles.textTertiary }} title={path}>
            {path}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {diffLines !== null && added !== undefined && removed !== undefined ? (
          <span className="shrink-0 flex items-center gap-1 font-mono text-[10px] font-bold">
            <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}>
              +{added}
            </span>
            <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}>
              −{removed}
            </span>
          </span>
        ) : null}
        {path && (
          <button
            onClick={() => {
              if (activeProjectId !== null) openFileInSidebar(activeProjectId, path);
            }}
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold transition-colors"
            style={{ background: styles.subtle, color: styles.textSecondary }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
            title={`Open ${path}`}
          >
            Open
          </button>
        )}
      </div>
      {loading ? (
        <div className="px-3 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          loading diff…
        </div>
      ) : diffLines === null ? null : diffLines.length === 0 ? (
        <div className="px-3 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          no snapshot recorded for this change
        </div>
      ) : (
        <div
          className="rounded-[10px] max-h-72 overflow-y-auto auto-scroll font-mono text-[11px] leading-[1.55] border"
          style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.25)" : styles.bg }}
        >
          {diffLines.map((line, i) => (
            <div
              key={i}
              className="flex"
              style={{
                background:
                  line.type === "add"
                    ? withAlpha(SEMANTIC_COLORS.success, 0.07)
                    : line.type === "del"
                      ? withAlpha(SEMANTIC_COLORS.danger, 0.07)
                      : "transparent",
              }}
            >
              <span
                className="w-3 shrink-0 select-none text-center"
                style={{
                  color:
                    line.type === "add"
                      ? SEMANTIC_COLORS.success
                      : line.type === "del"
                        ? SEMANTIC_COLORS.danger
                        : styles.textTertiary,
                }}
              >
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-words pr-3" style={{ color: styles.text }}>
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Terminal detail (run_command expanded body) ────────────────────────────

function TerminalDetail({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  const [expanded, setExpanded] = useState(false);
  const output = tool.outputSummary ?? null;
  const lines = output ? output.split("\n").filter((l) => l.length > 0) : [];
  const preview = lines.slice(0, 3);
  const rest = lines.slice(3);
  if (output === null) {
    return (
      <div className="px-1 py-1 text-[10.5px] font-mono" style={{ color: styles.textTertiary }}>
        {tool.ok === null ? "running…" : "no output"}
      </div>
    );
  }
  return (
    <div
      className="rounded-[10px] border px-3 py-2 font-mono text-[10.5px] leading-[1.55] max-h-56 overflow-y-auto auto-scroll"
      style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)", color: styles.textSecondary }}
    >
      {preview.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">{line}</div>
      ))}
      {rest.length > 0 && (
        <>
          {expanded && rest.map((line, i) => (
            <div key={`r-${i}`} className="whitespace-pre-wrap break-words">{line}</div>
          ))}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[10px] font-bold underline"
            style={{ color: styles.accent }}
          >
            {expanded ? "Show less" : `+${rest.length} more line${rest.length === 1 ? "" : "s"}`}
          </button>
        </>
      )}
    </div>
  );
}

// ─── Output detail (default + web tools expanded body) ──────────────────────

function OutputDetail({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  if (tool.outputSummary === undefined || tool.outputSummary.length === 0) {
    return (
      <div className="px-1 py-1 text-[10.5px] font-mono" style={{ color: styles.textTertiary }}>
        {tool.ok === null ? "running…" : "no output"}
      </div>
    );
  }
  return (
    <div
      className="rounded-[10px] border px-3 py-2 font-mono text-[10.5px] leading-[1.55] max-h-48 overflow-y-auto auto-scroll whitespace-pre-wrap break-words"
      style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.22)" : "rgba(0,0,0,0.02)", color: styles.textSecondary }}
    >
      {tool.outputSummary}
    </div>
  );
}

// ─── ApprovalRow (ROUND-37 approvals — pending asks, resolved records) ──────

export type ApprovalDecisionChoice = "approved" | "denied";
export type ApprovalRemember = "once" | "always";

function ApprovalRow({
  entry,
  onDecision,
}: {
  entry: Extract<WorkingEntry, { type: "approval" }>;
  onDecision?: (approvalId: string, decision: ApprovalDecisionChoice, remember: ApprovalRemember) => void;
}) {
  const styles = useThemeStyles();
  const pending = entry.status === "pending";

  if (!pending) {
    const decisionText =
      entry.status === "approved"
        ? entry.remember === "always"
          ? "Always allowed"
          : "Allowed"
        : entry.status === "denied"
          ? "Denied"
          : "Expired";
    const tone =
      entry.status === "approved" ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger;
    return (
      <div className="flex items-center gap-2 h-7 px-1 -ml-1 font-mono text-[11px] min-w-0">
        <span className="shrink-0 font-semibold" style={{ color: tone }}>
          {decisionText}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ color: styles.textTertiary }}>
          {entry.argsSummary || entry.toolName}
        </span>
      </div>
    );
  }

  return (
    <div
      className="rounded-[12px] border-[1.5px] px-3 py-2.5 my-1"
      style={{
        borderColor: withAlpha("#f59e0b", 0.55),
        background: withAlpha("#f59e0b", styles.isDark ? 0.08 : 0.05),
      }}
      role="alert"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: "#f59e0b" }} aria-hidden />
        <span className="text-[11.5px] font-bold" style={{ color: styles.text }}>
          Permission needed
        </span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0" style={{ background: styles.subtle, color: styles.textTertiary }}>
          {entry.category}
        </span>
      </div>
      <div
        className="rounded-[8px] px-2.5 py-1.5 font-mono text-[11.5px] break-all mb-2"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.04)", color: styles.text }}
      >
        {entry.argsSummary || entry.toolName}
      </div>
      {onDecision ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecision(entry.approvalId, "approved", "once")}
            className="h-7 px-3 rounded-full text-[11px] font-bold transition-transform hover:scale-[1.02] active:scale-95"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            Allow once
          </button>
          <button
            onClick={() => onDecision(entry.approvalId, "approved", "always")}
            className="h-7 px-3 rounded-full text-[11px] font-bold border-[1.5px] transition-colors"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            Always allow
          </button>
          <button
            onClick={() => onDecision(entry.approvalId, "denied", "once")}
            className="h-7 px-3 rounded-full text-[11px] font-bold border-[1.5px] transition-colors"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            Deny
          </button>
          <span className="flex-1" />
          <span className="text-[10px] font-mono shrink-0" style={{ color: styles.textTertiary }}>
            waiting…
          </span>
        </div>
      ) : (
        <div className="text-[10.5px] font-mono" style={{ color: styles.textTertiary }}>
          waiting for decision…
        </div>
      )}
    </div>
  );
}

// ─── ToolLine: the universal one-line tool row ───────────────────────────────

function ToolLine({
  tool,
  sessionId,
  live = false,
}: {
  tool: ToolUseEntry;
  sessionId: string | null;
  live?: boolean;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const userTouched = useRef(false);
  const prevOk = useRef<boolean | null>(tool.ok);

  // ROUND-33 live behavior preserved: an in-flight write auto-expands the
  // moment it completes (the owner's "live file creation" moment).
  useEffect(() => {
    if (!userTouched.current && live && prevOk.current === null && tool.ok !== null && DIFF_TOOLS.has(tool.toolName)) {
      setOpen(true);
    }
    prevOk.current = tool.ok;
  }, [tool.ok, tool.toolName, live]);

  const Icon = TOOL_ICONS[tool.toolName] ?? Terminal;
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const waitingApproval = tool.ok === null && !live && tool.toolName === "run_command";

  const toggle = () => {
    userTouched.current = true;
    setOpen((v) => !v);
  };

  const expandable = (() => {
    if (tool.toolName === "delegate_task") return true;
    if (tool.outputSummary !== undefined && tool.outputSummary.length > 0) return true;
    if (DIFF_TOOLS.has(tool.toolName)) return true;
    if (tool.ok === null) return true;
    return false;
  })();

  return (
    <div className="min-w-0">
      <button
        onClick={expandable ? toggle : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${label} ${tool.argsSummary}`}
        title={`${tool.toolName} ${tool.argsSummary}`}
        className="flex items-center gap-2 h-7 w-full max-w-full px-1 -ml-1 rounded-md transition-colors text-left"
        style={{ color: styles.textTertiary, cursor: expandable ? "pointer" : "default" }}
        onMouseEnter={(e) => {
          if (expandable) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <Icon size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: styles.textSecondary }}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: styles.textTertiary }}>
          {tool.argsSummary}
        </span>
        <span
          className="shrink-0 w-4 text-center text-[11px]"
          style={{
            color: waitingApproval
              ? "#f59e0b"
              : tool.ok === false
                ? SEMANTIC_COLORS.danger
                : tool.ok === null
                  ? styles.textTertiary
                  : SEMANTIC_COLORS.success,
          }}
        >
          {waitingApproval ? "…" : tool.ok === null ? "…" : tool.ok ? "✓" : "✗"}
        </span>
        {expandable ? (
          <ChevronDown
            size={10}
            className="shrink-0"
            style={{ color: styles.textTertiary, transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
      </button>
      {open && (
        <div className="mt-0.5 mb-1 pl-4 min-w-0">
          {tool.toolName === "delegate_task" ? (
            <DelegateDetail tool={tool} sessionId={sessionId} live={live} />
          ) : DIFF_TOOLS.has(tool.toolName) ? (
            <DiffDetail tool={tool} sessionId={sessionId} />
          ) : tool.toolName === "run_command" ? (
            <TerminalDetail tool={tool} />
          ) : (
            <OutputDetail tool={tool} />
          )}
        </div>
      )}
    </div>
  );
}

/** delegate_task → SubAgentCard (ROUND-36 integration preserved). */
function DelegateDetail({
  tool,
  sessionId,
  live,
}: {
  tool: ToolUseEntry;
  sessionId: string | null;
  live: boolean;
}) {
  const hay = `${tool.argsSummary} ${tool.outputSummary ?? ""}`;
  const sessionMatch = /session: (sess_[A-Za-z0-9-]+)/.exec(hay);
  const roleMatch = /role: ([a-z]+)/.exec(hay);
  const taskMatch = /task: (.+?)(?:, role:|, session:|$)/.exec(tool.argsSummary);
  if (sessionMatch === null) {
    return <OutputDetail tool={tool} />;
  }
  return (
    <SubAgentCard
      sessionId={sessionMatch[1]}
      parentSessionId={sessionId}
      role={roleMatch?.[1]}
      task={taskMatch?.[1]}
      live={live}
    />
  );
}

// ─── The section itself ──────────────────────────────────────────────────────

export function WorkingSection({
  entries,
  sessionId,
  ts,
  endTs,
  live = false,
  startedAtMs,
  stopped = false,
  liveEntryIndex,
  defaultOpen,
  onApprovalDecision,
}: {
  entries: WorkingEntry[];
  sessionId: string | null;
  /** Turn start (folded turns). */
  ts?: string;
  /** Turn end (folded turns). */
  endTs?: string;
  /** Streaming now — the header counts up and pulses. */
  live?: boolean;
  /** Wall-clock turn start for the live timer. */
  startedAtMs?: number;
  /** Terminal state after a stream error — "Stopped", timer frozen. */
  stopped?: boolean;
  /** ROUND-37 review M1: index of the entry that is STILL STREAMING (the
   * in-flight thought) — only that row renders as "Thinking"; completed
   * thoughts collapse the moment their text starts. */
  liveEntryIndex?: number;
  /** ROUND-37 review #4: initial open state. Live sections ALWAYS open (the
   * owner watches progress); folded sections open per the Detailed
   * preference — unless collapseHint says the turn was just watched live.
   * ROUND-38: the Detailed/Compact/Hidden toggle is gone; folded turns
   * now start COLLAPSED (the owner's "Worked for Ns → click to expand"
   * design), live turns start expanded. */
  defaultOpen?: boolean;
  onApprovalDecision?: (approvalId: string, decision: ApprovalDecisionChoice, remember: ApprovalRemember) => void;
}) {
  const styles = useThemeStyles();
  // ROUND-38: no more activityMode toggle — folded turns collapse by default,
  // live turns expand; a manual tap always wins; live→false auto-collapses.
  const [expanded, setExpanded] = useState(defaultOpen ?? live);
  const userTouched = useRef(false);
  const prevLive = useRef(false);

  // LIVE turns expand to show progress, then AUTO-COLLAPSE on completion
  // (owner: the finished chat reads as answer + "Worked for Ns"). A manual
  // tap always wins. ROUND-38: the collapse is now a SMOOTH animated
  // transition (AnimatePresence + height/opacity) rather than a hard cut.
  useEffect(() => {
    if (live && !prevLive.current) {
      if (!userTouched.current) setExpanded(true);
      userTouched.current = false;
    } else if (!live && prevLive.current) {
      if (!userTouched.current) setExpanded(false);
    }
    prevLive.current = live;
  }, [live]);

  const liveSeconds = useLiveSeconds(startedAtMs, live && !stopped);
  const foldedSeconds = ts !== undefined && endTs !== undefined ? elapsedSeconds(ts, endTs) : 0;
  const seconds = live ? liveSeconds : foldedSeconds;

  const toolCount = entries.filter((e) => e.type === "tool").length;
  const pendingApproval = entries.some((e) => e.type === "approval" && e.status === "pending");

  const headerLabel = live
    ? stopped
      ? "Stopped"
      : "Working"
    : `Worked for ${seconds}s`;
  const actionSuffix = toolCount > 0 ? ` · ${toolCount} ${toolCount === 1 ? "action" : "actions"}` : "";

  return (
    <div className="min-w-0">
      <div
        className="flex items-center gap-2 h-7 max-w-full cursor-pointer select-none"
        onClick={() => {
          userTouched.current = true;
          setExpanded((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            userTouched.current = true;
            setExpanded((v) => !v);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${headerLabel}${actionSuffix}. ${expanded ? "Collapse" : "Expand"} work.`}
      >
        {live && !stopped ? (
          <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: styles.accent }} aria-hidden />
        ) : (
          <span className="w-1.5 h-1.5 shrink-0" aria-hidden />
        )}
        <span className="text-[11.5px] font-semibold truncate" style={{ color: styles.textSecondary }}>
          {headerLabel}
        </span>
        {live && !stopped && startedAtMs !== undefined ? (
          <span className="shrink-0 font-mono text-[10.5px]" style={{ color: styles.textTertiary }}>
            {formatClock(liveSeconds * 1000)}
          </span>
        ) : null}
        {pendingApproval ? (
          <span className="shrink-0 text-[10.5px] font-semibold" style={{ color: "#f59e0b" }}>
            · waiting for approval
          </span>
        ) : (
          <span className="shrink-0 text-[10.5px]" style={{ color: styles.textTertiary }}>
            {actionSuffix}
          </span>
        )}
        <span className="flex-1" />
        <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }} className="shrink-0">
          <ChevronDown size={12} style={{ color: styles.textTertiary }} />
        </motion.span>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="work-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="relative ml-[7px] pl-3.5 border-l-2 py-1 flex flex-col gap-0.5" style={{ borderColor: withAlpha(styles.accent, 0.22) }}>
              {entries.map((entry, i) => {
                if (entry.type === "thinking") {
                  return (
                    <ThoughtRow
                      key={`t-${i}`}
                      text={entry.text}
                      thinkingMs={entry.thinkingMs}
                      live={live && i === liveEntryIndex}
                    />
                  );
                }
                if (entry.type === "text") {
                  return <NarrationRow key={`t-${i}`} content={entry.content} />;
                }
                if (entry.type === "tool") {
                  return <ToolLine key={`t-${entry.tool.seq}`} tool={entry.tool} sessionId={sessionId} live={live} />;
                }
                return <ApprovalRow key={`t-${i}`} entry={entry} onDecision={onApprovalDecision} />;
              })}
              {live && entries.length === 0 ? (
                <div className="flex items-center gap-2 h-7">
                  <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                    starting<span className="ac-ellipsis" aria-hidden />
                  </span>
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Bare (section-less) rendering for turns with thoughts but NO tools —
 * amendment #7: a thinking-only turn shows a bare ThoughtRow, no header. */
export function BareWorkingEntries({
  entries,
  onApprovalDecision,
}: {
  entries: WorkingEntry[];
  onApprovalDecision?: (approvalId: string, decision: ApprovalDecisionChoice, remember: ApprovalRemember) => void;
}) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.type === "thinking") {
          return <ThoughtRow key={`b-${i}`} text={entry.text} thinkingMs={entry.thinkingMs} />;
        }
        if (entry.type === "text") {
          return <NarrationRow key={`b-${i}`} content={entry.content} />;
        }
        if (entry.type === "approval") {
          return <ApprovalRow key={`b-${i}`} entry={entry} onDecision={onApprovalDecision} />;
        }
        return null; // tool entries imply a section — handled by the caller
      })}
    </>
  );
}
