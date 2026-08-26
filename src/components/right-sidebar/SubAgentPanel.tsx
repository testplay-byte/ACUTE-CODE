import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  fetchSubAgents,
  fetchSubAgentDetail,
  retrySubAgent,
  type SessionDetail,
  type SessionEvent,
  type SubAgentStatus,
} from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { ease } from "../../lib/motion";
import { useEffect, useRef, useState } from "react";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Bot,
  Check,
  CircleAlert,
  ClipboardList,
  Clock,
  FileCode2,
  FilePenLine,
  FilePlus2,
  FolderPlus,
  Globe,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Search,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";

/**
 * ROUND-43 right-sidebar Sub-agent tab — the phase-card redesign (owner: "it
 * was not looking good, it was not proper, and it was not beautiful… make it
 * much better, much more proper, and well-handled").
 *
 * Structure: ONE CARD PER PHASE, in execution order —
 *   1. TASK        the delegation prompt (ClampedText @ 6 lines)
 *   2. ACTIVITY    the live tool timeline (rows: icon + mono basename +
 *                 relative time + terminal-state rail; new rows animate in)
 *   3. FILES       the manifest of files touched (count chip, show-all)
 *   4. REPORT      the final answer (ClampedText @ 6 lines, accent rail)
 *
 * Status system: a single coherent chip in the panel header (queued /
 * running / retrying / done / failed / cancelled) — pulsing dot while work
 * is in flight, check/x glyphs for terminal states, a spinner ONLY for the
 * initial detail load. A failed child gets an explicit danger banner with
 * the error reason + the RETRY primary action (resumes from the event log,
 * same endpoint the chat's SubAgentCard uses).
 *
 * Everything data-side is unchanged from R41/42: 600ms polling of the
 * child's event log; the error reason comes from the existing
 * /sessions/:id/subagents listing; retry is the existing
 * POST /sessions/:id/subagents/:child/retry.
 */
const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a825",
  tester: "#f59e0b",
};

/** Tool names that mutate files — collected into the Files card. */
const FILE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_dir",
  "delete_file",
]);

const RUNNING_BLUE = "#3B82F6";

/** Icon + tint for a file-mutating tool (used in the Files manifest). */
function FileToolIcon({ toolName, size = 12 }: { toolName: string; size?: number }): JSX.Element {
  switch (toolName) {
    case "write_file":
      return <FilePlus2 size={size} />;
    case "edit_file":
      return <FilePenLine size={size} />;
    case "create_dir":
      return <FolderPlus size={size} />;
    case "delete_file":
      return <Trash2 size={size} />;
    default:
      return <FileCode2 size={size} />;
  }
}

/** The icon for a NON-file tool in the activity timeline. */
function ToolIcon({ toolName, size = 13 }: { toolName: string; size?: number }) {
  if (toolName === "run_command" || toolName === "search_files" || toolName === "list_dir") {
    return <TerminalIcon size={size} />;
  }
  if (toolName === "web_fetch" || toolName === "web_search") return <Globe size={size} />;
  if (toolName.startsWith("search")) return <Search size={size} />;
  if (toolName === "delegate_task") return <Bot size={size} />;
  return <Sparkles size={size} />;
}

/** Extract a file path from a tool.use event's argsSummary. The runtime
 * formats argsSummary as the first argument (the path) for file tools. */
function filePathFromArgs(toolName: string, argsSummary: string): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  const trimmed = argsSummary.trim().replace(/^["']|["']$/g, "");
  return trimmed === "" ? null : trimmed;
}

/** Split a path into dir + basename for a nicer mono rendering. */
function splitPath(path: string): { dir: string; base: string } {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

/** Compact relative time ("now", "12s", "3m", "2h") for tool/file rows. */
function relTime(ts: string, nowMs: number): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** m:ss (or h:mm:ss) elapsed since the first event — the header's live clock. */
function elapsedLabel(startTs: string | undefined, nowMs: number): string | null {
  if (startTs === undefined) return null;
  const t = Date.parse(startTs);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  const hh = Math.floor(mm / 60);
  if (hh > 0) return `${hh}:${String(mm % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

interface ToolCard {
  toolName: string;
  argsSummary: string;
  ok: boolean | null;
  outputSummary: string | null;
  ts: string;
}

interface ActionItem {
  kind: "tool" | "text";
  seq: number;
  ts: string;
  tool?: ToolCard;
  text?: string;
}

/** Parse the event log into renderable pieces (prompt / interleaved actions
 * / files-written list / final report + the last failure for the banner). */
function parseSubAgentEvents(events: SessionEvent[]): {
  promptText: string | null;
  firstTs: string | undefined;
  actions: ActionItem[];
  filesWritten: Array<{ toolName: string; path: string; ts: string }>;
  report: string | null;
  reportSeq: number | null;
  hasRunningTool: boolean;
  lastFailure: { toolName: string; outputSummary: string } | null;
} {
  const promptEvent = events.find((e) => e.type === "message.user");
  const promptText =
    promptEvent && typeof (promptEvent.payload as { content?: unknown } | null)?.content === "string"
      ? ((promptEvent.payload as { content: string }).content)
      : null;

  const filesWritten: Array<{ toolName: string; path: string; ts: string }> = [];
  const actions: ActionItem[] = [];
  let hasRunningTool = false;
  let lastFailure: { toolName: string; outputSummary: string } | null = null;

  for (const e of events) {
    if (e.type === "tool.use") {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const toolName = typeof p.toolName === "string" ? p.toolName : "tool";
      const argsSummary = typeof p.argsSummary === "string" ? p.argsSummary : "";
      const ok = typeof p.ok === "boolean" ? p.ok : null;
      const outputSummary = typeof p.outputSummary === "string" ? p.outputSummary : null;
      const tool: ToolCard = { toolName, argsSummary, ok, outputSummary, ts: e.ts };
      actions.push({ kind: "tool", seq: e.seq, ts: e.ts, tool });
      if (ok === null) hasRunningTool = true;
      if (ok === false) lastFailure = { toolName, outputSummary: outputSummary ?? "" };
      const path = filePathFromArgs(toolName, argsSummary);
      if (path !== null) filesWritten.push({ toolName, path, ts: e.ts });
    } else if (e.type === "message.assistant") {
      const content =
        typeof (e.payload as { content?: unknown } | null)?.content === "string"
          ? ((e.payload as { content: string }).content)
          : "";
      if (content !== "") actions.push({ kind: "text", seq: e.seq, ts: e.ts, text: content });
    }
  }

  // The final report = last message.assistant content (the child's reply
  // after completing its task — same as the parent sees from delegate_task).
  const lastAssistant = [...events].reverse().find((e) => e.type === "message.assistant");
  const report =
    lastAssistant && typeof (lastAssistant.payload as { content?: unknown } | null)?.content === "string"
      ? ((lastAssistant.payload as { content: string }).content)
      : null;

  return {
    promptText,
    firstTs: events[0]?.ts,
    actions,
    filesWritten,
    report,
    reportSeq: report !== null ? (lastAssistant?.seq ?? null) : null,
    hasRunningTool,
    lastFailure,
  };
}

/** The panel's coherent status vocabulary. */
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

  // ROUND-41: poll at 600ms for near-live progress. The child's event log
  // records tool.use + message.assistant as they happen, so each poll
  // reveals the latest actions without lag. (Unchanged by the R43 redesign.)
  const detailQuery = useQuery({
    queryKey: ["subagent-detail", subAgentId],
    queryFn: () => fetchSubAgentDetail(subAgentId as string),
    enabled: subAgentId !== null,
    staleTime: 600,
    refetchInterval: subAgentId !== null ? 600 : false,
  });

  const events = detailQuery.data?.events ?? [];
  const { promptText, firstTs, actions, filesWritten, report, reportSeq, hasRunningTool, lastFailure } =
    parseSubAgentEvents(events);

  // Local retry state: true from the Retry click until the endpoint answers
  // (the chip shows "retrying", then polling takes over with running/…).
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const liveStatus = derivePanelStatus(detailQuery.data, hasRunningTool, retrying);

  // The error REASON for the failed banner — the subagents listing (same
  // data source the chat's SubAgentCard uses) carries `error` per child.
  const subsQuery = useQuery({
    queryKey: ["subagents", parentSessionId],
    queryFn: () => fetchSubAgents(parentSessionId as string),
    enabled: parentSessionId !== null && liveStatus === "failed",
    staleTime: 600,
    refetchInterval: liveStatus === "failed" ? 600 : false,
  });
  const childError = parentSessionId !== null
    ? (subsQuery.data ?? []).find((s: SubAgentStatus) => s.id === subAgentId)?.error ?? null
    : null;

  const role = tab.subRole ?? "agent";
  const roleColor = ROLE_COLORS[role] ?? styles.accent;
  const [filesExpanded, setFilesExpanded] = useState(false);
  const filesToShow = filesExpanded ? filesWritten : filesWritten.slice(0, 5);

  // A ticking "now" while work is in flight, so relative row times + the
  // header clock stay fresh between polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (liveStatus !== "running" && liveStatus !== "retrying") return;
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, [liveStatus]);

  // Live feel: auto-scroll pinned to the bottom while running — but only
  // when the user is already near the bottom (never yank their scroll).
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
  }, [events.length, report, liveStatus]);

  // On a terminal run the final assistant message is the REPORT — don't
  // duplicate it as the last activity row (the Report card owns it).
  const visibleActions =
    liveStatus === "done" || liveStatus === "failed"
      ? actions.filter((a) => !(a.kind === "text" && a.seq === reportSeq))
      : actions;

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

  const isWorking = liveStatus === "running" || liveStatus === "retrying";
  const initialLoading = detailQuery.isPending;
  const loadError = detailQuery.isError;

  // The banner's error reason: the child's recorded error (from the
  // subagents listing) → the last failed tool's output → a quiet fallback.
  const failureReason =
    childError ??
    (lastFailure !== null
      ? `${lastFailure.toolName}${lastFailure.outputSummary !== "" ? `: ${lastFailure.outputSummary}` : ""}`
      : null) ??
    (detailQuery.data !== undefined ? "The run ended in a failed state." : null);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ── Panel header: role chip + title + live elapsed + status chip ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <span
          className="text-[9px] font-mono font-bold uppercase shrink-0 px-1.5 py-0.5 rounded-md"
          style={{ color: roleColor, background: withAlpha(roleColor, 0.14) }}
        >
          {role}
        </span>
        <div className="flex-1 min-w-0 truncate text-[11.5px] font-semibold" style={{ color: styles.text }}>
          {tab.title ?? "Sub-agent"}
        </div>
        {isWorking ? (
          <span className="shrink-0 text-[9.5px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
            {elapsedLabel(firstTs, nowMs) ?? "0:00"}
          </span>
        ) : null}
        <StatusChip status={liveStatus} styles={styles} />
      </div>

      {/* ── Scrollable phase-card stack ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        <div className="px-2.5 py-2.5 flex flex-col gap-2.5">
          {/* Initial load — the panel's ONLY spinner. */}
          {initialLoading ? (
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
              {/* FAILED banner — explicit reason + the Retry primary action. */}
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

              {/* 1 · TASK — the delegation prompt, clamped at 6 lines. */}
              {promptText !== null ? (
                <PhaseCard
                  icon={<ClipboardList size={11} style={{ color: roleColor }} />}
                  label="Task"
                  styles={styles}
                >
                  <ClampedText
                    text={promptText}
                    lines={6}
                    expandLabel="Show full task"
                    collapseLabel="Collapse task"
                    className="text-[11.5px] leading-[1.6] whitespace-pre-wrap break-words"
                  />
                </PhaseCard>
              ) : null}

              {/* 2 · ACTIVITY — the live timeline. */}
              <PhaseCard
                icon={<ActivityIcon size={11} style={{ color: isWorking ? RUNNING_BLUE : styles.textTertiary }} />}
                label="Activity"
                badge={
                  <>
                    {visibleActions.length > 0 ? (
                      <span
                        className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full tabular-nums"
                        style={{ color: styles.textTertiary, background: withAlpha(styles.textTertiary, 0.1) }}
                      >
                        {visibleActions.length}
                      </span>
                    ) : null}
                    {isWorking ? (
                      <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: RUNNING_BLUE }}>
                        <PulsingDot color={RUNNING_BLUE} size={6} /> live
                      </span>
                    ) : null}
                  </>
                }
                styles={styles}
              >
                {visibleActions.length === 0 ? (
                  <div className="text-[11px] py-1.5 flex items-center gap-2" style={{ color: styles.textTertiary }}>
                    {isWorking ? (
                      <>
                        <PulsingDot color={RUNNING_BLUE} size={6} />
                        Sub-agent is starting work…
                      </>
                    ) : (
                      <>
                        <MessageSquareText size={11} />
                        No actions yet.
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {visibleActions.map((a, i) =>
                      a.kind === "tool" && a.tool ? (
                        <ToolRow
                          key={`t-${a.seq}`}
                          tool={a.tool}
                          styles={styles}
                          nowMs={nowMs}
                          isLastRunning={isWorking && a.tool.ok === null && i === visibleActions.length - 1}
                        />
                      ) : (
                        <TextRow key={`a-${a.seq}`} text={a.text ?? ""} styles={styles} />
                      ),
                    )}
                  </div>
                )}
              </PhaseCard>

              {/* 3 · FILES — the manifest of what this child touched. */}
              {filesWritten.length > 0 ? (
                <PhaseCard
                  icon={<FileCode2 size={11} style={{ color: styles.accent }} />}
                  label="Files"
                  badge={
                    <span
                      className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full tabular-nums"
                      style={{ color: styles.accent, background: withAlpha(styles.accent, 0.12) }}
                    >
                      {filesWritten.length}
                    </span>
                  }
                  styles={styles}
                >
                  <div className="flex flex-col gap-1">
                    {filesToShow.map((f, i) => {
                      const { dir, base } = splitPath(f.path);
                      return (
                        <div
                          key={`${f.path}-${i}`}
                          className="flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-[10.5px]"
                          style={{ background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle }}
                        >
                          <span
                            className="shrink-0 w-4 h-4 grid place-items-center rounded-[5px]"
                            style={{ color: styles.accent, background: withAlpha(styles.accent, 0.1) }}
                          >
                            <FileToolIcon toolName={f.toolName} size={10} />
                          </span>
                          <span className="font-mono truncate" style={{ color: styles.textSecondary }} title={f.path}>
                            {dir ? <span style={{ color: styles.textTertiary }}>{dir}</span> : null}
                            <span style={{ color: styles.text }}>{base}</span>
                          </span>
                          <span
                            className="ml-auto shrink-0 text-[9px] font-mono tabular-nums"
                            style={{ color: styles.textTertiary }}
                          >
                            {relTime(f.ts, nowMs)}
                          </span>
                        </div>
                      );
                    })}
                    {filesWritten.length > 5 ? (
                      <button
                        onClick={() => setFilesExpanded((v) => !v)}
                        className="self-start px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors"
                        style={{ color: styles.accent }}
                      >
                        {filesExpanded ? "Show less" : `Show all ${filesWritten.length} files`}
                      </button>
                    ) : null}
                  </div>
                </PhaseCard>
              ) : null}

              {/* 4 · REPORT — the final answer, clamped at 6 lines. Only once
                  the run is terminal: while working, the latest assistant
                  text is progress narration (it lives in Activity above). */}
              {report !== null && !isWorking ? (
                <PhaseCard
                  icon={<Sparkles size={11} style={{ color: styles.accent }} />}
                  label="Final report"
                  styles={styles}
                >
                  <div
                    className="rounded-[8px] border-l-[3px] pl-2.5 py-0.5"
                    style={{ borderColor: styles.accent }}
                  >
                    <ClampedText
                      text={report}
                      lines={6}
                      expandLabel="Show full report"
                      collapseLabel="Collapse report"
                      className="text-[11.5px] leading-[1.6] whitespace-pre-wrap break-words"
                    />
                  </div>
                </PhaseCard>
              ) : null}
            </>
          )}
        </div>
      </div>
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

/** One phase card — small-caps header (icon + label + optional badge) over
 * the body. The app's card language: 12px radius, hairline border, layered
 * backgrounds instead of heavy chrome. */
function PhaseCard({
  icon,
  label,
  badge,
  styles,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  styles: ReturnType<typeof useThemeStyles>;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-[12px] overflow-hidden"
      style={{
        background: styles.isDark ? "rgba(0,0,0,0.14)" : styles.card,
        border: `1px solid ${styles.borderSubtle}`,
      }}
      data-phase={label.toLowerCase()}
    >
      <header
        className="flex items-center gap-1.5 px-2.5 h-[26px] border-b"
        style={{ borderColor: styles.borderSubtle, background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle }}
      >
        <span className="shrink-0">{icon}</span>
        <span className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{ color: styles.textTertiary }}>
          {label}
        </span>
        <span className="ml-auto flex items-center gap-1.5">{badge}</span>
      </header>
      <div className="px-2.5 py-2">{children}</div>
    </section>
  );
}

/** One activity row for a tool call: terminal-state rail on the left, icon,
 * mono name + basename arg, relative time, status glyph. New rows animate
 * in (framer-motion, the app's shared easing). */
function ToolRow({
  tool,
  styles,
  nowMs,
  isLastRunning,
}: {
  tool: ToolCard;
  styles: ReturnType<typeof useThemeStyles>;
  nowMs: number;
  isLastRunning: boolean;
}) {
  const isFileTool = FILE_TOOLS.has(tool.toolName);
  const stateColor =
    tool.ok === null ? RUNNING_BLUE : tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger;
  const { dir, base } = splitPath(tool.argsSummary);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease }}
      className="flex items-start gap-2 rounded-[8px] px-2 py-1.5"
      style={{
        background:
          tool.ok === false ? withAlpha(SEMANTIC_COLORS.danger, 0.07) : styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle,
      }}
    >
      {/* Terminal-state rail */}
      <span
        className="shrink-0 w-[3px] self-stretch rounded-full"
        style={{ background: stateColor, opacity: isLastRunning || tool.ok === false ? 1 : 0.65 }}
        aria-hidden
      />
      <div className="mt-0.5 shrink-0" style={{ color: isFileTool ? styles.accent : styles.textTertiary }}>
        {isFileTool ? <FileCode2 size={12} /> : <ToolIcon toolName={tool.toolName} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10.5px] font-semibold shrink-0" style={{ color: styles.text }}>
            {tool.toolName}
          </span>
          {tool.argsSummary ? (
            <span className="font-mono text-[10px] truncate" style={{ color: styles.textTertiary }} title={tool.argsSummary}>
              {dir ? <span style={{ opacity: 0.7 }}>{dir}</span> : null}
              {base}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 flex items-center gap-1.5">
            <span className="text-[9px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
              {relTime(tool.ts, nowMs)}
            </span>
            {tool.ok === null ? (
              <PulsingDot color={RUNNING_BLUE} size={5} />
            ) : tool.ok ? (
              <Check size={10} style={{ color: SEMANTIC_COLORS.success }} />
            ) : (
              <CircleAlert size={10} style={{ color: SEMANTIC_COLORS.danger }} />
            )}
          </span>
        </div>
        {tool.outputSummary !== null && tool.outputSummary !== "" ? (
          <div
            className="font-mono text-[9.5px] mt-0.5 truncate"
            style={{ color: tool.ok === false ? SEMANTIC_COLORS.danger : styles.textTertiary }}
            title={tool.outputSummary}
          >
            {tool.outputSummary}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

/** Interleaved assistant narration — quiet prose (no bubble chrome), clamped
 * to 3 lines; the final answer lives in its own Report card. */
function TextRow({ text, styles }: { text: string; styles: ReturnType<typeof useThemeStyles> }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease }}
      className="flex items-start gap-1.5 px-1 py-0.5"
      title={text}
    >
      <span className="mt-[3px] shrink-0" style={{ color: styles.textTertiary }}>
        <Bot size={10} />
      </span>
      <span
        className="text-[10.5px] leading-[1.5] break-words"
        style={{
          color: styles.textSecondary,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {text}
      </span>
    </motion.div>
  );
}
