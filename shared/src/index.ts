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
 * injected); the other values map to `reasoning.effort` on
 * chat-completions wire formats. NOT persisted — sub-agents never inherit it.
 *
 * ROUND-95 (R95-E): "medium" JOINS the vocabulary (additive — the R50
 * owner directive was "only four options", but the R95 owner report says
 * the levels were supposed to be MODEL-SPECIFIC: models whose detected
 * effort ladder is e.g. ["low","medium"] get a Medium option, and
 * chat.ts maps every level onto the model's own ladder — see
 * ModelReasoningSupport below and REASONING_EFFORT_LEVELS).
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly and was showing the
 * default options. This should not happen"): "xhigh" JOINS TOO — the
 * picker must be able to offer the model's ACTUAL top rungs verbatim
 * (OpenRouter's live 2026-09-13 catalog: x-ai/grok-4.6 and openai/gpt-5.2
 * carry ["xhigh","high","medium","low"], z-ai/glm-5.2 ["xhigh","high"]).
 * Stored per-session levels from older builds stay valid (the union only
 * widened); the classic Default/Low/High/Max set remains what a model with
 * UNKNOWN capabilities offers.
 */
export type ThinkingLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";

/** The accepted thinking-level values (validation source of truth). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

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
  /** ROUND-92 (R92-C): the truth the sidecar has ALWAYS served
   * (storage/agents.ts serves provider_id/model as string | null — the
   * seeded templates since round 1, and since R91-A every force-deleted
   * provider's referencing agents, carry NULL) — the agent is simply NOT
   * CONFIGURED yet and arms itself from the first chat pick (R92-B). */
  providerId: string | null;
  model: string | null;
  /** Secondary model used for vision-capable calls, or null when unset. */
  visionModel: string | null;
  allowedTools: string[];
  memoryPolicy: MemoryPolicy;
  skills: string[];
  maxTurns: number;
  temperature: number;
}

/* ── ROUND-95 (R95-B): per-model reasoning capability ───────────────────── */

/**
 * ROUND-95 (R95-B, owner: "The thinking level was supposed to be
 * model-specific. Multiple models have different thinking levels … Our
 * program should be able to properly detect the models' thinking options,
 * like which options it supports and such"): the wire-side REASONING-EFFORT
 * vocabulary — the values ACUTE may inject as `reasoning.effort` on
 * chat-completions requests. Ordered lowest → highest.
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly and was showing the
 * default options. This should not happen. It needs to be improved and
 * handled better"): the vocabulary now keeps the provider's OWN rungs
 * VERBATIM — "xhigh" and "max" are real ladder values (the R95 merge edge
 * folded both DOWN to "high", which made a detected ['max','high','low']
 * model render a menu IDENTICAL to the unknown-capabilities default — the
 * exact invisibility the owner reported). "none" remains OUTSIDE the
 * vocabulary: it is a DISABLE switch, not an effort, and is dropped at the
 * catalog-merge edge (registry.ts normalizeReasoningEfforts). Anything
 * else a provider lists that falls outside this vocabulary is dropped
 * there too; the stored metadata therefore only ever contains these six.
 */
export type ReasoningEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The accepted reasoning-effort values (validation source of truth). */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * ROUND-95 (R95-B): a model row's DETECTED reasoning capability, captured
 * from the provider's live catalog (OpenRouter /models entries:
 * `supported_parameters` containing "reasoning" plus the `reasoning`
 * object's `supported_efforts` list) and stored on the row as a JSON blob.
 *
 * `supported: false` = the catalog explicitly says the model takes no
 * reasoning parameter. A null/absent ModelReasoningSupport = UNKNOWN (never
 * detected — the honest default for non-OpenRouter providers, which expose
 * no such metadata) — consumers must NEVER block on unknown: fall back to
 * the global thinking-level selector.
 */
export interface ModelReasoningSupport {
  /** The provider's catalog marks the model as reasoning-capable. */
  supported: boolean;
  /** The efforts the provider lists for this model, within the wire
   * vocabulary. May be empty when the model is supported but the provider
   * names no discrete efforts (e.g. OpenRouter's plain reasoning-only
   * entries) — effort selection then falls back to the global levels. */
  efforts: readonly ReasoningEffortLevel[];
  /** ROUND-96 (R96-F): the provider's PUBLISHED default rung for the model
   * (OpenRouter `reasoning.default_effort`), normalized by the same
   * vocabulary rules as `efforts` (a "none"/out-of-vocabulary default
   * reads as absent). Optional + absent = unknown — ACUTE never injects a
   * default itself (a "Default" pick injects nothing and lets the provider
   * apply its own); the field exists so the composer's menu can SAY which
   * rung the model would use ("model default: max"). */
  defaultEffort?: ReasoningEffortLevel;
}

/** One provider billing line for a completed model call. */
export interface UsageRecord {
  /** The agent that authored the call — null for the R83 hidden-call rows
   * (the compaction summarizer + the debug analyst: real provider spend
   * with NO agent behind it; usage rows are grouped by session, never
   * joined on agent — the null is safe by construction). */
  agentId: string | null;
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
