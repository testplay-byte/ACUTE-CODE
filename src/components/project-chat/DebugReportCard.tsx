import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bug, ChevronDown, LoaderCircle } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-66 (R66-2-c, the owner's C1 directive): the DEDICATED debug-report
 * section rendered at the very bottom of a turn's response. The report comes
 * from the ROUTE-SIDE context-free debug analyst (agent-core's
 * agents/debug-analyst.ts): after the turn completes, a completely fresh
 * model call receives the session's whole transcript (user request, every
 * tool call with its COMPLETE result, errors) and streams this analysis
 * live. Kept separate from the answer by construction — the persisted
 * `debug.report` event is skipped by the model-facing history so a follow-up
 * user message NEVER includes it.
 *
 * ROUND-67 (R67-B, owner directives): the card now COLLAPSES itself.
 * Owner spec: "While it is typing it will show it properly but when it has
 * properly typed it will collapse. It will collapse the debug report menu
 * by itself." → the WORKING-section ThoughtRow contract, applied here:
 * expanded while the analyst streams, auto-collapses on the streaming→done
 * flip, a manual header tap ALWAYS wins over the automation, and a folded
 * (reloaded) card mounts collapsed. Plus a "Copy report" button at the very
 * bottom of the card (the owner's "There was no copy option for the debug
 * report" complaint) that writes a clipboard payload carrying the model +
 * the full report text, so the copy "properly shows the details, like which
 * model was being used" even when the card is minimized.
 *
 * Props-driven, NO store imports: the chat panel feeds this either the LIVE
 * stream state (stream-store's liveTurn.debugReport: streaming text while
 * the analyst works) or the FOLDED shape (AssistantTurnItem.debugReport,
 * state "done"). The folded turn renders the same card with state done.
 */
export interface DebugReportCardProps {
  report: {
    /** streaming = the analyst is working (spinner + live partial text);
     * done = the full report; error = the honest failure line. */
    state: "streaming" | "done" | "error";
    /** The report text (partial while streaming, full when done; "" on error). */
    text: string;
    /** The model that produced the analysis (chip in the header). */
    model?: string;
    /** state "error" only — the honest reason the analyst failed. */
    error?: string;
  };
  /** Threaded to ChatMarkdown for path pills (the panel's project id);
   * absent → "" (path pills render but do not resolve a project). */
  projectId?: string;
}

/** The amber status color — the SEMANTIC_COLORS exception pattern: a
 * documented cross-theme token (the debug analyst's failure is a warning,
 * not the red of a failed turn — the turn itself succeeded). */
const AMBER = "#d97706";

/**
 * ROUND-67 (R67-B): the clipboard payload for the "Copy report" button.
 * The header line pins WHICH model produced the analysis (the owner's "make
 * sure the debug report will properly show the details, like which model
 * was being used… when I copy it directly"), then the full report body —
 * the same markdown the card renders, untruncated by the collapsed state.
 * Exported so the tests pin the exact format.
 */
export function buildDebugReportCopyText(report: DebugReportCardProps["report"]): string {
  if (report.state !== "done" || report.text === "") return "";
  return `Debug report — model: ${report.model ?? "unknown"}\n\n${report.text}`;
}

export function DebugReportCard({ report, projectId }: DebugReportCardProps) {
  const styles = useThemeStyles();
  const resetAfter = useTimeoutClear();
  const [copied, setCopied] = useState(false);
  const isStreaming = report.state === "streaming";
  const isError = report.state === "error";

  // ── ROUND-67 (R67-B): the collapse contract (WorkingSection's ThoughtRow
  // pattern, copied deliberately): open defaults to the streaming state, a
  // streaming→done flip auto-collapses, and a userTouched ref pins every
  // manual header tap over the automation forever after.
  const [open, setOpen] = useState(isStreaming);
  const userTouched = useRef(false);
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (!userTouched.current) {
      if (isStreaming) setOpen(true); // analyst working → expanded
      else if (prevStreaming.current) setOpen(false); // just finished → collapse
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  const borderTone = isError ? withAlpha(AMBER, 0.4) : styles.borderSubtle;
  const titleTone = isError ? AMBER : styles.textSecondary;
  // The copy footer needs the DONE report's text (never streaming/error).
  const copyText = buildDebugReportCopyText(report);

  return (
    <div
      data-testid="debug-report-card"
      className="rounded-[14px] border overflow-hidden"
      style={{ borderColor: borderTone, background: styles.subtle }}
    >
      {/* Header row (ROUND-67 R67-B: the whole row is the collapse toggle):
          the analyst mark + label + model chip + the honest subtitle (this
          analysis came from an agent that never participated in the
          conversation — no self-grading) + the status + the chevron. */}
      <button
        type="button"
        onClick={() => {
          userTouched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} debug report`}
        data-testid="debug-report-toggle"
        className="w-full text-left px-3.5 py-2.5 flex items-center gap-2.5 flex-wrap min-w-0 transition-colors"
        onMouseEnter={(e) => {
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Bug
          size={14}
          className="shrink-0"
          style={{ color: isError ? AMBER : styles.textTertiary }}
          aria-hidden
        />
        <span className="text-[12px] font-bold shrink-0" style={{ color: titleTone }}>
          Debug report
        </span>
        {report.model ? (
          <span
            className="font-mono text-[10.5px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[240px] truncate"
            style={{ background: styles.card, color: styles.textTertiary }}
            title={report.model}
          >
            {report.model}
          </span>
        ) : null}
        <span
          className="text-[10.5px] min-w-0 truncate"
          style={{ color: styles.textTertiary }}
          title="Produced by a separate context-free analyst after the turn completed"
        >
          context-free analyst
        </span>
        <span
          data-testid="debug-report-status"
          className="ml-auto shrink-0 flex items-center gap-1.5 text-[10.5px] font-semibold"
          style={{ color: isError ? AMBER : styles.textTertiary }}
        >
          {isStreaming ? (
            <>
              <LoaderCircle size={11} className="animate-spin" aria-hidden />
              Analyzing the last execution…
            </>
          ) : isError ? (
            "Analysis failed"
          ) : (
            "Done"
          )}
        </span>
        <ChevronDown
          size={12}
          aria-hidden
          className="shrink-0"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
        />
      </button>

      {/* Body: streaming → spinner row + the LIVE partial markdown (the
          owner wants to watch it stream); done → the full markdown; error →
          the honest amber line (no markdown — a failure is one line).
          ROUND-67 (R67-B): the whole body rides the AnimatePresence height
          collapse so the card minimizes itself when the analyst finishes. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div data-testid="debug-report-body" className="px-3.5 pb-3 pt-0.5 min-w-0">
              {isError ? (
                <div
                  className="text-[11.5px] leading-[1.5] break-words"
                  style={{ color: withAlpha(AMBER, styles.isDark ? 0.95 : 0.9) }}
                  role="alert"
                >
                  {report.error ?? "The debug analyst failed to produce a report."}
                </div>
              ) : report.text !== "" ? (
                <ChatMarkdown content={report.text} projectId={projectId ?? ""} />
              ) : isStreaming ? (
                // Streaming with no text yet — the loading animation is the whole
                // body (the header spinner + this quiet placeholder).
                <div className="text-[11.5px]" style={{ color: styles.textTertiary }}>
                  Analyzing the last execution…
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FOOTER — ROUND-67 (R67-B, owner: "There should be a proper copy
          button at the very bottom of the debug report"): rendered whenever
          a DONE report exists, OUTSIDE the collapse, so the copy works with
          the card minimized (the collapsed card = header + this row).
          Styling mirrors TurnErrorCard's "Copy details" (the h-7 px-2.5
          bordered pill) with the 1200ms copied→"Copied" flash. */}
      {report.state === "done" && report.text !== "" ? (
        <div
          className="px-3.5 py-2 flex items-center border-t"
          style={{ borderColor: borderTone }}
        >
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(copyText).then(() => {
                setCopied(true);
                resetAfter(() => setCopied(false), 1200);
              });
            }}
            aria-label="Copy debug report"
            data-testid="debug-report-copy"
            className="h-7 px-2.5 rounded-lg text-[11.5px] font-semibold border transition-colors"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
