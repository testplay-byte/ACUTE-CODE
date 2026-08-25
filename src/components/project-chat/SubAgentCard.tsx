import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  fetchSubAgents,
  fetchSessionDetail,
  retrySubAgent,
  type SessionDetail,
} from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * SubAgentCard (ROUND-36 — the owner's sub-agent monitoring ask): one card
 * per delegated sub-agent, live-updating while it runs. "when the user taps
 * on the running sessions, he can look at their status" — the card shows
 * role/task/status/progress/tokens/elapsed and opens the FULL child log in
 * a dialog. Failed children offer smart RETRY (resumes from the event log).
 */
export function SubAgentCard({
  sessionId,
  parentSessionId,
  role,
  task,
  live,
}: {
  sessionId: string;
  parentSessionId: string | null;
  role?: string;
  task?: string;
  /** Round-35 live segment context: poll faster while the turn streams. */
  live?: boolean;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [logOpen, setLogOpen] = useState(false);

  const subagentsQuery = useQuery({
    queryKey: ["subagents", parentSessionId ?? sessionId],
    queryFn: () => fetchSubAgents(parentSessionId ?? sessionId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const anyRunning = (data ?? []).some((s) => s.status === "running" || s.status === "queued");
      return anyRunning ? (live ? 1200 : 2500) : false;
    },
  });

  // Match this card's child by id (the tool row's argsSummary carries it).
  const child = (subagentsQuery.data ?? []).find((s) => s.id === sessionId);

  const statusTone =
    child?.status === "completed"
      ? SEMANTIC_COLORS.success
      : child?.status === "failed"
        ? SEMANTIC_COLORS.danger
        : styles.accent;

  return (
    <div
      className="rounded-[12px] border overflow-hidden"
      style={{ borderColor: withAlpha(statusTone, 0.35), background: styles.card }}
    >
      {/* Row */}
      <button
        onClick={() => setLogOpen((v) => !v)}
        aria-expanded={logOpen}
        className="w-full flex items-center gap-2.5 px-3 h-11 text-left"
      >
        <span
          className="w-7 h-7 shrink-0 rounded-[9px] grid place-items-center"
          style={{ background: withAlpha(statusTone, 0.12), color: statusTone }}
        >
          {child?.status === "running" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : child?.status === "completed" ? (
            <CheckCircle2 size={13} />
          ) : child?.status === "failed" ? (
            <XCircle size={13} />
          ) : (
            <CircleDashed size={13} className="animate-pulse" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: statusTone }}>
              {role ?? child?.subRole ?? "agent"}
            </span>
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: withAlpha(statusTone, 0.12), color: statusTone }}
            >
              {child?.status ?? "queued"}
            </span>
            {child && child.todosTotal > 0 && (
              <span className="text-[9px] font-mono" style={{ color: styles.textTertiary }}>
                {child.todosDone}/{child.todosTotal} todos
              </span>
            )}
            {child && (child.inputTokens > 0 || child.outputTokens > 0) && (
              <span className="text-[9px] font-mono" style={{ color: styles.textTertiary }}>
                ↑{fmtTokens(child.inputTokens)} ↓{fmtTokens(child.outputTokens)}
              </span>
            )}
          </span>
          <span className="block truncate text-[11px] font-medium" style={{ color: styles.textSecondary }}>
            {task ?? child?.title ?? "sub-agent task"}
          </span>
        </span>
        <ChevronDown
          size={12}
          className="shrink-0"
          style={{ color: styles.textTertiary, transform: logOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
      </button>

      {/* Failed → smart retry (ADR-0022: resumes from the event log) */}
      {child?.status === "failed" && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <button
            onClick={() => {
              void retrySubAgent(parentSessionId ?? sessionId, sessionId).then(() => {
                void queryClient.invalidateQueries({ queryKey: ["subagents", parentSessionId ?? sessionId] });
              });
            }}
            className="h-7 px-2.5 rounded-full text-[10.5px] font-bold flex items-center gap-1.5"
            style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}
          >
            <RefreshCw size={10} /> Retry (resumes from where it stopped)
          </button>
          {child.error && (
            <span className="text-[10px] truncate" style={{ color: SEMANTIC_COLORS.danger }} title={child.error}>
              {child.error.slice(0, 80)}
            </span>
          )}
        </div>
      )}

      {/* Report preview (completed) */}
      {child?.status === "completed" && child.report && !logOpen && (
        <div className="px-3 pb-2 text-[11px] leading-snug line-clamp-2" style={{ color: styles.textTertiary }}>
          {child.report.replace(/\n/g, " ").slice(0, 140)}
          {child.report.length > 140 ? "…" : ""}
        </div>
      )}

      {/* Full child log dialog */}
      {logOpen && <SubAgentLog childId={sessionId} />}
    </div>
  );
}

/** The child's full transcript (tap-to-inspect — the owner's monitoring ask). */
function SubAgentLog({ childId }: { childId: string }) {
  const styles = useThemeStyles();
  const detailQuery = useQuery({
    queryKey: ["session", "live", childId],
    queryFn: () => fetchSessionDetail(childId),
    refetchInterval: (q) => {
      const data = q.state.data as SessionDetail | undefined;
      return data && (data.status === "running" || data.status === "queued") ? 2000 : false;
    },
  });
  const detail = detailQuery.data;
  if (detailQuery.isLoading || !detail) {
    return (
      <div className="px-3 py-3 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
        loading sub-agent log…
      </div>
    );
  }
  return (
    <div className="border-t px-3 py-2.5 max-h-72 overflow-y-auto auto-scroll flex flex-col gap-1.5" style={{ borderColor: styles.borderSubtle }}>
      {detail.events
        .filter((e) => e.type === "message.user" || e.type === "message.assistant" || e.type === "tool.use")
        .map((e, i) => {
          if (e.type === "message.user") {
            const content = (e.payload as { content?: unknown }).content;
            return (
              <div key={i} className="text-[11px] font-medium rounded-[8px] px-2 py-1" style={{ background: withAlpha(styles.accent, 0.08), color: styles.textSecondary }}>
                {String(content ?? "").slice(0, 200)}
              </div>
            );
          }
          if (e.type === "message.assistant") {
            const content = (e.payload as { content?: unknown }).content;
            const text = String(content ?? "").trim();
            if (text === "") return null;
            return (
              <div key={i} className="text-[11px] leading-snug whitespace-pre-wrap" style={{ color: styles.text }}>
                <Bot size={10} className="inline mr-1" style={{ color: styles.accent }} />
                {text.slice(0, 600)}
                {text.length > 600 ? "…" : ""}
              </div>
            );
          }
          const p = e.payload as { toolName?: string; ok?: boolean };
          return (
            <div key={i} className="text-[10px] font-mono flex items-center gap-1.5" style={{ color: styles.textTertiary }}>
              <span style={{ color: p.ok === false ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}>
                {p.ok === false ? "✗" : "✓"}
              </span>
              {p.toolName}
            </div>
          );
        })}
    </div>
  );
}

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
