import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  FileCode2,
  Globe,
  Loader2,
  PanelRightOpen,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import {
  DIFF_TOOLS,
  fetchSubAgents,
  parseDiffArgs,
  resolveSnapshotForTool,
  restoreCheckpoint,
  stopSessionTurn,
  type DiffLine,
  type SubAgentStatus,
  type ToolUseEntry,
  type WorkingEntry,
  computeUnifiedDiff,
  fetchSessionCheckpoints,
  fetchSnapshot,
} from "../../lib/api";
import { pushLocalToast } from "../../hooks/use-notifications";
import {
  selectSubAgentsLive,
  useStreamStore,
  type LiveToolUseEntry,
  type StreamingToolInput,
} from "../../lib/stream-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { SubAgentCard } from "./SubAgentCard";
// ROUND-68 (R68-A): the INLINE screenshot row — one per `screenshot`
// WorkingEntry, rendered at its capture moment between the tool rows.
import { ScreenshotRow } from "./ScreenshotRow";
import { extractStringArg } from "./streaming-args";
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
 *
 * ROUND-52 (R52-c, owner: "After running the commands, it should actually
 * show the terminal interface of those commands too"): an in-flight
 * run_command pill renders a compact LIVE terminal tail (LiveOutputTail)
 * under it while the command streams — tool-output chunks the stream-store
 * accumulates on the entry (see LiveOutputTail for the display rules).
 *
 * ROUND-68 (R68-A, owner: "The screenshots were supposed to be shown
 * properly when they were actually taken, not at the bottom in a dedicated
 * section. When the screenshots were taken they should be shown at that
 * specific time."): the section's row map now interleaves INLINE
 * ScreenshotRow tiles with the tool rows — one per `screenshot`
 * WorkingEntry, at the entry's list position (the capture moment), not in
 * the R67-D bottom strip (deleted). The rows are live-only: the folded log
 * never persists rasters, so only a live (or stopped) turn can carry them.
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

/** ROUND-52 (R51-d): the in-flight blue for pending tool rows — the same
 * value as SubAgentPanel's RUNNING_BLUE (kept local: that panel owns the
 * canonical const; this file only borrows the hue for in-flight states). */
const RUNNING_BLUE = "#3B82F6";

/** ROUND-58 (R58-cf): stable empty default for the pending-write-inputs
 * derive (the store selector returns undefined for folded sections — a
 * fresh [] there would re-render on every store tick). */
const EMPTY_STREAMING_INPUTS: StreamingToolInput[] = [];

/** Elapsed seconds between two ISO stamps (0 when unparseable). */
function elapsedSeconds(start: string, end: string): number {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

/** ROUND-52 (R52-c): the amber warning tone for the stalled-watch line
 * (same value SubAgentPanel uses — a semantic, theme-stable warning color). */
const AMBER = "#f59e0b";

/** Compact token count (same formatting as the SubAgentCard rows). */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// ─── ROUND-48 (R48-e2): live Delegated rows ──────────────────────────────────

/**
 * ROUND-64 (R64-c, owner: "Below it showed me 'Delegated task' and then the
 * description… When I expanded any one of them, it showed me all three or
 * so sub-agents which were active. This was not good."): claim-match the
 * parent's live children to the turn's delegate_task rows — every PENDING
 * row owns EXACTLY ONE child instead of all of them. Assignment rules
 * (deterministic, computed from data the caller already has):
 *   1. a COMPLETED delegate row claims the child session id parsed from its
 *      own output (`session: sess_…`) — that child is taken even if it is
 *      still running;
 *   2. each PENDING row, in timeline order, claims the EARLIEST-CREATED
 *      running/queued child not taken by (1) or an earlier pending row;
 *   3. a pending row with no unclaimed child claims NOTHING (it renders the
 *      quiet "delegating…" beat).
 * Keyed by the tool row's seq (the same key WorkingSection renders rows
 * by). Pure; exported for tests.
 */
export function assignDelegateChildren(
  entries: WorkingEntry[],
  children: SubAgentStatus[],
): Map<number, string | null> {
  const claims = new Map<number, string | null>();
  const taken = new Set<string>();
  // (1) completed rows claim their parsed session ids.
  for (const entry of entries) {
    if (entry.type !== "tool" || entry.tool.toolName !== "delegate_task" || entry.tool.ok === null) {
      continue;
    }
    const hay = `${entry.tool.argsSummary} ${entry.tool.outputSummary ?? ""}`;
    const m = /session: (sess_[A-Za-z0-9-]+)/.exec(hay);
    if (m !== null) taken.add(m[1]);
  }
  // (2) pending rows, in order, claim the earliest-created live child.
  const live = children
    .filter((c) => (c.status === "running" || c.status === "queued") && !taken.has(c.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let next = 0;
  for (const entry of entries) {
    if (entry.type !== "tool" || entry.tool.toolName !== "delegate_task" || entry.tool.ok !== null) {
      continue;
    }
    const child = next < live.length ? live[next] : undefined;
    next += 1;
    if (child === undefined) {
      claims.set(entry.tool.seq, null);
    } else {
      taken.add(child.id);
      claims.set(entry.tool.seq, child.id);
    }
  }
  return claims;
}

/**
 * ROUND-48 (R48-e2, owner: "no option in the main chat to click the Delegated
 * card… it was just saying Running Running Running"): the shared poll of the
 * parent's children (GET /sessions/:id/subagents). While ANY row is queued/
 * running it refetches every ~1.2s — the Delegated card's live rows + the
 * single-live-child affordance read from it, joined with the stream-store's
 * live map (fresher status + lastActivity straight off the SSE frames). The
 * same ["subagents", id] query key the picker + SubAgentCard use — one cache.
 */
function useDelegateChildren(parentSessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["subagents", parentSessionId],
    queryFn: () => fetchSubAgents(parentSessionId as string),
    enabled: enabled && parentSessionId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      const anyLive = (data ?? []).some(
        (s) => s.status === "running" || s.status === "queued",
      );
      return anyLive ? 1200 : false;
    },
  });
}

/** The monospace 4-char code badge — the owner's quick-identify mark for a
 * sub-agent (picker rows, Delegated rows, panel header, approval cards). */
export function SubAgentCodeChip({
  code,
  title,
}: {
  code: string;
  title?: string;
}) {
  const styles = useThemeStyles();
  return (
    <span
      className="shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-[0.08em]"
      style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
      title={title ?? `Sub-agent code ${code}`}
      data-testid="subagent-code-chip"
    >
      {code}
    </span>
  );
}

/** One LIVE child row inside the expanded Delegated card: code chip + role +
 * title + status + todo progress + tokens + the child's current activity
 * (from the stream-store live map — the freshest tool summary, no poll lag).
 * Clicking opens the child's chat tab in the right sidebar.
 * ROUND-52 (R52-c): running rows carry a STOP button (the owner: stop a
 * sub-agent "just like how I can stop the main agent" — same server route)
 * and the supervisor's watch sample (age · tools · todos · elapsed). */
function LiveDelegateRow({
  child,
  live,
  parentSessionId,
  projectId,
}: {
  child: SubAgentStatus;
  live: ReturnType<typeof selectSubAgentsLive>[string] | undefined;
  parentSessionId: string;
  projectId: string;
}) {
  const styles = useThemeStyles();
  const [stopping, setStopping] = useState(false);
  const code = live?.code ?? child.code;
  const role = live?.role ?? child.subRole ?? "agent";
  const status = live?.status ?? child.status;
  const todosDone = live?.todosDone ?? child.todosDone;
  const todosTotal = live?.todosTotal ?? child.todosTotal;
  const title = child.title ?? live?.task ?? "sub-agent task";
  const watch = live?.watch;
  const tone =
    status === "completed"
      ? SEMANTIC_COLORS.success
      : status === "failed"
        ? SEMANTIC_COLORS.danger
        : styles.accent;

  const open = () => {
    useRightSidebarStore
      .getState()
      .openSubAgent(projectId, parentSessionId, child.id, `${code} · ${title}`, child.subRole ?? undefined);
  };

  // ROUND-52 (R52-c): the owner's manual stop — POST /sessions/:id/stop works
  // for children now (the orchestrator registers them in the shared turn
  // registry). Optimistic "stopping" chip; the terminal frame + detail line
  // land through the same live map.
  const stopChild = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (stopping || status !== "running") return;
    setStopping(true);
    void stopSessionTurn(child.id).finally(() => setStopping(false));
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="w-full rounded-[10px] border px-2 py-1.5 text-left cursor-pointer transition-colors"
      style={{ borderColor: withAlpha(tone, 0.35), background: styles.card }}
      aria-label={`Open sub-agent ${code} · ${title} in sidebar`}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = withAlpha(tone, 0.06);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = styles.card;
      }}
      data-testid="live-delegate-row"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <SubAgentCodeChip code={code} />
        <span
          className="shrink-0 text-[9px] font-black uppercase tracking-widest"
          style={{ color: tone }}
        >
          {role}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" style={{ color: styles.textSecondary }} title={title}>
          {title}
        </span>
        <span
          className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full"
          style={{ background: withAlpha(tone, 0.12), color: tone }}
        >
          {stopping ? "stopping…" : status}
        </span>
        {todosTotal > 0 ? (
          <span className="shrink-0 text-[9px] font-mono" style={{ color: styles.textTertiary }}>
            {todosDone}/{todosTotal} todos
          </span>
        ) : null}
        {child.inputTokens > 0 || child.outputTokens > 0 ? (
          <span className="shrink-0 text-[9px] font-mono" style={{ color: styles.textTertiary }}>
            ↑{fmtTokens(child.inputTokens)} ↓{fmtTokens(child.outputTokens)}
          </span>
        ) : null}
        {status === "running" ? (
          <button
            type="button"
            onClick={stopChild}
            disabled={stopping}
            aria-label={`Stop sub-agent ${code}`}
            title="Stop this sub-agent (the parent keeps running)"
            className="shrink-0 w-6 h-6 grid place-items-center rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: SEMANTIC_COLORS.danger }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = withAlpha(SEMANTIC_COLORS.danger, 0.1);
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            data-testid="stop-subagent-btn"
          >
            <Square size={11} fill="currentColor" strokeWidth={0} />
          </button>
        ) : null}
      </div>
      {live?.lastActivity !== undefined ? (
        <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
          {status === "running" ? (
            <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: tone }} aria-hidden />
          ) : null}
          <span
            className="min-w-0 flex-1 truncate font-mono text-[10px]"
            style={{
              color: watch?.stalled === true ? AMBER : styles.textTertiary,
            }}
            title={live.lastActivity}
          >
            {live.lastActivity}
          </span>
          {/* ROUND-52 (R52-c): the supervisor's heartbeat sample — run age ·
              tool count; amber when the child looks stalled. */}
          {watch !== undefined && status === "running" ? (
            <span
              className="shrink-0 font-mono text-[9px]"
              style={{ color: watch.stalled ? AMBER : styles.textTertiary }}
              title={
                watch.stalled
                  ? `No activity for ${Math.round(watch.lastEventAgeMs / 1000)}s — the supervisor is watching`
                  : `Running for ${Math.round(watch.elapsedMs / 1000)}s · ${watch.toolCount} tool calls`
              }
            >
              {watch.stalled
                ? `no activity ${Math.round(watch.lastEventAgeMs / 1000)}s`
                : `${Math.round(watch.elapsedMs / 1000)}s · ${watch.toolCount} tools`}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* ROUND-52 (R52-c): WHY a terminal frame fired — "stopped by the
          owner" / "stalled — …" — instead of a bare failed chip. */}
      {live?.detail !== undefined && (status === "failed" || status === "completed") ? (
        <div className="mt-0.5 text-[9.5px] font-medium truncate" style={{ color: styles.textTertiary }}>
          {live.detail}
        </div>
      ) : null}
    </div>
  );
}

/** The pending delegate_task body: every LIVE child of this parent as a
 * clickable row (plus a quiet "delegating…" beat before the first child
 * appears). Replaced by SubAgentCard the moment the tool result lands.
 * Pure render — the data hooks live in DelegateDetail (unconditional hook
 * order; the pending → completed transition swaps branches safely). */
function LiveDelegateRows({
  rows,
  liveMap,
  parentSessionId,
  projectId,
}: {
  rows: SubAgentStatus[];
  liveMap: ReturnType<typeof selectSubAgentsLive>;
  parentSessionId: string;
  projectId: string;
}) {
  const styles = useThemeStyles();
  if (rows.length === 0) {
    return (
      <div className="px-1 py-1 text-[10.5px] font-mono" style={{ color: styles.textTertiary }}>
        delegating<span className="ac-ellipsis" aria-hidden />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 min-w-0">
      {rows.map((child) => (
        <LiveDelegateRow
          key={child.id}
          child={child}
          live={liveMap[child.id]}
          parentSessionId={parentSessionId}
          projectId={projectId}
        />
      ))}
    </div>
  );
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
            {/* ROUND-58 (R58-cf, owner: "On the thought section… on the left
                side of it there is a weird AI kind of highlighting, which is
                not good"): the body is now a clean self-contained notes
                block — rounded, a very subtle neutral wash (styles.subtle),
                mono, relaxed leading. NO left border rail, NO accent color on
                the container (Linear/Notion-quiet, not AI glow). The
                collapse/expand chevron, Thinking… label and "Thought for Ns"
                duration above stay exactly as they were. */}
            <div
              className="mt-0.5 mb-1 rounded-[10px] px-3 py-1.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-words max-h-64 overflow-y-auto auto-scroll"
              style={{ background: styles.subtle, color: styles.textSecondary }}
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
  // ROUND-43: min-w-0 + break-words — a long unbreakable token in a
  // narration can never widen the chat column (the owner's bottom-scrollbar
  // bug); it wraps like every other text row.
  return (
    <div className="min-w-0 break-words py-0.5 text-[12.5px] leading-[1.6]" style={{ color: styles.text }}>
      {content}
    </div>
  );
}

// ─── Diff detail (write_file / edit_file expanded body) ─────────────────────

function DiffDetail({ tool, sessionId }: { tool: ToolUseEntry; sessionId: string | null }) {
  const styles = useThemeStyles();
  // ROUND-46 (R46-c): restore invalidates the explorer tree + open file
  // views (the file on disk changes under them).
  const queryClient = useQueryClient();
  // ROUND-38: open files in the right sidebar's Files tab (not the old center
  // Code panel). The active project is set by ChatFocusLayout.
  const openFileInSidebar = useRightSidebarStore((s) => s.openFile);
  const activeProjectId = useRightSidebarStore((s) => s.activeProjectId);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  // ROUND-46 (R46-c): the restore target — the resolved snapshot's id, armed
  // only when a full snapshot was fetched AND it carries before content.
  const [restoreTarget, setRestoreTarget] = useState<{ id: string } | null>(null);
  // ROUND-46 (R46-c): two-step destructive-confirm state for restore.
  const [restoreState, setRestoreState] = useState<"idle" | "confirm" | "restoring" | "restored">(
    "idle",
  );

  const { path } = parseDiffArgs(tool.argsSummary);

  const checkpointsQuery = useQuery({
    queryKey: ["session-checkpoints", sessionId],
    queryFn: () => fetchSessionCheckpoints(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });

  const loadDiff = async () => {
    // ROUND-46 (R46-c) RACE FIX: while the checkpoints list is still in
    // flight, resolving against `?? []` finds nothing and bakes "no snapshot
    // recorded" forever — the `diffLines !== null` guard below then blocks
    // the re-run once the data actually arrives (the first diff card to
    // mount hit exactly this). Wait for the query; the effect re-fires on
    // the pending → settled transition (data arrival, and errors where
    // data stays undefined).
    if (checkpointsQuery.isLoading) return;
    if (diffLines !== null || !sessionId) return;
    setLoading(true);
    try {
      const resolved = resolveSnapshotForTool(checkpointsQuery.data ?? [], path, tool.seq);
      const snap = resolved ? await fetchSnapshot(sessionId, resolved.seq) : null;
      setDiffLines(snap ? computeUnifiedDiff(snap.beforeContent, snap.afterContent) : []);
      // ROUND-46 (R46-c): Restore targets the snapshot's BEFORE content. A
      // create (beforeContent === null) has nothing to go back to — and the
      // backend's restore of a create DELETES the file (unlink branch) — so
      // the action is deliberately NOT armed for creates.
      setRestoreTarget(
        snap !== null && snap.beforeContent !== null && resolved !== null
          ? { id: resolved.id }
          : null,
      );
    } catch {
      setDiffLines([]);
      setRestoreTarget(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDiff();
    // loadDiff depends on query state; mount + data arrival are the triggers
    // we care about.
  }, [checkpointsQuery.data, checkpointsQuery.isLoading]);

  // ROUND-46 (R46-c): restore the recorded BEFORE content over the file on
  // disk. Never a single-click destructive action (two-step confirm below).
  // The stored snapshot row itself is untouched — the diff above keeps
  // showing the recorded history (honest note rendered once restored).
  const onRestore = async () => {
    if (restoreTarget === null || restoreState === "restoring") return;
    setRestoreState("restoring");
    try {
      const result = await restoreCheckpoint(restoreTarget.id);
      setRestoreState("restored");
      // The file on disk changed under the explorer tree + any open file
      // view — the same invalidation keys the live-turn send path uses.
      void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["project-file"] });
      pushLocalToast("File restored", result.message);
    } catch (err) {
      // 404/409/500 with the server's message — persistent toast so it
      // isn't missed, back to idle so the owner can retry.
      setRestoreState("idle");
      pushLocalToast(
        "Restore failed",
        err instanceof Error ? err.message : String(err),
        "task_failed",
      );
    }
  };

  // ROUND-46 (R46-c): the Restore affordance, styled like the Open pill
  // (h-5 px-2 rounded-full text-[10px] font-bold) so it reads as one family.
  const restoreUi = (() => {
    if (restoreState === "restoring") {
      return (
        <button
          disabled
          aria-live="polite"
          title="Restoring the file to its content before this change…"
          className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold flex items-center gap-1 cursor-default"
          style={{ background: styles.subtle, color: styles.textSecondary }}
        >
          <Loader2 size={10} className="animate-spin" /> Restoring…
        </button>
      );
    }
    if (restoreState === "restored") {
      return (
        <span
          className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold flex items-center gap-1"
          style={{
            background: withAlpha(SEMANTIC_COLORS.success, 0.12),
            color: SEMANTIC_COLORS.success,
          }}
        >
          <RotateCcw size={10} /> Restored
        </span>
      );
    }
    if (restoreTarget === null || diffLines === null) return null;
    if (restoreState === "confirm") {
      return (
        <>
          <button
            onClick={() => void onRestore()}
            title="Overwrite the file on disk with its recorded content from before this change"
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold border-[1.5px] transition-colors flex items-center gap-1"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            <RotateCcw size={10} /> Confirm restore?
          </button>
          <button
            onClick={() => setRestoreState("idle")}
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold transition-colors"
            style={{ background: styles.subtle, color: styles.textSecondary }}
          >
            Cancel
          </button>
        </>
      );
    }
    return (
      <button
        onClick={() => setRestoreState("confirm")}
        title="Restore the file on disk to its content from before this change"
        className="shrink-0 h-5 px-2 rounded-full text-[10px] font-bold transition-colors flex items-center gap-1"
        style={{ background: styles.subtle, color: styles.textSecondary }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
      >
        <RotateCcw size={10} /> Restore
      </button>
    );
  })();

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
        {restoreUi}
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
      {restoreState === "restored" && (
        <div className="mt-1 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
          File restored on disk — the diff above is the recorded history; the
          stored snapshot is unchanged.
        </div>
      )}
    </div>
  );
}

// ─── ROUND-52 (R52-c): the LIVE terminal tail of a running command ────────

/**
 * ROUND-52 (R52-c, owner: "After running the commands, it should actually
 * show the terminal interface of those commands too"): the compact live
 * tail rendered UNDER an in-flight run_command pill while the command
 * streams. The store accumulates tool-output chunks (capped ~4KB); this
 * view keeps only the LAST ~10 lines, stick-to-bottom scrolled (never yank
 * the user's scroll — the pinned-bottom check is the panel's convention),
 * with a tiny pulsing "live" indicator. The matching tool-result CLEARS the
 * tail — the settled pill's expanded body shows the final output, never
 * both. Shared with SubAgentPanel's transcript tool rows (same treatment
 * for subagent-event inner tool-output frames).
 */
export function LiveOutputTail({ output }: { output: string }) {
  const styles = useThemeStyles();
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether the user scrolled up (stop auto-scrolling then).
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // New chunks arrive → keep the bottom pinned while the user is at it.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Display: the LAST ~10 lines of the accumulated tail.
  const shown = output.split("\n").slice(-10);
  return (
    <div className="mt-0.5 mb-1 pl-4 min-w-0" data-testid="live-command-output">
      <div className="flex items-center gap-1.5 h-4 px-0.5">
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: RUNNING_BLUE }} aria-hidden />
        <span
          className="text-[9px] font-mono font-bold uppercase tracking-[0.14em]"
          style={{ color: RUNNING_BLUE }}
        >
          live
        </span>
      </div>
      <div
        ref={ref}
        className="rounded-[10px] border px-2.5 py-1.5 max-h-32 overflow-y-auto auto-scroll font-mono text-[10px] leading-[1.5] break-words"
        style={{
          borderColor: withAlpha(RUNNING_BLUE, 0.35),
          background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)",
          color: styles.textSecondary,
        }}
      >
        {shown.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ROUND-58 (R58-cf): the LIVE write preview of a streaming file write ────

/** Rendering cap for the preview BODY (~8KB tail — the store already caps the
 * raw at 256KB; the box shows what is being written RIGHT NOW, and a 250KB
 * text node would jank the chat column). */
const MAX_WRITE_PREVIEW_CHARS = 8_000;

/**
 * ROUND-58 (R58-cf, owner: "no live preview while the agent WRITES files —
 * the file diff only appears after the tool completes"): the compact live
 * write preview rendered under an in-flight write_file/edit_file pill while
 * the model is still GENERATING the call's JSON arguments. Styled after
 * LiveOutputTail (same box language: rounded-[10px], hairline border, mono
 * 11px, subtle bg, tiny pulsing dot) — the label reads
 * `writing <filename> — <N> chars` and the body shows the partial
 * content-so-far (extracted by the tolerant streaming-args parser — the raw
 * is a JSON PREFIX, never parseable). Stick-to-bottom like the terminal
 * tail; the matching tool-result CLEARS the preview — the expanded DiffDetail
 * (the real diff card) takes over.
 */
export function LiveWritePreview({ raw }: { raw: string }) {
  const styles = useThemeStyles();
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const path = extractStringArg(raw, "path");
  const contentArg = extractStringArg(raw, "content");
  const content = contentArg.found ? contentArg : extractStringArg(raw, "newString");

  // Filename only (the full path rides the row's title/argsSummary).
  const filename = path.found
    ? path.value.split(/[\\/]/).filter((seg) => seg !== "").pop() ?? path.value
    : "file";
  const label = `writing ${filename} — ${content.value.length} chars`;

  // Track whether the user scrolled up (stop auto-scrolling then).
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // The content grows → keep the bottom pinned while the user is at it.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [content.value]);

  const shown =
    content.value.length > MAX_WRITE_PREVIEW_CHARS
      ? `…${content.value.slice(content.value.length - MAX_WRITE_PREVIEW_CHARS)}`
      : content.value;

  return (
    <div className="mt-0.5 mb-1 pl-4 min-w-0" data-testid="live-write-preview">
      <div className="flex items-center gap-1.5 h-4 px-0.5">
        {/* Subtle animated shimmer — CSS-only pulse on the small dot
            (ac-pulse: the app's shared live-dot animation, reduced-motion
            aware — same as LiveOutputTail). */}
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: RUNNING_BLUE }} aria-hidden />
        <span
          className="text-[9px] font-mono font-bold uppercase tracking-[0.14em] truncate"
          style={{ color: RUNNING_BLUE }}
          title={path.found ? path.value : undefined}
        >
          {label}
        </span>
      </div>
      <div
        ref={ref}
        className="rounded-[10px] border px-2.5 py-1.5 max-h-40 overflow-y-auto auto-scroll font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap"
        style={{
          borderColor: withAlpha(RUNNING_BLUE, 0.35),
          background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)",
          color: styles.textSecondary,
        }}
      >
        {shown === "" ? " " : shown}
      </div>
    </div>
  );
}

/**
 * ROUND-58 (R58-cf): a PENDING write row — the model started generating a
 * write_file/edit_file call's arguments (tool-input-start frame) but the
 * final tool-call frame hasn't landed, so there is no ToolUseEntry yet. The
 * row mirrors a collapsed ToolLine's shape (running-blue icon chip + label +
 * mono path + "…" in-flight status) with the live write preview beneath —
 * the owner sees the file being written the moment the model starts typing
 * its content. Not interactive: the preview is always shown.
 */
function LiveWritePendingRow({ toolName, raw }: { toolName: string; raw: string }) {
  const styles = useThemeStyles();
  const Icon = TOOL_ICONS[toolName] ?? FileCode2;
  const path = extractStringArg(raw, "path");
  const argsSummary = path.found ? `path: ${path.value}` : toolName;
  return (
    <div className="min-w-0" data-testid="live-write-pending-row">
      <div
        className="flex items-center gap-2 h-7 w-full max-w-full px-1 -ml-1"
        style={{ color: styles.textTertiary }}
      >
        <ToolIconChip Icon={Icon} background={withAlpha(RUNNING_BLUE, 0.12)} color={RUNNING_BLUE} />
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: styles.textSecondary }}>
          Writing
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: styles.textTertiary }} title={path.found ? path.value : undefined}>
          {argsSummary}
        </span>
        <span className="shrink-0 w-4 text-center text-[11px]" style={{ color: styles.textTertiary }}>
          …
        </span>
        <span className="w-2.5 shrink-0" />
      </div>
      {raw !== "" ? <LiveWritePreview raw={raw} /> : null}
    </div>
  );
}

// ─── Terminal detail (run_command expanded body) ────────────────────────────

function TerminalDetail({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  const [expanded, setExpanded] = useState(false);
  const output = tool.outputSummary ?? null;
  // ROUND-52 (R52-c): an expanded in-flight run_command shows its LIVE
  // streaming tail (the same live view as under the pill — the "running…"
  // placeholder stays for calls with no output yet).
  const liveOutput = (tool as LiveToolUseEntry).liveOutput;
  if (output === null && tool.ok === null && liveOutput !== undefined && liveOutput !== "") {
    return <LiveOutputTail output={liveOutput} />;
  }
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
  sessionId,
  onDecision,
}: {
  entry: Extract<WorkingEntry, { type: "approval" }>;
  /** ROUND-48 (R48-e2): the PARENT session id — resolves a sub-agent ask's
   * code/role attribution via the live map / the polled subagents rows. */
  sessionId?: string | null;
  onDecision?: (approvalId: string, decision: ApprovalDecisionChoice, remember: ApprovalRemember) => void;
}) {
  const styles = useThemeStyles();
  const pending = entry.status === "pending";

  // ROUND-48 (R48-e2): sub-agent attribution. A delegated child's approvals
  // ride the parent's SSE as subagent-event envelopes; stream-store routes
  // them into this same approvals queue WITH subAgentId. The live map is the
  // freshest lookup (the status frames precede any approval); the polled
  // /subagents rows are the fallback — together they always answer WHO is
  // asking. Main-agent approvals carry no subAgentId → no prefix (unchanged).
  const liveMap = useStreamStore(selectSubAgentsLive);
  const needsLookup = entry.subAgentId !== undefined;
  const subsQuery = useQuery({
    queryKey: ["subagents", sessionId ?? null],
    queryFn: () => fetchSubAgents(sessionId as string),
    enabled: needsLookup && sessionId != null && liveMap[entry.subAgentId as string] === undefined,
    staleTime: 10_000,
  });
  // Normalize the two lookup sources (live map carries `role`; the polled
  // /subagents row carries `subRole`) into the chip + role for the prefix.
  const liveEntry = needsLookup ? liveMap[entry.subAgentId as string] : undefined;
  const rowEntry = needsLookup
    ? (subsQuery.data ?? []).find((s) => s.id === (entry.subAgentId as string))
    : undefined;
  const attributedCode = liveEntry?.code ?? rowEntry?.code;
  const attributedRole = liveEntry?.role ?? rowEntry?.subRole ?? undefined;

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
        {attributedCode !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}>
            {attributedCode}
          </span>
        ) : null}
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
        {needsLookup ? (
          <span
            className="flex items-center gap-1 text-[11.5px] font-bold min-w-0"
            style={{ color: styles.text }}
            data-testid="subagent-approval-attribution"
          >
            <span className="truncate">Sub-agent</span>
            {attributedCode !== undefined && attributedRole !== undefined ? (
              <>
                <span
                  className="shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-[0.08em]"
                  style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
                >
                  {attributedCode}
                </span>
                <span className="truncate">· {attributedRole} —</span>
              </>
            ) : (
              <span>—</span>
            )}
          </span>
        ) : null}
        <span className="text-[11.5px] font-bold shrink-0" style={{ color: styles.text }}>
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

/**
 * ROUND-51 (R51-d, owner: "When the agents were called those areas should be
 * highlighted. When the file edits were made those areas should be
 * highlighted properly. Even if they are minimized, those should be
 * highlighted a bit better."): the tinted rounded-square icon chip for the
 * two tool families that CHANGE the project — delegate_task and the
 * DIFF_TOOLS write/edit set. Their bare 11px glyph was invisible in a
 * collapsed transcript; the chip shape is readable at a glance. Deliberately
 * an icon-chip, NOT a left-rail accent (the owner rejected rails in R51-b).
 * Decorative: the row button already carries the full aria-label.
 */
function ToolIconChip({
  Icon,
  background,
  color,
}: {
  Icon: LucideIcon;
  background: string;
  color: string;
}) {
  return (
    <span
      className="shrink-0 grid h-5 w-5 place-items-center rounded-[6px]"
      style={{ background, color }}
      data-testid="tool-icon-chip"
      aria-hidden="true"
    >
      <Icon size={11} />
    </span>
  );
}

function ToolLine({
  tool,
  sessionId,
  projectId,
  live = false,
  claimedChildId,
}: {
  tool: ToolUseEntry;
  sessionId: string | null;
  /** ROUND-40: threaded from WorkingSection so DelegateDetail → SubAgentCard
   * can open the sub-agent's tab in the right sidebar. */
  projectId: string;
  live?: boolean;
  /** ROUND-64 (R64-c): this pending delegate_task row's CLAIMED child id
   * (assignDelegateChildren) — the expanded body renders exactly ONE live
   * child row instead of every running child of the parent. */
  claimedChildId?: string | null;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const userTouched = useRef(false);
  const prevOk = useRef<boolean | null>(tool.ok);

  // ROUND-48 (R48-e2, owner: "There was no option in the main chat to click
  // the Delegated card and see that agent on the right sidebar"): while this
  // delegate_task call is pending, watch the parent's children. When EXACTLY
  // ONE child is live the row itself becomes an open-in-sidebar affordance
  // (chevron swaps for the panel icon); otherwise the row keeps its
  // expand/collapse behavior (the expanded body lists every live child).
  const delegatePending = tool.toolName === "delegate_task" && tool.ok === null;
  const subsQuery = useDelegateChildren(sessionId, delegatePending);
  const liveChildren = delegatePending
    ? (subsQuery.data ?? []).filter((s) => s.status === "running" || s.status === "queued")
    : [];
  const singleLiveChild = liveChildren.length === 1 ? liveChildren[0] : null;

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

  // ROUND-51 (R51-d): the chip tint per family. Delegations carry the accent
  // wash (the strongest signal — a sub-agent is working on the project);
  // file edits stay calm (subtle + textSecondary, the chip SHAPE is the
  // differentiator) and borrow the in-flight running blue only while
  // ok === null — the same in-progress language as SubAgentPanel's live rows.
  // Every other tool keeps the plain glyph, byte-identical to pre-R51.
  const chipTone =
    tool.toolName === "delegate_task"
      ? { background: withAlpha(styles.accent, 0.12), color: styles.accent }
      : DIFF_TOOLS.has(tool.toolName)
        ? {
            background: tool.ok === null ? withAlpha(RUNNING_BLUE, 0.12) : styles.subtle,
            color: tool.ok === null ? RUNNING_BLUE : styles.textSecondary,
          }
        : null;

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

  // Single live child → the row click opens that child's chat tab in the
  // right sidebar (the owner's ask — see the child live instead of "Running
  // Running Running"). Zero or multiple live children keep the toggle.
  const openSingleLive = () => {
    if (singleLiveChild === null || sessionId === null) return;
    useRightSidebarStore.getState().openSubAgent(
      projectId,
      sessionId,
      singleLiveChild.id,
      `${singleLiveChild.code} · ${singleLiveChild.title ?? "Sub-agent"}`,
      singleLiveChild.subRole ?? undefined,
    );
  };

  const rowAction: "open-subagent" | "toggle" | null =
    singleLiveChild !== null && sessionId !== null
      ? "open-subagent"
      : expandable
        ? "toggle"
        : null;

  // ROUND-52 (R52-c): the live terminal tail of an in-flight run_command —
  // tool-output chunks the stream-store accumulated under this entry
  // (folded turns never carry the field; the result clears it).
  const liveOutput = (tool as LiveToolUseEntry).liveOutput ?? "";
  const showLiveTail = tool.ok === null && liveOutput !== "";
  // ROUND-58 (R58-cf): the live write preview of an in-flight write_file/
  // edit_file — the stream-store attached the accumulated args raw
  // (liveInput) when the tool-call frame landed; the tool-result strips it
  // and the real DiffDetail takes over.
  const liveInput = (tool as LiveToolUseEntry).liveInput;
  const showLiveWrite =
    tool.ok === null && DIFF_TOOLS.has(tool.toolName) && liveInput !== undefined && liveInput !== "";

  return (
    <div className="min-w-0">
      <button
        onClick={
          rowAction === "open-subagent"
            ? openSingleLive
            : rowAction === "toggle"
              ? toggle
              : undefined
        }
        aria-expanded={rowAction === "toggle" ? open : undefined}
        aria-label={
          rowAction === "open-subagent" && singleLiveChild !== null
            ? `Open sub-agent ${singleLiveChild.code} · ${singleLiveChild.title ?? "Sub-agent"} in sidebar`
            : `${label} ${tool.argsSummary}`
        }
        title={
          rowAction === "open-subagent" && singleLiveChild !== null
            ? `Open sub-agent ${singleLiveChild.code} in the right sidebar`
            : `${tool.toolName} ${tool.argsSummary}`
        }
        className="flex items-center gap-2 h-7 w-full max-w-full px-1 -ml-1 rounded-md transition-colors text-left"
        style={{
          color: styles.textTertiary,
          cursor: rowAction !== null ? "pointer" : "default",
        }}
        onMouseEnter={(e) => {
          if (rowAction !== null) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {chipTone !== null ? (
          <ToolIconChip Icon={Icon} background={chipTone.background} color={chipTone.color} />
        ) : (
          <Icon size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
        )}
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: styles.textSecondary }}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: styles.textTertiary }}>
          {tool.argsSummary}
        </span>
        {rowAction === "open-subagent" ? (
          <span
            className="shrink-0 flex items-center gap-1 text-[10px] font-bold"
            style={{ color: styles.accent }}
          >
            live
            <PanelRightOpen size={11} />
          </span>
        ) : (
          <span
            className="shrink-0 w-4 text-center text-[11px]"
            style={{
              color:
                waitingApproval
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
        )}
        {rowAction === "toggle" ? (
          <ChevronDown
            size={10}
            className="shrink-0"
            style={{ color: styles.textTertiary, transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
      </button>
      {/* ROUND-52 (R52-c): the compact live tail under the pill while the
          command streams — hidden while expanded (the expanded body's
          TerminalDetail carries the same live view there, never both).
          ROUND-58 (R58-cf): an in-flight write/edit gets its LIVE write
          preview the same way (never both with the expanded body). */}
      {showLiveTail && !open ? <LiveOutputTail output={liveOutput} /> : null}
      {showLiveWrite && !open ? <LiveWritePreview raw={liveInput} /> : null}
      {open && (
        <div className="mt-0.5 mb-1 pl-4 min-w-0">
          {tool.toolName === "delegate_task" ? (
            <DelegateDetail tool={tool} sessionId={sessionId} live={live} projectId={projectId} claimedChildId={claimedChildId} />
          ) : DIFF_TOOLS.has(tool.toolName) ? (
            // ROUND-58 (R58-cf): while the write is still in flight the
            // preview IS the body (the diff snapshot doesn't exist yet); the
            // tool-result swaps in the real DiffDetail.
            showLiveWrite ? (
              <LiveWritePreview raw={liveInput} />
            ) : (
              <DiffDetail tool={tool} sessionId={sessionId} />
            )
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

/** delegate_task → SubAgentCard (ROUND-36 integration preserved).
 * ROUND-40: threads `projectId` down to SubAgentCard so its onClick can
 * open the child's tab in the right sidebar.
 * ROUND-64 (R64-c): `claimedChildId` — the PENDING body renders exactly ONE
 * live child (this row's claim from assignDelegateChildren, computed once
 * per render by WorkingSection) instead of every running child of the
 * parent (owner: expanding one of three parallel delegations showed all
 * three sub-agents). */
function DelegateDetail({
  tool,
  sessionId,
  projectId,
  live,
  claimedChildId,
}: {
  tool: ToolUseEntry;
  sessionId: string | null;
  projectId: string;
  live: boolean;
  claimedChildId?: string | null;
}) {
  // All hooks run unconditionally — the pending → completed transition swaps
  // branches, so the hook order must be identical in every branch.
  const styles = useThemeStyles();
  const liveMap = useStreamStore(selectSubAgentsLive);
  const subsQuery = useDelegateChildren(sessionId, sessionId !== null);

  const hay = `${tool.argsSummary} ${tool.outputSummary ?? ""}`;
  const sessionMatch = /session: (sess_[A-Za-z0-9-]+)/.exec(hay);
  const roleMatch = /role: ([a-z]+)/.exec(hay);
  const taskMatch = /task: (.+?)(?:, role:|, session:|$)/.exec(tool.argsSummary);

  // ROUND-48 (R48-e2): while the delegate_task RESULT is pending there is no
  // `session:` id in the output yet — render the parent's LIVE children as
  // clickable rows (status/todo/token progress + the current activity from
  // the SSE live map) instead of a bare "running…" OutputDetail.
  // ROUND-64 (R64-c): claim-matched — ONLY this row's claimed child renders
  // (assignDelegateChildren); no claim yet → the quiet "delegating…" beat.
  const pending = tool.ok === null;
  const claimedChild =
    claimedChildId !== undefined && claimedChildId !== null
      ? (subsQuery.data ?? []).find((s) => s.id === claimedChildId) ?? null
      : null;
  const liveRows = pending ? (claimedChild !== null ? [claimedChild] : []) : [];
  if (pending && sessionId !== null) {
    return (
      <LiveDelegateRows
        rows={liveRows}
        liveMap={liveMap}
        parentSessionId={sessionId}
        projectId={projectId}
      />
    );
  }
  if (sessionMatch === null) {
    return <OutputDetail tool={tool} />;
  }

  // Completed: the code chip (matched by the child session id parsed from the
  // output — the polled /subagents rows carry it, the live map is the fallback)
  // + the existing SubAgentCard.
  const childCode =
    (subsQuery.data ?? []).find((s) => s.id === sessionMatch[1])?.code ??
    liveMap[sessionMatch[1]]?.code ??
    null;
  return (
    <div className="min-w-0">
      {childCode !== null ? (
        <div className="flex items-center gap-1.5 mb-1 px-1">
          <SubAgentCodeChip code={childCode} />
          <span className="text-[10px] font-mono" style={{ color: styles.textTertiary }}>
            sub-agent
          </span>
        </div>
      ) : null}
      <SubAgentCard
        sessionId={sessionMatch[1]}
        parentSessionId={sessionId}
        role={roleMatch?.[1]}
        task={taskMatch?.[1]}
        live={live}
        projectId={projectId}
      />
    </div>
  );
}

// ─── The section itself ──────────────────────────────────────────────────────

export function WorkingSection({
  entries,
  sessionId,
  projectId,
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
  /** ROUND-40: the chat panel's project id — threaded down to SubAgentCard
   * so clicking a sub-agent task opens its tab in the right sidebar. */
  projectId: string;
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

  // ROUND-58 (R58-cf): in-flight tool-ARG streaming — write_file/edit_file
  // calls whose JSON args the model is still generating (a tool-input-start
  // frame landed, no ToolUseEntry yet). Live sections only (folded turns
  // never carry streaming state). The selector returns the store's array
  // REFERENCE (stable between patches) or undefined — never a fresh array —
  // so there is no re-render loop; the DIFF filter is a render-time derive.
  const liveStreamingInputs = useStreamStore((s) =>
    live && sessionId !== null ? s.bySession[sessionId]?.liveTurn?.streamingToolInputs : undefined,
  );
  const pendingWriteInputs: StreamingToolInput[] =
    liveStreamingInputs === undefined
      ? EMPTY_STREAMING_INPUTS
      : liveStreamingInputs.filter((si) => DIFF_TOOLS.has(si.toolName));

  const toolCount = entries.filter((e) => e.type === "tool").length;
  const pendingApproval = entries.some((e) => e.type === "approval" && e.status === "pending");

  // ── ROUND-64 (R64-c): claim-match the parent's live children to THIS
  // section's delegate_task rows. WorkingSection maps every tool row of the
  // turn, so the assignment is computed HERE (once per render, from the
  // same ["subagents", id] cache the DelegateDetail bodies use) and the
  // claimed child id rides the row down — each pending row's expanded body
  // then renders EXACTLY ONE live child instead of all of them (owner:
  // "When I expanded any one of them, it showed me all three or so
  // sub-agents which were active. This was not good.").
  const hasDelegateRow = entries.some((e) => e.type === "tool" && e.tool.toolName === "delegate_task");
  const delegateChildrenQuery = useDelegateChildren(sessionId, hasDelegateRow);
  const delegateClaims = useMemo(
    () => (hasDelegateRow ? assignDelegateChildren(entries, delegateChildrenQuery.data ?? []) : null),
    [hasDelegateRow, entries, delegateChildrenQuery.data],
  );

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
            {/* ROUND-58 (R58-cf, owner: the left rail looked like "a weird AI
                kind of highlighting"): the accent border-l-2 rail is GONE —
                the rows sit in a plain column; each row keeps its own
                self-contained shape (ThoughtRow's subtle notes block, the
                tool pills, the approval cards). */}
            <div className="py-1 flex flex-col gap-0.5">
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
                  // R48: distinct prefix from the index-keyed rows above — a
                  // tool's seq could equal a sibling row's list index and the
                  // shared `t-` prefix produced duplicate React keys.
                  return (
                    <ToolLine
                      key={`tool-${entry.tool.seq}`}
                      tool={entry.tool}
                      sessionId={sessionId}
                      live={live}
                      projectId={projectId}
                      claimedChildId={
                        entry.tool.toolName === "delegate_task"
                          ? delegateClaims?.get(entry.tool.seq)
                          : undefined
                      }
                    />
                  );
                }
                // ROUND-68 (R68-A, owner: "When the screenshots were taken
                // they should be shown at that specific time."): the capture
                // marker renders INLINE at its list position — the entry was
                // appended at frame arrival (during tool execution), so it
                // sits right after the in-flight tool row that captured it,
                // NOT in a dedicated bottom section (the R67-D strip is
                // gone). Screenshots never count as tools (toolCount filters
                // type === "tool" only — unaffected).
                if (entry.type === "screenshot") {
                  return (
                    <ScreenshotRow
                      key={`shot-${entry.frameId}-${entry.ts}`}
                      shot={{ frameId: entry.frameId, tool: entry.tool, ts: entry.ts }}
                    />
                  );
                }
                return <ApprovalRow key={`t-${i}`} entry={entry} sessionId={sessionId} onDecision={onApprovalDecision} />;
              })}
              {live && entries.length === 0 && pendingWriteInputs.length === 0 ? (
                <div className="flex items-center gap-2 h-7">
                  <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                    starting<span className="ac-ellipsis" aria-hidden />
                  </span>
                </div>
              ) : null}
              {/* ROUND-58 (R58-cf): PENDING write rows — the model is
                  generating a write_file/edit_file call's args right now; the
                  live write preview streams beneath each row until the final
                  tool-call frame converts it into a ToolUseEntry. */}
              {pendingWriteInputs.map((si) => (
                <LiveWritePendingRow key={`sw-${si.toolCallId}`} toolName={si.toolName} raw={si.raw} />
              ))}
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
        // ROUND-68 (R68-A): screenshots are LIVE-ONLY entries and a bare
        // (tools-free) block has no section to anchor an inline row — skip
        // them exactly like tool entries (consistent with the caller's
        // segmentation: a screenshot can only follow a tool row anyway).
        if (entry.type === "screenshot") {
          return null;
        }
        return null; // tool entries imply a section — handled by the caller
      })}
    </>
  );
}
