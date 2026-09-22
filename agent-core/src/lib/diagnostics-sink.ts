/**
 * ROUND-117 (R117-e, the error-hardening round): the DIAGNOSTIC SINK — the
 * seam that lets NON-HTTP capture points write into the current server's
 * diagnostics error ring (routes/context.ts's SidecarDiagnosticError ring,
 * served by GET /diagnostics/errors to the in-app Console tab).
 *
 * WHY a seam instead of an export from server.ts: every prospective caller
 * lives BELOW the server in the import graph (agents/chat.ts folds tool
 * results, lib/notification-bus.ts fans notifications, the crash handlers in
 * lib/crash-handlers.ts run before/without a server) — and server.ts already
 * value-imports chat.ts and notification-bus.ts, so those modules importing
 * a value back from server.ts would create true ESM cycles. The pattern
 * mirrors the process-wide singleton buses (events-bus, notification-bus):
 * buildServer REGISTERS its per-instance ring here (the last build wins,
 * exactly like the singleton buses' "one sidecar = one bus"); every capture
 * point imports the pure `recordDiagnostic` leaf — this module imports
 * NOTHING at runtime.
 *
 * Contract:
 *   - Before any server builds (CLI boot, hermetic tests, a crash during
 *     startup) recordDiagnostic is a NO-OP — no ring exists to serve it.
 *   - The sink call itself never throws into the caller (a diagnostics
 *     failure must never crash the code path being diagnosed).
 *   - Scrubbing + length capping happen at the REGISTRATION side (server.ts
 *     reuses scrubDiagnosticText, the same scrubber the HTTP recorder uses),
 *     so every entry in the ring is uniformly safe regardless of origin.
 */

/** One non-HTTP diagnostic report. `kind` names the capture point
 * ("crash" | "notification" | "tool-shape" | …) — the Console row's chip. */
export interface DiagnosticSinkInput {
  kind: string;
  message: string;
  /** Envelope code — defaults to "INTERNAL" at the registration side. */
  code?: string;
  /** Defaults to 500 at the registration side (the ring records ≥500 only). */
  statusCode?: number;
}

type Sink = (entry: DiagnosticSinkInput) => void;

let sink: Sink | null = null;

/**
 * Register the current server's ring writer. server.ts's buildServer calls
 * this once per instance; passing null detaches (test isolation).
 */
export function registerDiagnosticSink(fn: Sink | null): void {
  sink = fn;
}

/**
 * The non-HTTP capture points' write: process crash handlers, notification
 * delivery failures, unverified tool-result shapes. No-op until a server
 * registered its ring; never throws.
 */
export function recordDiagnostic(kind: string, message: string, code?: string): void {
  if (sink === null) return;
  try {
    sink({ kind, message, ...(code !== undefined ? { code } : {}) });
  } catch {
    // Best-effort by contract — a broken sink must never break the caller.
  }
}
