import { Bug, LoaderCircle } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
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

export function DebugReportCard({ report, projectId }: DebugReportCardProps) {
  const styles = useThemeStyles();
  const isStreaming = report.state === "streaming";
  const isError = report.state === "error";
  const borderTone = isError ? withAlpha(AMBER, 0.4) : styles.borderSubtle;
  const titleTone = isError ? AMBER : styles.textSecondary;

  return (
    <div
      data-testid="debug-report-card"
      className="rounded-[14px] border overflow-hidden"
      style={{ borderColor: borderTone, background: styles.subtle }}
    >
      {/* Header row: the analyst mark + label + model chip + the honest
          subtitle (this analysis came from an agent that never participated
          in the conversation — no self-grading). */}
      <div className="px-3.5 py-2.5 flex items-center gap-2.5 flex-wrap min-w-0">
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
      </div>

      {/* Body: streaming → spinner row + the LIVE partial markdown (the
          owner wants to watch it stream); done → the full markdown; error →
          the honest amber line (no markdown — a failure is one line). */}
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
    </div>
  );
}
