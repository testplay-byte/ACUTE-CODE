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
 * ROUND-81 (R81, the owner-directed unified mode picker): the session's
 * OPERATING MODE — one selector replacing the old four-value permission
 * switcher AND the six-builtin task-mode picker. Exactly three values:
 * - "full":  FULL ACCESS — all tools, zero approval prompts (every ASK-tier
 *            gate auto-approves; denylist-supreme refusals — sudo, rm -rf, … —
 *            are NEVER bypassed). The agent decides autonomously how to work
 *            (research / plan / build / debug / edit) and switches postures
 *            via switch_mode as the task's shape changes.
 * - "ask":   ASK (default) — full tool access, but ask-tier gates wait on
 *            the owner before important commands/changes.
 * - "plan":  PLAN — read-only/research tools only (no file writes, no
 *            commands). The agent can plan, read, and research but cannot
 *            edit the project.
 * R81 migration: the old "editor" value maps to "ask" (fail-closed — editor
 * had no terminal; ask is the only mode that still gates commands).
 */
export type PermissionMode = "full" | "ask" | "plan";

/** The 3 accepted operating-mode values (validation source of truth). */
export const PERMISSION_MODES: readonly PermissionMode[] = ["full", "ask", "plan"];

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
 *
 * ROUND-67 (R67-A, the owner's #1 v0.66.0 field report: "I uploaded an image
 * directly in chat and the agent said the image doesn't exist"): `path` is
 * now RELIABLE for binary attachments too. Dropped/pasted bytes and
 * OS-picker binaries are persisted server-side into
 * <root>/attachments/<name> (POST /attachments/upload), and the composer
 * threads the returned PROJECT-RELATIVE path (forward slashes) here — the
 * runtime's renderAttachments turns it into the exact analyze_image
 * instruction. The shape itself is unchanged: no byte field rides the wire
 * (bytes go straight to the upload route, never into the event log).
 */
export interface MessageAttachment {
  /** Display name (≤200 chars, non-empty — validated on the send routes). */
  name: string;
  /**
   * Where the file lives, when known. ROUND-67 (R67-A): for persisted
   * attachments this is the PROJECT-RELATIVE path of the uploaded copy
   * ("attachments/photo.png", forward slashes) — resolvable by the agent's
   * read_file/analyze_image against the project root. Legacy/OS-picker rows
   * may still carry an absolute path.
   */
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
