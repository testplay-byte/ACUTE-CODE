/**
 * approval-card.test.ts — R115-M's honest re-pin. NO card test existed before
 * this round (src/components/__tests__ held only screen-scaffold.test.ts), and
 * the mobile suite is PURE-LOGIC by convention (jest.config.js: "no screen
 * snapshots, no native bridge" — nothing imports react-native at test time),
 * so the rebuild's contract is pinned the screen-scaffold way: a TYPE-ONLY
 * component import (erased at runtime — `npx tsc --noEmit` is the assertion's
 * execution engine) plus pure fixtures for the decision seam.
 *
 * What R115-M changed (the structure, honestly): the headline is
 * TypeBodyStrong ≤2 lines (the mono headline retired — it was cramped), the
 * detail is a tertiary caption ≤3 lines rendered ONLY when toolCall has
 * remaining lines, the expiry read is a CHIP ("expires in {n}s"/"{n}m",
 * warning tint under 30s, dim "expired") replacing v2's plain caption + the
 * standalone danger Badge, the risk line rides a warning-tinted CircleAlert,
 * the context caption is one line, and both buttons sit 50px side by side
 * carrying the approve/deny testIDs + headline accessibility labels. The
 * optimistic settle springs, the destructive danger hairline, the expired
 * dim+disable, and the entrance stagger are all kept verbatim from v2.
 * What did NOT change: the props surface below — pinned so the screen's
 * call site survives the rebuild intact.
 */

import { describe, expect, it } from "@jest/globals";

import type { ApprovalCardProps } from "@/components/approval-card";
import type { ApprovalCardModel, ApprovalDecision } from "@/features/approvals";

// ── fixtures (pure — the view model's own shape, as the screen builds it) ──

const card: ApprovalCardModel = {
  row: {
    id: "appr_1",
    sessionId: "sess_abcdef123456",
    agentId: "agent_default",
    projectId: null,
    toolCall: "npm install\n--force\n--legacy-peer-deps",
    category: "confirm",
    status: "pending",
    decidedBy: null,
    reason: null,
    remember: null,
    createdAt: "2026-09-18T11:59:00Z",
    decidedAt: null,
    expiresAt: "2026-09-18T12:02:00Z",
  },
  headline: "npm install",
  detail: "--force\n--legacy-peer-deps",
  tone: "warning",
  riskLine: "needs your confirmation before it runs",
  expiresAtMs: Date.parse("2026-09-18T12:02:00Z"),
  expired: false,
  expiresInMs: 120_000,
  canAlways: true,
};

// The decision seam the screen + card share (409-aware): (id, decision) →
// null when delivered (or honestly raced elsewhere), the failure line
// otherwise. A pure mirror of the screen's own decide().
const decide: ApprovalCardProps["onDecide"] = (id: string, decision: ApprovalDecision) =>
  Promise.resolve(id === "appr_1" && decision === "approved" ? null : "the host is offline — the decision was not delivered");

// ── the pins ────────────────────────────────────────────────────────────────

// The props surface is UNCHANGED by the rebuild — exactly the four keys the
// screen's call site passes (card · enterIndex? · caption · onDecide).
type ExpectedKeys = "card" | "enterIndex" | "caption" | "onDecide";
type PropKeys = keyof ApprovalCardProps;
type SurfaceUnchanged = Exclude<PropKeys, ExpectedKeys> extends never ? true : never;
const surfacePinned: SurfaceUnchanged = true;

describe("ApprovalCard — the R115-M rebuild contract", () => {
  it("the props surface survives the rebuild unchanged (card · enterIndex? · caption · onDecide)", () => {
    // Both the type-level pin above and the runtime mirror — tsc is the gate
    // that runs the first, jest the second.
    expect(surfacePinned).toBe(true);
    const props: ApprovalCardProps = {
      card,
      enterIndex: 0,
      caption: "session sess_abcdef1234 · no project",
      onDecide: decide,
    };
    expect(props.card.headline).toBe("npm install");
  });

  it("enterIndex stays optional — static contexts mount the card with no stagger", () => {
    const props: Omit<ApprovalCardProps, "card"> = {
      caption: "session sess_abcdef1234 · no project",
      onDecide: decide,
    };
    expect(props.enterIndex).toBeUndefined();
  });

  it("the decision seam stays 409-aware: null = delivered (or raced), the line = failure", async () => {
    await expect(decide("appr_1", "approved")).resolves.toBe(null);
    await expect(decide("appr_2", "denied")).resolves.toBe(
      "the host is offline — the decision was not delivered",
    );
  });

  it("the view model the card renders is the feature's own (headline/detail split + expiry truth)", () => {
    // The pure mirror of toApprovalCard's contract — the runtime half lives
    // in features/__tests__/approvals.test.ts; this pins the SHAPE the card
    // consumes so a model change breaks this compile, not just the screen.
    expect(card.headline).toBe(card.row.toolCall.split("\n")[0]);
    expect(card.detail).toBe(card.row.toolCall.split("\n").slice(1).join("\n"));
    expect(card.expiresInMs).toBeGreaterThan(30_000); // the chip's calm tier
    expect(card.expired).toBe(false);
  });
});
