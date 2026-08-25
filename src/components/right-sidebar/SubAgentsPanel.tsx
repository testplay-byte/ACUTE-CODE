import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight } from "lucide-react";
import { fetchSubAgentDetail, fetchSubAgents, type SubAgentStatus } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { useRef } from "react";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-38 right-sidebar Sub-agents tab (owner: "I can click on the sub agent
 * which is doing work and I can see… the prompt at the very top which was
 * given to the sub agent. Below I will be able to see the actions which the
 * sub agent was performing").
 *
 * List: the parent session's child sub-agents (GET /sessions/:id/subagents)
 * with status + role + todo progress. Selecting one fetches the child's full
 * event log (GET /sessions/:id — a child session is a session) and renders:
 *   - PROMPT at the top (the child's first message.user content — the framing
 *     + TASK the orchestrator sent).
 *   - ACTIONS below (every tool.use + message.assistant event in order).
 */
const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a825",
  tester: "#f59e0b",
};

function statusColor(status: string, styles: { textTertiary: string }): string {
  if (status === "running") return SEMANTIC_COLORS.success;
  if (status === "failed") return SEMANTIC_COLORS.danger;
  if (status === "completed") return styles.textTertiary;
  return styles.textTertiary;
}

/** Extract a usable text payload from an event. */
function eventText(type: string, payload: unknown): { kind: "tool" | "text" | "user"; text: string; meta?: string } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (type === "message.user" || type === "message.assistant") {
    const content = typeof p.content === "string" ? p.content : "";
    if (content === "") return null;
    return { kind: type === "message.user" ? "user" : "text", text: content };
  }
  if (type === "tool.use") {
    const toolName = typeof p.toolName === "string" ? p.toolName : "tool";
    const argsSummary = typeof p.argsSummary === "string" ? p.argsSummary : "";
    const ok = p.ok;
    const outputSummary = typeof p.outputSummary === "string" ? p.outputSummary : "";
    const meta = `${typeof ok === "boolean" ? (ok ? "✓" : "✗") : "…"}${outputSummary ? ` · ${outputSummary}` : ""}`;
    return { kind: "tool", text: `${toolName}${argsSummary ? ` · ${argsSummary}` : ""}`, meta };
  }
  return null;
}

export function SubAgentsPanel({
  sessionId,
}: {
  /** The current PARENT session id (for the sub-agents list). null when none. */
  sessionId: string | null;
}) {
  const styles = useThemeStyles();
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["subagents", sessionId],
    queryFn: () => fetchSubAgents(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 2_000,
    refetchInterval: 2_000, // live status while sub-agents run
  });

  const detailQuery = useQuery({
    queryKey: ["subagent-detail", selectedId],
    queryFn: () => fetchSubAgentDetail(selectedId as string),
    enabled: selectedId !== null,
    staleTime: 1_500,
    refetchInterval: selectedId !== null ? 1_500 : false,
  });

  const subs: SubAgentStatus[] = listQuery.data ?? [];
  const selected = subs.find((s) => s.id === selectedId) ?? null;
  const events = detailQuery.data?.events ?? [];
  // The prompt = first message.user event content.
  const promptEvent = events.find((e) => e.type === "message.user");
  const promptText =
    promptEvent && typeof (promptEvent.payload as { content?: unknown })?.content === "string"
      ? ((promptEvent.payload as { content: string }).content)
      : null;

  if (sessionId === null) {
    return (
      <div className="h-full grid place-items-center px-6 text-center">
        <div>
          <Bot size={26} className="mx-auto mb-2" style={{ color: styles.textTertiary }} />
          <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
            No active session
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: styles.textTertiary }}>
            Send a message in the chat — sub-agents the agent delegates to appear here.
          </div>
        </div>
      </div>
    );
  }

  if (subs.length === 0) {
    return (
      <div className="h-full grid place-items-center px-6 text-center">
        <div>
          <Bot size={26} className="mx-auto mb-2" style={{ color: styles.textTertiary }} />
          <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
            No sub-agents yet
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: styles.textTertiary }}>
            When the agent delegates a task (delegate_task), the child session shows up here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* List strip (collapses when one is selected) */}
      <div
        className="shrink-0 flex flex-col border-b"
        style={{ borderColor: styles.border }}
      >
        {subs.map((sub) => {
          const active = sub.id === selectedId;
          const role = sub.subRole ?? "agent";
          return (
            <button
              key={sub.id}
              onClick={() => setSelectedId(active ? null : sub.id)}
              className="flex items-center gap-2 px-2.5 h-8 text-left transition-colors"
              style={{
                background: active ? withAlpha(styles.accent, 0.1) : "transparent",
                color: active ? styles.text : styles.textSecondary,
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = styles.subtleHover; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: statusColor(sub.status, styles) }}
                aria-hidden
              />
              <span
                className="text-[9.5px] font-mono font-bold uppercase shrink-0 px-1.5 py-0.5 rounded-md"
                style={{ color: ROLE_COLORS[role] ?? styles.textTertiary, background: withAlpha(ROLE_COLORS[role] ?? styles.textTertiary, 0.12) }}
              >
                {role}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] font-semibold" title={sub.title ?? "Untitled"}>
                {sub.title ?? "Untitled"}
              </span>
              <span className="text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
                {sub.status}
              </span>
              <ChevronRight size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
            </button>
          );
        })}
      </div>

      {/* Detail: prompt + actions */}
      {selectedId !== null && selected !== null ? (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
          {/* The PROMPT at the very top (owner directive). */}
          <div
            className="shrink-0 px-3 py-2.5 border-b"
            style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
          >
            <div className="text-[9.5px] font-bold uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
              Prompt
            </div>
            <div className="text-[11.5px] font-mono leading-[1.55] whitespace-pre-wrap break-words" style={{ color: styles.text }}>
              {promptText ?? selected.title ?? "(no prompt recorded)"}
            </div>
          </div>

          {/* The ACTIONS below. */}
          <div className="px-3 py-2 flex flex-col gap-1.5">
            <div className="text-[9.5px] font-bold uppercase tracking-wider mb-0.5" style={{ color: styles.textTertiary }}>
              Actions
            </div>
            {events
              .filter((e) => e.type === "tool.use" || e.type === "message.assistant")
              .map((e, i) => {
                const t = eventText(e.type, e.payload);
                if (t === null) return null;
                if (t.kind === "tool") {
                  return (
                    <div key={i} className="flex items-start gap-1.5 text-[11px]">
                      <span className="font-mono shrink-0 mt-0.5" style={{ color: SEMANTIC_COLORS.success }}>›</span>
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] break-words" style={{ color: styles.text }}>{t.text}</div>
                        {t.meta ? (
                          <div className="font-mono text-[10px] mt-0.5" style={{ color: styles.textTertiary }}>{t.meta}</div>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="text-[11.5px] leading-[1.55] py-0.5" style={{ color: styles.text }}>
                    {t.text}
                  </div>
                );
              })}
            {selected.report ? (
              <div className="mt-2 pt-2 border-t text-[11.5px] leading-[1.55]" style={{ borderColor: styles.border, color: styles.text }}>
                <div className="text-[9.5px] font-bold uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
                  Final report
                </div>
                {selected.report}
              </div>
            ) : null}
            {selected.error ? (
              <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }}>
                {selected.error}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center px-6 text-center">
          <div className="text-[11px]" style={{ color: styles.textTertiary }}>
            Select a sub-agent to see its prompt + actions.
          </div>
        </div>
      )}
    </div>
  );
}
