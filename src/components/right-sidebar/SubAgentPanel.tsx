import { useQuery } from "@tanstack/react-query";
import { fetchSubAgentDetail } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { useRef } from "react";
import { withAlpha } from "../dashboard/helpers";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";

/**
 * ROUND-38/39 right-sidebar Sub-agent tab (owner: "I can click on the sub
 * agent which is doing work and I can see… the prompt at the very top which
 * was given to the sub agent. Below I will be able to see the actions which
 * the sub agent was performing").
 *
 * ROUND-39: each sub-agent tab is bound to ONE child session (the tab was
 * created by picking from the quick menu's sub-agent picker). The prompt
 * renders at the top (the child's first message.user content = the framing
 * + TASK the orchestrator sent). The ACTIONS render below (every tool.use
 * + message.assistant event in order) + the final report.
 */
const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a825",
  tester: "#f59e0b",
};

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

export function SubAgentPanel({ tab }: { tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const subAgentId = tab.subAgentId ?? null;

  // Fetch the sub-agent's full event log (events + prompt + actions).
  const detailQuery = useQuery({
    queryKey: ["subagent-detail", subAgentId],
    queryFn: () => fetchSubAgentDetail(subAgentId as string),
    enabled: subAgentId !== null,
    staleTime: 1_500,
    refetchInterval: subAgentId !== null ? 1_500 : false,
  });

  const events = detailQuery.data?.events ?? [];
  // The prompt = first message.user event content.
  const promptEvent = events.find((e) => e.type === "message.user");
  const promptText =
    promptEvent && typeof (promptEvent.payload as { content?: unknown })?.content === "string"
      ? ((promptEvent.payload as { content: string }).content)
      : null;
  // The final report = last message.assistant event content (the child's
  // reply after completing its task — same as the parent sees from
  // delegate_task's return value).
  const lastAssistant = [...events].reverse().find((e) => e.type === "message.assistant");
  const report =
    lastAssistant && typeof (lastAssistant.payload as { content?: unknown })?.content === "string"
      ? ((lastAssistant.payload as { content: string }).content)
      : null;
  const role = tab.subRole ?? "agent";
  const roleColor = ROLE_COLORS[role] ?? styles.textTertiary;

  if (subAgentId === null) {
    return (
      <div className="h-full grid place-items-center px-6 text-center">
        <div className="text-[11.5px]" style={{ color: styles.textTertiary }}>
          No sub-agent bound to this tab.
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full flex flex-col min-h-0 overflow-y-auto auto-scroll">
      {/* The PROMPT at the very top (owner directive). */}
      <div
        className="shrink-0 px-3 py-2.5 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className="text-[9px] font-mono font-bold uppercase shrink-0 px-1.5 py-0.5 rounded-md"
            style={{ color: roleColor, background: withAlpha(roleColor, 0.14) }}
          >
            {role}
          </span>
          <div className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
            Prompt
          </div>
        </div>
        <div className="text-[11.5px] font-mono leading-[1.55] whitespace-pre-wrap break-words" style={{ color: styles.text }}>
          {promptText ?? tab.title ?? "(no prompt recorded)"}
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
        {report ? (
          <div className="mt-2 pt-2 border-t text-[11.5px] leading-[1.55]" style={{ borderColor: styles.border, color: styles.text }}>
            <div className="text-[9.5px] font-bold uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
              Final report
            </div>
            {report}
          </div>
        ) : null}
      </div>
    </div>
  );
}
