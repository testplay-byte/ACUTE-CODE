import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bug, ChevronDown, LoaderCircle } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";

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
 *
 * R126-3h (the flagged-debt ledger — 3d-2's caveat, TOKENS §11 status
 * grammar): the ERROR card's amber materials (the withAlpha(AMBER, 0.4)
 * border + the subtle fill + the flat-hue amber text) are RETIRED — the
 * error container is the §11 WARNING badge tone (bg-badge-warning + its fg
 * pair, the queue-kept notice spelling) with warning-deep ink on the icon /
 * title / status / alert line; the resting card is the WELL container
 * (.ac-well — surfaceWell + the clay rim, TOKENS §10). The status line rides
 * the deep tiers (streaming → running-deep, done → success-deep, error →
 * warning-deep). The Copy footer is the OUTLINED-SECONDARY action
 * (border-line-strong + text-muted + hover wash — COMPONENTS §4). The
 * SEMANTIC_COLORS amber import + withAlpha are gone (flat hues are
 * dots-only, and this card has no dot).
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

/** R126-3h: the status line's deep-tier ink (TOKENS §11 — text, never a
 * flat hue): streaming → running, done → success, error → warning. */
function statusToneClass(state: "streaming" | "done" | "error"): string {
  if (state === "streaming") return "text-running-deep";
  if (state === "error") return "text-warning-deep";
  return "text-success-deep";
}

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

  // The copy footer needs the DONE report's text (never streaming/error).
  const copyText = buildDebugReportCopyText(report);

  return (
    <div
      data-testid="debug-report-card"
      // R100-D: 14px arbitrary radius → rounded-xl (the 12px card step).
      // R126-3h: the container is the WELL at rest (border-clay-rim +
      // bg-well, TOKENS §10 — the subtle fill + borderSubtle legs are
      // retired) and the §11 WARNING badge tone on error (the
      // withAlpha(AMBER, 0.4) border dies).
      className={cn(
        "rounded-xl border overflow-hidden",
        isError ? "border-transparent bg-badge-warning text-badge-warning-fg" : "border-clay-rim bg-well",
      )}
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
        // R100-D (TOKENS §6): the hover wash is the CSS class (hover:bg-hover
        // — the CSS-var leg; no JS hover painting).
        className="w-full text-left px-3.5 py-2.5 flex items-center gap-2.5 flex-wrap min-w-0 transition-colors hover:bg-hover"
      >
        <Bug
          size={14}
          // R126-3h: error → the warning-deep ink tier (the flat AMBER leg
          // dies); resting → the muted secondary ink.
          className={cn("shrink-0", isError ? "text-warning-deep" : "text-muted")}
          aria-hidden
        />
        {/* R100-D (weight law): the card title is 600 (bold is wizard
            display only). R126-3h: error → warning-deep; resting → muted. */}
        <span
          className={cn("text-[12px] font-semibold shrink-0", isError ? "text-warning-deep" : "text-muted")}
        >
          Debug report
        </span>
        {report.model ? (
          <span
            // R100-D: 10.5→10px mono (the meta-mono tier). R126-3h: the chip
            // rides the class legs (bg-card + text-muted).
            className="font-mono text-[10px] px-1.5 py-0.5 rounded-md shrink-0 max-w-[240px] truncate bg-card text-muted"
            title={report.model}
          >
            {report.model}
          </span>
        ) : null}
        <span
          className="text-[10px] min-w-0 truncate"
          style={{ color: styles.textTertiary }}
          title="Produced by a separate context-free analyst after the turn completed"
        >
          context-free analyst
        </span>
        <span
          data-testid="debug-report-status"
          // R126-3h: the status text rides the §11 deep tiers (the flat
          // tertiary/amber ink legs are retired).
          className={cn(
            "ml-auto shrink-0 flex items-center gap-1.5 text-[10px] font-medium",
            statusToneClass(report.state),
          )}
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
                  // R100-D: 11.5→12px (the no-half-pixel snap).
                  // R126-3h: the honest failure line rides the warning-deep
                  // tier (the withAlpha(AMBER) flat-hue text dies).
                  className="text-[12px] leading-[1.5] break-words text-warning-deep"
                  role="alert"
                >
                  {report.error ?? "The debug analyst failed to produce a report."}
                </div>
              ) : report.text !== "" ? (
                <ChatMarkdown content={report.text} projectId={projectId ?? ""} />
              ) : isStreaming ? (
                // Streaming with no text yet — the loading animation is the whole
                // body (the header spinner + this quiet placeholder).
                <div className="text-[12px]" style={{ color: styles.textTertiary }}>
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
        <div className="px-3.5 py-2 flex items-center border-t border-line">
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
            // R100-D: 11.5→12px; buttons are 600 per the weight law.
            // R126-3h: the OUTLINED-SECONDARY species (border-line-strong +
            // text-muted + the CSS hover wash — the neutral border/
            // secondary ink inline pair is retired).
            className="h-7 px-2.5 rounded-lg text-[12px] font-semibold border border-line-strong text-muted transition-colors duration-100 hover:bg-subtle hover:text-ink"
          >
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
