/**
 * ROUND-107 (R107-c-impl, F9): the APPROVALS command group — the surface
 * the one-shot hint always pointed at (`acute raw POST /approvals/<id>/
 * decision …`) as first-class commands:
 *
 *   `acute approvals ls [--status pending|approved|denied|expired]`
 *     → GET /approvals (server.ts:1388 — {approvals: ApprovalRow[]})
 *   `acute approvals <id> approve [--remember once|always]`
 *   `acute approvals <id> deny`
 *     → POST /approvals/:id/decision (server.ts:1400 — body
 *       {decision: "approved"|"denied", remember?: "once"|"always"};
 *       the server downgrades remember=always to once on destructive
 *       categories — the response carries the effective value).
 */
import { apiFetch } from "../api.js";
import type { CliContext } from "../context.js";
import { flagString } from "../flags.js";
import { didYouMean } from "../suggest.js";
import { trunc } from "../render/tools.js";

/** GET /approvals rows (agent-core approvals.ts ApprovalRow — camelCase via
 * the SELECT aliases: id, toolCall, createdAt, …). */
interface ApprovalRow {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  toolCall: string;
  category: string;
  status: string;
  decidedBy: string | null;
  reason: string | null;
  remember: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

const SUBCOMMANDS: readonly string[] = ["ls", "approve", "deny"];

const STATUSES: readonly string[] = ["pending", "approved", "denied", "expired"];

const USAGE = `usage:
  acute approvals ls [--status pending|approved|denied|expired]
                                      approval rows, newest first (no filter by default)
  acute approvals <id> approve [--remember once|always]
                                      POST the decision (destructive never remembers always)
  acute approvals <id> deny           POST the denial`;

/** The status column's color (padded inside the color — trailing spaces are
 * invisible under SGR, alignment survives). */
function statusStyle(ctx: CliContext, status: string): (s: string) => string {
  if (status === "pending") return ctx.kit.yellow;
  if (status === "approved") return ctx.kit.green;
  if (status === "denied") return ctx.kit.red;
  return ctx.kit.dim; // expired + anything unknown
}

export async function runApprovalsCommand(ctx: CliContext, rest: readonly string[]): Promise<number> {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [first, second] = positional;

  // The DOCUMENTED spelling is `approvals <id> approve|deny` — the verb is
  // the SECOND token. `approvals ls` (verb first) and `approvals approve
  // <id>` (either order) resolve to the same branches; a bare `approvals`
  // means ls (the sessions precedent).
  const verbFirst = first === "approve" || first === "deny";
  const verbSecond = second === "approve" || second === "deny";
  if (first === "ls" || (first === undefined && second === undefined)) {
    return listApprovals(ctx);
  }
  if (verbFirst || verbSecond) {
    const verb = verbFirst ? first : second;
    const id = verbFirst ? second : first;
    return decideApproval(ctx, id, verb);
  }
  const named = second !== undefined ? second : first;
  ctx.stderr(
    `unknown approvals subcommand: ${named}${didYouMean(named ?? "", SUBCOMMANDS)}\n${USAGE}\n`,
  );
  return 1;
}

/** `approvals ls` — GET /approvals (+ the --status query filter). */
async function listApprovals(ctx: CliContext): Promise<number> {
  const status = flagString(ctx.flags, "status");
  if (status !== undefined && !STATUSES.includes(status)) {
    ctx.stderr(`--status must be pending|approved|denied|expired (got '${status}')\n`);
    return 1;
  }
  const { approvals } = await apiFetch<{ approvals: ApprovalRow[] }>(
    ctx.conn,
    "GET",
    status !== undefined ? `/approvals?status=${encodeURIComponent(status)}` : "/approvals",
  );
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify({ approvals })}\n`);
    return 0;
  }
  ctx.stderr(
    ctx.kit.dim(`${approvals.length} approval(s)${status !== undefined ? ` · status ${status}` : ""}\n`),
  );
  for (const a of approvals) {
    ctx.stdout(
      `${trunc(a.id, 18).padEnd(18)}  ${statusStyle(ctx, a.status)(a.status.padEnd(9))}  ${trunc(a.category, 12).padEnd(12)}  ${trunc(a.toolCall, 56).padEnd(56)}  ${a.createdAt}\n`,
    );
  }
  return 0;
}

/** `approvals <id> approve|deny [--remember once|always]` — the decision POST. */
async function decideApproval(
  ctx: CliContext,
  id: string | undefined,
  verb: string | undefined,
): Promise<number> {
  if (id === undefined) {
    ctx.stderr(`${USAGE}\n`);
    return 1;
  }
  const decision = verb === "approve" ? "approved" : "denied";
  const remember = flagString(ctx.flags, "remember");
  if (remember !== undefined && remember !== "once" && remember !== "always") {
    ctx.stderr(`--remember must be once or always (got '${remember}')\n`);
    return 1;
  }
  const result = await apiFetch<{ ok: boolean; decision: string; remember: string }>(
    ctx.conn,
    "POST",
    `/approvals/${id}/decision`,
    { decision, ...(remember !== undefined ? { remember } : {}) },
  );
  if (ctx.json) {
    ctx.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  }
  ctx.stdout(`approval ${id} ${result.decision} (remember ${result.remember})\n`);
  return 0;
}
