import { useState } from "react";
import { motion } from "framer-motion";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import type { DetailedUsageProject, DetailedUsageSession } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { formatWhen } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { formatCompactTokens, formatCost, formatDuration } from "./usage-helpers";

/**
 * ROUND-52 (R52-b): projects → sessions drill-down — the /usage screen's main
 * event (the owner-approved DASHBOARD usage page layout, app DNA): collapsible
 * project sections (chevron + color dot + summary chips), each expanding to
 * its session rows; sub-agent children nest under their delegating parent
 * with an indented "sub-agent · role" badge. Sessions cap at 20 visible with
 * a "show all" expander inside a max-h-96 custom-scrollbar pane.
 */

const VISIBLE_SESSIONS = 20;

function statusColor(status: string, textTertiary: string): string {
  return status === "failed" ? SEMANTIC_COLORS.danger : textTertiary;
}

/** Tool-breakdown tooltip for a session row ("read_file ×12 · write_file ×3 (1 failed)"). */
function toolBreakdownTitle(session: DetailedUsageSession): string {
  if (session.toolCalls.length === 0) return `${session.title} — no tool calls`;
  return `${session.title} — ${session.toolCalls
    .map((t) => `${t.tool} ×${t.count}${t.failures > 0 ? ` (${t.failures} failed)` : ""}`)
    .join(", ")}`;
}

function SessionRow({
  session,
  projectId,
  onOpen,
  styles,
}: {
  session: DetailedUsageSession;
  projectId: string | null;
  onOpen: (sessionId: string, projectId: string | null) => void;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary, border, softShadow } = styles;

  return (
    <motion.button
      onClick={() => {
        // Sub-agent children are not standalone chats — open the PARENT
        // conversation (the child lives in its SubAgentPanel). Deep-link
        // shape matches RecentActivity (?session= is read by use-active-session).
        onOpen(session.isSubagent && session.parentId ? session.parentId : session.id, projectId);
      }}
      aria-label={`Open session ${session.title}`}
      title={toolBreakdownTitle(session)}
      className="w-full cursor-pointer rounded-2xl border-[1.5px] bg-card p-3.5 text-left transition-colors duration-200 hover:bg-hover"
      style={{
        borderColor: border,
        boxShadow: softShadow,
      }}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold" style={{ color: text }}>
              {session.title}
            </span>
            <span
              className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: statusColor(session.status, textTertiary) }}
            >
              {session.status}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {session.model ? (
              <span className="truncate font-mono" style={{ color: textSecondary }} title={session.model}>
                {session.model}
              </span>
            ) : null}
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textTertiary }}>{formatDuration(session.durationMs)}</span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textSecondary }} title={`${session.tokens.input.toLocaleString()} sent · ${session.tokens.output.toLocaleString()} received`}>
              ↑ {formatCompactTokens(session.tokens.input)} ↓ {formatCompactTokens(session.tokens.output)}
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textTertiary }}>{session.requests} req</span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textTertiary }}>
              {session.toolCallCount} {session.toolCallCount === 1 ? "call" : "calls"}
            </span>
            {session.costUsd > 0 ? (
              <>
                <span style={{ color: textTertiary }}>·</span>
                <span style={{ color: textSecondary }}>{formatCost(session.costUsd)}</span>
              </>
            ) : null}
            {session.subagentCount > 0 ? (
              <>
                <span style={{ color: textTertiary }}>·</span>
                <span className="font-semibold" style={{ color: textSecondary }}>
                  {session.subagentCount} sub-agent{session.subagentCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </motion.button>
  );
}

/** Indented sub-agent child row — "sub-agent · role" badge + the same facts. */
function SubAgentRow({
  session,
  projectId,
  onOpen,
  styles,
}: {
  session: DetailedUsageSession;
  projectId: string | null;
  onOpen: (sessionId: string, projectId: string | null) => void;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary, border, accent, accentText } = styles;

  return (
    <div
      className="ml-4 sm:ml-6 rounded-xl border-[1.5px] border-l-[3px] p-3 transition-colors duration-200 hover:bg-hover"
      style={{
        borderColor: border,
        borderLeftColor: accent,
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(session.parentId ?? session.id, projectId)}
        aria-label={`Open parent session of sub-agent ${session.title}`}
        title={toolBreakdownTitle(session)}
        className="w-full cursor-pointer text-left"
      >
        <div className="flex items-center gap-2">
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: accent, color: accentText }}
          >
            <Bot size={10} strokeWidth={2.5} />
            sub-agent{session.role ? ` · ${session.role}` : ""}
          </span>
          <span className="truncate text-[12px] font-medium" style={{ color: text }}>
            {session.title}
          </span>
          <span
            className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: statusColor(session.status, textTertiary) }}
          >
            {session.status}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-1 text-[11px]">
          <span style={{ color: textTertiary }}>{formatDuration(session.durationMs)}</span>
          <span style={{ color: textTertiary }}>·</span>
          <span style={{ color: textSecondary }} title={`${session.tokens.input.toLocaleString()} sent · ${session.tokens.output.toLocaleString()} received`}>
            ↑ {formatCompactTokens(session.tokens.input)} ↓ {formatCompactTokens(session.tokens.output)}
          </span>
          <span style={{ color: textTertiary }}>·</span>
          <span style={{ color: textTertiary }}>
            {session.toolCallCount} {session.toolCallCount === 1 ? "call" : "calls"}
          </span>
        </div>
      </button>
    </div>
  );
}

function ProjectSection({
  project,
  onOpenSession,
  styles,
}: {
  project: DetailedUsageProject;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  styles: ThemeStyles;
}) {
  const { card, text, textSecondary, textTertiary, border, subtleHover, softShadow } = styles;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /* R100-G: hover is the CSS bg-hover wash now — no `hovered` state (the
     old JS pair painted subtleHover + a lift). */

  const mains = project.sessions.filter((s) => !s.isSubagent);
  const subs = project.sessions.filter((s) => s.isSubagent);
  const subsByParent = new Map<string, DetailedUsageSession[]>();
  for (const sub of subs) {
    const key = sub.parentId ?? "";
    const group = subsByParent.get(key) ?? [];
    group.push(sub);
    subsByParent.set(key, group);
  }

  const visibleMains = showAll ? mains : mains.slice(0, VISIBLE_SESSIONS);
  const hiddenCount = mains.length - visibleMains.length;
  // Children whose parent is not among this project's mains (deleted parent,
  // cross-project delegation) still render — usage data never silently drops.
  const orphanSubs = (subsByParent.get("") ?? []).concat(
    [...subsByParent.entries()]
      .filter(([parentId]) => parentId !== "" && !mains.some((m) => m.id === parentId))
      .flatMap(([, group]) => group),
  );

  return (
    <div
      className="rounded-2xl border-[1.5px]"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Toggle project ${project.name} sessions`}
        className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-4 text-left transition-colors duration-200 hover:bg-hover"
      >
        <span style={{ color: textTertiary }} className="shrink-0">
          {open ? <ChevronDown size={16} strokeWidth={2.5} /> : <ChevronRight size={16} strokeWidth={2.5} />}
        </span>
        <span
          className="h-3 w-3 shrink-0 rounded-full border-2"
          style={{ backgroundColor: project.color, borderColor: project.color }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold" style={{ color: text }}>
              {project.name}
            </span>
            {project.synthetic ? (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: subtleHover, color: textTertiary }}
              >
                no project
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span style={{ color: textSecondary }}>
              <strong style={{ color: text }}>{project.totals.sessions}</strong>{" "}
              {project.totals.sessions === 1 ? "session" : "sessions"}
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textSecondary }}>
              <strong style={{ color: text }}>{project.totals.subagents}</strong> sub-agent
              {project.totals.subagents === 1 ? "" : "s"}
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textSecondary }}>
              <strong style={{ color: text }}>{project.totals.toolCalls.toLocaleString()}</strong> tool calls
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span
              style={{ color: textSecondary }}
              title={`${project.totals.tokens.input.toLocaleString()} sent · ${project.totals.tokens.output.toLocaleString()} received`}
            >
              ↑ {formatCompactTokens(project.totals.tokens.input)} ↓{" "}
              {formatCompactTokens(project.totals.tokens.output)}
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textSecondary }}>{formatCost(project.totals.costUsd)}</span>
            {project.lastActivity ? (
              <>
                <span style={{ color: textTertiary }}>·</span>
                <span style={{ color: textTertiary }}>last {formatWhen(project.lastActivity)}</span>
              </>
            ) : null}
          </span>
        </span>
      </button>

      {open ? (
        <div className="px-3 pb-3.5 sm:px-4">
          <div
            className="custom-scrollbar flex max-h-96 flex-col gap-2 overflow-y-auto p-1"
            aria-label={`Sessions in ${project.name}`}
          >
            {mains.length === 0 && subs.length === 0 ? (
              <p className="py-4 text-center text-[12px] font-medium" style={{ color: textSecondary }}>
                No sessions recorded for this project yet.
              </p>
            ) : (
              <>
                {visibleMains.map((session) => (
                  <div key={session.id} className="flex flex-col gap-1.5">
                    <SessionRow
                      session={session}
                      projectId={project.synthetic ? null : project.id}
                      onOpen={onOpenSession}
                      styles={styles}
                    />
                    {(subsByParent.get(session.id) ?? []).map((child) => (
                      <SubAgentRow
                        key={child.id}
                        session={child}
                        projectId={project.synthetic ? null : project.id}
                        onOpen={onOpenSession}
                        styles={styles}
                      />
                    ))}
                  </div>
                ))}
                {orphanSubs.map((child) => (
                  <SubAgentRow
                    key={child.id}
                    session={child}
                    projectId={project.synthetic ? null : project.id}
                    onOpen={onOpenSession}
                    styles={styles}
                  />
                ))}
              </>
            )}
          </div>
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 w-full cursor-pointer rounded-xl py-2 text-[12px] font-semibold transition-colors"
              style={{ color: styles.accent }}
            >
              Show all {mains.length} sessions
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsDrilldown({
  projects,
  onOpenSession,
  styles,
}: {
  projects: DetailedUsageProject[];
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  styles: ThemeStyles;
}) {
  const { textTertiary, accent } = styles;

  return (
    <section aria-label="Projects and sessions" className="mb-4 md:mb-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} aria-hidden="true" />
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Projects &amp; Sessions
          </h2>
        </div>
        <span className="text-[11px]" style={{ color: textTertiary }}>
          Sub-agent runs nest under their parent
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            onOpenSession={onOpenSession}
            styles={styles}
          />
        ))}
      </div>
    </section>
  );
}
