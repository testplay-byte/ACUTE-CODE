/**
 * approvals.test.ts — the approvals inbox's pure state + typed client: the
 * card view model (headline/detail split, category tones, risk lines, the
 * honest expiry), the decision wire (decision-only body), and the client's
 * outcome parsing — all against an injected fake sender (the manager's api()
 * seam), zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import { apiPath, parseApiError, type ApiSender, type ApiOutcome } from "../api";
import {
  categoryTone,
  decisionBody,
  fetchPendingApprovals,
  parseIsoMs,
  postApprovalDecision,
  riskLineFor,
  toApprovalCard,
  type ApprovalRow,
} from "../approvals";

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-18T12:00:00Z");

function makeRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr_1",
    sessionId: "sess_abcdef123456",
    agentId: "agent_default",
    projectId: "proj_acute",
    toolCall: "git push --force origin main",
    category: "confirm",
    status: "pending",
    decidedBy: null,
    reason: null,
    remember: null,
    createdAt: "2026-09-18T11:59:00Z",
    decidedAt: null,
    expiresAt: "2026-09-18T12:02:00Z",
    ...overrides,
  };
}

/** The fake sender — records calls, answers canned responses. */
function makeSender(
  respond: (path: string, init: { method?: string; bodyText?: string }) => {
    status: number;
    bodyText: string;
  },
) {
  const calls: Array<{ path: string; init: { method?: string; bodyText?: string } }> = [];
  const sender: ApiSender = {
    async api(path, init = {}) {
      calls.push({ path, init });
      const response = respond(path, init);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: {},
        bodyText: response.bodyText,
      };
    },
  };
  return { sender, calls };
}

// ── the view model ──────────────────────────────────────────────────────────

describe("approvals — the card view model", () => {
  it("splits a single-line tool call into headline with no detail", () => {
    const card = toApprovalCard(makeRow(), NOW);
    expect(card.headline).toBe("git push --force origin main");
    expect(card.detail).toBe("");
  });

  it("splits a multi-line tool call into headline + compact detail", () => {
    const card = toApprovalCard(
      makeRow({ toolCall: "npm install\n--force\n--legacy-peer-deps" }),
      NOW,
    );
    expect(card.headline).toBe("npm install");
    expect(card.detail).toBe("--force\n--legacy-peer-deps");
  });

  it("maps category tones: destructive=danger, confirm=warning, web=neutral", () => {
    expect(categoryTone("destructive")).toBe("danger");
    expect(categoryTone("confirm")).toBe("warning");
    expect(categoryTone("web")).toBe("neutral");
  });

  it("derives the honest risk line per category, with the host's reason winning", () => {
    expect(riskLineFor(makeRow({ category: "destructive" }))).toContain("destructive");
    expect(riskLineFor(makeRow({ category: "confirm" }))).toContain("confirmation");
    expect(riskLineFor(makeRow({ category: "web" }))).toContain("web access");
    expect(riskLineFor(makeRow({ reason: "touches production config" }))).toBe(
      "touches production config",
    );
  });

  it("carries expiry truth: live countdown, never a fabricated past", () => {
    const card = toApprovalCard(makeRow(), NOW);
    expect(card.expiresAtMs).toBe(Date.parse("2026-09-18T12:02:00Z"));
    expect(card.expiresInMs).toBe(120_000);
    expect(card.expired).toBe(false);
  });

  it("marks a pending row past its expiry as expired (the honest dead state)", () => {
    const card = toApprovalCard(makeRow({ expiresAt: "2026-09-18T11:00:00Z" }), NOW);
    expect(card.expired).toBe(true);
    expect(card.expiresInMs).toBe(0);
  });

  it("treats empty or garbage expiry as no expiry at all", () => {
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("not-a-date")).toBeNull();
    expect(parseIsoMs(undefined)).toBeNull();
    expect(toApprovalCard(makeRow({ expiresAt: "" }), NOW).expiresAtMs).toBeNull();
  });

  it("gates never-always on the destructive category only", () => {
    expect(toApprovalCard(makeRow({ category: "destructive" }), NOW).canAlways).toBe(false);
    expect(toApprovalCard(makeRow({ category: "confirm" }), NOW).canAlways).toBe(true);
    expect(toApprovalCard(makeRow({ category: "web" }), NOW).canAlways).toBe(true);
  });
});

// ── the client ──────────────────────────────────────────────────────────────

describe("approvals — the typed client", () => {
  it("prefixes every path with /api/v1", () => {
    expect(apiPath("/approvals?status=pending")).toBe("/api/v1/approvals?status=pending");
  });

  it("parses the host's error envelope; falls back honestly off-shape", () => {
    expect(parseApiError(409, '{"error":{"code":"CONFLICT","message":"already decided"}}')).toEqual({
      status: 409,
      code: "CONFLICT",
      message: "already decided",
    });
    const fallback = parseApiError(500, "plain text");
    expect(fallback.code).toBe("HTTP_500");
    expect(fallback.message).toBe("plain text");
    expect(parseApiError(502, "").message).toContain("502");
  });

  it("fetches the pending rows through the status filter", async () => {
    const row = makeRow();
    const { sender, calls } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ approvals: [row] }),
    }));
    const outcome = await fetchPendingApprovals(sender);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data).toEqual([row]);
    }
    expect(calls[0]?.path).toBe("/api/v1/approvals?status=pending");
  });

  it("reads a non-array approvals field as an empty list (never a crash)", async () => {
    const { sender } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ approvals: null }),
    }));
    const outcome = await fetchPendingApprovals(sender);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data).toEqual([]);
  });

  it("surfaces HTTP errors as values with the envelope's code", async () => {
    const { sender } = makeSender(() => ({
      status: 401,
      bodyText: '{"error":{"code":"UNAUTHORIZED","message":"bad token"}}',
    }));
    const outcome: ApiOutcome<ApprovalRow[]> = await fetchPendingApprovals(sender);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(401);
      expect(outcome.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("sends the decision-only body the route validates (approved/denied)", async () => {
    const { sender, calls } = makeSender(() => ({
      status: 200,
      bodyText: JSON.stringify({ ok: true, decision: "approved", remember: "once" }),
    }));
    const outcome = await postApprovalDecision(sender, "appr_1", "approved");
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe("/api/v1/approvals/appr_1/decision");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.bodyText).toBe('{"decision":"approved"}');
    expect(decisionBody("denied")).toBe('{"decision":"denied"}');
  });

  it("carries the 409 already-decided race as an error outcome", async () => {
    const { sender } = makeSender(() => ({
      status: 409,
      bodyText: '{"error":{"code":"CONFLICT","message":"approval appr_1 is already denied"}}',
    }));
    const outcome = await postApprovalDecision(sender, "appr_1", "denied");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.status).toBe(409);
      expect(outcome.error.code).toBe("CONFLICT");
    }
  });
});
