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

/**
 * ROUND-50 (R50-c1, the composer's permission-mode switcher): the session's
 * standing permission posture. Enforced in agent-core's prepareTurn (tool
 * set) and the approvals engine (ask-tier gates):
 * - "full":  all tools; every ASK-tier gate auto-approves (denylist-supreme
 *            refusals — sudo, rm -rf, … — are NEVER bypassed).
 * - "ask":   today's behavior (default) — ask-tier gates wait on the owner.
 * - "plan":  read-only/research tools only (no file writes, no commands).
 * - "editor": file tools stay (auto-approved as today), but run_command is
 *            removed from the tool set entirely.
 */
export type PermissionMode = "full" | "ask" | "plan" | "editor";

/** The 4 accepted permission-mode values (validation source of truth). */
export const PERMISSION_MODES: readonly PermissionMode[] = ["full", "ask", "plan", "editor"];

/**
 * ROUND-50 (R50-c1, the composer's thinking-level selector): per-SEND
 * reasoning-effort hint. "default" = provider/model default (nothing
 * injected); low/high/max map to `reasoning.effort` on chat-completions
 * wire formats. NOT persisted — sub-agents never inherit it.
 */
export type ThinkingLevel = "default" | "low" | "high" | "max";

/** The 4 accepted thinking-level values (validation source of truth). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["default", "low", "high", "max"];

/**
 * ROUND-50 (R50-c1): one attachment on an outgoing user message — picked via
 * the OS file picker, @-mentioned, or dropped. `text` (the server-read head
 * of the file, capped at 128KB) rides the message.user event payload and is
 * rendered into the model-facing history by assembleHistory; the UI receives
 * only the display fields (name/path/size) via toProjectChatItems.
 */
export interface MessageAttachment {
  /** Display name (≤200 chars, non-empty — validated on the send routes). */
  name: string;
  /** Absolute (user-picked) or project-relative path, when known. */
  path?: string;
  /** File size in bytes, when known. */
  size?: number;
  /** Server-read text head (≤128KB); null = binary/unreadable. Not shipped
   * back to the UI — the payload is display-only in toProjectChatItems. */
  text?: string | null;
}

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
  /** ROUND-50 (R50-c1, the context meter's cache-hit-rate line): prompt
   * tokens served from the provider's cache (OpenRouter
   * `prompt_tokens_details.cached_tokens`, surfaced by AI SDK v7 as
   * `usage.inputTokenDetails.cacheReadTokens`). Null when the provider
   * didn't report a cached tier. */
  cachedInputTokens?: number | null;
  costUsd: number;
  /** ISO-8601 timestamp of the call. */
  ts: string;
}
