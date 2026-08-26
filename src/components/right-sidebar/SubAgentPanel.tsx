import { useQuery } from "@tanstack/react-query";
import { fetchSubAgentDetail, type SessionEvent, type SessionDetail } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { useRef, useState } from "react";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import {
  Bot,
  Check,
  CircleCheck,
  CircleX,
  FileCode2,
  FilePenLine,
  FilePlus2,
  FolderPlus,
  Globe,
  LoaderCircle,
  MessageSquareText,
  Search,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";

/**
 * ROUND-38/39/41/42 right-sidebar Sub-agent tab.
 *
 * ROUND-42 (owner: "The prompt which was given to it was showing fully… It
 * should be minimized to about 10 lines or so… the user has to manually click
 * the expand button to see the full one" + "the UI could be improved. It could
 * be made better and much more proper and much better looking"). Redesign:
 *   - The TASK bubble clamps at 10 lines with a Show more/less toggle (the
 *     final report clamps too — same rule, same component).
 *   - A unified vertical TIMELINE for live progress: each tool call is a
 *     compact row on a status-colored rail (running = pulsing, ok = green,
 *     failed = red); assistant text renders as soft interleaved bubbles.
 *   - The FILES section under the task is a tight manifest (tool-specific
 *     icons, count badge, clamped to 5 rows with "show all").
 *   - The FINAL REPORT closes the panel with an accent-rail card + eyebrow.
 *   - Live status badge + near-live 600ms polling preserved from R41.
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

/** The icon for a NON-file tool in the timeline. */
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
  // argsSummary is typically the path itself for file tools (the runtime
  // uses the first positional arg as the summary). Strip leading/trailing
  // quotes if present.
  const trimmed = argsSummary.trim().replace(/^["']|["']$/g, "");
  return trimmed === "" ? null : trimmed;
}

/** Split a path into dir + basename for a nicer mono rendering. */
function splitPath(path: string): { dir: string; base: string } {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
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

/**
 * Derive a live status from the session detail (status field + hasRunningTool). */
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
  const [filesExpanded, setFilesExpanded] = useState(false);
  const filesToShow = filesExpanded ? filesWritten : filesWritten.slice(0, 5);

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
      {/* ── Header strip: role + title + live status ── */}
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

      {/* ── The TASK (the prompt this sub-agent was given) — right-aligned
          role-tinted bubble, clamped to 10 lines (ROUND-42). ── */}
      {promptText !== null ? (
        <div className="shrink-0 px-3 pt-3 pb-1 flex flex-col items-end">
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
            <ClampedText
              text={promptText}
              lines={10}
              expandLabel="Show full task"
              collapseLabel="Collapse task"
            />
          </div>
        </div>
      ) : null}

      {/* ── Files manifest — what this sub-agent wrote/changed (ROUND-42:
          compact rows, tool icons, count badge, clamped to 5 + toggle). ── */}
      {filesWritten.length > 0 ? (
        <div className="shrink-0 px-3 py-2">
          <div
            className="rounded-xl border overflow-hidden"
            style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle }}
          >
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 border-b"
              style={{ borderColor: styles.borderSubtle }}
            >
              <FileCode2 size={12} style={{ color: styles.accent }} />
              <span className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
                Files
              </span>
              <span
                className="ml-auto text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full"
                style={{
                  color: styles.accent,
                  background: withAlpha(styles.accent, 0.12),
                }}
              >
                {filesWritten.length}
              </span>
            </div>
            <div className="flex flex-col">
              {filesToShow.map((f, i) => {
                const { dir, base } = splitPath(f.path);
                return (
                  <div
                    key={`${f.path}-${i}`}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px]"
                    style={{ borderTop: i === 0 ? "none" : `1px solid ${styles.borderSubtle}` }}
                  >
                    <span className="shrink-0" style={{ color: styles.accent }}>
                      <FileToolIcon toolName={f.toolName} />
                    </span>
                    <span className="font-mono truncate" style={{ color: styles.textSecondary }} title={f.path}>
                      {dir ? (
                        <span style={{ color: styles.textTertiary }}>{dir}</span>
                      ) : null}
                      <span style={{ color: styles.text }}>{base}</span>
                    </span>
                  </div>
                );
              })}
              {filesWritten.length > 5 ? (
                <button
                  onClick={() => setFilesExpanded((v) => !v)}
                  className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-left transition-colors"
                  style={{ color: styles.accent, borderTop: `1px solid ${styles.borderSubtle}` }}
                >
                  {filesExpanded
                    ? "Show less"
                    : `Show all ${filesWritten.length} files`}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Activity timeline — tool rows + assistant bubbles, in order,
          on a status-colored rail (ROUND-42 redesign). ── */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5 mb-2">
          {liveStatus === "running" ? (
            <LoaderCircle size={11} className="animate-spin" style={{ color: styles.accent }} />
          ) : (
            <MessageSquareText size={11} style={{ color: styles.textTertiary }} />
          )}
          <span className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
            {actions.length === 0 ? "Working…" : "Live progress"}
          </span>
        </div>
        {actions.length === 0 ? (
          <div className="text-[11px] py-2" style={{ color: styles.textTertiary }}>
            {liveStatus === "running" ? "Sub-agent is starting work…" : "No actions yet."}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {actions.map((a, i) =>
              a.kind === "tool" && a.tool ? (
                <TimelineToolRow
                  key={`t-${i}`}
                  tool={a.tool}
                  styles={styles}
                  isLast={i === actions.length - 1 && liveStatus === "running" && a.tool.ok === null}
                />
              ) : (
                <AssistantBubble
                  key={`a-${i}`}
                  text={a.text ?? ""}
                  styles={styles}
                  isReport={false}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* ── Final report — accent-rail card + eyebrow (clamped like the task). ── */}
      {report ? (
        <div className="px-3 pb-4 mt-1">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Sparkles size={11} style={{ color: styles.accent }} />
            <span className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: styles.textTertiary }}>
              Final report
            </span>
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

/**
 * ROUND-42: a compact timeline tool row — status-colored left rail, icon,
 * tool name, mono arg summary, status chip. The last RUNNING tool gets a
 * pulsing rail (the live-progress signal).
 */
function TimelineToolRow({
  tool,
  styles,
  isLast,
}: {
  tool: ToolCard;
  styles: ReturnType<typeof useThemeStyles>;
  isLast: boolean;
}) {
  const isFileTool = FILE_TOOLS.has(tool.toolName);
  const statusColor =
    tool.ok === null ? "#3B82F6" : tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger;
  const { dir, base } = splitPath(tool.argsSummary);
  return (
    <div
      className="flex items-start gap-2 rounded-lg border px-2 py-1.5"
      style={{
        borderColor: tool.ok === false ? withAlpha(SEMANTIC_COLORS.danger, 0.35) : styles.border,
        background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle,
      }}
    >
      {/* Status rail */}
      <span
        className={`shrink-0 w-[3px] self-stretch rounded-full ${tool.ok === null ? "animate-pulse" : ""}`}
        style={{ background: statusColor, opacity: isLast ? 1 : 0.65 }}
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
              {dir ? <span style={{ color: styles.textTertiary, opacity: 0.7 }}>{dir}</span> : null}
              {base}
            </span>
          ) : null}
          <div className="ml-auto shrink-0">
            {tool.ok === null ? (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ color: "#3B82F6" }}>
                <LoaderCircle size={9} className="animate-spin" />
                running
              </span>
            ) : tool.ok ? (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ color: SEMANTIC_COLORS.success }}>
                <CircleCheck size={9} />
                ok
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ color: SEMANTIC_COLORS.danger }}>
                <CircleX size={9} />
                failed
              </span>
            )}
          </div>
        </div>
        {tool.ok === false && tool.outputSummary ? (
          <div className="font-mono text-[9.5px] mt-0.5 truncate" style={{ color: SEMANTIC_COLORS.danger }} title={tool.outputSummary}>
            {tool.outputSummary}
          </div>
        ) : tool.ok === true && tool.outputSummary ? (
          <div className="font-mono text-[9.5px] mt-0.5 truncate" style={{ color: styles.textTertiary }} title={tool.outputSummary}>
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
      {isReport ? (
        <ClampedText text={text} lines={10} expandLabel="Show full report" collapseLabel="Collapse report" />
      ) : (
        text
      )}
    </div>
  );
}
