/**
 * v1 domain types shared by the React frontend and the agent-core sidecar.
 * Types only — this package ships no runtime behavior in Phase 1.
 * These unions are the canonical contract (single source of truth); consumers
 * must not fork or extend them locally.
 */

/** How a session picks its agents (ADR-0001: single / auto-team / manual). */
export type RunMode = "single" | "auto-team" | "manual";

/** Lifecycle of a work session driven through the sidecar. */
export type SessionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A user's response to an approval request raised by the sidecar. */
export type ApprovalDecision = "approved" | "denied" | "expired";

/**
 * Risk tier attached to a tool. agent-core's categorize() additionally returns
 * "destructive" for irreversible operations — an internal fourth tier above these three.
 */
export type ToolPermission = "auto" | "confirm" | "blocked";

/** How an agent's memory is loaded/persisted across a session. */
export type MemoryPolicy = "none" | "on-start" | "every-turn";

/** A saved, user-editable agent definition (agents are first-class records in SPEC). */
export interface AgentRecord {
  id: string;
  name: string;
  /** Free-form job title, e.g. "implementer", "reviewer" — used during team assembly. */
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  /** Secondary model used for vision-capable calls, or null when unset. */
  visionModel: string | null;
  allowedTools: string[];
  memoryPolicy: MemoryPolicy;
  skills: string[];
  maxTurns: number;
  temperature: number;
}

/** One provider billing line for a completed model call. */
export interface UsageRecord {
  agentId: string;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** ISO-8601 timestamp of the call. */
  ts: string;
}
