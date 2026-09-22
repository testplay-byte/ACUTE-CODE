/**
 * ROUND-117 (R117-e, the error-hardening round): PROCESS-LEVEL CRASH
 * HANDLERS — `uncaughtException` + `unhandledRejection` for the sidecar.
 *
 * Pre-R117 the sidecar ran with NO handlers: a stray throw outside a route
 * (a busted timer callback, an un-awaited promise in a plugin, an EPIPE on
 * some future surface) killed the process with Node's default spew — no
 * ring entry, no honest sidecar.log line, and the Rust shell saw an opaque
 * death. The designed recovery ALREADY exists: the boot sweep
 * (Orchestrator.sweepStaleRunning) flips crash-orphaned `running` sessions
 * to failed at the next start, so a CONTROLLED exit code 1 beats a zombie
 * half-alive process every time.
 *
 * Semantics (per the R117-e brief):
 *   - write the error — SCRUBBED of secret shapes — to the diagnostics ring
 *     (best-effort: the in-memory ring dies with the process; the durable
 *     half is the sidecar.log line) AND to sidecar.log via console.error
 *     (the Rust shell pipes stderr there);
 *   - then a CONTROLLED exit(1). A clean death > a zombie.
 *   - double-fire guard: once the exit is in flight, later crashes during
 *     teardown are ignored (the first error is the signal; the rest are
 *     cascade noise).
 *
 * TESTING SHAPE: installCrashHandlers(deps, target?) — every effect is
 * INJECTED (the sink, the log, the exit fn) and the signal target defaults
 * to `process` but accepts any `{ on(event, listener) }` object, so the
 * unit suite drives the registered listeners directly without touching the
 * real process.
 */
import { scrubSecretShapes } from "./secret-shapes.js";

/** The injectable effects — production passes the real ring sink + stderr +
 * process.exit; tests pass spies. */
export interface CrashHandlerDeps {
  /** Best-effort diagnostics-ring write (the registration side in server.ts
   * re-scrubs + re-caps — this scrub is the belt for the log line). */
  record: (message: string) => void;
  /** The sidecar.log channel (console.error in production). */
  log: (...args: unknown[]) => void;
  /** The controlled exit. */
  exit: (code: number) => void;
}

/** Minimal signal-target surface (`process` satisfies it; tests fake it). */
export interface CrashSignalTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** The marker prefixed to every crash record so the log line is greppable. */
export const CRASH_LOG_PREFIX = "[crash]";

/**
 * Scrub secret shapes from crash text. Composition of the two existing
 * scrubbers the codebase already trusts: the R82 shared key-shape module
 * (sk-…/github_pat_…/nvapi-… — lib/secret-shapes.ts) + the Bearer-token
 * pattern from the ring's own scrubDiagnosticText (server.ts). The ring
 * re-scrubs + caps at registration; sidecar.log gets its text only from
 * HERE, so no length cap — the full stack is the post-mortem gold.
 */
export function scrubCrashText(text: string): string {
  const bearerScrubbed = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***");
  return scrubSecretShapes(bearerScrubbed);
}

/** Format an arbitrary thrown value for the record: name + message + stack
 * for Errors (the stack is the post-mortem gold), JSON/toString otherwise. */
export function formatCrashError(error: unknown): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" && error.stack.length > 0 ? `\n${error.stack}` : "";
    return `${error.name}: ${error.message}${stack}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Install the crash handlers on `target` (default: the real process). Both
 * uncaughtException and unhandledRejection get the SAME treatment — record
 * (scrubbed) + log + controlled exit(1) — and the double-fire flag makes the
 * exit-once guarantee explicit.
 */
export function installCrashHandlers(deps: CrashHandlerDeps, target: CrashSignalTarget = process): void {
  let exiting = false;
  const handle = (kind: "uncaughtException" | "unhandledRejection", error: unknown): void => {
    if (exiting) return; // double-fire guard — the exit is already in flight
    exiting = true;
    const message = scrubCrashText(formatCrashError(error));
    const line = `${CRASH_LOG_PREFIX} ${kind}: ${message}`;
    try {
      deps.record(line);
    } catch {
      // The ring is best-effort — the log + exit below are the durable half.
    }
    deps.log(line);
    deps.exit(1);
  };
  target.on("uncaughtException", (error) => handle("uncaughtException", error));
  target.on("unhandledRejection", (reason) => handle("unhandledRejection", reason));
}
