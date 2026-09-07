/**
 * ROUND-75 (R75): the TRANSIENT-API retry ladder — the owner's spec,
 * verbatim:
 *
 *   "If it fails, it will retry automatically. If it fails again
 *    immediately afterwards, it will set up a timer… 1.5 minutes. After
 *    that, if it fails again, it will wait longer… 5 minutes. After 5
 *    minutes, if it fails again to continue, it will wait for 10 minutes.
 *    Even if it fails after 10 minutes, it will do one final attempt. It
 *    will wait for 30 minutes, and if it fails after 30 minutes too, it
 *    will stop, notify the user, and show the error message… When it fails
 *    in situations like these due to timeout or due to some rate limit or
 *    something like that, it would do this. If it is some other kind of
 *    issue… then it will not do this auto retry logic."
 *
 * LADDER = [immediate, 1.5 min, 5 min, 10 min, 30 min] — five retries after
 * the initial attempt, SIX attempts total; the sixth failure is terminal
 * (persistTurnError + the task_failed notification + the honest error
 * card, all reused from the R43/R71 paths). WHICH failures ladder is
 * decided by the caller (agents/error-classification.ts's transient split:
 * rate_limit / network / timeout — never auth, never overflow, never
 * unknown); this module is PURE TIMING + REGISTRY, with no dependency on
 * the classification (and vice versa — the two modules compose at the
 * single call site in runtime.ts's two catch blocks).
 *
 * Composition with the existing layers (each stays exactly as it was):
 *   · Inner: the AI SDK's own maxRetries: 4 (seconds-scale, 429/5xx) —
 *     invisible intermediate retries, unchanged.
 *   · Overflow recovery (R71-e2 D5): compaction + one retry — unchanged,
 *     and deliberately checked BEFORE the ladder (a context overflow is
 *     not transient; waiting cannot fix it).
 *   · This ladder: the outer, patient layer for genuinely transient
 *     provider trouble.
 *
 * The wait is ABORT-AWARE (a user Stop during a 30-minute wait aborts
 * immediately — the turn then routes through the normal ABORTED path) and
 * TICKS (a callback every RETRY_TICK_MS so the SSE stream emits a
 * meta.retry heartbeat: the connection stays alive through the silence
 * AND the UI's countdown refreshes).
 *
 * The ACTIVE-WAIT REGISTRY exists for the sub-agent supervisor (R52-b):
 * its stall watchdog aborts children with no persisted events for
 * childStallTimeoutMs (default 5 min) — a child legitimately sitting in a
 * 30-minute retry wait would otherwise be stall-killed at minute 5. The
 * catch registers the wait before sleeping and clears it after; the
 * watchdog consults getActiveRetryWait(childId) and treats a registered
 * wait as "alive, waiting" instead of "stalled".
 *
 * Pure-ish module: timers + an in-process Map; no DB, no I/O, never
 * throws, never rejects.
 */

/**
 * The owner's wait schedule, indexed by retry number (1-based): the first
 * retry is immediate (0 ms), then 90 s, 5 min, 10 min, and a final 30 min.
 * RETRY_LADDER_MS.length = 5 retries → RETRY_TOTAL_ATTEMPTS = 6 attempts.
 */
export const RETRY_LADDER_MS: readonly number[] = [
  0,
  90_000,
  300_000,
  600_000,
  1_800_000,
];

/** Total provider attempts per turn: the initial call + every ladder rung. */
export const RETRY_TOTAL_ATTEMPTS: number = RETRY_LADDER_MS.length + 1;

/**
 * Heartbeat cadence during a wait: one onTick every 60 s (the SSE
 * meta.retry frame refresh — keep-alive + live countdown). Shorter than
 * the shortest non-zero rung (90 s) so even the 1.5-minute wait gets one
 * tick; never fires past the deadline.
 */
export const RETRY_TICK_MS = 60_000;

/** The wait completed (the deadline passed) / was cut short (aborted). */
export type RetryWaitOutcome = "completed" | "aborted";

/**
 * Wait `waitMs`, honoring an optional AbortSignal and ticking a callback
 * with the remaining time. Never rejects; resolves "aborted" the moment
 * the signal fires (or is already fired). The deadline timer is exact —
 * ticks are best-effort refreshes and never extend the wait.
 */
export function waitForRetry(args: {
  waitMs: number;
  signal?: AbortSignal;
  /** Tick cadence; default RETRY_TICK_MS. Clamped to the wait length. */
  tickMs?: number;
  /** Called on every tick with the remaining ms (> 0). Never after the end. */
  onTick?: (remainingMs: number) => void;
}): Promise<RetryWaitOutcome> {
  const { waitMs, signal, onTick } = args;
  const tickMs = args.tickMs ?? RETRY_TICK_MS;
  if (waitMs <= 0) {
    return Promise.resolve(signal?.aborted === true ? "aborted" : "completed");
  }
  return new Promise<RetryWaitOutcome>((resolve) => {
    let settled = false;
    // Both timer kinds share Node's Timeout type; clearTimeout clears either
    // (the one cleanup list keeps finish() free of declaration-order traps).
    const timers: NodeJS.Timeout[] = [];
    const finish = (outcome: RetryWaitOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish("aborted");
    if (signal?.aborted === true) {
      finish("aborted");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = Date.now() + waitMs;
    timers.push(setTimeout(() => finish("completed"), waitMs));
    if (onTick !== undefined && tickMs > 0 && tickMs < waitMs) {
      timers.push(
        setInterval(() => {
          const remaining = deadline - Date.now();
          if (remaining > 0) onTick(remaining);
        }, tickMs),
      );
    }
  });
}

/* ── The active-wait registry (supervisor interplay) ───────────────────────── */

export interface ActiveRetryWait {
  sessionId: string;
  /** The upcoming attempt number (2..RETRY_TOTAL_ATTEMPTS). */
  attempt: number;
  totalAttempts: number;
  /** The full rung length (ms) — informational for the watchdog frame. */
  waitMs: number;
  /** Epoch ms when the wait started. */
  startedAt: number;
  /** Epoch ms when the retry fires. */
  until: number;
}

/**
 * In-process map of sessions currently sitting in a retry wait. Module-
 * level (one sidecar process = one registry, the turn-registry pattern).
 * Best-effort bookkeeping: register/clear bracket every wait; a missed
 * clear (process crash) is impossible to observe by definition.
 */
const activeRetryWaits = new Map<string, ActiveRetryWait>();

/** Register a wait (called just before waitForRetry; overwrite = fine). */
export function registerActiveRetryWait(entry: ActiveRetryWait): void {
  activeRetryWaits.set(entry.sessionId, entry);
}

/** Clear the wait (called after waitForRetry settles — success, abort, or
 * terminal). Idempotent. */
export function clearActiveRetryWait(sessionId: string): void {
  activeRetryWaits.delete(sessionId);
}

/** The live wait for a session, when one exists (the watchdog consults this). */
export function getActiveRetryWait(sessionId: string): ActiveRetryWait | undefined {
  return activeRetryWaits.get(sessionId);
}

/* ── Formatting (the human lines the frames carry) ─────────────────────────── */

/**
 * A wait length as the owner phrases them: "immediately", "1.5 min",
 * "5 min", "10 min", "30 min" (sub-minute waits render as whole seconds).
 * Used by the meta.retry frame's message and the terminal error line.
 */
export function formatRetryWaitMs(ms: number): string {
  if (ms <= 0) return "immediately";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} min`;
  return `${minutes.toFixed(1)} min`;
}
