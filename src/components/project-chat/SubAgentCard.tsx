import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  fetchSubAgents,
  fetchSessionDetail,
  retrySubAgent,
  type SessionDetail,
} from "../../lib/api";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * SubAgentCard (ROUND-36 — the owner's sub-agent monitoring ask): one card
 * per delegated sub-agent, live-updating while it runs. "when the user taps
 * on the running sessions, he can look at their status" — the card shows
 * role/task/status/progress/tokens/elapsed and opens the FULL child log in
 * a dialog. Failed children offer smart RETRY (resumes from the event log).
 *
 * ROUND-40 (owner: "if I click on… a sub-agent running task… then it will
 * automatically open up on the right sidebar window"): clicking the card's
 * main body calls `useRightSidebarStore.getState().openSubAgent(...)` so the
 * child session opens as a tab in the right sidebar. A small chevron button
 * on the right still toggles the inline SubAgentLog dialog (so the existing
 * "tap to inspect the transcript inline" behavior is preserved).
 */
export function SubAgentCard({
  sessionId,
  parentSessionId,
  projectId,
  role,
  task,
  live,
}: {
  sessionId: string;
  parentSessionId: string | null;
  /** ROUND-40: the chat panel's project id — needed to open the sub-agent
   * tab in the right sidebar via `openSubAgent(projectId, …)`. */
  projectId: string;
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

  // ROUND-40: open this sub-agent's tab in the right sidebar (the owner's
  // "click the sub-agent task card → opens in the right sidebar" directive).
  // Falls back to the child's own session id if the parent is null (defensive;
  // the store's openSubAgent signature requires a string parent). The
  // `?? undefined` coerces SubAgentStatus.subRole's `string | null` to the
  // `string | undefined` the store helper expects.
  // R48: the tab title is code-prefixed (`K7F2 · <title>`) so open tabs are
  // identifiable at a glance — same convention as the live Delegated rows in
  // WorkingSection and the SubAgentPicker (the owner's "quickly know which
  // sub-agent is which" directive).
  const displayTitle = task ?? child?.title ?? "Sub-agent";
  const openInSidebar = () => {
    useRightSidebarStore.getState().openSubAgent(
      projectId,
      parentSessionId ?? sessionId,
      sessionId,
      child?.code ? `${child.code} · ${displayTitle}` : displayTitle,
      role ?? child?.subRole ?? undefined,
    );
  };

  return (
    <div
      className="rounded-[12px] border overflow-hidden"
      style={{ borderColor: withAlpha(statusTone, 0.35), background: styles.card }}
    >
      {/* Row — clicking the body opens the sub-agent tab in the right sidebar
          (ROUND-40 owner directive). The chevron on the right is a SEPARATE
          small button that toggles the inline log dialog (preserves the existing
          "tap to inspect the transcript" behavior). */}
      <div
        role="button"
        tabIndex={0}
        onClick={openInSidebar}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openInSidebar();
          }
        }}
        className="w-full flex items-center gap-2.5 px-3 h-11 text-left cursor-pointer transition-colors"
        style={{ color: styles.text }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = withAlpha(statusTone, 0.06);
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
        title={`Open ${role ?? child?.subRole ?? "sub-agent"} in sidebar`}
        aria-label={`Open ${role ?? child?.subRole ?? "sub-agent"} ${task ?? ""} in sidebar`}
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
        {/* Small inline-log toggle (keeps the ROUND-36 inspect-transcript UX).
            stopPropagation so clicking it doesn't ALSO open the sidebar tab. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLogOpen((v) => !v);
          }}
          aria-expanded={logOpen}
          aria-label="Toggle inline sub-agent log"
          title="Toggle inline log"
          className="shrink-0 w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = styles.subtleHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {logOpen ? (
            <PanelRightOpen size={12} />
          ) : (
            <ChevronDown
              size={12}
              style={{ transform: logOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
            />
          )}
        </button>
      </div>

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
