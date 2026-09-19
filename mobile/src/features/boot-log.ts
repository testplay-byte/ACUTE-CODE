/**
 * boot-log — the app's startup breadcrumb trail (R108).
 *
 * THE PROBLEM IT SOLVES: v0.103.0 sat on the splash logo forever on the
 * owner's phone, and the only diagnosable surface was "it's stuck" — no
 * stage trail, no error text, nothing on the device and nothing obvious in
 * logcat. This module makes every future boot SELF-EVIDENCING, in three
 * layers:
 *
 *   1. STAGES — bootLog("stage-name") appends a timestamped breadcrumb that
 *      BOTH prints to logcat (console.log → the ReactNativeJS tag — see the
 *      Android Studio filter in mobile/README.md) AND stays in memory, so
 *      the on-device error screen can show exactly how far the boot got.
 *
 *   2. GLOBAL ERRORS — installBootErrorHandling() wires the fatal-JS-error
 *      hook (ErrorUtils.setGlobalHandler) so an uncaught exception logs its
 *      full message + stack under an unmissable [ACUTE-BOOT] ERROR line and
 *      is remembered for the error screen (the boundary catches render
 *      errors; this catches everything else, e.g. module-eval throws).
 *
 *   3. AN ACCESSIBLE RECORD — getBootTrace()/getBootError() hand the trail
 *      to whoever renders the failure surface, and the ERROR line is kept
 *      as a plain string (message + stack) that survives being copied out
 *      of a screenshot.
 *
 * Pure TS + one Platform check — no native surface, jest-testable as-is.
 */

import { Platform } from "react-native";

export interface BootStage {
  /** The stage's stable name (e.g. "js-entry", "theme-resolved"). */
  stage: string;
  /** Milliseconds since the FIRST recorded stage (t=0 = first bootLog call). */
  at: number;
  /** Optional one-line detail (e.g. a resolved value or a failure note). */
  detail?: string;
}

/** The in-memory trail (bounded — a boot either finishes or dies young). */
const MAX_STAGES = 64;
const stages: BootStage[] = [];
let t0: number | null = null;

/** The last fatal error, formatted for display ([ACUTE-BOOT] ERROR verbatim). */
let bootError: string | null = null;

function now(): number {
  return Date.now();
}

/** The logcat-forwarding print. On RN, console.log lands under the
 *  ReactNativeJS tag — the one the Android Studio filter keys on. In tests
 *  (no RN runtime) the same lines ride the jest console. */
function emit(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/**
 * Record a boot stage. Order is the trail; the FIRST call pins t=0 so the
 * deltas read as "how long between stages", not wall-clock noise.
 */
export function bootLog(stage: string, detail?: string): void {
  if (t0 === null) t0 = now();
  const entry: BootStage = { stage, at: now() - t0, detail };
  stages.push(entry);
  if (stages.length > MAX_STAGES) stages.shift();
  const suffix = detail !== undefined ? ` — ${detail}` : "";
  emit(`[ACUTE-BOOT] ${stage}${suffix}`);
}

/** The trail, formatted one-line-per-stage for the error screen. */
export function getBootTrace(): string {
  return stages.map((s) => `${s.at}ms ${s.stage}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
}

/** The recorded stages as data (tests + the copy-to-clipboard affordance). */
export function getBootStages(): readonly BootStage[] {
  return stages;
}

/** The last fatal error as a display string (message + stack), or null. */
export function getBootError(): string | null {
  return bootError;
}

/** Format an unknown thrown value the honest way (Error → message+stack). */
export function formatThrown(error: unknown): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack : "(no stack)";
    return `${error.name}: ${error.message}\n${stack}`;
  }
  return String(error);
}

/** Record + print a fatal boot error (called by the global handler AND the
 *  error boundary — whichever sees it first wins, the record is shared). */
export function recordBootError(error: unknown): void {
  bootError = formatThrown(error);
  emit(`[ACUTE-BOOT] ERROR ${bootError}`);
}

/**
 * Wire the global fatal-error hook. Idempotent (double-install just re-wires
 * the same closure — the previous handler chains through so dev-mode red
 * boxes still work).
 *
 * Declared `let` because the shape of ErrorUtils is ambient RN — declared
 * loosely enough that both the app and jest (no ErrorUtils) compile clean.
 */
let installed = false;
export function installBootErrorHandling(): void {
  if (installed) return;
  installed = true;
  const globalAny = globalThis as unknown as {
    ErrorUtils?: {
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
    };
  };
  const errorUtils = globalAny.ErrorUtils;
  if (!errorUtils || typeof errorUtils.setGlobalHandler !== "function") {
    // No RN ErrorUtils (jest, web) — nothing to wire.
    bootLog("boot-error-hook-unavailable");
    return;
  }
  const previous = typeof errorUtils.getGlobalHandler === "function"
    ? errorUtils.getGlobalHandler()
    : undefined;
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    recordBootError(error);
    // Chain the prior handler (dev-mode red box / crash reporting) — ours is
    // the recorder, not the replacement.
    if (previous) {
      try {
        previous(error, isFatal);
      } catch {
        // A broken previous handler must not mask the record we just made.
      }
    }
  });
  bootLog("boot-error-hook-installed");
}

/** TEST-ONLY: wipe the module-level state (the install guard + trail + error
 *  record) so each test starts from a clean boot. Never called by the app. */
export function _resetBootLogForTests(): void {
  installed = false;
  stages.length = 0;
  t0 = null;
  bootError = null;
}

/** The logcat identity line — printed once at boot so every filtered session
 *  opens with the app's version + platform (the "what am I even looking at"). */
export function bootIdentity(): string {
  const os = Platform.OS;
  const version = Platform.Version;
  return `${os} ${typeof version === "number" ? `API ${version}` : String(version)}`;
}
