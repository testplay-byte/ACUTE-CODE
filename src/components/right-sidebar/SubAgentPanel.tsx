import { useQuery } from "@tanstack/react-query";
import { fetchSubAgentDetail, type SessionEvent, type SessionDetail } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { useRef } from "react";
import { withAlpha } from "../dashboard/helpers";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import {
  Bot,
  Check,
  CircleCheck,
  CircleX,
  FileCode2,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

/**
 * ROUND-38/39/41 right-sidebar Sub-agent tab.
 *
 * ROUND-41 (owner: "the sub-agents were not looking like I wanted. They
 * were not looking good. They were not proper. The user interface was not
 * like the chat window I hoped for it to be. It was not showing the live
 * progress of the sub-agents or anything like that… if the sub-agents write
 * any file or anything like that, then they should be shown in the
 * sub-agents menu side too"). Rebuilt to look like a chat window:
 *   - The PROMPT renders as a user message at the top (right-aligned bubble).
 *   - Each tool.use event renders as a "tool card" (icon + tool name +
 *     args + ok/failed status chip + output summary). File-mutating tools
 *     (write_file / edit_file / create_dir / delete_file) ALSO feed the
 *     "Files written" section above the actions.
 *   - Each message.assistant event renders as a left-aligned assistant
 *     bubble (so partial / intermediate text shows live, not just the
 *     final report).
 *   - The FINAL REPORT (last message.assistant) renders as the closing
 *     assistant bubble with a "Final report" eyebrow.
 *   - Live "running" badge (animated spinner) when the sub-agent is in
 *     the running state — polling at 600ms gives a near-live feel.
 *   - Empty state when no sub-agent is bound.
 */
const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a825",
  tester: "#f59e0b",
};

/** Tool names that mutate files — collected into the "Files written" section. */
const FILE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_dir",
  "delete_file",
]);

/** Icon for a file-mutating tool (used in the Files written section). */
function FileToolIcon({ toolName }: { toolName: string }): JSX.Element {
  switch (toolName) {
    case "write_file":
      return <Plus size={12} />;
    case "edit_file":
      return <Pencil size={12} />;
    case "create_dir":
      return <FolderPlus size={12} />;
    case "delete_file":
      return <X size={12} />;
    default:
      return <FileCode2 size={12} />;
  }
}

/** Extract a file path from a tool.use event's argsSummary. The runtime
 * formats argsSummary as the first argument (the path) for file tools. */
function filePathFromArgs(toolName: string, argsSummary: string): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  // argsSummary is typically the path itself for file tools (the runtime
  // uses the first positional arg as the summary). Strip leading/trailing
  // quotes if present.
  const trimmed = argsSummary.trim().replace(/^["']|["']$/g, "");
  return trimmed === "" ? null : trimmed;
}

interface ToolCard {
  toolName: string;
  argsSummary: string;
  ok: boolean | null;
  outputSummary: string | null;
  ts: string;
}

/** Parse the event log into renderable items (prompt / tool cards / assistant
 * bubbles / files-written list / final report). */
function parseSubAgentEvents(events: SessionEvent[]): {
  promptText: string | null;
  actions: Array<{ kind: "tool" | "text"; tool?: ToolCard; text?: string; ts: string }>;
  filesWritten: Array<{ toolName: string; path: string; ts: string }>;
  report: string | null;
  hasRunningTool: boolean;
} {
  const promptEvent = events.find((e) => e.type === "message.user");
  const promptText =
    promptEvent && typeof (promptEvent.payload as { content?: unknown } | null)?.content === "string"
      ? ((promptEvent.payload as { content: string }).content)
      : null;

  const filesWritten: Array<{ toolName: string; path: string; ts: string }> = [];
  const actions: Array<{ kind: "tool" | "text"; tool?: ToolCard; text?: string; ts: string }> = [];
  let hasRunningTool = false;

  for (const e of events) {
    if (e.type === "tool.use") {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const toolName = typeof p.toolName === "string" ? p.toolName : "tool";
      const argsSummary = typeof p.argsSummary === "string" ? p.argsSummary : "";
      const ok = typeof p.ok === "boolean" ? p.ok : null;
      const outputSummary = typeof p.outputSummary === "string" ? p.outputSummary : null;
      const tool: ToolCard = { toolName, argsSummary, ok, outputSummary, ts: e.ts };
      actions.push({ kind: "tool", tool, ts: e.ts });
      if (ok === null) hasRunningTool = true;
      // Feed the files-written section.
      const path = filePathFromArgs(toolName, argsSummary);
      if (path !== null) filesWritten.push({ toolName, path, ts: e.ts });
    } else if (e.type === "message.assistant") {
      const content =
        typeof (e.payload as { content?: unknown } | null)?.content === "string"
          ? ((e.payload as { content: string }).content)
          : "";
      if (content !== "") actions.push({ kind: "text", text: content, ts: e.ts });
    }
  }

  // The final report = last message.assistant event content (the child's
  // reply after completing its task — same as the parent sees from
  // delegate_task's return value).
  const lastAssistant = [...events].reverse().find((e) => e.type === "message.assistant");
  const report =
    lastAssistant && typeof (lastAssistant.payload as { content?: unknown } | null)?.content === "string"
      ? ((lastAssistant.payload as { content: string }).content)
      : null;

  return { promptText, actions, filesWritten, report, hasRunningTool };
}

/** Derive a live status from the session detail (status field + hasRunningTool). */
function deriveStatus(detail: SessionDetail | undefined, hasRunningTool: boolean): "idle" | "running" | "completed" | "failed" {
  if (!detail) return "idle";
  const s = (detail as unknown as { status?: string }).status;
  if (s === "running") return "running";
  if (s === "failed") return "failed";
  if (s === "completed") return "completed";
  // queued / undefined — but if a tool is in flight, show running.
  return hasRunningTool ? "running" : "idle";
}

export function SubAgentPanel({ tab }: { tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const subAgentId = tab.subAgentId ?? null;

  // ROUND-41: poll at 600ms (down from 1500ms) for near-live progress. The
  // child's event log records tool.use + message.assistant as they happen,
  // so each poll reveals the latest actions without lag.
  const detailQuery = useQuery({
    queryKey: ["subagent-detail", subAgentId],
    queryFn: () => fetchSubAgentDetail(subAgentId as string),
    enabled: subAgentId !== null,
    staleTime: 600,
    refetchInterval: subAgentId !== null ? 600 : false,
  });

  const events = detailQuery.data?.events ?? [];
  const { promptText, actions, filesWritten, report, hasRunningTool } = parseSubAgentEvents(events);
  const liveStatus = deriveStatus(detailQuery.data, hasRunningTool);
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
      {/* ── Header strip: role + live status ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
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
        <LiveStatusBadge status={liveStatus} styles={styles} />
      </div>

      {/* ── The PROMPT at the top (user-message bubble, right-aligned) ── */}
      {promptText !== null ? (
        <div className="shrink-0 px-3 pt-3 pb-1 flex justify-end">
          <div
            className="max-w-[88%] rounded-2xl rounded-br-sm px-3 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words"
            style={{
              background: styles.isDark ? withAlpha(roleColor, 0.18) : withAlpha(roleColor, 0.12),
              color: styles.text,
              border: `1px solid ${withAlpha(roleColor, 0.3)}`,
            }}
          >
            <div className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: roleColor }}>
              Task
            </div>
            {promptText}
          </div>
        </div>
      ) : null}

      {/* ── Files written section (if any) ── */}
      {filesWritten.length > 0 ? (
        <div className="shrink-0 px-3 py-2 mx-3 mt-2 rounded-xl border" style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle }}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <FileCode2 size={12} style={{ color: styles.accent }} />
            <span className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
              Files written ({filesWritten.length})
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {filesWritten.map((f, i) => (
              <div key={`${f.path}-${i}`} className="flex items-center gap-1.5 text-[11px]">
                <span style={{ color: styles.textTertiary }}>
                  <FileToolIcon toolName={f.toolName} />
                </span>
                <span className="font-mono truncate" style={{ color: styles.textSecondary }} title={f.path}>
                  {f.path}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Actions: tool cards + assistant bubbles, in order ── */}
      <div className="px-3 py-2 flex flex-col gap-2">
        <div className="text-[9.5px] font-bold uppercase tracking-wider mb-0.5" style={{ color: styles.textTertiary }}>
          {actions.length === 0 ? "Working…" : "Live progress"}
        </div>
        {actions.length === 0 ? (
          <div className="text-[11px] py-2" style={{ color: styles.textTertiary }}>
            {liveStatus === "running" ? "Sub-agent is starting work…" : "No actions yet."}
          </div>
        ) : (
          actions.map((a, i) =>
            a.kind === "tool" && a.tool ? (
              <ToolCardView key={`t-${i}`} tool={a.tool} styles={styles} />
            ) : (
              <AssistantBubble key={`a-${i}`} text={a.text ?? ""} styles={styles} isReport={false} />
            ),
          )
        )}
      </div>

      {/* ── Final report ── */}
      {report ? (
        <div className="px-3 pb-4 mt-1">
          <div className="text-[9.5px] font-bold uppercase tracking-wider mb-1.5" style={{ color: styles.textTertiary }}>
            Final report
          </div>
          <AssistantBubble text={report} styles={styles} isReport />
        </div>
      ) : null}
    </div>
  );
}

/** Live status badge — colored dot + label, animated for running. */
function LiveStatusBadge({
  status,
  styles,
}: {
  status: "idle" | "running" | "completed" | "failed";
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const tone =
    status === "running"
      ? "#3B82F6"
      : status === "completed"
        ? SEMANTIC_COLORS.success
        : status === "failed"
          ? SEMANTIC_COLORS.danger
          : styles.textTertiary;
  const label = status === "idle" ? "idle" : status;
  return (
    <div
      className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wider"
      style={{ background: withAlpha(tone, 0.14), color: tone }}
    >
      {status === "running" ? (
        <LoaderCircle size={10} className="animate-spin" />
      ) : status === "completed" ? (
        <Check size={10} />
      ) : status === "failed" ? (
        <CircleX size={10} />
      ) : (
        <Bot size={10} />
      )}
      {label}
    </div>
  );
}

/** A tool card — icon + tool name + args + ok/failed status chip + output. */
function ToolCardView({
  tool,
  styles,
}: {
  tool: ToolCard;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const isFileTool = FILE_TOOLS.has(tool.toolName);
  const isTerminalTool = tool.toolName === "run_command" || tool.toolName === "search_files" || tool.toolName === "list_dir";
  const Icon = isFileTool ? FileCode2 : isTerminalTool ? TerminalIcon : Bot;
  const iconColor = isFileTool ? styles.accent : isTerminalTool ? styles.textTertiary : styles.textSecondary;
  return (
    <div
      className="rounded-lg border px-2.5 py-1.5 flex items-start gap-2"
      style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle }}
    >
      <div className="mt-0.5 shrink-0" style={{ color: iconColor }}>
        <Icon size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-semibold" style={{ color: styles.text }}>
            {tool.toolName}
          </span>
          {tool.argsSummary ? (
            <span className="font-mono text-[10.5px] truncate" style={{ color: styles.textTertiary }} title={tool.argsSummary}>
              {tool.argsSummary}
            </span>
          ) : null}
          <div className="ml-auto shrink-0">
            {tool.ok === null ? (
              <span className="inline-flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
                <LoaderCircle size={9} className="animate-spin" />
                running
              </span>
            ) : tool.ok ? (
              <span className="inline-flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wider" style={{ color: SEMANTIC_COLORS.success }}>
                <CircleCheck size={9} />
                ok
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-[9.5px] font-bold uppercase tracking-wider" style={{ color: SEMANTIC_COLORS.danger }}>
                <CircleX size={9} />
                failed
              </span>
            )}
          </div>
        </div>
        {tool.outputSummary ? (
          <div className="font-mono text-[10px] mt-0.5 truncate" style={{ color: styles.textTertiary }} title={tool.outputSummary}>
            {tool.outputSummary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** An assistant bubble — left-aligned, markdown-ish prose. The final report
 * gets a thicker accent left-border + a slightly elevated background. */
function AssistantBubble({
  text,
  styles,
  isReport,
}: {
  text: string;
  styles: ReturnType<typeof useThemeStyles>;
  isReport: boolean;
}) {
  return (
    <div
      className={`max-w-[92%] rounded-2xl ${isReport ? "rounded-bl-sm border-l-[3px]" : "rounded-bl-sm"} px-3 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words`}
      style={{
        background: isReport ? styles.card : styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle,
        color: styles.text,
        borderColor: isReport ? styles.accent : styles.border,
        border: isReport ? undefined : `1px solid ${styles.border}`,
      }}
    >
      {text}
    </div>
  );
}
