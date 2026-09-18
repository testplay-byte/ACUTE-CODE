/**
 * ROUND-106 (R106-S3): the CLI's own view of the sidecar's SSE frame union
 * (CLI-DESIGN §2/§4). Deliberately LOCAL — the package has zero runtime
 * dependencies, so it cannot import `shared`; this mirrors the wire shapes
 * the desktop's StreamTurnEvent union carries (src/lib/api.ts), listing the
 * frames the TERMINAL acts on and tolerating everything else structurally
 * (`unknown` extras + a catch-all `[type: string]: unknown`), exactly the
 * "unknown frames ignored" version-skew rule (acute.mjs precedent, §7 risk
 * 2).
 */

/** The frames a turn stream carries that the CLI renders or acts on. */
export type TurnFrame =
  | { type: "text-delta"; delta: string; text?: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-call"; toolName: string; argsSummary: string }
  | {
      type: "tool-result";
      toolName: string;
      argsSummary: string;
      ok: boolean;
      outputSummary?: string;
    }
  | { type: "tool-output"; toolName: string; argsSummary?: string; chunk: string }
  | { type: "meta.continuation"; iteration: number; reason?: string }
  | {
      type: "meta.retry";
      attempt: number;
      totalAttempts: number;
      waitMs: number;
      remainingMs: number;
      retryAt: number;
      errorClass: string;
      classMessage: string;
      message: string;
      providerError?: string;
      rateLimitReason?: "quota" | "rate" | "capacity";
    }
  | { type: "meta.key"; key: { attempt: number; totalKeys: number; reason: string }; message: string }
  | { type: "meta.queue_continue"; count: number; recovery?: boolean }
  | { type: "meta.overflow_recovery"; message: string }
  | { type: "meta.compaction"; tokensSaved: number; droppedMessages: number; throughSeq: number }
  | { type: "meta.context_limit"; tokens: number; limit: number }
  | { type: "meta.request_limit"; requests: number; limit: number }
  | { type: "meta.continuation_complete"; iterations: number }
  | {
      type: "subagent-status";
      sessionId: string;
      parentSessionId: string;
      status: "queued" | "running" | "completed" | "failed";
      task: string;
      role: string;
      code: string;
      detail?: string;
    }
  | {
      type: "subagent-event";
      sessionId: string;
      parentSessionId: string;
      inner: { type: string; [extra: string]: unknown };
    }
  | {
      type: "finish";
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | {
      type: "done";
      usage?: UsageLine;
      queuedKept?: number;
    }
  | {
      type: "approval.requested";
      approvalId: string;
      toolName: string;
      argsSummary: string;
      category: string;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      decision: "approved" | "denied" | "expired";
      remember?: "once" | "always";
    }
  | { type: "error"; status?: number; code?: string; message: string }
  | { type: "stopped" }
  | { type: string; [extra: string]: unknown };

/** The usage tail the done frame carries (model · N in · N out · $cost). */
export interface UsageLine {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** A parsed-but-unrecognized frame — rendered as nothing, never an error. */
export function isTerminalFrame(frame: TurnFrame): boolean {
  return frame.type === "done" || frame.type === "stopped" || frame.type === "error";
}

/** Structural parse of one `data: ` payload → a frame (never throws; the
 * malformed-frame tolerance of the desktop's reader). */
export function parseFrame(raw: string): TurnFrame | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as { type?: unknown };
    if (typeof candidate.type !== "string" || candidate.type === "") return null;
    return parsed as TurnFrame;
  } catch {
    return null;
  }
}
