/**
 * approvals.ts — the approvals inbox's typed client + pure state (the killer
 * feature, ANDROID-R1 §4).
 *
 * THE WIRES (read from agent-core, not invented):
 *   GET  /api/v1/approvals?status=pending
 *        → {approvals: ApprovalRow[]} — the row is the EXISTING desktop
 *          shape (R3 §1.5: NO widening): {id, sessionId, agentId, projectId,
 *          toolCall, category, status, decidedBy, reason, remember,
 *          createdAt, decidedAt, expiresAt} — ISO strings throughout.
 *   POST /api/v1/approvals/:id/decision  body {decision: "approved"|"denied"}
 *        → 200 {ok, decision, remember} · 404 unknown · 409 already decided ·
 *          400 bad decision value. (The route's exact words: decision must be
 *          'approved' or 'denied' — v1 mobile sends decision only; remember
 *          is the desktop's option and the phone never sends it.)
 *
 * THE HARD RULE (LINKING-PROTOCOL §4 / the route's own downgrade): a
 * destructive approval can NEVER be "always allow". v1 mobile honors this by
 * construction — it offers no remember option at all — and the view model
 * still carries `canAlways` so a future "always" affordance can be gated
 * exactly where the desktop gates it.
 *
 * Expiry honesty: pending rows carry expiresAt (the engine's timeout). A row
 * past its expiry renders the honest "expired" state with disabled buttons
 * (the desktop's boot sweep denies it fail-closed; the decision route 409s
 * non-pending rows — the phone never pretends a dead row is decidable).
 */

import { apiJson, type ApiOutcome, type ApiSender } from "./api";

// ── the wire row (agent-core approvals.ts ApprovalRow, 1:1) ─────────────────

export interface ApprovalRow {
  id: string;
  sessionId: string;
  agentId: string;
  projectId: string | null;
  /** The command/action text — what the agent wants to run. */
  toolCall: string;
  /** "confirm" | "destructive" | "web" (the ask tiers) — free string on the wire. */
  category: string;
  status: string;
  decidedBy: string | null;
  reason: string | null;
  remember: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

/** The decision the route accepts — its own spelled values. */
export type ApprovalDecision = "approved" | "denied";

// ── the view model ──────────────────────────────────────────────────────────

/** The badge tone for a category (destructive reads danger — the quiet flag). */
export type CategoryTone = "danger" | "warning" | "neutral";

export interface ApprovalCardModel {
  row: ApprovalRow;
  /** First line of the tool call — the mono headline. */
  headline: string;
  /** Remaining lines (compact, dim) — "" when the call is single-line. */
  detail: string;
  tone: CategoryTone;
  /** The risk line: the row's reason when the host wrote one, else the
   * category's honest one-liner. */
  riskLine: string;
  /** Epoch ms of the expiry — null when the row carries none/""/garbage. */
  expiresAtMs: number | null;
  /** Expiry has passed while still pending — the honest dead state. */
  expired: boolean;
  /** Seconds until expiry (null when no expiry) — drives "expires in Ns". */
  expiresInMs: number | null;
  /** False ONLY for destructive categories — the never-"always" rule. */
  canAlways: boolean;
}

/** Parse an ISO timestamp to epoch ms; null for ""/unparseable (honest). */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The category's badge tone — destructive is the only danger tier. */
export function categoryTone(category: string): CategoryTone {
  if (category === "destructive") return "danger";
  if (category === "confirm") return "warning";
  return "neutral";
}

/** The category's risk line — the same quiet honesty the desktop's modal
 * carries; the row's own reason wins when the host wrote one. */
export function riskLineFor(row: ApprovalRow): string {
  if (row.reason !== null && row.reason !== "") return row.reason;
  switch (row.category) {
    case "destructive":
      return "destructive operation — review before approving";
    case "confirm":
      return "needs your confirmation before it runs";
    case "web":
      return "web access the agent is asking to make";
    default:
      return `the agent is asking for permission (${row.category})`;
  }
}

/** Row → card view model (pure; `now` injectable for tests). */
export function toApprovalCard(row: ApprovalRow, now: number): ApprovalCardModel {
  const lines = row.toolCall.split("\n");
  const headline = (lines[0] ?? "").trim();
  const detail = lines.slice(1).join("\n").trim();
  const expiresAtMs = parseIsoMs(row.expiresAt);
  const expired = row.status === "pending" && expiresAtMs !== null && expiresAtMs <= now;
  return {
    row,
    headline: headline === "" ? "(empty request)" : headline,
    detail,
    tone: categoryTone(row.category),
    riskLine: riskLineFor(row),
    expiresAtMs,
    expired,
    expiresInMs: expiresAtMs === null ? null : Math.max(0, expiresAtMs - now),
    canAlways: row.category !== "destructive",
  };
}

/** All pending rows → sorted, view-modeled cards (newest first — the route's
 * own ORDER BY created_at DESC is preserved; `now` injectable). */
export function toApprovalCards(rows: ApprovalRow[], now: number): ApprovalCardModel[] {
  return rows.map((row) => toApprovalCard(row, now));
}

// ── the client (injectable sender — ConnectionManager satisfies it) ────────

/** GET the pending rows. */
export async function fetchPendingApprovals(sender: ApiSender): Promise<ApiOutcome<ApprovalRow[]>> {
  const outcome = await apiJson<{ approvals: ApprovalRow[] }>(sender, "/approvals?status=pending");
  if (!outcome.ok) return outcome;
  const rows = Array.isArray(outcome.data.approvals)
    ? outcome.data.approvals
    : [];
  return { ok: true, data: rows };
}

/** The decision body — v1 sends decision ONLY (the route's other fields are
 * the desktop's; the phone honors the destructive-never-always rule by never
 * asking to remember at all). */
export function decisionBody(decision: ApprovalDecision): string {
  return JSON.stringify({ decision });
}

/** POST a decision. 200 {ok,decision,remember} · 404 · 409 (already decided). */
export async function postApprovalDecision(
  sender: ApiSender,
  id: string,
  decision: ApprovalDecision,
): Promise<ApiOutcome<{ ok: boolean; decision: ApprovalDecision; remember: string }>> {
  return apiJson<{ ok: boolean; decision: ApprovalDecision; remember: string }>(
    sender,
    `/approvals/${encodeURIComponent(id)}/decision`,
    { method: "POST", bodyText: decisionBody(decision) },
  );
}
