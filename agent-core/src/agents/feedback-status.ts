/**
 * ROUND-125 (R125-B, the owner's v0.117.0 verdict): the SELF-FEEDBACK
 * STATUS registry — the machine-side state object that finally makes the
 * ledger's WRITING visible. The owner's words: "it did not actually show me
 * the processing of the feedback ledger. It did not show me the info of
 * when it was being written or other stuff like that."
 *
 * R122's design was deliberately SILENT (zero frames, zero events — the
 * separation law: ledger CONTENT must never ride a frame or enter the
 * model-facing history), and in that silence the writer became invisible:
 * the settings viewer could only see the FILE's finished state, never the
 * live act of writing. R125-B splits the difference the separation law
 * actually allows: STATUS is not CONTENT. "writing right now, phase
 * mid-turn, session X" leaks nothing the owner cannot already see on the
 * stream — so it may ride frames and a route; the entry's words never do.
 *
 * This module is the registry's whole home: a module-level singleton (ONE
 * sidecar process = ONE feedback writer at a time, de facto — the ledger's
 * own write chain serializes the appends; this registry just reports the
 * live state), pure setter functions, and a copy-returning getter.
 * Deliberately DEPENDENCY-FREE (no db, no fs) so the transitions are
 * trivially unit-pinnable — the writer (agents/feedback-writer.ts) reports
 * in, the status route (routes/feedback.ts) reads out, the mid-turn
 * checkpoint (routes/sse.ts) consults the `writing` flag before launching.
 *
 * The registry lives beside the mid-turn CHECKPOINT arm predicate
 * (shouldArmFeedbackCheckpoint) + the settle constant for the same reason:
 * both are the round's pure, side-effect-free logic, kept out of the route
 * so tests never import the whole SSE graph to pin them.
 */

/** The live writing state of the feedback reporter (one slot, whole process). */
export interface FeedbackWriterStatus {
  /** True while a reporter model call is in flight (begin → end, try/finally). */
  writing: boolean;
  /** Which phase is (or was last) writing: "turn-end" (after the terminal
   * frame) or "mid-turn" (the R125-B checkpoint while the turn is live). */
  phase: "turn-end" | "mid-turn";
  /** The session the current/last write reports on (null before any write). */
  sessionId: string | null;
  /** ISO timestamp of the current write's start (null before any write). */
  startedAt: string | null;
  /** ISO timestamp of the last COMPLETED write (success or failure). */
  lastWriteTs: string | null;
  /** "written" | "failed" — the last completed write's outcome class. */
  lastWriteOutcome: string | null;
  /** The ledger's entry count as measured right after the last successful
   * append (null when no write has succeeded yet). */
  lastEntries: number | null;
  /** The last failed write's error excerpt (null on success / before any). */
  lastError: string | null;
}

/** The initial honest state: nobody has ever written, nothing is in flight. */
const registry: FeedbackWriterStatus = {
  writing: false,
  phase: "turn-end",
  sessionId: null,
  startedAt: null,
  lastWriteTs: null,
  lastWriteOutcome: null,
  lastEntries: null,
  lastError: null,
};

/**
 * R125-B: the overlap guard's token. Each beginFeedbackWrite mints a fresh
 * run id; endFeedbackWrite only applies when its token is still current.
 * Why: the mid-turn checkpoint and the turn-end phase CAN legitimately
 * overlap (the checkpoint's model call is still running when the turn ends
 * and the turn-end phase launches). Without the guard, the checkpoint's
 * (earlier) end would flip `writing` to false while the turn-end call is
 * still in flight — a status strip would show "idle" during a real write.
 * With it, the newer write owns the registry until IT ends; the older
 * write's completion is dropped (the newer one's completion reports fresher
 * state anyway).
 */
let currentRun = 0;

/**
 * Mark a write as STARTED. Called at runFeedbackWriter's entry — before the
 * transcript build, before any early return, so even a write that fails in
 * its first breath is visible as "was writing, then failed" rather than
 * never having happened. Clears the previous run's error (a fresh write
 * starts with a clean slate; lastWrite* survive until it completes).
 * Returns the run token for the matching endFeedbackWrite call.
 */
export function beginFeedbackWrite(sessionId: string, phase: "turn-end" | "mid-turn"): number {
  currentRun += 1;
  registry.writing = true;
  registry.phase = phase;
  registry.sessionId = sessionId;
  registry.startedAt = new Date().toISOString();
  registry.lastError = null;
  return currentRun;
}

/** What endFeedbackWrite needs to know about the write's completion. */
export type FeedbackWriteOutcome =
  | { ok: true; entries: number | null }
  | { ok: false; error: string };

/**
 * Mark a write as FINISHED (success or failure). Stale tokens (a newer
 * write began in the meantime — see currentRun above) are dropped: the
 * newer write owns the registry. On success the outcome class is "written"
 * and the post-append entry count is recorded; on failure it is "failed"
 * with a length-capped error excerpt (the full text stays in stderr — the
 * registry feeds a one-line strip, never a wall).
 */
export function endFeedbackWrite(runId: number, outcome: FeedbackWriteOutcome): void {
  if (runId !== currentRun) return;
  registry.writing = false;
  registry.lastWriteTs = new Date().toISOString();
  if (outcome.ok) {
    registry.lastWriteOutcome = "written";
    registry.lastEntries = outcome.entries;
    registry.lastError = null;
  } else {
    registry.lastWriteOutcome = "failed";
    registry.lastError =
      outcome.error.length > 300 ? `${outcome.error.slice(0, 300)}…` : outcome.error;
  }
}

/**
 * Reset the LAST-WRITE fields — hooked by DELETE /feedback/file (the
 * viewer's Clear): after a wipe there is no "last entry" to point at, and
 * the strip's "Last entry … · N entries" line would describe a file that no
 * longer exists. The LIVE fields (writing/phase/sessionId/startedAt) are
 * left alone on purpose: a write in flight while the owner clears the file
 * is still in flight, and it will re-create the file with its entry when it
 * lands (the ledger's write chain serializes clear-then-append in order).
 */
export function resetFeedbackWriteStatus(): void {
  registry.lastWriteTs = null;
  registry.lastWriteOutcome = null;
  registry.lastEntries = null;
  registry.lastError = null;
}

/** Read the registry — a COPY, so callers can never mutate the live state. */
export function readFeedbackStatus(): FeedbackWriterStatus {
  return { ...registry };
}

// ── The mid-turn checkpoint's pure logic ─────────────────────────────────────
//
// R125-B (the owner's other half: "it should be able to write the
// self-feedback ledger and improve it midway too if it feels like"): while
// a turn is still streaming, a CHEAP issue heuristic watches the frames the
// route already sees and arms ONE checkpoint model call — an entry written
// MID-TURN that records what has gone wrong so far, instead of waiting for
// the turn to end (which, if the trouble kills the turn, is exactly the
// report the owner wanted but the R122 phase could only write AFTER the
// fact — and a hard crash of the route itself could lose entirely).

/** The per-frame issue counters the route's send() wrapper maintains. */
export interface FeedbackIssueCounters {
  /** tool-result frames with ok === false (failed / refused tool calls). */
  failedTools: number;
  /** approval.resolved frames with decision === "denied" (owner denials). */
  approvalDenials: number;
  /** DISTINCT retry attempts (meta.retry frames deduped by attempt number —
   * the runtime re-emits the frame on every wait TICK with the same attempt). */
  retryEvents: number;
}

/**
 * The ARM predicate — pure, so the trigger's thresholds are pinnable
 * without standing up the whole SSE route. The conditions (any ONE arms):
 *   · failedTools >= 3            — three failed tool calls in one turn is
 *                                    a tool-reliability incident, not noise;
 *   · denials >= 1 && failed >= 1 — the owner refused a call AND a call
 *                                    failed: the agent is fighting both its
 *                                    tools and its owner;
 *   · retryEvents >= 2            — the retry ladder climbed a SECOND rung:
 *                                    the first retry did not save the turn.
 * One denial alone does NOT arm (a single refusal is the owner steering,
 * routine); one retry alone does not arm (the R75 ladder's normal job).
 */
export function shouldArmFeedbackCheckpoint(counters: FeedbackIssueCounters): boolean {
  return (
    counters.failedTools >= 3 ||
    (counters.approvalDenials >= 1 && counters.failedTools >= 1) ||
    counters.retryEvents >= 2
  );
}

/**
 * The checkpoint's SETTLE window: the armed checkpoint waits this long
 * before its model call. Rationale (documented for the route): the route
 * cannot see the future, so "don't run in the last ~2 s before the stream
 * closes" is implemented as "let the checkpoint settle" — if the turn
 * finishes (or a queue-continuation turn begins) inside the window, the
 * checkpoint stands down: the turn-end entry covers that turn, and a
 * checkpoint written seconds before the summary would say nearly the same
 * thing twice at double the model cost.
 */
export const FEEDBACK_CHECKPOINT_SETTLE_MS = 2000;
