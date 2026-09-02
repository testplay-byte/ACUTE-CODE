/**
 * ROUND-52 (R52-f): buildApprovalDeps — extracted from tools/index.ts so the
 * plugin modules (exec/web/browser) share ONE builder and the
 * permissionMode/projectId/emit/signal/appendEvent forwarding can never drift
 * between call sites. VERBATIM the R50-c1 logic.
 *
 * ROUND-64 (R64-d): permissionMode became a LIVE GETTER. The owner: "If I
 * changed the permissions midway, like from ask to full access, then it
 * should properly get applied for the next runs of commands and other
 * stuff." runtime.ts's prepareTurn captures session.permissionMode ONCE per
 * turn into toolDeps (a turn can run for many minutes), so the mid-turn
 * PATCH /sessions/:id/permissions (updateSessionPermissionMode → DB) never
 * reached the in-flight turn's approval gates — a flip ask→full kept asking
 * until the NEXT turn. The getter re-reads the CURRENT session row from the
 * DB on every read and falls back to the turn-captured value when the row is
 * gone or the read throws (fail-closed: the captured value, never a widening
 * default). runtime.ts is untouched — object-literal getters are transparent
 * to every consumer reading deps.permissionMode (approvals.ts reads it at
 * decision time, ~lines 496 and ~730), and nothing in the approval flow
 * spreads the deps object (a spread would snapshot the value — verified by
 * grep this round).
 */
import type { ApprovalRequestDeps } from "../approvals.js";
import { getSession } from "../storage/sessions.js";
import type { ToolDeps } from "./index.js";

/**
 * ROUND-50 (R50-c1): the approval-gate deps every gated tool builds from
 * toolDeps (run_command, web_fetch, browser_control-navigate) — ONE builder
 * so the permissionMode forwarding can never drift between call sites.
 */
export function buildApprovalDeps(toolDeps: ToolDeps): ApprovalRequestDeps {
  return {
    db: toolDeps.db,
    sessionId: toolDeps.sessionId,
    agentId: toolDeps.agentId,
    interactive: toolDeps.interactiveApprovals === true,
    // ROUND-64 (R64-d): LIVE, not a copy — re-reads the session row so a
    // mid-turn permission-mode change reaches THIS turn's remaining approval
    // decisions (the prepareTurn snapshot stays as the fallback).
    get permissionMode() {
      try {
        const session = getSession(toolDeps.db, toolDeps.sessionId);
        if (session !== undefined) return session.permissionMode;
      } catch {
        // fail-closed: unreadable row → the turn-captured value (the
        // pre-R64 behavior), never a widening default.
      }
      return toolDeps.permissionMode;
    },
    ...(toolDeps.projectId !== undefined ? { projectId: toolDeps.projectId } : {}),
    ...(toolDeps.emit !== undefined ? { emit: toolDeps.emit } : {}),
    ...(toolDeps.signal !== undefined ? { signal: toolDeps.signal } : {}),
    ...(toolDeps.appendEvent !== undefined ? { appendEvent: toolDeps.appendEvent } : {}),
  };
}
