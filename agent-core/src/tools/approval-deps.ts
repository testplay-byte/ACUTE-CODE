/**
 * ROUND-52 (R52-f): buildApprovalDeps — extracted from tools/index.ts so the
 * plugin modules (exec/web/browser) share ONE builder and the
 * permissionMode/projectId/emit/signal/appendEvent forwarding can never drift
 * between call sites. VERBATIM the R50-c1 logic.
 */
import type { ApprovalRequestDeps } from "../approvals.js";
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
    ...(toolDeps.permissionMode !== undefined ? { permissionMode: toolDeps.permissionMode } : {}),
    ...(toolDeps.projectId !== undefined ? { projectId: toolDeps.projectId } : {}),
    ...(toolDeps.emit !== undefined ? { emit: toolDeps.emit } : {}),
    ...(toolDeps.signal !== undefined ? { signal: toolDeps.signal } : {}),
    ...(toolDeps.appendEvent !== undefined ? { appendEvent: toolDeps.appendEvent } : {}),
  };
}
