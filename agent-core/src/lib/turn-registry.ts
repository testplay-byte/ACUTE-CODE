/**
 * ROUND-52 (R52-b): the shared LIVE-TURN registry.
 *
 * server.ts used to own an `activeTurns` Map keyed by session id so POST
 * /sessions/:id/stop could abort the in-flight streamed turn. Sub-agent
 * children run INSIDE the parent's turn (the delegate_task tool awaits them),
 * so child session ids never had an entry — stopping a sub-agent was
 * impossible. The registry moves the map HERE where both the server (main
 * turns) and the orchestrator (child turns) register, giving the owner's Stop
 * button one uniform mechanism:
 *
 *   POST /sessions/:id/stop  →  abortTurn(id, "owner")
 *     - id = a MAIN session  → aborts the main turn (children cascade via the
 *       parent signal forwarding that already existed since R48-e1).
 *     - id = a CHILD session → aborts ONLY that child; the parent turn keeps
 *       running and receives an honest "stopped by the owner" report from the
 *       delegate_task tool result (the orchestrator composes it).
 *
 * Entries also carry a REASON ("owner" | "stall") so the orchestrator can
 * distinguish the owner's manual stop from the ROUND-52 watchdog's stall abort
 * in the child's final report to the parent agent.
 */
export type TurnStopReason = "owner" | "stall";

interface RegisteredTurn {
  controller: AbortController;
  reason: TurnStopReason | null;
  /** When the registration happened (diagnostics only). */
  registeredAt: number;
}

const turns = new Map<string, RegisteredTurn>();

/** Register the live turn for a session (main or child). One live turn per
 * session — a second registration for the same id replaces the first (the
 * runtime refuses concurrent turns anyway). */
export function registerTurn(sessionId: string, controller: AbortController): void {
  turns.set(sessionId, { controller, reason: null, registeredAt: Date.now() });
}

/** Remove a registration. Pass the SAME controller to avoid deleting a newer
 * turn's entry (same guard server.ts used with its raw Map). */
export function unregisterTurn(sessionId: string, controller: AbortController): void {
  const entry = turns.get(sessionId);
  if (entry !== undefined && entry.controller === controller) turns.delete(sessionId);
}

/** The live controller for a session, if a turn is in flight. */
export function getTurnController(sessionId: string): AbortController | undefined {
  return turns.get(sessionId)?.controller;
}

/** Why the in-flight turn (if any) was aborted — read by the orchestrator to
 * compose the child's honest final report ("stopped by the owner" vs
 * "stalled"). Null while the turn has not been aborted. */
export function getTurnStopReason(sessionId: string): TurnStopReason | null {
  return turns.get(sessionId)?.reason ?? null;
}

/** Abort the in-flight turn for a session (if any), recording WHY.
 * Returns true when a live turn was actually aborted. */
export function abortTurn(sessionId: string, reason: TurnStopReason): boolean {
  const entry = turns.get(sessionId);
  if (entry === undefined) return false;
  entry.reason = reason;
  entry.controller.abort();
  return true;
}

/** Test/introspection helper: ids of every currently live turn. */
export function liveTurnIds(): string[] {
  return [...turns.keys()];
}
