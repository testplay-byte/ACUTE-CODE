import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Globe,
  LoaderCircle,
  Monitor,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { MiniAgentAction, MiniAgentRun, MiniAgentSkillName } from "../../lib/api";
// R132-MA-ui: the disclosure grammar joins from the ONE motion palace
// (MOTION.md §2 — expand rides DISCLOSURE_SPRING {180,24}, collapse is a
// 200ms TIMING never a spring) — the same legs ToolLine/ThoughtRow ride,
// never a hand-rolled spring.
import { DISCLOSURE_SPRING } from "../../lib/motion";
import { DISCLOSURE_COLLAPSE_MS, DISCLOSURE_FADE_MS } from "../usage/usage-helpers";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { ChatMarkdown } from "./ChatMarkdown";

/**
 * MiniAgentSection (ROUND-132, R132-MA-ui — the owner's centerpiece
 * directive, verbatim): "the mini agent will live within the conversation,
 * the chat window itself. And when the mini agent is at work, a dedicated
 * section for it will appear, and its actions will be shown in there. And
 * the prompt given to it by the main agent will also be shown there, and it
 * will be handled just like a tool call, but a mini agent tool call."
 *
 * ONE component renders BOTH lives of a run, from the SAME record:
 *  · LIVE — the `{type:"mini"}` WorkingEntry the stream-store upserts from
 *    the three `mini-agent.*` SSE frames (the section opens the moment the
 *    mini starts, its action rows append as the mini works);
 *  · FOLDED — the same entry rebuilt by toProjectChatItems from the
 *    persisted `mini_agent.*` session events (the reload render).
 *
 * Anatomy (the DebugReportCard material set — the well container + the §11
 * deep-tier status inks; NO new hues, NO hardcoded hex):
 *  · header (the whole row is the collapse toggle): the skill icon + title
 *    + skill badge + the resolved model chip + the status word + chevron;
 *  · THE PROMPT the main agent gave it — always rendered (2-line clamp
 *    with expand; the owner's explicit ask);
 *  · the compact action rows — one per completed tool call, ok/fail glyph
 *    coloring, collapsible result;
 *  · the final report (terminal only, collapsible) + the steps/token
 *    footer OUTSIDE the collapse, so a collapsed section keeps its honest
 *    one-line summary;
 *  · a FAILED run shows the honest failure line (danger-deep, role=alert).
 *
 * Collapse contract (DebugReportCard's R67-B law, copied deliberately):
 * expanded while the mini RUNS (the owner watches it work), auto-collapses
 * on the running→terminal flip, a manual header tap always wins, and a
 * folded (reloaded) section mounts collapsed.
 *
 * Props-driven, NO store imports — the panel feeds this the run record
 * (live entry or folded entry); the component never fetches.
 */
export function MiniAgentSection({
  run,
  projectId,
}: {
  run: MiniAgentRun;
  /** Threaded to ChatMarkdown for path pills (the panel's project id);
   * absent → "" (path pills render but do not resolve a project). */
  projectId?: string;
}) {
  const styles = useThemeStyles();
  const isRunning = run.status === "running";
  const isFailed = run.status === "failed";

  // ── the collapse contract (see the docblock — the DebugReportCard law). ──
  const [open, setOpen] = useState(isRunning);
  const userTouched = useRef(false);
  const prevRunning = useRef(isRunning);
  useEffect(() => {
    if (!userTouched.current) {
      if (isRunning) setOpen(true); // mini at work → expanded
      else if (prevRunning.current) setOpen(false); // just finished → collapse
    }
    prevRunning.current = isRunning;
  }, [isRunning]);

  // THE PROMPT's 2-line clamp + expand (the letter's "maybe 2-line clamp
  // with expand") — the affordance renders only when the task is long
  // enough to actually clamp (~2 lines at the section's width).
  const [taskExpanded, setTaskExpanded] = useState(false);
  const taskIsLong = run.task.length > MINI_TASK_CLAMP_CHARS;

  const SkillIcon = MINI_SKILL_ICONS[run.skill] ?? Wrench;

  return (
    <div
      data-testid="mini-agent-section"
      data-mini-id={run.miniId}
      // R126-3h material set: the WELL container (border-clay-rim + bg-well,
      // TOKENS §10) — a hairline-bounded sub-region of the activity well it
      // renders in; the failed state keeps the NEUTRAL container (the §11
      // danger-deep status text carries the failure — a quiet card, the
      // failure's ink is the signal).
      className="my-1 rounded-xl border border-clay-rim bg-well overflow-hidden"
    >
      {/* ── Header row (the whole row is the collapse toggle) ── */}
      <button
        type="button"
        onClick={() => {
          userTouched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} mini agent (${run.skill}) — ${run.task.slice(0, 80)}`}
        data-testid="mini-agent-toggle"
        // R100-D (TOKENS §6): the hover wash is the CSS class (hover:bg-hover
        // — the CSS-var leg; no JS hover painting).
        className="w-full text-left px-3 py-2 flex items-center gap-2 flex-wrap min-w-0 transition-colors hover:bg-hover"
      >
        <SkillIcon size={14} className="shrink-0 text-muted" aria-hidden />
        {/* R100-D (weight law): the card title is 600 (bold is wizard
            display only); resting ink is the muted secondary tier. */}
        <span className="text-[12px] font-semibold shrink-0 text-muted">Mini agent</span>
        {/* The skill badge — the identity-chip grammar (mono, the §11
            NEUTRAL badge tone; "one tinted status chip per row" is obeyed:
            the status WORD carries no chip at all). */}
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-badge-neutral text-badge-neutral-fg">
          {run.skill}
        </span>
        {run.model ? (
          <span
            className="font-mono text-[10px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[220px] truncate bg-card text-muted"
            title={`${run.model.providerId} · ${run.model.modelId}`}
          >
            {run.model.modelId}
          </span>
        ) : null}
        <span
          data-testid="mini-agent-status"
          // R126-3h: the status text rides the §11 DEEP tiers (running →
          // running-deep, done → success-deep, failed → danger-deep).
          className={cn(
            "ml-auto shrink-0 flex items-center gap-1.5 text-[10px] font-medium",
            isFailed ? "text-danger-deep" : isRunning ? "text-running-deep" : "text-success-deep",
          )}
        >
          {isRunning ? (
            <>
              <LoaderCircle size={11} className="animate-spin" aria-hidden />
              running
            </>
          ) : isFailed ? (
            "failed"
          ) : (
            "done"
          )}
        </span>
        <ChevronDown
          size={12}
          aria-hidden
          className="shrink-0"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
      </button>

      {/* THE PROMPT the main agent gave it — ALWAYS rendered (the owner's
          exact words: "the prompt given to it by the main agent will also
          be shown there"), one clamped line OUTSIDE the collapse so a
          collapsed section still speaks its task; the body carries the
          full text (clamp + expand) when open. */}
      <div
        className="px-3 pb-1.5 min-w-0"
        data-testid="mini-agent-task-line"
        title={run.task}
      >
        <p
          className="text-[11px] leading-[1.45] break-words whitespace-pre-wrap line-clamp-1 font-mono"
          style={{ color: styles.textSecondary }}
        >
          {run.task}
        </p>
      </div>

      {/* ── Body: the prompt + the action rows + the report ── */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: DISCLOSURE_SPRING }}
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                height: { duration: DISCLOSURE_COLLAPSE_MS, ease: "easeOut" },
                opacity: { duration: DISCLOSURE_FADE_MS, ease: "easeOut" },
              },
            }}
            className="overflow-hidden"
          >
            <div data-testid="mini-agent-body" className="px-3 pb-2.5 pt-0.5 min-w-0 flex flex-col gap-2">
              {/* THE PROMPT the main agent gave it — the owner's explicit
                  ask, ALWAYS visible (the clamp is presentation, the full
                  text rides the title attr — the record never shrinks). */}
              <div className="min-w-0" data-testid="mini-agent-task">
                <span className="block text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: styles.textTertiary }}>
                  Task given by the main agent
                </span>
                <p
                  className={cn(
                    "text-[12px] leading-[1.5] break-words whitespace-pre-wrap",
                    !taskExpanded && taskIsLong && "line-clamp-2",
                  )}
                  style={{ color: styles.text }}
                  title={run.task}
                  data-mini-task-full={run.task}
                >
                  {run.task}
                </p>
                {taskIsLong ? (
                  <button
                    type="button"
                    onClick={() => setTaskExpanded((v) => !v)}
                    aria-label={taskExpanded ? "Clamp the task to two lines" : "Show the whole task"}
                    // R126-3h: the OUTLINED-SECONDARY species at micro scale
                    // (border-line-strong + text-muted + the hover wash).
                    className="mt-1 h-6 px-2 rounded-lg text-[11px] font-semibold border border-line-strong text-muted transition-colors duration-100 hover:bg-subtle hover:text-ink"
                  >
                    {taskExpanded ? "Show less" : "Show all"}
                  </button>
                ) : null}
              </div>

              {/* The compact action rows — one per COMPLETED tool call,
                  arrival order (the seq counter rides the backend's own
                  emission order; a mini loop is serial per run). */}
              {run.actions.length > 0 ? (
                <div className="min-w-0 flex flex-col gap-0.5" data-testid="mini-agent-actions">
                  {run.actions.map((action) => (
                    <MiniActionRow key={`${run.miniId}-${action.seq}`} action={action} />
                  ))}
                </div>
              ) : isRunning ? (
                // No completed action yet — the honest quiet placeholder
                // (the parent mini_agent pill's own liveness covers the
                // in-flight window; this is the section's first beat).
                <div className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                  dispatching<span className="ac-ellipsis" aria-hidden />
                </div>
              ) : null}

              {/* The final result — done renders the REPORT (markdown: the
                  mini's wrapper mandates the ## REPORT shape); failed
                  renders the honest failure line (plain text — a failure is
                  lines, not prose; danger-deep, the failed ToolLine
                  register). */}
              {run.result !== undefined && run.result !== "" ? (
                <div className="min-w-0" data-testid="mini-agent-result">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.08em] mb-0.5" style={{ color: styles.textTertiary }}>
                    {isFailed ? "Failure" : "Report"}
                  </span>
                  {isFailed ? (
                    <div className="text-[12px] leading-[1.5] break-words whitespace-pre-wrap text-danger-deep" role="alert">
                      {run.result}
                    </div>
                  ) : (
                    <div className="chat-prose min-w-0 break-words text-[12px] leading-[1.6]" style={{ color: styles.text, ["--chat-base-size" as string]: "12px" } as React.CSSProperties}>
                      <ChatMarkdown content={run.result} projectId={projectId ?? ""} />
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── FOOTER — the honest run summary, OUTSIDE the collapse (the
          DebugReportCard copy-footer placement): a collapsed section keeps
          its one-line "N steps · tokens" verdict. Running sections count
          the actions landed so far; terminal sections speak the done
          frame's own steps + usage (null usage degrades to the steps
          alone — never an invented number). ── */}
      {(() => {
        const steps = run.steps ?? run.actions.length;
        const tokens =
          run.usage !== undefined && run.usage !== null
            ? run.usage.inputTokens + run.usage.outputTokens
            : null;
        if (steps === 0 && tokens === null) return null;
        return (
          <div
            data-testid="mini-agent-footer"
            className="px-3 py-1.5 flex items-center gap-2 border-t border-line"
          >
            {/* R100-D: the stat chip grammar — mono 10px tabular, tertiary. */}
            <span className="font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
              {steps} step{steps === 1 ? "" : "s"}
              {isRunning ? " so far" : ""}
            </span>
            {tokens !== null ? (
              <span className="font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                ↑{fmtTokens(run.usage?.inputTokens ?? 0)} ↓{fmtTokens(run.usage?.outputTokens ?? 0)} tokens
              </span>
            ) : null}
          </div>
        );
      })()}
    </div>
  );
}

/** One compact action row: the ok/fail glyph (the R100-D every-glyph-an-
 * icon law — CircleCheck/CircleX in the semantic colors, aria-hidden) +
 * the tool name + argsSummary on ONE mono line, with the (capped-by-the-
 * backend) output summary behind the row's own disclosure when present. */
function MiniActionRow({ action }: { action: MiniAgentAction }) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const hasOutput = action.outputSummary !== null && action.outputSummary !== "";
  return (
    <div className="min-w-0" data-testid="mini-agent-action-row">
      <button
        type="button"
        onClick={() => (hasOutput ? setOpen((v) => !v) : undefined)}
        aria-expanded={hasOutput ? open : undefined}
        aria-label={`${action.ok ? "succeeded" : "failed"}: ${action.tool} ${action.argsSummary}`}
        className={cn(
          "w-full flex items-center gap-1.5 h-6 px-1 rounded-md text-left min-w-0",
          hasOutput ? "hover:bg-hover" : "cursor-default",
        )}
      >
        {action.ok ? (
          <CircleCheck size={10} className="shrink-0 text-success-deep" aria-hidden />
        ) : (
          <CircleX size={10} className="shrink-0 text-danger-deep" aria-hidden />
        )}
        <span className="shrink-0 font-mono text-[11px] font-medium" style={{ color: styles.textSecondary }}>
          {action.tool}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          style={{ color: styles.textTertiary }}
          title={action.argsSummary}
        >
          {action.argsSummary}
        </span>
        {hasOutput ? (
          <ChevronDown
            size={10}
            aria-hidden
            className="shrink-0"
            style={{ color: styles.textTertiary, transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasOutput ? (
          <motion.div
            key="out"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: DISCLOSURE_SPRING }}
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                height: { duration: DISCLOSURE_COLLAPSE_MS, ease: "easeOut" },
                opacity: { duration: DISCLOSURE_FADE_MS, ease: "easeOut" },
              },
            }}
            className="overflow-hidden"
          >
            {/* The backend caps output summaries at 400 chars — the honest
                ceiling renders whole, mono (the quiet row register). */}
            <div className="pl-4 pr-1 pb-1 font-mono text-[10px] leading-[1.5] break-words whitespace-pre-wrap" style={{ color: styles.textTertiary }}>
              {action.outputSummary}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The skill icons — one glyph per specialization (the section's ONE mark;
 * no family colors, the muted resting ink DebugReportCard's icon rides). */
const MINI_SKILL_ICONS: Record<MiniAgentSkillName, LucideIcon> = {
  browser: Globe,
  computer: Monitor,
  search: Search,
  custom: Wrench,
};

/** ~2 lines of task text at the section's 12px width — past this the clamp
 * engages and the Show-all affordance renders (presentation only; the full
 * task always rides the title attribute + the expand). */
const MINI_TASK_CLAMP_CHARS = 120;

/** Compact token count (the SubAgentCard rows' formatting). */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
