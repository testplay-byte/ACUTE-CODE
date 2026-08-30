import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  FileCode2,
  Globe,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  fetchSubAgentDetail,
  fetchSubAgents,
  retrySubAgent,
  type SessionDetail,
  type SessionEvent,
  type SubAgentStatus,
} from "../../lib/api";
import { selectSubAgentsLive, useStreamStore } from "../../lib/stream-store";
import type { SubAgentLiveEntry, SubAgentLiveStep } from "../../lib/stream-store";
// ROUND-50 (R50-b): the live segment reuses the main chat's EXACT thinking
// visual (auto-expand while live, collapse when done) so the sub-agent's raw
// stream reads like the main agent's.
import { ThoughtRow } from "../project-chat/WorkingSection";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { ease } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import { Markdown } from "./FileViewerPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";

/**
 * ROUND-48 (R48-e2) right-sidebar Sub-agent tab — the CHAT redesign (owner:
 * "it should look like the main chat, show the tools it runs live; the timer
 * updates every 5s instead of every second"). The R43 phase-card stack
 * (Task/Activity/Files/Report) is replaced by a chat TRANSCRIPT of the
 * child's event log, in the main chat's visual language:
 *
 *   message.user      → the delegation prompt as a right-aligned
 *                       accent-tinted task bubble (AgentChatPanel's
 *                       UserMessage language, scaled for the sidebar)
 *   message.assistant → a markdown bubble (FileViewerPanel's shared Markdown
 *                       renderer); the LAST one on a terminal run wears the
 *                       accent rail + "Final report" label (the old Report
 *                       card's affordance, now inline)
 *   tool.use          → one-line rows in the SAME visual style as the main
 *                       chat's tool lines (icon + past-tense label + mono
 *                       argsSummary + ✓/✗/… state + expandable output)
 *   todo.update       → a compact progress line (bar + n/m + current item)
 *   approval.*        → compact INFORMATIONAL cards — decisions happen in the
 *                       PARENT chat, where the ask lands with this child's
 *                       code attribution (R48-e1 wire contract)
 *   turn.error        → an error banner (TurnErrorCard language, compact)
 *
 * Kept from the R43 panel: the coherent header status chip, the explicit
 * failed banner with the Retry primary action (resumes from the event log via
 * POST /sessions/:parent/subagents/:child/retry), the 600ms live poll while
 * running (now slower — 5s — once settled), the stick-to-bottom scrolling
 * with the custom auto-scroll scrollbar, and the single initial-load spinner.
 *
 * Header: monospace code chip (R48-e1's deterministic 4-char [A-Z0-9] code —
 * resolved from the live SSE map, falling back to the polled /subagents row)
 * + role chip + title + StatusChip + an elapsed clock that now ticks EVERY
 * SECOND (was 5s — the owner's complaint).
 *
 * ROUND-50 (R50-b, owner: the panel must show "the actual live responses…
 * the raw data, the raw thinking, the raw text of it, streamed live just
 * like the main agent" + a stats footer at the very bottom): a LIVE
 * STREAMING segment renders the child's raw stream (thinking/text/tool rows
 * in arrival order, main-chat visuals) from the stream-store's live map
 * while the child works — see LiveStreamSegment + the visibility rule in
 * SubAgentPanel — and a pinned SubAgentStatsBar shows time / tokens sent /
 * tokens received / tokens-per-second / model (live values while running,
 * authoritative row values after completion).
 */
const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a925",
  tester: "#f59e0b",
};

const RUNNING_BLUE = "#3B82F6";

/** Tool icon + past-tense label maps — mirrors WorkingSection's maps so the
 * child's tool rows read EXACTLY like the main chat's tool lines. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  list_dir: FileCode2,
  read_file: FileCode2,
  write_file: FileCode2,
  edit_file: FileCode2,
  create_dir: FileCode2,
  delete_file: FileCode2,
  web_search: Globe,
  web_fetch: Globe,
  search_code: Search,
  search_files: Search,
  git_status: FileCode2,
  git_diff: FileCode2,
  git_log: FileCode2,
  run_command: TerminalIcon,
  todo_write: ListChecks,
  index_project: TerminalIcon,
  delegate_task: TerminalIcon,
};

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

/** Strip a leading "K7Q2 · " code prefix from a tab title (the R48-e2
 * openSubAgent call sites prefix titles with the child's code; the header
 * shows the code as its OWN chip, so the text must not repeat it). */
function stripCodePrefix(title: string): string {
  return title.replace(/^[A-Z0-9]{4} · /, "");
}

/** m:ss (or h:mm:ss) elapsed since the first event — the header's live clock. */
function elapsedLabel(startTs: string | undefined, nowMs: number): string | null {
  if (startTs === undefined) return null;
  const t = Date.parse(startTs);
  if (Number.isNaN(t)) return null;
  return elapsedFromMs(Math.max(0, nowMs - t));
}

/** m:ss (or h:mm:ss) for a raw elapsed-ms duration — the stats footer's
 * TIME cell (same format as the header clock). */
function elapsedFromMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  const hh = Math.floor(mm / 60);
  if (hh > 0) return `${hh}:${String(mm % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** Compact token count (k above 1000) — the stats footer's token cells. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// ─── Transcript model ────────────────────────────────────────────────────────

interface ToolCard {
  toolName: string;
  argsSummary: string;
  ok: boolean | null;
  outputSummary: string | null;
  ts: string;
}

interface ApprovalCardData {
  approvalId: string;
  toolName: string;
  argsSummary: string;
  category: string;
  status: "pending" | "approved" | "denied" | "expired";
  remember?: "once" | "always";
  ts: string;
}

interface TodoCardData {
  done: number;
  total: number;
  current: string | null;
}

interface ErrorCardData {
  code: string;
  message: string;
  providerError?: string;
  model?: string;
  ts: string;
}

type TranscriptItem =
  | { kind: "user"; seq: number; ts: string; content: string }
  | { kind: "assistant"; seq: number; ts: string; content: string }
  | { kind: "tool"; seq: number; ts: string; tool: ToolCard }
  | { kind: "todo"; seq: number; ts: string; todos: TodoCardData }
  | { kind: "approval"; seq: number; ts: string; approval: ApprovalCardData }
  | { kind: "error"; seq: number; ts: string; error: ErrorCardData };

/** Fold the child's append-only event log into renderable transcript items
 * (seq order). Approval resolved events update their requested card in place
 * (the same fold toProjectChatItems applies on the main timeline). */
function parseSubAgentTranscript(events: SessionEvent[]): {
  items: TranscriptItem[];
  firstTs: string | undefined;
  hasRunningTool: boolean;
  lastAssistantSeq: number | null;
} {
  const items: TranscriptItem[] = [];
  const approvalIndex = new Map<string, number>();
  let hasRunningTool = false;
  let lastAssistantSeq: number | null = null;

  for (const e of events) {
    const payload =
      e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : null;

    if (e.type === "message.user") {
      if (payload !== null && typeof payload.content === "string" && payload.content !== "") {
        items.push({ kind: "user", seq: e.seq, ts: e.ts, content: payload.content });
      }
      continue;
    }

    if (e.type === "message.assistant") {
      if (payload !== null && typeof payload.content === "string" && payload.content.trim() !== "") {
        lastAssistantSeq = e.seq;
        items.push({ kind: "assistant", seq: e.seq, ts: e.ts, content: payload.content });
      }
      continue;
    }

    if (e.type === "tool.use") {
      const toolName = typeof payload?.toolName === "string" ? payload.toolName : "tool";
      const argsSummary = typeof payload?.argsSummary === "string" ? payload.argsSummary : "";
      const ok = typeof payload?.ok === "boolean" ? payload.ok : null;
      const outputSummary = typeof payload?.outputSummary === "string" ? payload.outputSummary : null;
      if (ok === null) hasRunningTool = true;
      items.push({
        kind: "tool",
        seq: e.seq,
        ts: e.ts,
        tool: { toolName, argsSummary, ok, outputSummary, ts: e.ts },
      });
      continue;
    }

    if (e.type === "todo.update") {
      const raw = Array.isArray(payload?.todos)
        ? (payload.todos as Array<{ content?: unknown; status?: unknown }>)
        : [];
      if (raw.length > 0) {
        const todos = raw.map((t) => ({
          content: typeof t.content === "string" ? t.content : "",
          status: t.status === "completed" || t.status === "in_progress" ? t.status : ("pending" as const),
        }));
        items.push({
          kind: "todo",
          seq: e.seq,
          ts: e.ts,
          todos: {
            done: todos.filter((t) => t.status === "completed").length,
            total: todos.length,
            current: todos.find((t) => t.status === "in_progress")?.content ?? null,
          },
        });
      }
      continue;
    }

    if (e.type === "approval.requested" || e.type === "approval.resolved") {
      const approvalId = typeof payload?.approvalId === "string" ? payload.approvalId : "";
      const toolName = typeof payload?.toolName === "string" ? payload.toolName : "run_command";
      const argsSummary = typeof payload?.argsSummary === "string" ? payload.argsSummary : "";
      const category = typeof payload?.category === "string" ? payload.category : "confirm";
      if (e.type === "approval.requested") {
        approvalIndex.set(approvalId, items.length);
        items.push({
          kind: "approval",
          seq: e.seq,
          ts: e.ts,
          approval: { approvalId, toolName, argsSummary, category, status: "pending", ts: e.ts },
        });
      } else {
        const status =
          payload?.decision === "approved" || payload?.decision === "denied"
            ? (payload.decision as "approved" | "denied")
            : ("expired" as const);
        const remember =
          payload?.remember === "once" || payload?.remember === "always" ? payload.remember : undefined;
        const idx = approvalIndex.get(approvalId);
        if (idx !== undefined && items[idx]?.kind === "approval") {
          items[idx] = {
            ...items[idx],
            approval: { ...items[idx].approval, status, ...(remember !== undefined ? { remember } : {}) },
          };
        } else {
          items.push({
            kind: "approval",
            seq: e.seq,
            ts: e.ts,
            approval: { approvalId, toolName, argsSummary, category, status, ts: e.ts },
          });
        }
      }
      continue;
    }

    if (e.type === "turn.error") {
      const asString = (v: unknown): string | undefined =>
        typeof v === "string" && v.length > 0 ? v : undefined;
      items.push({
        kind: "error",
        seq: e.seq,
        ts: e.ts,
        error: {
          code: asString(payload?.code) ?? "PROVIDER_ERROR",
          message: asString(payload?.message) ?? "The generation failed.",
          providerError: asString(payload?.providerError),
          model: asString(payload?.model),
          ts: e.ts,
        },
      });
      continue;
    }
    // Other event types (session markers etc.) don't render in the transcript.
  }

  return { items, firstTs: events[0]?.ts, hasRunningTool, lastAssistantSeq };
}

/** The panel's coherent status vocabulary (unchanged from the R43 panel). */
type PanelStatus = "queued" | "running" | "retrying" | "done" | "failed" | "cancelled";

function derivePanelStatus(
  detail: SessionDetail | undefined,
  hasRunningTool: boolean,
  retrying: boolean,
): PanelStatus {
  if (retrying) return "retrying";
  const s = (detail as unknown as { status?: string } | undefined)?.status;
  if (s === "running") return "running";
  if (s === "failed") return "failed";
  if (s === "cancelled") return "cancelled";
  if (s === "completed") return "done";
  // queued / undefined — but a tool in flight means work is happening.
  return hasRunningTool ? "running" : "queued";
}

export function SubAgentPanel({ tab }: { tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const subAgentId = tab.subAgentId ?? null;
  const parentSessionId = tab.parentSessionId ?? null;

  // ROUND-41/R48-e2: poll the child's event log at 600ms for near-live
  // progress while queued/running; once settled drop to a slow 5s heartbeat
  // (a retry from the chat's SubAgentCard flips the status back and the fast
  // poll resumes on the next refetch).
  const detailQuery = useQuery({
    queryKey: ["subagent-detail", subAgentId],
    queryFn: () => fetchSubAgentDetail(subAgentId as string),
    enabled: subAgentId !== null,
    staleTime: 600,
    refetchInterval:
      subAgentId === null
        ? false
        : (query) => {
            const s = (query.state.data as unknown as { status?: string } | undefined)?.status;
            return s === "running" || s === "queued" ? 600 : 5000;
          },
  });

  // The parent's children rows (the SAME ["subagents", parent] cache key the
  // picker/Delegated card/SubAgentCard use): this child's code (the header
  // chip — R48-e1's deterministic 4-char id), its recorded error (the failed
  // banner's reason) and its title. Polled live while any child runs.
  const subsQuery = useQuery({
    queryKey: ["subagents", parentSessionId],
    queryFn: () => fetchSubAgents(parentSessionId as string),
    enabled: parentSessionId !== null,
    staleTime: 600,
    refetchInterval:
      parentSessionId === null
        ? false
        : (query) => {
            const anyLive = (query.state.data ?? []).some(
              (s: SubAgentStatus) => s.status === "running" || s.status === "queued",
            );
            return anyLive ? 600 : 5000;
          },
  });

  // The stream-store live map is the FRESHEST source (straight off the SSE
  // frames, no poll lag) — the polled row is the durable fallback.
  const liveMap = useStreamStore(selectSubAgentsLive);
  const liveEntry = subAgentId !== null ? liveMap[subAgentId] : undefined;
  const childRow = subAgentId !== null ? (subsQuery.data ?? []).find((s) => s.id === subAgentId) : undefined;
  const code = liveEntry?.code ?? childRow?.code ?? null;

  const events = detailQuery.data?.events ?? [];
  const { items, firstTs, hasRunningTool, lastAssistantSeq } = parseSubAgentTranscript(events);

  // Local retry state: true from the Retry click until the endpoint answers
  // (the chip shows "retrying", then polling takes over with running/…).
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const liveStatus = derivePanelStatus(detailQuery.data, hasRunningTool, retrying);
  const isWorking = liveStatus === "running" || liveStatus === "retrying";

  // ── ROUND-50 (R50-b): the LIVE raw-stream segment ──────────────────────
  // Visibility rule (documented, deterministic):
  //  1. The child must have LIVE data in the store (the subagent-event
  //     envelope stream — thinking/text deltas + tool rows). No live entry
  //     (reloaded mid-run, channel-less run) → the polled transcript stands
  //     alone, exactly as before R50-b.
  //  2. While the child is queued/running the segment renders (frozen tail
  //     included) — the raw stream the owner asked to see live.
  //  3. HANDOFF: once the child turns terminal, the segment stays visible
  //     ONLY until the polled transcript catches up (its LAST event is a
  //     closing message.assistant or turn.error — both turn paths always
  //     close a finished attempt with one), bridging the 600ms poll lag so
  //     nothing flashes away; then the polled transcript takes over.
  //  4. While the segment is visible, polled TOOL + ASSISTANT rows are
  //     SUPPRESSED (kind-based, no timestamp races): the live log renders
  //     exactly those live; user/todo/approval/error rows keep rendering —
  //     the live stream carries none of them. Zero duplication, main-chat
  //     parity (live turn above → folded turn below, never both).
  const liveText = liveEntry?.liveText ?? "";
  const liveThinking = liveEntry?.liveThinking ?? "";
  const liveSteps = liveEntry?.liveSteps ?? [];
  const liveHasContent =
    liveText !== "" || liveThinking !== "" || liveSteps.length > 0 || (liveEntry?.liveToolCalls ?? 0) > 0;
  const lastEvent = events[events.length - 1];
  const polledCaughtUp =
    lastEvent !== undefined &&
    (lastEvent.type === "message.assistant" || lastEvent.type === "turn.error");
  const liveSegmentVisible = liveHasContent && (isWorking || !polledCaughtUp);
  const renderItems = liveSegmentVisible
    ? items.filter((it) => it.kind !== "tool" && it.kind !== "assistant")
    : items;

  // The error REASON for the failed banner: the child's recorded error (the
  // subagents listing) → the last failed tool's output → a quiet fallback.
  const lastFailure = (() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "tool" && it.tool.ok === false) return it.tool;
    }
    return null;
  })();
  const failureReason =
    childRow?.error ??
    (lastFailure !== null
      ? `${lastFailure.toolName}${lastFailure.outputSummary !== null && lastFailure.outputSummary !== "" ? `: ${lastFailure.outputSummary}` : ""}`
      : null) ??
    (detailQuery.data !== undefined ? "The run ended in a failed state." : null);

  const role = tab.subRole ?? liveEntry?.role ?? childRow?.subRole ?? "agent";
  const roleColor = ROLE_COLORS[role] ?? styles.accent;

  // ROUND-48 (R48-e2, owner: "the timer updates every 5s instead of every
  // second"): the header clock now ticks at 1000ms (was 5000ms) while work
  // is in flight.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isWorking) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isWorking]);

  // Live feel: auto-scroll pinned to the bottom while new events arrive —
  // but only when the user is already near the bottom (never yank their
  // scroll). Long transcripts live in the same max-height flex scroll with
  // the right sidebar's custom auto-scroll scrollbar. ROUND-50 (R50-b): the
  // live segment's growth (deltas) is in the deps too — the raw stream
  // scrolls as it streams, like the main chat.
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, liveStatus, liveSteps.length, liveText.length, liveThinking.length]);

  const doRetry = async () => {
    if (parentSessionId === null || subAgentId === null || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retrySubAgent(parentSessionId, subAgentId);
      await queryClient.invalidateQueries({ queryKey: ["subagent-detail", subAgentId] });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  if (subAgentId === null) {
    return (
      <div className="h-full grid place-items-center px-6 text-center">
        <div className="text-[11.5px]" style={{ color: styles.textTertiary }}>
          No sub-agent bound to this tab.
        </div>
      </div>
    );
  }

  const initialLoading = detailQuery.isPending;
  const loadError = detailQuery.isError;

  // The honest session title (the polled row) wins; the tab title (which the
  // R48-e2 call sites prefix with the code) is the fallback, minus its code
  // prefix — the header already shows the code as its own chip.
  const headerTitle =
    childRow?.title ?? (tab.title !== "" ? stripCodePrefix(tab.title) : "Sub-agent");

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="subagent-panel">
      {/* ── Panel header: code chip + role chip + title + clock + status ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2.5 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        {code !== null ? (
          <span
            className="shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-[0.08em]"
            style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
            title={`Sub-agent code ${code}`}
            data-testid="subagent-code-chip"
          >
            {code}
          </span>
        ) : null}
        <span
          className="text-[9px] font-mono font-bold uppercase shrink-0 px-1.5 py-0.5 rounded-md"
          style={{ color: roleColor, background: withAlpha(roleColor, 0.14) }}
        >
          {role}
        </span>
        <div className="flex-1 min-w-0 truncate text-[11.5px] font-semibold" style={{ color: styles.text }} title={headerTitle}>
          {headerTitle}
        </div>
        {isWorking ? (
          <span
            className="shrink-0 text-[9.5px] font-mono tabular-nums"
            style={{ color: styles.textTertiary }}
            data-testid="subagent-elapsed"
          >
            {elapsedLabel(firstTs, nowMs) ?? "0:00"}
          </span>
        ) : null}
        <StatusChip status={liveStatus} styles={styles} />
      </div>

      {/* ── Scrollable chat transcript ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll" style={{ scrollbarWidth: "thin" }}>
        <div className="px-2.5 py-2.5 flex flex-col gap-2 min-w-0">
          {initialLoading ? (
            // The panel's ONLY spinner: the initial detail load.
            <div className="py-10 flex flex-col items-center gap-2" style={{ color: styles.textTertiary }}>
              <LoaderCircle size={16} className="animate-spin" style={{ color: styles.accent }} />
              <span className="text-[11px]">Loading sub-agent…</span>
            </div>
          ) : loadError ? (
            <div
              className="rounded-[12px] px-3 py-3 flex flex-col gap-2"
              style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.08), border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.3)}` }}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
                <AlertTriangle size={12} /> Couldn&apos;t load this sub-agent
              </div>
              <div className="text-[10.5px]" style={{ color: styles.textSecondary }}>
                {detailQuery.error instanceof Error ? detailQuery.error.message : "The sidecar didn't answer."}
              </div>
              <button
                onClick={() => void detailQuery.refetch()}
                className="self-start h-6 px-2.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1.5"
                style={{ background: styles.card, color: styles.text, border: `1px solid ${styles.border}` }}
              >
                <RefreshCw size={10} /> Try again
              </button>
            </div>
          ) : (
            <>
              {/* FAILED banner — explicit reason + the Retry primary action
                  (kept from the R43 panel; a chat transcript can fail too). */}
              <AnimatePresence initial={false}>
                {liveStatus === "failed" ? (
                  <motion.div
                    key="failed-banner"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.25, ease }}
                    className="rounded-[12px] px-3 py-2.5 flex flex-col gap-2"
                    style={{
                      background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
                      border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.35)}`,
                    }}
                    role="alert"
                    data-testid="subagent-failed-banner"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
                      <AlertTriangle size={12} /> Sub-agent failed
                    </div>
                    {failureReason !== null ? (
                      <div className="font-mono text-[10px] leading-[1.5] break-words" style={{ color: styles.textSecondary }}>
                        {failureReason}
                      </div>
                    ) : null}
                    {retryError !== null ? (
                      <div className="text-[10px]" style={{ color: SEMANTIC_COLORS.danger }}>
                        {retryError}
                      </div>
                    ) : null}
                    <button
                      onClick={() => void doRetry()}
                      disabled={retrying || parentSessionId === null}
                      aria-label="Retry sub-agent"
                      className="self-start h-7 px-3 rounded-full text-[10.5px] font-bold inline-flex items-center gap-1.5 transition-transform active:scale-95 disabled:opacity-60"
                      style={{
                        background: SEMANTIC_COLORS.danger,
                        color: "#fff",
                        boxShadow: `0 2px 8px ${withAlpha(SEMANTIC_COLORS.danger, 0.35)}`,
                      }}
                    >
                      <RefreshCw size={11} className={retrying ? "animate-spin" : ""} />
                      {retrying ? "Retrying…" : "Retry"}
                    </button>
                    <div className="text-[9.5px]" style={{ color: styles.textTertiary }}>
                      Retry resumes from the last completed step in the event log.
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {renderItems.map((item) => {
                switch (item.kind) {
                  case "user":
                    return <TaskBubble key={`u-${item.seq}`} content={item.content} />;
                  case "assistant":
                    return (
                      <AssistantBubble
                        key={`a-${item.seq}`}
                        content={item.content}
                        isReport={!isWorking && item.seq === lastAssistantSeq}
                      />
                    );
                  case "tool":
                    return <TranscriptToolRow key={`t-${item.seq}`} tool={item.tool} />;
                  case "todo":
                    return <TodoLine key={`d-${item.seq}`} todos={item.todos} />;
                  case "approval":
                    return <ApprovalLine key={`v-${item.seq}`} approval={item.approval} />;
                  case "error":
                    return <ErrorLine key={`e-${item.seq}`} error={item.error} />;
                }
                return null;
              })}

              {/* ── ROUND-50 (R50-b): the LIVE raw-stream segment — the
                  child's thinking/text/tool stream as it arrives (owner:
                  "the actual raw data, the raw thinking, the raw text of it
                  … streamed live just like the main agent"). See the
                  visibility rule above the render. ── */}
              {liveSegmentVisible && liveEntry !== undefined ? (
                <LiveStreamSegment
                  entry={liveEntry}
                  streaming={isWorking}
                />
              ) : null}

              {/* The live tail while work is in flight (only when the live
                  segment ISN'T carrying the feed — no live data = the
                  pre-R50-b polled-only view). */}
              {isWorking && !liveSegmentVisible ? (
                <div className="flex items-center gap-2 px-1.5 h-6 text-[10.5px]" style={{ color: styles.textTertiary }}>
                  <PulsingDot color={RUNNING_BLUE} size={6} />
                  {renderItems.some((it) => it.kind === "tool" || it.kind === "assistant")
                    ? "working…"
                    : "Sub-agent is starting work…"}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ── ROUND-50 (R50-b, owner: "the stats of the subagents should be
          shown at the very bottom of its responses in live view") — the
          pinned stats bar: time / tokens sent / tokens received /
          tokens-per-second / model. Live values while running; authoritative
          row values after completion. ── */}
      {!initialLoading && !loadError ? (
        <SubAgentStatsBar
          working={isWorking}
          nowMs={nowMs}
          live={liveEntry}
          row={childRow}
          detail={detailQuery.data}
        />
      ) : null}
    </div>
  );
}

/** The delegation prompt — the main chat's user-bubble language (R38's calm
 * accent-tinted bubble), scaled for the sidebar. */
function TaskBubble({ content }: { content: string }) {
  const styles = useThemeStyles();
  const bubbleBg = withAlpha(styles.accent, styles.isDark ? 0.18 : 0.1);
  const bubbleBorder = withAlpha(styles.accent, styles.isDark ? 0.32 : 0.22);
  return (
    <div className="flex justify-end min-w-0">
      <div
        className="max-w-[88%] rounded-[14px] rounded-br-[4px] px-3 py-2 border text-[12px] leading-[1.55] font-medium"
        style={{ background: bubbleBg, borderColor: bubbleBorder, color: styles.text }}
        data-testid="subagent-task-bubble"
      >
        <ClampedText
          text={content}
          lines={6}
          expandLabel="Show full task"
          collapseLabel="Show less"
          className="whitespace-pre-wrap break-words"
        />
      </div>
    </div>
  );
}

/** An assistant message — a markdown bubble in the main chat's visual
 * language (shared Markdown renderer). The LAST one on a terminal run is the
 * child's final report: accent left rail + a "Final report" mini-label. */
function AssistantBubble({ content, isReport }: { content: string; isReport: boolean }) {
  const styles = useThemeStyles();
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <span className="mt-1.5 shrink-0" style={{ color: styles.textTertiary }} aria-hidden>
        <Bot size={11} />
      </span>
      <div
        className="min-w-0 flex-1 rounded-[12px] px-2.5 py-1.5 border"
        style={{
          background: styles.isDark ? "rgba(0,0,0,0.14)" : styles.subtle,
          borderColor: isReport ? styles.accent : styles.borderSubtle,
          borderLeft: isReport ? `3px solid ${styles.accent}` : undefined,
        }}
        data-testid="subagent-assistant-bubble"
      >
        {isReport ? (
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] mb-1" style={{ color: styles.accent }}>
            Final report
          </div>
        ) : null}
        <Markdown content={content} />
      </div>
    </div>
  );
}

/** One tool row — the SAME visual style as the main chat's tool lines
 * (WorkingSection's ToolLine): icon + past-tense label + mono argsSummary +
 * ✓/✗/… state glyph + an expandable output block (chevron). */
function TranscriptToolRow({ tool }: { tool: ToolCard }) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.toolName] ?? TerminalIcon;
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const expandable =
    (tool.outputSummary !== null && tool.outputSummary !== "") || tool.ok === null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      className="min-w-0"
    >
      <button
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${label} ${tool.argsSummary}`}
        data-testid="subagent-tool-row"
        className="flex items-center gap-2 h-7 w-full max-w-full px-1.5 -ml-1.5 rounded-md transition-colors text-left"
        style={{
          color: styles.textTertiary,
          cursor: expandable ? "pointer" : "default",
        }}
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
            color:
              tool.ok === false
                ? SEMANTIC_COLORS.danger
                : tool.ok === null
                  ? RUNNING_BLUE
                  : SEMANTIC_COLORS.success,
          }}
        >
          {tool.ok === null ? "…" : tool.ok ? "✓" : "✗"}
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
      {open ? (
        <div className="mt-0.5 mb-1 pl-4 min-w-0">
          <div
            className="rounded-[10px] px-2.5 py-1.5 border font-mono text-[10px] leading-[1.5] break-words"
            style={{
              background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle,
              borderColor: styles.borderSubtle,
              color: tool.ok === false ? SEMANTIC_COLORS.danger : styles.textSecondary,
            }}
            data-testid="subagent-tool-output"
          >
            {tool.ok === null
              ? "running…"
              : tool.outputSummary !== null && tool.outputSummary !== ""
                ? tool.outputSummary
                : "(no output)"}
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

/** todo.update — a compact progress line: bar + done/total + the current
 * in-progress item (truncated, full text on the title). */
function TodoLine({ todos }: { todos: TodoCardData }) {
  const styles = useThemeStyles();
  const pct = todos.total > 0 ? (todos.done / todos.total) * 100 : 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      className="flex items-center gap-2 h-7 w-full max-w-full px-1.5 -ml-1.5 rounded-md min-w-0"
      data-testid="subagent-todo-line"
    >
      <ListChecks size={11} className="shrink-0" style={{ color: styles.accent }} />
      <div className="w-16 h-1.5 rounded-full overflow-hidden shrink-0" style={{ background: styles.subtle }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.max(todos.done > 0 ? 10 : 3, pct)}%`, background: styles.accent }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums" style={{ color: styles.textSecondary }}>
        {todos.done}/{todos.total}
      </span>
      {todos.current !== null ? (
        <span
          className="min-w-0 flex-1 truncate text-[10.5px]"
          style={{ color: styles.textTertiary }}
          title={todos.current}
        >
          {todos.current}
        </span>
      ) : null}
    </motion.div>
  );
}

/** approval.requested/resolved — a compact INFORMATIONAL card (R48-e1: the
 * child's asks ride the parent's SSE and are DECIDED in the parent chat's
 * ApprovalCard with the "Sub-agent {code} · {role}" attribution; this panel
 * only shows what was asked and how it landed). */
function ApprovalLine({ approval }: { approval: ApprovalCardData }) {
  const styles = useThemeStyles();
  const pending = approval.status === "pending";
  const tone = pending
    ? "#f59e0b"
    : approval.status === "approved"
      ? SEMANTIC_COLORS.success
      : SEMANTIC_COLORS.danger;
  const title = pending
    ? "Permission asked"
    : approval.status === "approved"
      ? "Permission approved"
      : approval.status === "denied"
        ? "Permission denied"
        : "Permission expired";
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      className="rounded-[10px] border px-2 py-1.5 min-w-0"
      style={{ borderColor: withAlpha(tone, 0.35), background: withAlpha(tone, 0.06) }}
      data-testid="subagent-approval-card"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {pending ? (
          <ShieldAlert size={11} className="shrink-0" style={{ color: tone }} />
        ) : (
          <Check size={11} className="shrink-0" style={{ color: tone }} />
        )}
        <span className="text-[10.5px] font-bold shrink-0" style={{ color: tone }}>
          {title}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px]"
          style={{ color: styles.textTertiary }}
          title={`${approval.toolName} ${approval.argsSummary}`}
        >
          {approval.toolName} {approval.argsSummary}
        </span>
      </div>
      {pending ? (
        <div className="mt-1 text-[9.5px]" style={{ color: styles.textTertiary }}>
          Decide in the main chat — the ask appears there with this sub-agent&apos;s code.
        </div>
      ) : null}
    </motion.div>
  );
}

/** turn.error — an error banner in the main chat's TurnErrorCard language
 * (compact: reason + code, no retry — the Retry lives on the failed banner). */
function ErrorLine({ error }: { error: ErrorCardData }) {
  const styles = useThemeStyles();
  const reason = error.providerError ?? error.message;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease }}
      role="alert"
      className="rounded-[12px] border px-2.5 py-2 flex items-start gap-2 min-w-0"
      style={{
        borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4),
        background: withAlpha(SEMANTIC_COLORS.danger, 0.07),
      }}
      data-testid="subagent-error-banner"
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.danger }} />
      <div className="min-w-0">
        <div className="text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
          Turn failed
        </div>
        <div className="mt-0.5 font-mono text-[10px] leading-[1.5] break-words" style={{ color: styles.textSecondary }}>
          {reason}
        </div>
        <div className="mt-0.5 text-[9.5px] font-mono" style={{ color: styles.textTertiary }}>
          {error.code}
        </div>
      </div>
    </motion.div>
  );
}

// ─── ROUND-50 (R50-b): the LIVE raw-stream segment + the pinned stats bar ────

/** The child's LIVE raw stream — thinking (the main chat's ThoughtRow visual,
 * auto-expanded while streaming), interleaved tool rows (the transcript's
 * exact row style), and the raw text streaming with the main chat's caret.
 * `streaming` freezes the caret/thought-rows when the child turned terminal
 * but the polled transcript hasn't caught up yet (the handoff gap). */
function LiveStreamSegment({ entry, streaming }: { entry: SubAgentLiveEntry; streaming: boolean }) {
  const styles = useThemeStyles();
  // The ordered live log; when only flat accumulators exist (a store entry
  // written before the ordered log landed), synthesize the two blocks so the
  // raw stream still renders.
  const steps: SubAgentLiveStep[] =
    entry.liveSteps.length > 0
      ? entry.liveSteps
      : [
          ...((entry.liveThinking ?? "") !== ""
            ? [{ type: "thinking" as const, text: entry.liveThinking }]
            : []),
          ...((entry.liveText ?? "") !== "" ? [{ type: "text" as const, text: entry.liveText }] : []),
        ];
  const lastIdx = steps.length - 1;
  return (
    <div className="flex flex-col gap-1.5 min-w-0" data-testid="subagent-live-stream">
      {streaming ? (
        <div
          className="flex items-center gap-2 px-1.5 h-5 text-[9.5px] font-mono uppercase tracking-[0.12em]"
          style={{ color: RUNNING_BLUE }}
        >
          <PulsingDot color={RUNNING_BLUE} size={5} />
          streaming live
        </div>
      ) : null}
      {steps.map((step, i) => {
        if (step.type === "thinking") {
          return <ThoughtRow key={`lt-${i}`} text={step.text ?? ""} live={streaming && i === lastIdx} />;
        }
        if (step.type === "tool" && step.tool !== undefined) {
          return (
            <TranscriptToolRow
              key={`lt-${i}`}
              tool={{
                toolName: step.tool.toolName,
                argsSummary: step.tool.argsSummary,
                ok: step.tool.ok,
                outputSummary: step.tool.outputSummary ?? null,
                ts: "",
              }}
            />
          );
        }
        // Text: the LAST text step is the in-flight streaming tail (caret
        // while streaming); earlier text runs are interim narration in the
        // main chat's narration style.
        const isTail = i === lastIdx;
        return (
          <div
            key={`lt-${i}`}
            className="min-w-0 break-words whitespace-pre-wrap text-[12px] leading-[1.6]"
            style={{ color: styles.text }}
            data-testid={isTail ? "subagent-live-text" : "subagent-live-narration"}
          >
            {step.text}
            {isTail && streaming ? (
              <span
                className="inline-block w-[6px] h-[12px] ml-0.5 align-middle rounded-sm ac-caret-blink"
                style={{ background: styles.accent }}
                aria-hidden
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One micro-typography cell of the stats bar: an uppercase tracking label
 * above a mono tabular value. */
function StatCell({
  label,
  value,
  title,
  styles,
  testId,
}: {
  label: string;
  value: string;
  title?: string;
  styles: ReturnType<typeof useThemeStyles>;
  testId?: string;
}) {
  return (
    <span className="flex flex-col min-w-0 shrink-0" title={title} data-testid={testId}>
      <span
        className="text-[8px] font-bold uppercase tracking-[0.14em] leading-[1.1]"
        style={{ color: styles.textTertiary }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[10px] font-semibold tabular-nums leading-[1.3] truncate max-w-[120px]"
        style={{ color: styles.textSecondary }}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * ROUND-50 (R50-b, owner: "the stats of the subagents should be shown at the
 * very bottom of its responses in live view: the total time taken, the total
 * tokens sent, the total tokens received, the tokens per second feed, the
 * model which was being used") — pinned at the panel's very bottom.
 *
 * VALUE RULES:
 *  - While queued/running: LIVE values — the store's finish-event token
 *    accumulators + a ticking clock anchored at the child's createdAt (the
 *    same anchor the final value uses, so the handoff is monotone). Tokens
 *    fall back to the polled row's ledger when no live stream exists
 *    (reloaded mid-run / channel-less run).
 *  - After completion (or failure): the AUTHORITATIVE /subagents row —
 *    inputTokens/outputTokens from the usage ledger, model from the latest
 *    usage row, elapsed = createdAt → updatedAt.
 *  - Tokens/sec = output tokens ÷ elapsed seconds (live both ways; "—" until
 *    a full second exists to divide by).
 *  - Model: the status frame's resolved model (freshest) → the row's
 *    usage-derived model → "—".
 */
function SubAgentStatsBar({
  working,
  nowMs,
  live,
  row,
  detail,
}: {
  working: boolean;
  nowMs: number;
  live: SubAgentLiveEntry | undefined;
  row: SubAgentStatus | undefined;
  detail: SessionDetail | undefined;
}) {
  const styles = useThemeStyles();
  const createdAt = row?.createdAt ?? detail?.createdAt;
  const updatedAt = row?.updatedAt ?? detail?.updatedAt;
  const createdMs = createdAt !== undefined ? Date.parse(createdAt) : NaN;
  const updatedMs = updatedAt !== undefined ? Date.parse(updatedAt) : NaN;
  const startMs =
    !Number.isNaN(createdMs) ? createdMs : live?.startedAtMs ?? nowMs;
  // While working the clock ticks from createdAt; after completion it freezes
  // at createdAt → updatedAt (the row's own duration).
  const elapsedMs = working
    ? Math.max(0, nowMs - startMs)
    : Number.isNaN(updatedMs)
      ? Math.max(0, nowMs - startMs)
      : Math.max(0, updatedMs - startMs);
  const elapsedSec = elapsedMs / 1000;
  // Tokens: live accumulators while working (finish events, all attempts —
  // SUM semantics like the usage ledger); the row's ledger after completion.
  const inputTokens = working
    ? live?.inputTokens ?? row?.inputTokens ?? 0
    : row?.inputTokens ?? live?.inputTokens ?? 0;
  const outputTokens = working
    ? live?.outputTokens ?? row?.outputTokens ?? 0
    : row?.outputTokens ?? live?.outputTokens ?? 0;
  const tps =
    outputTokens > 0 && elapsedSec >= 1 ? `${(outputTokens / elapsedSec).toFixed(1)}` : "—";
  // Model: while working the status frame's resolved model is freshest; after
  // completion the row's usage-derived model is authoritative.
  const model = working ? live?.model ?? row?.model ?? null : row?.model ?? live?.model ?? null;

  return (
    <div
      className="shrink-0 flex items-end gap-3.5 px-2.5 h-9 border-t overflow-hidden"
      style={{
        borderColor: styles.borderSubtle,
        background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle,
      }}
      data-testid="subagent-stats-footer"
    >
      <StatCell
        label={working ? "Time" : "Total time"}
        value={elapsedFromMs(elapsedMs)}
        styles={styles}
        testId="subagent-stat-time"
      />
      <StatCell
        label="Sent"
        value={`↑ ${fmtTokens(inputTokens)}`}
        title={`${inputTokens} input tokens`}
        styles={styles}
        testId="subagent-stat-in"
      />
      <StatCell
        label="Received"
        value={`↓ ${fmtTokens(outputTokens)}`}
        title={`${outputTokens} output tokens`}
        styles={styles}
        testId="subagent-stat-out"
      />
      <StatCell
        label="Tok/s"
        value={tps}
        title="output tokens per second"
        styles={styles}
        testId="subagent-stat-tps"
      />
      <span className="flex flex-col min-w-0 flex-1">
        <span
          className="text-[8px] font-bold uppercase tracking-[0.14em] leading-[1.1]"
          style={{ color: styles.textTertiary }}
        >
          Model
        </span>
        <span
          className="font-mono text-[10px] font-semibold leading-[1.3] truncate"
          style={{ color: styles.textSecondary }}
          title={model ?? undefined}
          data-testid="subagent-stat-model"
        >
          {model ?? "—"}
        </span>
      </span>
    </div>
  );
}

/** A tiny pulsing dot — the "work in flight" signal (used instead of
 * spinners everywhere except the initial detail load). */
function PulsingDot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <motion.span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: color }}
      animate={{ scale: [1, 1.45, 1], opacity: [1, 0.5, 1] }}
      transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
      aria-hidden
    />
  );
}

/** The coherent panel-header status chip (queued / running / retrying /
 * done / failed / cancelled). Pulsing dot while in flight; check/x glyphs
 * for terminal states. */
function StatusChip({
  status,
  styles,
}: {
  status: PanelStatus;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const tone: string =
    status === "running"
      ? RUNNING_BLUE
      : status === "retrying"
        ? styles.accent
        : status === "done"
          ? SEMANTIC_COLORS.success
          : status === "failed" || status === "cancelled"
            ? SEMANTIC_COLORS.danger
            : styles.textTertiary;
  return (
    <div
      className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wider"
      style={{ background: withAlpha(tone, 0.14), color: tone }}
      data-testid="subagent-status-chip"
    >
      {status === "running" || status === "retrying" ? (
        <PulsingDot color={tone} size={5} />
      ) : status === "done" ? (
        <Check size={10} />
      ) : status === "failed" || status === "cancelled" ? (
        <CircleAlert size={10} />
      ) : (
        <Clock size={10} />
      )}
      {status}
    </div>
  );
}
