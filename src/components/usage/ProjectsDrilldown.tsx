import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, ChevronRight, FolderKanban } from "lucide-react";
import type { DetailedUsageProject, DetailedUsageSession } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { formatWhen } from "../../lib/format";
import { DISCLOSURE_SPRING, SPRING, ease } from "../../lib/motion";
import { Kicker } from "../ui/Kicker";
import {
  CLAY_CARD,
  DISCLOSURE_COLLAPSE_MS,
  DISCLOSURE_FADE_MS,
  formatCompactTokens,
  formatCost,
  formatDuration,
} from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-52 (R52-b): projects → sessions drill-down — the /usage screen's main
 * event (the owner-approved DASHBOARD usage page layout, app DNA): collapsible
 * project sections (chevron + color dot + summary chips), each expanding to
 * its session rows; sub-agent children nest under their delegating parent
 * with an indented "sub-agent · role" badge. Sessions cap at 20 visible with
 * a "show all" expander inside a max-h-96 custom-scrollbar pane.
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign — the usage.html structural
 * reference): the collapsible groups ride the DISCLOSURE grammar (MOTION §2/§4
 * — expand = DISCLOSURE_SPRING {180, 24}; collapse = a 200ms TIMING + 150ms
 * fade, closing never bounces); the chevron ROTATES on the house spring; the
 * project group is ONE clay card with FLAT session rows separated by 1px
 * hairlines (no per-row cards); the DEEPEST nesting level (sub-agent runs)
 * sinks into the RECESSED WELL (`bg-well` + the rim hairline — TOKENS §10's
 * ladder); session status words ride the status TEXT tier (text-success-deep
 * / text-danger-deep — TOKENS §11); and the filter pills are the CHIP grammar
 * (resting `bg-well` + rim + 12px/600 secondary; selected = `bg-accent-deep`
 * + accentText) with quiet expand/collapse-all secondary buttons.
 */

const VISIBLE_SESSIONS = 20;

/** The session filter modes (the usage.html reference's u-filter). */
type SessionFilter = "all" | "subs";

/** Status word ink — the §11 status TEXT tier (deep/bright pairs). */
function statusClass(status: string): string {
  if (status === "completed") return "text-success-deep";
  if (status === "failed") return "text-danger-deep";
  return "";
}

function statusInk(status: string, textTertiary: string): string | undefined {
  return status === "completed" || status === "failed" ? undefined : textTertiary;
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
  const { text, textSecondary, textTertiary } = styles;
  const statusTertiary = statusInk(session.status, textTertiary);

  return (
    <button
      type="button"
      onClick={() => {
        // Sub-agent children are not standalone chats — open the PARENT
        // conversation (the child lives in its SubAgentPanel). Deep-link
        // shape matches RecentActivity (?session= is read by use-active-session).
        onOpen(session.isSubagent && session.parentId ? session.parentId : session.id, projectId);
      }}
      aria-label={`Open session ${session.title}`}
      title={toolBreakdownTitle(session)}
      className="w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors duration-100 hover:bg-hover"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: text }}>
          {session.title}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide",
            statusClass(session.status),
          )}
          style={statusTertiary !== undefined ? { color: statusTertiary } : undefined}
        >
          {session.status}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
        {session.model ? (
          <span className="max-w-[220px] truncate font-mono" style={{ color: textSecondary }} title={session.model}>
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
    </button>
  );
}

/** Indented sub-agent child row — "sub-agent · role" badge + the same facts.
 *  R126-3b: the rows live in the parent's RECESSED WELL (bg-well + rim) —
 *  the deepest nesting level sinks one step DOWN from the card. */
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
  const { text, textSecondary, textTertiary } = styles;
  const statusTertiary = statusInk(session.status, textTertiary);

  return (
    <button
      type="button"
      onClick={() => onOpen(session.parentId ?? session.id, projectId)}
      aria-label={`Open parent session of sub-agent ${session.title}`}
      title={toolBreakdownTitle(session)}
      className="w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-hover"
    >
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-badge-accent px-2 py-0.5 text-[10px] font-medium text-badge-accent-fg">
          <Bot size={10} strokeWidth={2.5} aria-hidden />
          sub-agent{session.role ? ` · ${session.role}` : ""}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: text }}>
          {session.title}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide",
            statusClass(session.status),
          )}
          style={statusTertiary !== undefined ? { color: statusTertiary } : undefined}
        >
          {session.status}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-1 text-[11px] tabular-nums">
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
  );
}

/** The well that nests a parent session's delegated children (one spelling
 *  for under-parent groups AND orphan groups). */
function SubAgentWell({
  children,
  label,
}: {
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <div data-subagent-well className="ac-well ml-3 mr-1 my-1 rounded-lg p-1">
      {label ? (
        <div className="px-1.5 pb-0.5 pt-1 text-[10px] font-medium uppercase leading-none tracking-[0.08em] text-muted">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function ProjectSection({
  project,
  open,
  onToggle,
  onOpenSession,
  filter,
  styles,
}: {
  project: DetailedUsageProject;
  open: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  filter: SessionFilter;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary } = styles;
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

  // R126-3b ("Sub-agents only"): the subs filter keeps the delegating
  // parents + every sub-agent run; projects with no sub-agent traffic at
  // all are hidden (the usage.html reference's data-sf="subs" rule).
  const subsOnly = filter === "subs";
  const filteredMains = subsOnly
    ? mains.filter((m) => m.subagentCount > 0 || (subsByParent.get(m.id) ?? []).length > 0)
    : mains;
  const visibleMains = showAll || subsOnly ? filteredMains : filteredMains.slice(0, VISIBLE_SESSIONS);
  const hiddenCount = filteredMains.length - visibleMains.length;
  // Children whose parent is not among this project's mains (deleted parent,
  // cross-project delegation) still render — usage data never silently drops.
  const orphanSubs = (subsByParent.get("") ?? []).concat(
    [...subsByParent.entries()]
      .filter(([parentId]) => parentId !== "" && !mains.some((m) => m.id === parentId))
      .flatMap(([, group]) => group),
  );

  const projectId = project.synthetic ? null : project.id;

  return (
    <div className={CLAY_CARD}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`Toggle project ${project.name} sessions`}
        className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-4 text-left transition-colors duration-100 hover:bg-hover"
      >
        {/* R126-3b: the chevron ROTATES on the house spring (MOTION §4). */}
        <motion.span
          aria-hidden
          className="grid shrink-0 place-items-center"
          style={{ color: textTertiary }}
          animate={{ rotate: open ? 90 : 0 }}
          transition={SPRING}
        >
          <ChevronRight size={16} strokeWidth={2.5} />
        </motion.span>
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
              <span className="shrink-0 rounded-full bg-badge-neutral px-2 py-0.5 text-[10px] font-medium text-badge-neutral-fg">
                no project
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
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

      {/* R126-3b (MOTION §2/§4, the disclosure grammar): expand rides the
          DISCLOSURE spring (one soft settle, {180, 24}); collapse is a
          TIMING (200ms ease-out height + 150ms fade) — closing never
          bounces (the mobile R118-C law). */}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                height: { duration: DISCLOSURE_COLLAPSE_MS, ease },
                opacity: { duration: DISCLOSURE_FADE_MS, ease },
              },
            }}
            transition={DISCLOSURE_SPRING}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3.5 pt-1 sm:px-4">
              <div
                className="custom-scrollbar flex max-h-96 flex-col overflow-y-auto py-1"
                aria-label={`Sessions in ${project.name}`}
              >
                {mains.length === 0 && subs.length === 0 ? (
                  <p className="py-4 text-center text-[12px] font-medium" style={{ color: textSecondary }}>
                    No sessions recorded for this project yet.
                  </p>
                ) : (
                  <>
                    {visibleMains.map((session) => (
                      <div key={session.id} className="flex flex-col">
                        <SessionRow
                          session={session}
                          projectId={projectId}
                          onOpen={onOpenSession}
                          styles={styles}
                        />
                        {(subsByParent.get(session.id) ?? []).length > 0 ? (
                          <SubAgentWell label="Delegated sub-agents">
                            {(subsByParent.get(session.id) ?? []).map((child) => (
                              <SubAgentRow
                                key={child.id}
                                session={child}
                                projectId={projectId}
                                onOpen={onOpenSession}
                                styles={styles}
                              />
                            ))}
                          </SubAgentWell>
                        ) : null}
                      </div>
                    ))}
                    {orphanSubs.length > 0 ? (
                      <SubAgentWell label={subsOnly ? undefined : "Delegated sub-agents"}>
                        {orphanSubs.map((child) => (
                          <SubAgentRow
                            key={child.id}
                            session={child}
                            projectId={projectId}
                            onOpen={onOpenSession}
                            styles={styles}
                          />
                        ))}
                      </SubAgentWell>
                    ) : null}
                  </>
                )}
              </div>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-2 w-full cursor-pointer rounded-lg py-2 text-[12px] font-semibold tabular-nums text-accent-deep transition-colors duration-100"
                >
                  Show all {filteredMains.length} sessions
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
  const { textSecondary } = styles;
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  // "Sub-agents only" auto-opens the projects that carry sub-agent runs (the
  // usage.html reference behavior — the rows must be reachable); switching
  // back to "all" leaves them open (restore-free, predictable).
  const applyFilter = (mode: SessionFilter) => {
    setFilter(mode);
    if (mode === "subs") {
      const withSubs = new Set(
        projects
          .filter((p) => p.sessions.some((s) => s.isSubagent))
          .map((p) => p.id),
      );
      setExpandedIds((prev) => new Set([...prev, ...withSubs]));
    }
  };

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleProjects =
    filter === "subs"
      ? projects.filter((p) => p.sessions.some((s) => s.isSubagent))
      : projects;

  return (
    <section aria-label="Projects and sessions" className="mb-4 md:mb-6">
      <div className="mb-3 flex items-center justify-between">
        <Kicker as="h2" icon={FolderKanban}>
          Projects &amp; Sessions
        </Kicker>
        <span className="text-[11px] font-medium leading-none" style={{ color: textSecondary }}>
          Sub-agent runs nest under their parent
        </span>
      </div>
      {/* R126-3b: the filter pills (chip grammar — resting bg-well + rim +
          12px/600 secondary; selected = bg-accent-deep + accentText) + the
          quiet expand/collapse-all secondary buttons. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter sessions" className="flex items-center gap-1.5">
          {(
            [
              { mode: "all", label: "All sessions" },
              { mode: "subs", label: "Sub-agents only" },
            ] as const
          ).map(({ mode, label }) => {
            const active = filter === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => applyFilter(mode)}
                aria-pressed={active}
                className={cn(
                  "h-7 cursor-pointer rounded-full border px-3 text-[12px] font-semibold transition-colors duration-100",
                  active
                    ? "border-transparent bg-accent-deep"
                    : "border-clay-rim bg-well text-muted hover:bg-hover",
                )}
                style={active ? { color: styles.accentText } : undefined}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setExpandedIds(new Set(projects.map((p) => p.id)))}
            aria-label="Expand all projects"
            className="h-7 cursor-pointer rounded-lg border border-line-strong px-2.5 text-[12px] font-medium text-muted transition-colors duration-100 hover:bg-subtle active:scale-[0.98]"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setExpandedIds(new Set())}
            aria-label="Collapse all projects"
            className="h-7 cursor-pointer rounded-lg border border-line-strong px-2.5 text-[12px] font-medium text-muted transition-colors duration-100 hover:bg-subtle active:scale-[0.98]"
          >
            Collapse all
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {visibleProjects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            open={expandedIds.has(project.id)}
            onToggle={() => toggle(project.id)}
            onOpenSession={onOpenSession}
            filter={filter}
            styles={styles}
          />
        ))}
      </div>
    </section>
  );
}
