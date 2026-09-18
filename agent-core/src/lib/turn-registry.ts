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
 *
 * ROUND-78 (R78, owner: "工作中发送消息（排队）"): entries gained an optional
 * `notify` callback — the route registers the SSE `send` as the turn's
 * notifier, and POST /sessions/:id/queue calls notifyTurn(id, {type:
 * "user.queued", …}) so the LIVE stream renders the queued-message chip the
 * moment the message lands (the queue POST cannot write to the hijacked
 * response itself; the registry is the one shared handle). Absent notify =
 * a live turn with no interactive listener (children, background turns) —
 * notifyTurn simply reports false.
 */
export type TurnStopReason = "owner" | "stall";

interface RegisteredTurn {
  controller: AbortController;
  reason: TurnStopReason | null;
  /** When the registration happened (diagnostics only). */
  registeredAt: number;
  /** ROUND-78 (R78): the live stream's emit callback — the queue route's
   * user.queued frames ride it. Optional + unknown-typed on purpose: the
   * registry stays transport-agnostic (SSE today; never imported by the
   * runtime's turn functions). */
  notify?: (event: unknown) => void;
}

const turns = new Map<string, RegisteredTurn>();

/** Register the live turn for a session (main or child). One live turn per
 * session — a second registration for the same id replaces the first (the
 * R107-b F1 gates at both send routes refuse a second turn while one is
 * live, so a replacement now only ever happens after a leaked/stale entry,
 * never mid-flight).
 * ROUND-78 (R78): optional `notify` — the route passes its SSE send so
 * notifyTurn can push user.queued frames onto the still-open stream. */
export function registerTurn(sessionId: string, controller: AbortController, notify?: (event: unknown) => void): void {
  turns.set(sessionId, { controller, reason: null, registeredAt: Date.now(), ...(notify !== undefined ? { notify } : {}) });
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

/**
 * ROUND-78 (R78): push an event to a LIVE turn's registered notifier (the
 * route's SSE send). Returns whether a live entry WITH a notify callback
 * existed and was called — false for no-live-turn, a turn without a
 * listener (children / background turns), or a notifier that THREW (the
 * callback's own guards own their errors; a dead socket must never bubble
 * into the queue route's 200).
 */
export function notifyTurn(sessionId: string, event: unknown): boolean {
  const entry = turns.get(sessionId);
  if (entry === undefined || entry.notify === undefined) return false;
  try {
    entry.notify(event);
  } catch {
    return false;
  }
  return true;
}
