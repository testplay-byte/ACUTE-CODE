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

/* ── ROUND-80 (R80, owner: "in the settings retry customization is needed")
 * — the CUSTOMIZABLE schedule ──────────────────────────────────────────────
 *
 * The R75 ladder above is the DEFAULT schedule (the owner's original spec,
 * verbatim). R80 makes it configurable: RetrySettings (storage/settings.ts)
 * now carries maxAttempts + waitMinutes + providerTimeoutSeconds, and the
 * runtime resolves THIS module's resolveRetrySchedule() per turn from those
 * settings. The resolution is defensive-by-construction: out-of-bounds or
 * missing values fall back to the R75 defaults, so a corrupt row can never
 * produce a zero-rung or negative-wait ladder. The constants above stay as
 * the documented defaults (tests pin them; the default ladder is byte-
 * identical to pre-R80 behavior). */

/** Default total attempts (the initial call + the five default rungs). */
export const DEFAULT_RETRY_MAX_ATTEMPTS: number = 6;

/** Default rung waits in MINUTES (index = retry number - 1): the R75 spec. */
export const DEFAULT_RETRY_WAIT_MINUTES: readonly number[] = [0, 1.5, 5, 10, 30];

/** Default provider-call ceiling (10 minutes, chat.ts PROVIDER_CALL_TIMEOUT_MS). */
export const DEFAULT_PROVIDER_TIMEOUT_SECONDS: number = 600;

/** Bounds (storage + route validation + resolution all agree on these). */
export const RETRY_MAX_ATTEMPTS_BOUNDS = { min: 2, max: 10 } as const;
export const RETRY_WAIT_MINUTES_BOUNDS = { min: 0, max: 1440 } as const;
export const PROVIDER_TIMEOUT_SECONDS_BOUNDS = { min: 60, max: 3600 } as const;

/** The settings shape resolveRetrySchedule reads (RetrySettings structurally). */
export interface RetryScheduleSettings {
  maxAttempts?: number;
  waitMinutes?: number[];
  providerTimeoutSeconds?: number;
}

/** The per-turn resolved schedule the runtime's catch blocks consume. */
export interface ResolvedRetrySchedule {
  /** Rung waits in ms; length = totalAttempts - 1 (≥ 1 by bounds). */
  ladderMs: number[];
  /** Total provider attempts per turn (initial + rungs). */
  totalAttempts: number;
  /** The provider-call ceiling in ms (chat.ts input.timeoutMs). */
  timeoutMs: number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/**
 * Resolve the per-turn retry schedule from the (possibly partial/corrupt)
 * settings. Pure; never throws. Missing/out-of-bounds maxAttempts → 6;
 * each rung falls back to DEFAULT_RETRY_WAIT_MINUTES[i] (then the final
 * default rung for indexes past the default array — a 10-attempt schedule
 * extends with 30-min waits); timeout falls back to 600 s. Wait entries
 * outside [0, 1440] minutes fall back rung-by-rung (never clamp silently —
 * a 2-minute typo stays 2 minutes, an impossible value becomes the default).
 */
export function resolveRetrySchedule(settings: RetryScheduleSettings): ResolvedRetrySchedule {
  const totalAttempts = clampInteger(
    settings.maxAttempts,
    RETRY_MAX_ATTEMPTS_BOUNDS.min,
    RETRY_MAX_ATTEMPTS_BOUNDS.max,
    DEFAULT_RETRY_MAX_ATTEMPTS,
  );
  const rungCount = totalAttempts - 1;
  const source = Array.isArray(settings.waitMinutes) ? settings.waitMinutes : [];
  const ladderMs: number[] = [];
  for (let i = 0; i < rungCount; i += 1) {
    const provided = source[i];
    const fallback =
      DEFAULT_RETRY_WAIT_MINUTES[i] ??
      DEFAULT_RETRY_WAIT_MINUTES[DEFAULT_RETRY_WAIT_MINUTES.length - 1];
    const minutes =
      typeof provided === "number" &&
      Number.isFinite(provided) &&
      provided >= RETRY_WAIT_MINUTES_BOUNDS.min &&
      provided <= RETRY_WAIT_MINUTES_BOUNDS.max
        ? provided
        : fallback;
    ladderMs.push(Math.round(minutes * 60_000));
  }
  const timeoutSeconds = clampInteger(
    settings.providerTimeoutSeconds,
    PROVIDER_TIMEOUT_SECONDS_BOUNDS.min,
    PROVIDER_TIMEOUT_SECONDS_BOUNDS.max,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  );
  return { ladderMs, totalAttempts, timeoutMs: timeoutSeconds * 1000 };
}

/**
 * The human line for a resolved schedule — "immediately, 1.5 min, 5 min,
 * 10 min, 30 min" — used by the task_failed notification body (server.ts)
 * and the Settings card's footnote, so every surface phrases the schedule
 * the owner configured, never the hardcoded R75 one.
 */
export function describeRetrySchedule(schedule: ResolvedRetrySchedule): string {
  return schedule.ladderMs.map((ms) => formatRetryWaitMs(ms)).join(", ");
}

/* ── ROUND-105 (R105-C): the rate-limit REASON-aware rung floor ──────────── */

/** The QUOTA floor: a rate-limit whose REASON is "quota" (daily caps,
 * free-models-per-day, credits exhausted — see error-classification.ts)
 * cannot be healed by the default schedule's short rungs (the R105
 * free-model benchmark: OpenRouter's daily-cap 429 would ride 90 s → 5 min
 * rungs that re-burn attempts against a cap that resets at MIDNIGHT). The
 * floor jumps every quota rung to AT LEAST 10 minutes — the owner's ladder
 * itself says 10 min is the first "patient" rung — while rate/capacity/
 * unknown reasons keep the exact R75/R80 behavior (additive-only: the
 * default path is byte-identical when the reason is undefined). */
export const RATE_LIMIT_QUOTA_FLOOR_MS = 600_000;

/** The reason hint effectiveRungWaitMs takes — the classification's
 * `rateLimitReason` ("quota" | "rate" | "capacity") or undefined. */
export type RetryReasonHint = "quota" | "rate" | "capacity" | undefined;

/**
 * The reason-aware rung wait (R105-C). Pure; the runtime's two catch
 * blocks call this where they used to write `retryAfterMs ?? scheduleMs`
 * directly:
 *   · reason === "quota" → max(schedule, Retry-After, the 10-min floor) —
 *     a spent allocation is never retried early, even when the provider
 *     optimistically says "Retry-After: 5" (a daily cap has no meaningful
 *     per-request Retry-After); a LONGER provider Retry-After still wins.
 *   · any other reason (rate / capacity / undefined) → the pre-R105
 *     behavior, byte-identical: the provider's Retry-After replaces the
 *     schedule rung when present, else the schedule rung stands.
 */
export function effectiveRungWaitMs(
  scheduleMs: number,
  retryAfterMs: number | null,
  reason: RetryReasonHint,
): number {
  if (reason === "quota") {
    return Math.max(scheduleMs, retryAfterMs ?? 0, RATE_LIMIT_QUOTA_FLOOR_MS);
  }
  return retryAfterMs ?? scheduleMs;
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
