/**
 * context-meter.ts — the composer's CONTEXT WINDOW truth, typed 1:1 against
 * GET /sessions/:id/context (agent-core routes/sessions.ts R50-c1 → R83 →
 * R92-B; the desktop's ContextDonut data source).
 *
 * THE WIRE (nothing invented — every field read off the route):
 *   GET /sessions/:id/context?model=<id>&providerId=<id>
 *     → {model, providerId, contextWindow, contextWindowSource, maxOutputTokens,
 *        available, usedTokens, usedTokensBasis: "estimated",
 *        breakdown: {systemPrompt, systemTools, memory, messages, meta, mcpTools},
 *        compaction?: {throughSeq, droppedMessages, tokensSaved},
 *        actual: {inputTokens, outputTokens, cachedInputTokens|null, at, model}|null,
 *        cache: {inputTokens, cachedInputTokens, hitRate: number|null},
 *        sessionTotals: {inputTokens, outputTokens, requests, costUsd, providerCalls},
 *        usage: {main, subagents, combined}}
 *   404 unknown session · 409 no bound agent / unconfigured pair (the meter
 *   honors ?providerId/?model= — the effective-pair gate, R92-B).
 *
 * The phone asks for it on open and every 2.5s while a turn runs
 * (CONTEXT_LIVE_REFETCH_MS — the desktop donut's exact live cadence), and the
 * pill's pressure coloring uses the desktop's exact thresholds
 * (CONTEXT_DONUT_WARN 0.6 / CONTEXT_DONUT_DANGER 0.85 — ContextDonut.tsx).
 */

import { apiJson, type ApiOutcome, type ApiSender } from "./api";

// ── the wire shapes ─────────────────────────────────────────────────────────

export interface ContextCompaction {
  throughSeq: number;
  droppedMessages: number;
  tokensSaved: number;
}

export interface ContextActual {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  at: string;
  model: string;
}

export interface ContextUsageSplit {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
  providerCalls?: number;
}

export interface SessionContextReport {
  model: string;
  providerId: string;
  contextWindow: number;
  contextWindowSource: string;
  maxOutputTokens: number;
  available: number;
  usedTokens: number;
  usedTokensBasis: string;
  breakdown: {
    systemPrompt: number;
    systemTools: number;
    memory: number;
    messages: number;
    meta: number;
    mcpTools: number;
  };
  compaction?: ContextCompaction;
  actual: ContextActual | null;
  cache: {
    inputTokens: number;
    cachedInputTokens: number;
    hitRate: number | null;
  };
  sessionTotals: {
    inputTokens: number;
    outputTokens: number;
    requests: number;
    costUsd: number;
    providerCalls: number;
  };
  usage: {
    main: ContextUsageSplit;
    subagents: ContextUsageSplit;
    combined: ContextUsageSplit;
  };
}

// ── the pure display helpers (the desktop's exact recipes) ─────────────────

/** The live-refresh cadence while a turn streams (ContextDonut's constant). */
export const CONTEXT_LIVE_REFETCH_MS = 2_500;

/** Ring stays the accent below this fraction of the window used. */
export const CONTEXT_DONUT_WARN = 0.6;
/** Ring turns danger ABOVE this fraction. */
export const CONTEXT_DONUT_DANGER = 0.85;

/** The pressure tier a used/window pair lands in (pure — the pill's color). */
export function contextPressure(
  usedTokens: number,
  contextWindow: number,
): "comfortable" | "filling" | "danger" | "unknown" {
  if (contextWindow <= 0 || usedTokens < 0) return "unknown";
  const frac = Math.min(1, usedTokens / contextWindow);
  if (frac > CONTEXT_DONUT_DANGER) return "danger";
  if (frac >= CONTEXT_DONUT_WARN) return "filling";
  return "comfortable";
}

/** The pill's percentage caption — rounded, capped at 100 (pure). */
export function contextPercent(usedTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
}

/** "12.4k" / "1.2M" — the token caption (the desktop fmtTokens' k-ladder,
 * the M spelled out for the phone's own captions). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return String(tokens);
}

/** "$0.42" — the cost caption (2 decimals, 4 under a dollar). */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The context window's provenance caption (R83's source label — the wire
 * carries "override" | "catalog" | "default"; the tiers the desktop renders). */
export function contextWindowSourceCaption(source: string): string {
  if (source === "override") return "your override";
  if (source === "catalog") return "catalog default";
  if (source === "default") return "assumed 200k — unknown model";
  return source;
}

// ── the typed client (injected sender — zero React Native) ─────────────────

/**
 * GET /sessions/:id/context — the meter. `model`/`providerId` are the
 * composer's EFFECTIVE pair (the override's when present; omit both for the
 * session agent's own — the route's default).
 */
export function fetchSessionContext(
  sender: ApiSender,
  sessionId: string,
  opts: { model?: string; providerId?: string } = {},
): Promise<ApiOutcome<SessionContextReport>> {
  const params = new URLSearchParams();
  if (opts.model !== undefined && opts.model.trim() !== "") params.set("model", opts.model.trim());
  if (opts.providerId !== undefined && opts.providerId.trim() !== "") {
    params.set("providerId", opts.providerId.trim());
  }
  const query = params.toString();
  return apiJson<SessionContextReport>(
    sender,
    `/sessions/${encodeURIComponent(sessionId)}/context${query === "" ? "" : `?${query}`}`,
  );
}
