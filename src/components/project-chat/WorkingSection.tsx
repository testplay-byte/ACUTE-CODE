import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpenText,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  FileCode2,
  Globe,
  Loader,
  Loader2,
  PanelRightOpen,
  RotateCcw,
  Search,
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
  type SubAgentStatus,
  type ToolUseEntry,
  type WorkingEntry,
  fetchSessionCheckpoints,
  fetchSnapshot,
} from "../../lib/api";
// ROUND-96 (R96-H): the modern-IDE diff engine — hunks, gutter line numbers,
// honest caps (replaces api.ts's whole-file computeUnifiedDiff render here).
import { computeUnifiedDiff, type UnifiedDiffResult } from "../../lib/unified-diff";
import { pushLocalToast } from "../../hooks/use-notifications";
import {
  selectSubAgentsLive,
  useStreamStore,
  type LiveToolUseEntry,
  type StreamingToolInput,
} from "../../lib/stream-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { SubAgentCard } from "./SubAgentCard";
// R97-F: the thinking body renders fenced code blocks through the SAME
// CodeBlock the answers use (syntax colors + the language badge + Copy).
import { CodeBlock, PathPill } from "./ChatMarkdown";
// R117-f: the per-tool arg humanizer + the failed row's error excerpt (pure
// formatters over the server's argsSummary/outputSummary display strings).
import { formatToolTarget, toolErrorExcerpt } from "./tool-args";
// R117-f: the terminal detail's Copy button rides the app's shared
// copied-flash reset hook (the CodeBlock copy idiom).
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
// R101-F (DEFECT 4, owner v0.98.0: "it was not showing me the properly
// rendered flow diagrams"): a CLOSED ```mermaid fence inside a thinking/
// work block mounts the SAME diagram renderer the answers use — mirroring
// ChatMarkdown's mount exactly (code only; the theme rides the app store,
// no container context needed). The component itself stays lazy: mermaid
// loads only when such a fence actually mounts.
import { MermaidDiagram } from "./MermaidDiagram";
// ROUND-95 (R95-D): the small-block stick-to-bottom primitive — the live
// thinking block's body follows its own stream (see use-stick-to-bottom.ts).
import { useStickToBottom } from "./use-stick-to-bottom";
// ROUND-68 (R68-A): the INLINE screenshot row — one per `screenshot`
// WorkingEntry, rendered at its capture moment between the tool rows.
import { ScreenshotRow } from "./ScreenshotRow";
// ROUND-87 (R87): the ask_user question card + the turn's todo-list card.
import { QuestionCard } from "./QuestionCard";
import { TodoCard } from "./TodoCard";
import { extractStringArg } from "./streaming-args";
// R98-C2 introduced RUNNING_BLUE; R125 (the owner's verdict — "It shows
// me in the blue colored area the tool call of writing") RETIRES it from
// this file: the live boxes now speak the THEME ACCENT (styles.accent), so
// a running write reads in the app's own voice in every theme instead of a
// hard-coded blue slab. The constant stays exported in lib/semantics.ts for
// the surfaces not migrated this round (SubAgentPanel — the full PC
// redesign session owns those).
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
 * R99-B (owner: "analyze which info is necessary to be shown in compressed
 * view and in full view") — the COMPRESSED vs FULL information matrix this
 * section implements:
 *
 *   COMPRESSED (the folded summary row — what the eye needs at a glance):
 *     · status glyph — ✓ success while the work stands completed cleanly,
 *       ✗ danger when any tool in the fold failed (R117-f — never a clean ✓
 *       over failed work), □ (Square, tertiary) for a stopped live section,
 *       ● pulsing accent dot while it runs;
 *     · step count — "Completed N steps" (every entry the section renders:
 *     tools, thoughts, narration, approvals, captures — pluralized honestly)
 *     · failure count — "· N failed" in the danger color when N > 0 (R117-f);
 *     · tool count — "· N tools" only when tools > 0;
 *     · ROUND-120 (R120-C-PC, item 36): NO duration — the per-section
 *       right-aligned clock chip is GONE (the owner's "8-9 separate
 *       right-side blocks"); the turn footer's ONE consolidated
 *       "Ran 4m 12s · 23 actions · 18.2k tokens" block owns the answer, and
 *       a LIVE turn renders ONE clock (clockVisible gates it to the turn's
 *       FIRST live work section).
 *     · ROUND-120 (R120-C-PC, item 35): the FILE-MUTATION rows (write/
 *       edit/create/delete) render OUTSIDE the collapse — the mutations the
 *       agent made to the project are never hidden behind the expand (the
 *       owner: "file edits, created files… are not shown — the center never
 *       renders them").
 *   FULL (expanded — the complete timeline, in order): every ThoughtRow
 *     (one-line, expandable, fence-aware), NarrationRow interjections, each
 *     ToolLine pill (leading outcome glyph ✓/✗/◌ + verb + target + the
 *     one-line result summary; expansion reveals the full
 *     DiffDetail/TerminalDetail/OutputDetail/DelegateDetail body),
 *     ApprovalRow asks, inline ScreenshotRow captures, QuestionCard and
 *     TodoCard.
 *
 * Replaces the R32 ActivityBlock card: NO card chrome, NO icon tile, NO
 * "Completed N actions" banner — a borderless muted header
 * ("● Working · 0:07" live / "✓ Completed 8 steps · 3 tools · 1:12" done)
 * over one-line expandable rows. The turn's FINAL ANSWER renders OUTSIDE
 * this section (in AgentChatPanel), so collapsing the work never hides the
 * answer.
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
 *
 * ROUND-95 (R95-D, owner: "The thinking area was not auto-scrolling to the
 * very bottom… If I scroll up in the thinking area, then it should not
 * auto-scroll again. It should only scroll if I scroll to the very bottom
 * and leave it there."): the ThoughtRow's expanded body is now a STICK-
 * TO-BOTTOM scroller (use-stick-to-bottom.ts) — while LIVE it follows the
 * growing thinking text, scrolling up inside stops the follow, and a
 * small floating "Jump to latest" pill offers the way back. A completed
 * thought never follows (settled text is read from the top — manual tap
 * wins). The body also carries data-thinking-scroll: the chat panel's
 * wheel chaining keys off it (nested scrollers consume their own wheels
 * before the transcript ever detaches — see AgentChatPanel's R95-D note).
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
  // R114-e (the transcript polish round, mirroring the phone's R114-d
  // SkillCard): the skills tools get their OWN icons + labels so a
  // read_skill row reads as what it is — one quiet "Read skill · <name>"
  // line (the collapsed row already shows only label + argsSummary +
  // status; the raw body stays behind the manual expand).
  read_skill: BookOpenText,
  search_skills: Search,
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
  // R114-e: the skills pair (see TOOL_ICONS above).
  read_skill: "Read skill",
  search_skills: "Searched skills",
};

/** ROUND-58 (R58-cf): stable empty default for the pending-write-inputs
 * derive (the store selector returns undefined for folded sections — a
 * fresh [] there would re-render on every store tick). */
const EMPTY_STREAMING_INPUTS: StreamingToolInput[] = [];

/** ROUND-120 (R120-C-PC, item 35): the FILE-MUTATION family — the tool rows
 * that stay VISIBLE under a COLLAPSED section (folded or live): the owner's
 * round-120 verdict was that "file edits, created files… are not shown —
 * the center never renders them", and the R38 fold-by-default design was
 * exactly what hid them. Reads/searches/commands stay behind the expand;
 * the mutations the agent made to the project NEVER hide. */
export const FILE_MUTATION_TOOLS = new Set(["write_file", "edit_file", "create_dir", "delete_file"]);

/** ROUND-52 (R52-c): the amber warning tone for the stalled-watch line
 * (same value SubAgentPanel uses — a semantic, theme-stable warning color). */
// R98-C2: the duplicated amber literal retired — SEMANTIC_COLORS.warning is
// the ONE documented spelling (the design-language TOKENS §4 rule).
const AMBER = SEMANTIC_COLORS.warning;

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
      className="shrink-0 font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-md tracking-[0.08em]"
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
      className="w-full rounded-lg border px-2 py-1.5 text-left cursor-pointer transition-colors bg-card hover:bg-hover"
      style={{ borderColor: withAlpha(tone, 0.35) }}
      aria-label={`Open sub-agent ${code} · ${title} in sidebar`}
      data-testid="live-delegate-row"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <SubAgentCodeChip code={code} />
        <span
          className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em]"
          style={{ color: tone }}
        >
          {role}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" style={{ color: styles.textSecondary }} title={title}>
          {title}
        </span>
        <span
          className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
          style={{ background: withAlpha(tone, 0.12), color: tone }}
        >
          {stopping ? "stopping…" : status}
        </span>
        {todosTotal > 0 ? (
          <span className="shrink-0 text-[10px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
            {todosDone}/{todosTotal} todos
          </span>
        ) : null}
        {child.inputTokens > 0 || child.outputTokens > 0 ? (
          <span className="shrink-0 text-[10px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
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
            className="shrink-0 w-6 h-6 grid place-items-center rounded-lg transition-colors hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: SEMANTIC_COLORS.danger }}
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
              className="shrink-0 font-mono text-[10px] tabular-nums"
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
        <div className="mt-0.5 text-[10px] truncate" style={{ color: styles.textTertiary }}>
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
      <div className="px-1 py-1 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
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

/** R117-f: the Show-all threshold — ~15 mono lines at 11px/1.6 leading fill
 * the expanded body's max-h-64 (256px) clamp; a settled thought past that
 * count offers the quiet underline toggle that removes the cap. */
const THOUGHT_CLAMP_LINES = 15;

/**
 * Owner spec: "The thoughts will be only one line by default and when I tap
 * on them then it will expand and show me the full thoughts… While that
 * thought is actually happening it will stay expanded and when the thought
 * has been completed then it will collapse by itself."
 * → live rows auto-expand; completing (live→false) auto-collapses; a manual
 * tap always wins over the automation.
 */
/** R97-F: split the thinking text on CLOSED ``` fences — the prose parts
 * render as the quiet mono notes; each CLOSED fence renders as a CodeBlock
 * ({lang, code}) — or, since R101-F, as a MermaidDiagram when the fence's
 * language is mermaid (see ThoughtRow's render). An UNCLOSED trailing fence
 * stays in the prose (the stream is still emitting it — the block never
 * pops in/out mid-stream). Pure; exported for tests. */
export function splitThinkingFences(
  text: string,
): Array<{ kind: "text"; text: string } | { kind: "code"; lang: string; code: string }> {
  if (text === "") return [];
  const parts: Array<{ kind: "text"; text: string } | { kind: "code"; lang: string; code: string }> = [];
  const lines = text.split("\n");
  let currentText: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = /^\s{0,3}```(.*)$/.exec(lines[i]!);
    if (fence === null) {
      currentText.push(lines[i]!);
      i += 1;
      continue;
    }
    // A fence opened — find its closer.
    const lang = fence[1]?.trim() ?? "";
    let closer = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s{0,3}```\s*$/.test(lines[j]!)) {
        closer = j;
        break;
      }
    }
    if (closer === -1) {
      // UNCLOSED (still streaming): the rest stays prose — never a half block.
      currentText.push(...lines.slice(i));
      break;
    }
    if (currentText.length > 0) {
      parts.push({ kind: "text", text: currentText.join("\n") });
      currentText = [];
    }
    parts.push({ kind: "code", lang, code: lines.slice(i + 1, closer).join("\n") });
    i = closer + 1;
  }
  if (currentText.length > 0) parts.push({ kind: "text", text: currentText.join("\n") });
  return parts;
}

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
  const trimmed = text.trim();
  /* R97-F: the fence-split — the thinking text renders its fenced code blocks
   * as REAL CodeBlocks (the owner: "in the thinking, if it shows a code
   * block, then that code block should clearly be highlighted. It should
   * clearly be formatted in colors and it should be properly shown"), while
   * the prose between fences stays the quiet mono notes exactly as before.
   * STREAMING-SAFE: an UNCLOSED fence (the model is still emitting it) does
   * not flip into a code block until its closer arrives — the partial
   * fence stays plain text so the block never pops in and out mid-stream. */
  const fenceParts = useMemo(() => splitThinkingFences(trimmed), [trimmed]);

  // ── R117-f (the thinking moment, part 2): the settled thought's Show-all
  //    affordance. The expanded body clamps at max-h-64; once the thought
  //    settles (live → false) and its line count passes the clamp, a quiet
  //    underline toggle removes it. A LIVE thought never shows the toggle —
  //    the stick-to-bottom scroller owns that view (the R95-D contract). ──
  const [showAll, setShowAll] = useState(false);
  const bodyLineCount = useMemo(() => trimmed.split("\n").length, [trimmed]);
  const overClamp = !live && bodyLineCount > THOUGHT_CLAMP_LINES;

  // ── ROUND-95 (R95-D, owner: the thinking area "should be automatically
  //    scrolling if the user was at the very bottom of it but apparently it
  //    was not auto-scrolling"): the expanded body is a stick-to-bottom
  //    scroller — while LIVE it follows the streaming text (deps = the
  //    text itself; enabled = live, so a COMPLETED thought the user tapped
  //    open never moves). See use-stick-to-bottom.ts for the full pin /
  //    detach / flight contract. ──
  const {
    ref: thoughtScrollRef,
    pinned: thoughtPinned,
    jumpToBottom: jumpThoughtToBottom,
  } = useStickToBottom([trimmed], { enabled: live });

  useEffect(() => {
    if (!userTouched.current) {
      if (live) setOpen(true); // in-flight → expanded
      else if (prevLive.current) setOpen(false); // just completed → collapse
    }
    prevLive.current = live;
  }, [live]);

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
        className="flex items-center gap-1.5 h-6 max-w-full px-1 -ml-1 rounded-md transition-colors hover:bg-hover"
        style={{ color: styles.textTertiary }}
      >
        <ChevronDown
          size={10}
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
        {/* R100-D: the duration number goes tabular (numbers discipline). */}
        <span className="text-[11px] font-medium italic shrink-0 tabular-nums">{durationLabel}</span>
        {live && <span className="ac-ellipsis" aria-hidden />}
        {!open && !live && (
          <span className="text-[10px] font-mono italic truncate max-w-[420px]" style={{ color: styles.textTertiary }}>
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
                duration above stay exactly as they were.
                ROUND-95 (R95-D): the scroller + its floating pill now sit in
                a RELATIVE wrapper — an absolutely-positioned pill INSIDE the
                scroller itself would scroll WITH the content (it anchors in
                the scrollable area, not the visible box); the wrapper does
                not scroll, so the pill stays pinned to the block's visible
                bottom-right corner. */}
            <div className="relative mt-0.5 mb-1">
              <div
                ref={thoughtScrollRef}
                data-thinking-scroll
                className={`chat-thinking rounded-lg px-3 py-1.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-words overflow-y-auto auto-scroll ${
                  overClamp && !showAll ? "max-h-64" : ""
                }`}
                style={{ background: styles.subtle, color: styles.textSecondary, ["--chat-base-size" as string]: "11px" } as React.CSSProperties}
              >
                {/* The single content wrapper: the stick hook's
                    ResizeObserver observes it (growth past the max-h-64 cap
                    never changes the scroller's own box).
                    R97-F: the fence-split — CLOSED ``` blocks render as REAL
                    CodeBlocks (the syntax colors the owner asked for); the
                    prose stays the quiet mono notes. */}
                <div className="min-w-0">
                  {fenceParts.length === 0 ? (
                    <span>{trimmed}</span>
                  ) : (
                    fenceParts.map((part, pi) =>
                      part.kind === "text" ? (
                        <span key={pi} className="whitespace-pre-wrap break-words">
                          {part.text}
                          {pi < fenceParts.length - 1 ? "\n" : ""}
                        </span>
                      ) : part.lang.toLowerCase() === "mermaid" ? (
                        // R101-F (DEFECT 4): splitThinkingFences only emits
                        // CLOSED fences (an unclosed tail stays prose), so
                        // every mermaid part here is the complete source —
                        // the same gate ChatMarkdown's `terminated` flag
                        // applies. The diagram renders wherever the fence
                        // text rendered, in the collapsed AND expanded body
                        // alike (no state change needed); the thinking-note
                        // container itself is untouched.
                        <MermaidDiagram key={pi} code={part.code} />
                      ) : (
                        <CodeBlock key={pi} code={part.code} lang={part.lang === "" ? undefined : part.lang} />
                      ),
                    )
                  )}
                </div>
              </div>
              {/* ── R95-D: the INNER JUMP PILL — only while LIVE and
                  DETACHED from the block's own tail (the user scrolled up
                  inside the thinking text). Same frosted-pill language as
                  the transcript's Jump-to-latest, miniaturized for the
                  block. Clicking re-pins + smooth-jumps to the latest
                  thinking; arriving back at the bottom hides it. The
                  mousedown preventDefault keeps the focus wherever it was
                  (the transcript pill's rule — never steal focus). ── */}
              {!thoughtPinned && live ? (
                <button
                  type="button"
                  data-testid="thinking-jump-latest"
                  aria-label="Jump to the latest thinking"
                  title="Jump to the latest thinking"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => jumpThoughtToBottom()}
                  className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1 rounded-full border-[1.5px] pl-2 pr-1.5 py-0.5 shadow-md transition-all hover:shadow-lg"
                  style={{
                    borderColor: withAlpha(styles.accent, 0.28),
                    // R98-C2: the frosted pill rides the CSS-var leg (--ac-frosted).
                    background: "var(--ac-frosted)",
                    backdropFilter: "blur(12px) saturate(1.15)",
                    WebkitBackdropFilter: "blur(12px) saturate(1.15)",
                    color: styles.text,
                  }}
                >
                  <span className="text-[10px] font-semibold">Jump to latest</span>
                  <ChevronDown size={9} style={{ color: styles.accent }} aria-hidden />
                </button>
              ) : null}
              {/* ── R117-f: the settled thought's SHOW-ALL toggle — only when
                  the body passed its max-h-64 clamp (see THOUGHT_CLAMP_LINES)
                  and never while live. A quiet accent underline (the
                  TerminalDetail "+N more lines" idiom); "Show less" restores
                  the clamp. ── */}
              {overClamp ? (
                <button
                  type="button"
                  data-testid="thought-show-all"
                  onClick={() => setShowAll((v) => !v)}
                  aria-expanded={showAll}
                  className="mt-1 ml-1 text-[10px] font-medium underline"
                  style={{ color: styles.accent }}
                >
                  {showAll ? "Show less" : "Show all"}
                </button>
              ) : null}
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
  // R97-H: chat-narration rides the text-size ladder (Settings →
  // Appearance → Text Size) with the answer + thinking surfaces.
  return (
    <div
      className="chat-narration min-w-0 break-words py-0.5 text-[13px] leading-[1.6]"
      style={{ color: styles.text, ["--chat-base-size" as string]: "13px" } as React.CSSProperties}
    >
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
  // ROUND-96 (R96-H): the STRUCTURED diff (hunks + gutter numbers + honest
  // caps) replaces the old DiffLine[] — null until the snapshot resolves.
  const [diff, setDiff] = useState<UnifiedDiffResult | null>(null);
  // True when the load FINISHED without a snapshot (older session, no-op) —
  // distinct from null (still loading) so the effect never re-runs pointlessly.
  const [miss, setMiss] = useState(false);
  // The snapshot's shape: "create" (no before content — all-green NEW FILE
  // diff), "delete" (no after — all-red), "edit" (red/green hunks).
  const [kind, setKind] = useState<"edit" | "create" | "delete">("edit");
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
    // recorded" forever — the settled-state guard below then blocks
    // the re-run once the data actually arrives (the first diff card to
    // mount hit exactly this). Wait for the query; the effect re-fires on
    // the pending → settled transition (data arrival, and errors where
    // data stays undefined).
    if (checkpointsQuery.isLoading) return;
    if (diff !== null || miss || !sessionId) return;
    setLoading(true);
    try {
      const resolved = resolveSnapshotForTool(checkpointsQuery.data ?? [], path, tool.seq);
      const snap = resolved ? await fetchSnapshot(sessionId, resolved.seq) : null;
      if (snap === null) {
        setDiff(null);
        setMiss(true);
        setRestoreTarget(null);
      } else {
        setKind(snap.beforeContent === null ? "create" : snap.afterContent === null ? "delete" : "edit");
        setDiff(computeUnifiedDiff(snap.beforeContent, snap.afterContent));
        // ROUND-46 (R46-c): Restore targets the snapshot's BEFORE content. A
        // create (beforeContent === null) has nothing to go back to — and the
        // backend's restore of a create DELETES the file (unlink branch) — so
        // the action is deliberately NOT armed for creates.
        setRestoreTarget(
          snap.beforeContent !== null && resolved !== null
            ? { id: resolved.id }
            : null,
        );
      }
    } catch {
      setDiff(null);
      setMiss(true);
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
  // (h-5 px-2 rounded-full text-[10px] font-medium) so it reads as one family.
  // R100-D: the pill's rest/hover backgrounds moved to the CSS-var leg
  // (bg-subtle + hover:bg-hover — no JS hover painting).
  const restoreUi = (() => {
    if (restoreState === "restoring") {
      return (
        <button
          disabled
          aria-live="polite"
          title="Restoring the file to its content before this change…"
          className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium flex items-center gap-1 cursor-default bg-subtle"
          style={{ color: styles.textSecondary }}
        >
          <Loader2 size={10} className="animate-spin" /> Restoring…
        </button>
      );
    }
    if (restoreState === "restored") {
      return (
        <span
          className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium flex items-center gap-1"
          style={{
            background: withAlpha(SEMANTIC_COLORS.success, 0.12),
            color: SEMANTIC_COLORS.success,
          }}
        >
          <RotateCcw size={10} /> Restored
        </span>
      );
    }
    if (restoreTarget === null || diff === null) return null;
    if (restoreState === "confirm") {
      return (
        <>
          <button
            onClick={() => void onRestore()}
            title="Overwrite the file on disk with its recorded content from before this change"
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium border-[1.5px] transition-colors flex items-center gap-1"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            <RotateCcw size={10} /> Confirm restore?
          </button>
          <button
            onClick={() => setRestoreState("idle")}
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium transition-colors bg-subtle hover:bg-hover"
            style={{ color: styles.textSecondary }}
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
        className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium transition-colors flex items-center gap-1 bg-subtle hover:bg-hover"
        style={{ color: styles.textSecondary }}
      >
        <RotateCcw size={10} /> Restore
      </button>
    );
  })();

  const added = diff?.added;
  const removed = diff?.removed;

  return (
    <div className="min-w-0" data-testid="diff-block">
      <div className="flex items-center gap-2 mb-1">
        {path ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]" style={{ color: styles.textTertiary }} title={path}>
            {path}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {/* ROUND-96 (R96-H, owner: "like which parts of the code it changed
            and how it changed them… as modern IDEs do"): the one-glance file
            summary — NEW FILE for creates, the classic +N −M stats chip for
            edits (the numbers come from the real before/after snapshot). */}
        {kind === "create" ? (
          <span
            className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
            style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}
            data-diff-kind="create"
          >
            NEW FILE
          </span>
        ) : null}
        {kind === "delete" ? (
          <span
            className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
            style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}
            data-diff-kind="delete"
          >
            DELETED FILE
          </span>
        ) : null}
        {diff !== null && added !== undefined && removed !== undefined ? (
          <span className="shrink-0 flex items-center gap-1 font-mono text-[10px] tabular-nums">
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
            className="shrink-0 h-5 px-2 rounded-full text-[10px] font-medium transition-colors bg-subtle hover:bg-hover"
            style={{ color: styles.textSecondary }}
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
      ) : miss ? (
        <div className="px-3 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          no snapshot recorded for this change
        </div>
      ) : diff === null ? null : diff.identical ? (
        <div className="px-3 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
          no line changes between the recorded before and after
        </div>
      ) : (
        <div
          // R100-D (research §C4.5): the expanded diff card snaps to the 8px
          // radius step (rounded-lg), 1px border — the spec's exact card.
          className="rounded-lg max-h-96 overflow-y-auto auto-scroll font-mono text-[11px] leading-[1.55] border"
          style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.25)" : styles.bg }}
        >
          {diff.hunks.map((hunk, hi) => (
            <div key={`hunk-${hi}`}>
              {/* The classic "@@ -l,c +l,c @@" hunk header — the WHERE of the
                  change, at a glance (modern-IDE ask). Multiple hunks = the
                  far-between edits each get their own located window. */}
              <div
                className="px-2 py-0.5 sticky top-0 text-[10px] select-none"
                style={{
                  background: styles.isDark ? "rgba(0,0,0,0.45)" : styles.subtle,
                  color: styles.textTertiary,
                }}
                data-diff-hunk-header
              >
                {hunk.header}
              </div>
              {hunk.rows.map((line, li) => (
                <div
                  key={`row-${hi}-${li}`}
                  className="flex"
                  data-diff-type={line.type}
                  style={{
                    background:
                      line.type === "add"
                        ? withAlpha(SEMANTIC_COLORS.success, 0.07)
                        : line.type === "del"
                          ? withAlpha(SEMANTIC_COLORS.danger, 0.07)
                          : "transparent",
                  }}
                >
                  {/* The +/− gutter numbers (old | new), then the marker. */}
                  <span
                    className="w-8 shrink-0 select-none text-right pr-1.5"
                    data-diff-old={line.oldLine ?? ""}
                    style={{ color: styles.textTertiary, opacity: line.oldLine === null ? 0 : 1 }}
                  >
                    {line.oldLine ?? ""}
                  </span>
                  <span
                    className="w-8 shrink-0 select-none text-right pr-1.5"
                    data-diff-new={line.newLine ?? ""}
                    style={{ color: styles.textTertiary, opacity: line.newLine === null ? 0 : 1 }}
                  >
                    {line.newLine ?? ""}
                  </span>
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
          ))}
          {/* Honest tail notes — never a silent cut (the old renderer
              dropped lines past 200 with no marker). */}
          {diff.truncated > 0 ? (
            <div className="px-2 py-1 text-[10px]" style={{ color: styles.textTertiary }} data-diff-truncated>
              …{diff.truncated} more line{diff.truncated === 1 ? "" : "s"} not shown
            </div>
          ) : null}
          {diff.coarse ? (
            <div className="px-2 py-1 text-[10px]" style={{ color: styles.textTertiary }} data-diff-coarse>
              large change — shown as a block replacement, not a minimal diff
            </div>
          ) : null}
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
        {/* R125: the running accent replaces the retired RUNNING_BLUE — the
            live tail speaks the theme's own accent voice, not a blue slab. */}
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: styles.accent }} aria-hidden />
        <span
          className="text-[10px] font-mono font-medium uppercase tracking-[0.08em]"
          style={{ color: styles.accent }}
        >
          live
        </span>
      </div>
      <div
        ref={ref}
        className="rounded-lg border px-2.5 py-1.5 max-h-32 overflow-y-auto auto-scroll font-mono text-[10px] leading-[1.5] break-words"
        style={{
          borderColor: withAlpha(styles.accent, 0.28),
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
            aware — same as LiveOutputTail). R125: the theme accent owns the
            running voice (the retired RUNNING_BLUE's job). */}
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: styles.accent }} aria-hidden />
        <span
          className="text-[10px] font-mono font-medium uppercase tracking-[0.08em] truncate"
          style={{ color: styles.accent }}
          title={path.found ? path.value : undefined}
        >
          {label}
        </span>
      </div>
      <div
        ref={ref}
        className="rounded-lg border px-2.5 py-1.5 max-h-40 overflow-y-auto auto-scroll font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap"
        style={{
          borderColor: withAlpha(styles.accent, 0.28),
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
 * row mirrors a collapsed ToolLine's shape (running icon chip + label +
 * mono path + "…" in-flight status) with the live write preview beneath —
 * the owner sees the file being written the moment the model starts typing
 * its content. Not interactive: the preview is always shown.
 *
 * ROUND-125 (R125-2, owner: "it was showing me multiple writing at the same
 * time… the exact same ones… one much earlier in the conversation, the
 * other one showing further"): this row renders from the `pendingWrites`
 * PROP the chat panel threads to EXACTLY ONE section — the one that owns
 * the live tail. It used to read the store's streamingToolInputs through a
 * selector inside EVERY mounted live section, so a segmented turn (tools →
 * narration text → a new write) painted the same pending row in EACH of its
 * work sections plus the synthetic tail — the duplicate the owner watched.
 * The chip speaks the theme accent (R125's retirement of RUNNING_BLUE).
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
        <ToolIconChip Icon={Icon} background={withAlpha(styles.accent, 0.12)} color={styles.accent} />
        <span className="shrink-0 text-[11px] font-medium" style={{ color: styles.textSecondary }}>
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
  // R117-f (deliverable 6): the Copy button's copied-flash (the CodeBlock
  // copy idiom — 1.2s reset through the shared timeout-clear hook).
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const output = tool.outputSummary ?? null;
  // ROUND-52 (R52-c): an expanded in-flight run_command shows its LIVE
  // streaming tail (the same live view as under the pill — the "running…"
  // placeholder stays for calls with no output yet).
  const liveOutput = (tool as LiveToolUseEntry).liveOutput;
  if (output === null && tool.ok === null && liveOutput !== undefined && liveOutput !== "") {
    return <LiveOutputTail output={liveOutput} />;
  }
  const lines = output ? output.split("\n").filter((l) => l.length > 0) : [];
  // R117-f: the preview keeps its 3 lines (the rest behind the toggle).
  const preview = lines.slice(0, 3);
  const rest = lines.slice(3);
  if (output === null) {
    return (
      <div className="px-1 py-1 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
        {tool.ok === null ? "running…" : "no output"}
      </div>
    );
  }
  // R117-f (deliverable 6): the exit chip rides the detail's header row —
  // the colored form of the collapsed row's status detail (0 → quiet
  // success, N → danger), beside the Copy button (the CodeBlock idiom).
  const exitDetail = toolStatusDetail(tool);
  const copyOutput = () => {
    void navigator.clipboard?.writeText(output).then(() => {
      setCopied(true);
      resetAfter(() => setCopied(false), 1200);
    });
  };
  return (
    <div
      // R100-D (research §C4.5): expanded terminal card = 8px radius + 1px
      // border; 10.5→10px mono per the type floor snap.
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: styles.border }}
      data-testid="terminal-detail"
    >
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b"
        style={{ background: styles.subtle, borderColor: styles.border }}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {exitDetail !== null ? (
            <ToolStatusChip detail={exitDetail} />
          ) : (
            <span className="font-mono text-[10px] font-medium uppercase tracking-wide" style={{ color: styles.textTertiary }}>
              output
            </span>
          )}
        </span>
        <button
          onClick={copyOutput}
          aria-label="Copy output"
          title="Copy the command's output"
          data-testid="terminal-copy"
          className="shrink-0 flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors hover:bg-hover"
          style={{ color: styles.textTertiary }}
        >
          {copied ? <Check size={10} style={{ color: SEMANTIC_COLORS.success }} /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        className="px-3 py-2 font-mono text-[10px] leading-[1.55] max-h-56 overflow-y-auto auto-scroll"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)", color: styles.textSecondary }}
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
              className="mt-1 text-[10px] font-medium underline"
              style={{ color: styles.accent }}
            >
              {expanded ? "Show less" : `+${rest.length} more line${rest.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Output detail (default + web tools expanded body) ──────────────────────

function OutputDetail({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  if (tool.outputSummary === undefined || tool.outputSummary.length === 0) {
    return (
      <div className="px-1 py-1 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
        {tool.ok === null ? "running…" : "no output"}
      </div>
    );
  }
  return (
    <div
      className="rounded-lg border px-3 py-2 font-mono text-[10px] leading-[1.55] max-h-48 overflow-y-auto auto-scroll whitespace-pre-wrap break-words"
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
        <span className="shrink-0 font-medium" style={{ color: tone }}>
          {decisionText}
        </span>
        {attributedCode !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-md" style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}>
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
      // R100-D: the approval card keeps its semantic anatomy (§C4.5) — the
      // radius snaps 12px via the scale utility; the amber literals ride
      // SEMANTIC_COLORS.warning (the ONE documented spelling).
      className="rounded-xl border-[1.5px] px-3 py-2.5 my-1"
      style={{
        borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.55),
        background: withAlpha(SEMANTIC_COLORS.warning, styles.isDark ? 0.08 : 0.05),
      }}
      role="alert"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: SEMANTIC_COLORS.warning }} aria-hidden />
        {needsLookup ? (
          <span
            className="flex items-center gap-1 text-[12px] font-semibold min-w-0"
            style={{ color: styles.text }}
            data-testid="subagent-approval-attribution"
          >
            <span className="truncate">Sub-agent</span>
            {attributedCode !== undefined && attributedRole !== undefined ? (
              <>
                <span
                  className="shrink-0 font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-md tracking-[0.08em]"
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
        <span className="text-[12px] font-semibold shrink-0" style={{ color: styles.text }}>
          Permission needed
        </span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0" style={{ background: styles.subtle, color: styles.textTertiary }}>
          {entry.category}
        </span>
      </div>
      <div
        className="rounded-lg px-2.5 py-1.5 font-mono text-[12px] break-all mb-2"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.04)", color: styles.text }}
      >
        {entry.argsSummary || entry.toolName}
      </div>
      {onDecision ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecision(entry.approvalId, "approved", "once")}
            // R100-D (TOKENS §6 press law): the hover:scale is gone — resting
            // UI never fidgets; the active:scale press stays.
            className="h-7 px-3 rounded-full text-[11px] font-semibold transition-transform active:scale-95"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            Allow once
          </button>
          <button
            onClick={() => onDecision(entry.approvalId, "approved", "always")}
            className="h-7 px-3 rounded-full text-[11px] font-semibold border-[1.5px] transition-colors"
            style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
          >
            Always allow
          </button>
          <button
            onClick={() => onDecision(entry.approvalId, "denied", "once")}
            className="h-7 px-3 rounded-full text-[11px] font-semibold border-[1.5px] transition-colors"
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
        <div className="text-[10px] font-mono" style={{ color: styles.textTertiary }}>
          waiting for decision…
        </div>
      )}
    </div>
  );
}

// ─── ToolLine: the universal one-line tool row ───────────────────────────────

/**
 * ROUND-96 (R96-H, owner: "The chat window is not handled that well… the
 * chat area should show the details properly"): the tool row's one-glance
 * STATUS DETAIL — what the call actually DID, parsed from the summary the
 * tool itself already returned (the persisted event and the live SSE frame
 * carry the same outputSummary, so live and folded rows agree).
 *
 * HONESTY CONTRACT — only what the data actually carries:
 *  · run_command: the shell's exit code. Non-zero codes ride the output's
 *    "[exit code: N]" line (the exec tool stamps them); ok:true IS exit 0
 *    (the tool sets ok from the code) → the QUIET SUCCESS chip (R117-f:
 *    the colored exit-code chip — 0 reads green at 12% alpha, non-zero
 *    reads danger). A background launch has no settled code (the JOB
 *    outlives the launching shell) and a timeout/launch failure has none
 *    either → NO chip, the ✗ alone stays honest.
 *    Duration is NOT rendered: neither the SSE tool-result frame nor the
 *    persisted event carries one — noted rather than invented.
 *  · edit_file: the R96-C confirmation line ("Edited 'rel': N replacements,
 *    +A −B lines") → the classic +A −B stats chip.
 *  · read_file: the file's line count from the read markers ("of N total" /
 *    "returned lines A-B of N"), or the numbered lines when the whole read
 *    survived the 4K summary. A truncated summary (…[truncated N chars]…)
 *    renders NOTHING — a partial count would lie.
 *  · search_code: "N matches in M files" (or "0 matches" on the no-hit line).
 *  · search_files: "N files matching".
 * Pure; exported for tests (the assignDelegateChildren pattern).
 */
export function toolStatusDetail(
  tool: ToolUseEntry,
): { label: string; tone: "diff" | "danger" | "success" | "muted" } | null {
  if (tool.ok === null) return null;
  const out = tool.outputSummary ?? "";
  switch (tool.toolName) {
    case "run_command": {
      if (out.includes("[background job")) return null;
      const m = /\[exit code: (\d+)\]/.exec(out);
      if (m !== null) {
        // R117-f: a STAMPED code is the honest one — 0 reads the quiet
        // success tint whatever ok says (the exec tool sets ok FROM the
        // code, but the stamp is the record).
        return { label: `exit ${m[1]}`, tone: m[1] === "0" ? "success" : "danger" };
      }
      if (tool.ok === true) return { label: "exit 0", tone: "success" };
      return null;
    }
    case "edit_file": {
      // R96-C editConfirmation: "Edited 'rel': N replacements, +A −B lines…"
      const m = /(\d+) replacements?, \+(\d+) −(\d+) lines/.exec(out);
      if (m === null) return null;
      return { label: `+${m[2]} −${m[3]}`, tone: "diff" };
    }
    case "read_file": {
      if (out.includes("…[truncated")) return null;
      const total =
        /of (\d+) total/.exec(out) ?? /returned lines \d+-\d+ of (\d+)\]/.exec(out);
      if (total !== null) return { label: `${total[1]} lines`, tone: "muted" };
      // Whole-file read under the budget: the output is cat -n numbered —
      // count the "NNNNNN  " prefixed lines.
      const numbered = out.split("\n").filter((l) => /^\s*\d+  /.test(l)).length;
      return numbered > 0 ? { label: `${numbered} lines`, tone: "muted" } : null;
    }
    case "search_code": {
      const m = /^(\d+) match(?:es)? in (\d+) file(?:s)?/.exec(out);
      if (m !== null) {
        return {
          label: `${m[1]} match${m[1] === "1" ? "" : "es"} · ${m[2]} file${m[2] === "1" ? "" : "s"}`,
          tone: "muted",
        };
      }
      if (/^no content matches/.test(out)) return { label: "0 matches", tone: "muted" };
      return null;
    }
    case "search_files": {
      const m = /^(\d+) files? matching/.exec(out);
      return m !== null ? { label: `${m[1]} file${m[1] === "1" ? "" : "s"}`, tone: "muted" } : null;
    }
    default:
      return null;
  }
}

/** The rendered status-detail chip (toolStatusDetail's tone → styling).
 * R99-B: tabular-nums — the counts hold their width as they land.
 * R117-f: the tone ladder grew a SUCCESS rung — exit 0 reads the quiet
 * success tint, the danger tone gets its own chip background (the exit-code
 * chip is COLORED now, not just red text on a neutral pill). */
function ToolStatusChip({ detail }: { detail: NonNullable<ReturnType<typeof toolStatusDetail>> }) {
  const styles = useThemeStyles();
  if (detail.tone === "diff") {
    // The +/- pair — the diff card's own chip language (green/red).
    const [plus, minus] = detail.label.split(" ");
    return (
      <span className="shrink-0 flex items-center gap-0.5 font-mono text-[10px] tabular-nums" data-tool-status={detail.label}>
        <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}>
          {plus}
        </span>
        <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}>
          {minus}
        </span>
      </span>
    );
  }
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-full"
      style={{
        background:
          detail.tone === "success"
            ? withAlpha(SEMANTIC_COLORS.success, 0.12)
            : detail.tone === "danger"
              ? withAlpha(SEMANTIC_COLORS.danger, 0.1)
              : styles.subtle,
        color:
          detail.tone === "success"
            ? SEMANTIC_COLORS.success
            : detail.tone === "danger"
              ? SEMANTIC_COLORS.danger
              : styles.textTertiary,
      }}
      data-tool-status={detail.label}
    >
      {detail.label}
    </span>
  );
}

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
      className="shrink-0 grid h-5 w-5 place-items-center rounded-lg"
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
  // ROUND-96 (R96-H): the row's status detail (exit code / line count /
  // match count / the edit's +A −B) — only what the tool's own summary
  // carries (see toolStatusDetail's honesty contract).
  const statusDetail = toolStatusDetail(tool);
  // ── R117-f (deliverable 1): FAILURE VISIBILITY. A failed call tints the
  //    WHOLE row container — mobile ToolShell's language (R116-m donts #37:
  //    a danger border + a quiet ~5% danger wash; the 12px ✗ glyph alone was
  //    nearly invisible) — and its one-line error excerpt rides under the
  //    head while collapsed (expanding still shows the full dump). Rows that
  //    did NOT fail render byte-identical to pre-R117: no border, no wash —
  //    the tint arrives WITH the failure, never as hover noise. ──
  const failedRow = tool.ok === false;
  const errorExcerpt = failedRow && !open ? toolErrorExcerpt(tool.outputSummary) : null;
  // ── R117-f (deliverable 5): the humanized glance target — the file
  //    family's clickable PATH PILL, run_command's command headline, the
  //    delegate's role · task_id. The RAW argsSummary stays the fallback for
  //    unknown shapes AND always rides the row's title + aria-label + the
  //    expand — the record never shrinks to the glance. ──
  const target = formatToolTarget(tool.toolName, tool.argsSummary);
  // R99-B: the LEADING outcome glyph — ✓ success / ✗ failure / ◌ in-flight
  // (amber while the call waits on an approval — TOKENS §4: warning IS the
  // wait/attention semantic). The old TRAILING ✓/✗ span moved here so the
  // collapsed row reads status → verb → target → summary, the research
  // anatomy (VS Code/Cursor tool pills lead with the outcome). The status
  // WORD rides the row's aria-label (a button's aria-label replaces interior
  // content, so interior sr-only text would never be announced).
  // R100-D (research §C4.5, the every-glyph-an-icon law): the TEXT glyphs
  // (✓/✗/◌) are now LUCIDE components at the spec'd 12px — CircleCheck
  // success / CircleX danger / Loader in-flight — in the same semantic
  // colors (statusColor below is unchanged: tertiary while running, amber
  // while an approval waits). data-tool-status-kind carries the state for
  // tests/inspection (the icon renders no text).
  // DURATION HONESTY: no per-tool duration renders — neither the SSE
  // tool-result frame nor the persisted event carries timing data (the
  // R96-H noted-not-invented contract); the turn-level duration lives in
  // the section header's chip.
  const statusKind = tool.ok === false ? "failed" : tool.ok === null ? "running" : "ok";
  const StatusIcon = tool.ok === false ? CircleX : tool.ok === null ? Loader : CircleCheck;
  const statusColor =
    tool.ok === false
      ? SEMANTIC_COLORS.danger
      : tool.ok === null
        ? waitingApproval
          ? AMBER
          : styles.textTertiary
        : SEMANTIC_COLORS.success;
  const statusWord =
    tool.ok === false
      ? "failed"
      : tool.ok === null
        ? waitingApproval
          ? "waiting for approval"
          : "running"
        : "completed";

  // ROUND-51 (R51-d): the chip tint per family. Delegations carry the accent
  // wash (the strongest signal — a sub-agent is working on the project);
  // file edits stay calm (subtle + textSecondary, the chip SHAPE is the
  // differentiator) and borrow the RUNNING accent only while
  // ok === null — the same in-progress language as SubAgentPanel's live rows.
  // R125: the running voice is the THEME ACCENT (the owner's "blue colored
  // area" verdict retired RUNNING_BLUE from this file).
  // Every other tool keeps the plain glyph, byte-identical to pre-R51.
  const chipTone =
    tool.toolName === "delegate_task"
      ? { background: withAlpha(styles.accent, 0.12), color: styles.accent }
      : DIFF_TOOLS.has(tool.toolName)
        ? {
            background: tool.ok === null ? withAlpha(styles.accent, 0.12) : styles.subtle,
            color: tool.ok === null ? styles.accent : styles.textSecondary,
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
    <div
      data-testid="tool-line"
      data-tool-failed={failedRow ? "true" : undefined}
      className={failedRow ? "min-w-0 rounded-lg border py-0.5 px-0.5" : "min-w-0"}
      style={
        failedRow
          ? {
              borderColor: withAlpha(SEMANTIC_COLORS.danger, styles.isDark ? 0.55 : 0.45),
              background: withAlpha(SEMANTIC_COLORS.danger, 0.05),
            }
          : undefined
      }
    >
      {/* R117-f: the row is a div[role=button] (the LiveDelegateRow
          precedent) so a failed/path row can host REAL interactive children —
          the clickable PathPill below — without nesting buttons; the keydown
          handler mirrors the native-button Enter/Space contract exactly. */}
      <div
        role="button"
        tabIndex={0}
        onClick={
          rowAction === "open-subagent"
            ? openSingleLive
            : rowAction === "toggle"
              ? toggle
              : undefined
        }
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          // Non-interactive rows keep the native-button behavior: focusable,
          // but the keys never act.
          if (rowAction === null) return;
          e.preventDefault();
          if (rowAction === "open-subagent") openSingleLive();
          else toggle();
        }}
        aria-expanded={rowAction === "toggle" ? open : undefined}
        aria-label={
          rowAction === "open-subagent" && singleLiveChild !== null
            ? `Open sub-agent ${singleLiveChild.code} · ${singleLiveChild.title ?? "Sub-agent"} in sidebar`
            : `${label} ${tool.argsSummary} — ${statusWord}`
        }
        title={
          rowAction === "open-subagent" && singleLiveChild !== null
            ? `Open sub-agent ${singleLiveChild.code} in the right sidebar`
            : `${tool.toolName} ${tool.argsSummary}`
        }
        // R100-D: the row's hover wash is a CSS class (hover:bg-hover), gated
        // to interactive rows exactly as the old JS handler was — the
        // non-interactive rows (rowAction === null) never paint a hover.
        // R117-f: the failed row sits INSIDE its tinted container, so the
        // -ml-1 bleed (the hover wash's left reach) drops there only.
        className={`flex items-center gap-2 h-7 w-full max-w-full px-1 rounded-md transition-colors text-left ${
          rowAction !== null ? "hover:bg-hover" : ""
        }${failedRow ? "" : " -ml-1"}`}
        style={{
          color: styles.textTertiary,
          cursor: rowAction !== null ? "pointer" : "default",
        }}
      >
        {/* R99-B: the leading outcome glyph (see the statusWord derive above
            for the honesty/a11y notes) — R100-D: the 12px lucide status icon. */}
        <span
          data-testid="tool-status-glyph"
          data-tool-status-kind={statusKind}
          className="shrink-0 w-3.5 grid place-items-center leading-none"
          aria-hidden="true"
        >
          <StatusIcon size={12} style={{ color: statusColor }} strokeWidth={2.25} />
        </span>
        {chipTone !== null ? (
          <ToolIconChip Icon={Icon} background={chipTone.background} color={chipTone.color} />
        ) : (
          <Icon size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
        )}
        <span className="shrink-0 text-[11px] font-medium" style={{ color: styles.textSecondary }}>
          {label}
        </span>
        {/* R117-f: the humanized target (deliverable 5) — the path PILL for
            file tools (the R40 open-in-sidebar affordance, the same component
            the answers speak; stopPropagation keeps the row's toggle out of
            the pill's click), the command's headline / the delegate's
            role · task_id as plain mono, else the RAW summary. */}
        {target !== null && target.kind === "path" ? (
          <span className="min-w-0 flex-1 flex justify-start" onClick={(e) => e.stopPropagation()}>
            <PathPill path={target.value} projectId={projectId} />
          </span>
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px]"
            style={{ color: styles.textTertiary }}
            title={tool.argsSummary}
          >
            {target !== null ? target.value : tool.argsSummary}
          </span>
        )}
        {statusDetail !== null ? <ToolStatusChip detail={statusDetail} /> : null}
        {rowAction === "open-subagent" ? (
          <span
            className="shrink-0 flex items-center gap-1 text-[10px] font-medium"
            style={{ color: styles.accent }}
          >
            live
            <PanelRightOpen size={11} />
          </span>
        ) : null}
        {rowAction === "toggle" ? (
          <ChevronDown
            size={10}
            className="shrink-0"
            style={{ color: styles.textTertiary, transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
      </div>
      {/* R117-f (deliverable 1c): the one-line error excerpt under a failed
          row's head — the tool's own first output line, mono, danger,
          truncated; expanding swaps it for the full dump. */}
      {errorExcerpt !== null ? (
        <div className="mt-0.5 mb-1 pl-1 pr-2 min-w-0" data-testid="tool-error-excerpt">
          <span
            className="block truncate font-mono text-[10px]"
            style={{ color: SEMANTIC_COLORS.danger }}
            title={errorExcerpt}
          >
            {errorExcerpt}
          </span>
        </div>
      ) : null}
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
  live = false,
  startedAtMs,
  stopped = false,
  liveEntryIndex,
  defaultOpen,
  clockVisible = true,
  onApprovalDecision,
  onQuestionAnswer,
  pendingWrites,
}: {
  entries: WorkingEntry[];
  sessionId: string | null;
  /** ROUND-40: the chat panel's project id — threaded down to SubAgentCard
   * so clicking a sub-agent task opens its tab in the right sidebar. */
  projectId: string;
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
   * design), live turns start expanded.
   * ROUND-120 (R120-C-PC, item 36): the turn renders ONE live clock — the
   * panel passes clockVisible only on the turn's FIRST live work section
   * (before, every segmented live section painted its own right-aligned
   * elapsed clock — the owner's "8-9 separate right-side blocks"). */
  defaultOpen?: boolean;
  /** R120-C-PC (item 36): gates the live elapsed clock (default true). */
  clockVisible?: boolean;
  onApprovalDecision?: (approvalId: string, decision: ApprovalDecisionChoice, remember: ApprovalRemember) => void;
  /** ROUND-87 (R87): resolve a pending ask_user card (answers aligned per
   * question, sources = option-pick vs custom-typed). Wired on LIVE sections
   * only — a folded card is already settled. */
  onQuestionAnswer?: (questionId: string, answers: string[], sources: Array<"option" | "custom">) => void;
  /** ROUND-125 (R125-2, owner: "it was showing me multiple writing at the
   * same time… the exact same ones… one much earlier in the conversation,
   * the other one showing further"): the PENDING streaming write inputs
   * (write_file/edit_file calls whose JSON args the model is still
   * generating). The chat panel passes this to EXACTLY ONE section — the
   * one that owns the live tail — replacing this component's internal
   * stream-store selector, which made EVERY mounted live section read the
   * SAME streamingToolInputs and render the same pending row (a segmented
   * turn painted it in each of its work sections + the synthetic tail —
   * the owner's duplicate). Undefined = no pending rows (folded sections,
   * non-owning live sections). */
  pendingWrites?: StreamingToolInput[];
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

  // ROUND-125 (R125-2): the pending write inputs arrive as a PROP — passed
  // ONLY to the section that owns the live tail (the panel's choice; see
  // the prop's doc). The OLD store selector
  // (useStreamStore((s) => s.bySession[sessionId]?.liveTurn?.streamingToolInputs))
  // subscribed EVERY mounted live section to the SAME array, so each one
  // rendered the same LiveWritePendingRow — the owner's "multiple writing
  // at the same time… the exact same ones… one much earlier in the
  // conversation, the other one showing further". Folded sections and
  // non-owning live sections simply carry no pending rows.
  const pendingWriteInputs: StreamingToolInput[] = pendingWrites ?? EMPTY_STREAMING_INPUTS;

  const toolCount = entries.filter((e) => e.type === "tool").length;
  const pendingApproval = entries.some((e) => e.type === "approval" && e.status === "pending");
  // R120-C-PC (item 35): the rows that ride OUTSIDE the collapse — every
  // file-mutation entry (write/edit/create/delete), plus — while LIVE — the
  // PENDING streaming write inputs (a file being written right now is never
  // hidden by a fold). Derived once so the collapsed block renders ONLY when
  // it has something to show (no phantom padding on a read-only fold).
  const fileMutationRows: WorkingEntry[] = entries.filter(
    (e) => e.type === "tool" && FILE_MUTATION_TOOLS.has(e.tool.toolName),
  );
  const showFoldFileRows = fileMutationRows.length > 0 || (live && pendingWriteInputs.length > 0);

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

  // ── R99-B: the header grammar (the COMPRESSED/FULL matrix in the file
  // docblock). FOLDED: ✓ success glyph + "Completed N steps" + "· N tools".
  // LIVE: ● pulsing accent dot + "Working" (+ the amber waiting note) with
  // the actions counter + elapsed clock right-aligned — R120-C-PC (item 36):
  // the clock renders only on the turn's FIRST live work section
  // (clockVisible) so one turn paints ONE clock, never a stack of them.
  // Every number is mono tabular-nums — counts and clocks grow without
  // width jitter (the owner's anti-jitter discipline). A stopped live
  // section keeps the Square glyph (the TurnStoppedCard mark).
  // The status word rides the aria-label — the row button's aria-label
  // REPLACES interior content for assistive tech, so an interior sr-only
  // span would never be announced; the label says it outright.
  // ── R117-f (deliverable 1b): the folded header STOPS LYING. When any tool
  // in the folded section failed, the green ✓ swaps for the danger ✗ and a
  // "· N failed" count rides the label (the "N steps · M failed" variant of
  // the round's fix) — the pre-R117 header showed "✓ Completed N steps"
  // even when tools failed inside it (round-117 §1 item 13, the round's #1
  // PC bug). ──
  const stepCount = entries.length;
  const stepWord = stepCount === 1 ? "step" : "steps";
  const toolWord = toolCount === 1 ? "tool" : "tools";
  const failedToolCount = entries.filter((e) => e.type === "tool" && e.tool.ok === false).length;
  const headerLabel = live
    ? stopped
      ? "Stopped"
      : "Working"
    : `Completed ${stepCount} ${stepWord}`;
  const toolSuffix = !live && toolCount > 0 ? ` · ${toolCount} ${toolWord}` : "";
  const failedSuffix = !live && failedToolCount > 0 ? ` · ${failedToolCount} failed` : "";
  const liveActionLabel =
    live && toolCount > 0 ? `${toolCount} ${toolCount === 1 ? "action" : "actions"}` : "";
  // R120-C-PC (item 36): ONE live clock per turn (clockVisible — the panel
  // passes it only on the first live work section); folded sections carry
  // no duration at all anymore (the turn footer's consolidated block owns
  // the "how long it ran" answer).
  const liveClock =
    live && !stopped && startedAtMs !== undefined && clockVisible
      ? formatClock(liveSeconds * 1000)
      : null;
  const ariaSummary = live
    ? `${headerLabel}${liveActionLabel !== "" ? ` · ${liveActionLabel}` : ""}${
        liveClock !== null ? ` · ${liveClock}` : ""
      }`
    : `${headerLabel}${toolSuffix}${failedSuffix}`;

  return (
    <div className="min-w-0">
      <div
        data-testid="work-section-header"
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
        aria-label={`${ariaSummary}. ${expanded ? "Collapse" : "Expand"} work.`}
      >
        {live && !stopped ? (
          <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: styles.accent }} aria-hidden />
        ) : live ? (
          /* The stopped mark — the TurnStoppedCard's Square glyph (a stop is
             a quiet terminal state, never a failure). */
          <Square size={11} strokeWidth={2.5} className="shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
        ) : failedToolCount > 0 ? (
          /* R117-f: the failure-aware mark — ✗ in the danger color (the
             glyph swaps with the label; the section no longer claims a
             clean ✓ over failed work). */
          <CircleX size={11} strokeWidth={2.5} className="shrink-0" style={{ color: SEMANTIC_COLORS.danger }} aria-hidden />
        ) : (
          /* The completed mark — success ✓ (the folded work stands done). */
          <Check size={11} strokeWidth={2.5} className="shrink-0" style={{ color: SEMANTIC_COLORS.success }} aria-hidden />
        )}
        <span className="text-[12px] font-medium truncate" style={{ color: styles.textSecondary }}>
          {headerLabel}
        </span>
        {!live && toolCount > 0 && !pendingApproval ? (
          <span className="shrink-0 text-[10px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
            · {toolCount} {toolWord}
          </span>
        ) : null}
        {/* R117-f: the failure count — mono tabular-nums like the tool count,
          but in the danger color so the compressed row tells the truth at a
          glance (only on a folded section with failures). */}
        {!live && failedToolCount > 0 ? (
          <span
            data-testid="work-failed-count"
            className="shrink-0 text-[10px] font-mono tabular-nums font-medium"
            style={{ color: SEMANTIC_COLORS.danger }}
          >
            · {failedToolCount} failed
          </span>
        ) : null}
        {pendingApproval ? (
          <span className="shrink-0 text-[10px] font-medium" style={{ color: AMBER }}>
            · waiting for approval
          </span>
        ) : null}
        <span className="flex-1" />
        {/* The right-aligned numeric cluster — actions + clock while LIVE,
            the duration chip when folded (mono tabular-nums both). */}
        {live && liveActionLabel !== "" ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
            {liveActionLabel}
          </span>
        ) : null}
        {liveClock !== null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
            {liveClock}
          </span>
        ) : null}
        <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }} className="shrink-0">
          <ChevronDown size={12} style={{ color: styles.textTertiary }} />
        </motion.span>
      </div>
      {/* ── ROUND-120 (R120-C-PC, item 35): the FILE-MUTATION rows ride
          OUTSIDE the collapse. The owner's verdict — "file edits, created
          files… are not shown — the center never renders them" — was the
          R38 fold-by-default design hiding every write/edit/create/delete
          behind the "Completed N steps" header. Now those rows render as
          the SAME compact ToolLine rows the expanded body speaks (path
          pill + status glyph + the one-line summary — the PC vocabulary,
          reused verbatim), visible whether the section is collapsed or
          not; expanding swaps them into the full timeline in place (never
          a duplicate). Reads/searches/commands keep their home behind the
          expand. While LIVE and collapsed, the PENDING streaming writes
          ride here too (the honest live center: a file being written is
          never hidden by a fold). ── */}
      {!expanded && showFoldFileRows ? (
        <div className="py-0.5 flex flex-col gap-0.5" data-testid="fold-file-rows">
          {fileMutationRows.map((entry) =>
            entry.type === "tool" ? (
              <ToolLine
                key={`fold-file-${entry.tool.seq}`}
                tool={entry.tool}
                sessionId={sessionId}
                live={live}
                projectId={projectId}
              />
            ) : null,
          )}
          {live
            ? pendingWriteInputs.map((si) => (
                <LiveWritePendingRow key={`sw-${si.toolCallId}`} toolName={si.toolName} raw={si.raw} />
              ))
            : null}
        </div>
      ) : null}
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
                // ROUND-87 (R87): the ask_user card (option pills + custom
                // input while pending; the answered/timeout states collapse
                // honestly) and the turn's todo-list card.
                if (entry.type === "question") {
                  return (
                    <QuestionCard
                      key={`q-${entry.questionId}-${entry.ts}`}
                      entry={entry}
                      onAnswer={live ? onQuestionAnswer : undefined}
                    />
                  );
                }
                if (entry.type === "todo") {
                  return <TodoCard key={`todo-${entry.ts}`} entry={entry} />;
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
        // ROUND-87 (R87): the question + todo cards ride bare blocks too
        // (a tools-free turn can still ask or track todos).
        if (entry.type === "question") {
          return <QuestionCard key={`bq-${i}`} entry={entry} onAnswer={undefined} />;
        }
        if (entry.type === "todo") {
          return <TodoCard key={`bt-${i}`} entry={entry} />;
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
