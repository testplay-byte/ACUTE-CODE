import { describe, expect, it } from "vitest";
import type {
  AgentRecord,
  ApprovalDecision,
  MemoryPolicy,
  RunMode,
  SessionStatus,
  ToolPermission,
  UsageRecord,
} from "./index";

// Type-level lock: the v1 unions must stay exactly as the canonical contract defines them.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type _RunModeCheck = Expect<Equal<RunMode, "single" | "auto-team" | "manual">>;
export type _SessionStatusCheck = Expect<
  Equal<SessionStatus, "queued" | "running" | "completed" | "failed" | "cancelled">
>;
export type _ApprovalDecisionCheck = Expect<
  Equal<ApprovalDecision, "approved" | "denied" | "expired">
>;
export type _ToolPermissionCheck = Expect<Equal<ToolPermission, "auto" | "confirm" | "blocked">>;
export type _MemoryPolicyCheck = Expect<Equal<MemoryPolicy, "none" | "on-start" | "every-turn">>;

describe("shared v1 domain types", () => {
  it("accepts a fully populated AgentRecord", () => {
    const agent: AgentRecord = {
      id: "agent-1",
      name: "Implementer",
      role: "implementer",
      systemPrompt: "You implement carefully.",
      providerId: "provider-y",
      model: "model-x",
      visionModel: "model-vision",
      allowedTools: ["read", "edit"],
      memoryPolicy: "on-start",
      skills: ["typescript"],
      maxTurns: 40,
      temperature: 0.2,
    };
    expect(agent.id).toBe("agent-1");
    expect(agent.memoryPolicy).toBe("on-start");
  });

  it("accepts a null visionModel and every MemoryPolicy value", () => {
    const agent: AgentRecord = {
      id: "agent-2",
      name: "Reviewer",
      role: "reviewer",
      systemPrompt: "You review carefully.",
      providerId: "provider-y",
      model: "model-x",
      visionModel: null,
      allowedTools: [],
      memoryPolicy: "none",
      skills: [],
      maxTurns: 10,
      temperature: 0,
    };
    const policies: MemoryPolicy[] = ["none", "on-start", "every-turn"];
    expect(agent.visionModel).toBeNull();
    expect(policies).toHaveLength(3);
  });

  it("accepts UsageRecord and ApprovalDecision values", () => {
    const usage: UsageRecord = {
      agentId: "agent-1",
      sessionId: "session-1",
      provider: "provider-y",
      model: "model-x",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.0042,
      ts: "2026-08-21T12:00:00.000Z",
    };
    const decision: ApprovalDecision = "approved";
    const decisions: ApprovalDecision[] = ["approved", "denied", "expired"];
    expect(usage.costUsd).toBeGreaterThan(0);
    expect(decision).toBe("approved");
    expect(decisions).toHaveLength(3);
  });

  it("keeps the RunMode union closed", () => {
    const modes: RunMode[] = ["single", "auto-team", "manual"];
    const statuses: SessionStatus[] = [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(modes).toHaveLength(3);
    expect(statuses).toHaveLength(5);
  });
});
