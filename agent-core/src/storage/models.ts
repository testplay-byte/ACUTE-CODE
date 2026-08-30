/**
 * Model metadata storage (round-19, migration 0004). Each model row belongs
 * to a provider and carries the user's configuration: pricing per million
 * tokens, context window, thinking support, visibility (hidden from chat
 * picker but always visible in settings). The UNIQUE(provider_id, model_id)
 * constraint means "add model" is upsert-by-model_id per provider.
 */
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage/db.js";

export interface ModelRecord {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number | null;
  supportsThinking: boolean;
  hidden: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInput {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputPricePerMtok?: number | null;
  inputPriceCachedPerMtok?: number | null;
  outputPricePerMtok?: number | null;
  supportsThinking?: boolean;
  hidden?: boolean;
  sortOrder?: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  input_price_per_mtok: number | null;
  input_price_cached_per_mtok: number | null;
  output_price_per_mtok: number | null;
  supports_thinking: number;
  hidden: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    inputPricePerMtok: row.input_price_per_mtok,
    inputPriceCachedPerMtok: row.input_price_cached_per_mtok,
    outputPricePerMtok: row.output_price_per_mtok,
    supportsThinking: row.supports_thinking === 1,
    hidden: row.hidden === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_MODELS = `SELECT * FROM models WHERE provider_id = ? ORDER BY hidden ASC, sort_order ASC, model_id ASC`;

export function listModels(db: SqliteDatabase, providerId: string): ModelRecord[] {
  return (db.prepare(SELECT_MODELS).all(providerId) as ModelRow[]).map(toModel);
}

export function listVisibleModels(db: SqliteDatabase, providerId: string): ModelRecord[] {
  return (db.prepare(`${SELECT_MODELS} AND hidden = 0`).all(providerId) as ModelRow[]).map(toModel);
}

export function getModel(db: SqliteDatabase, id: string): ModelRecord | undefined {
  const row = db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
  return row ? toModel(row) : undefined;
}

/** Upsert a model for a provider (UNIQUE(provider_id, model_id)). */
export function upsertModel(
  db: SqliteDatabase,
  providerId: string,
  input: ModelInput,
): ModelRecord {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM models WHERE provider_id = ? AND model_id = ?")
    .get(providerId, input.modelId) as ModelRow | undefined;

  if (existing) {
    // ROUND-50 (R50-d): explicit-null vs absent — a null field CLEARS the
    // stored value back to "unknown" (the config dialog's empty input), an
    // absent field leaves it untouched. The old `input.x ?? existing.x`
    // collapsed null into "keep", so PATCH {field: null} silently did
    // nothing — the null-clearing contract never reached the DB.
    const keep = <T,>(next: T | undefined, prev: T): T =>
      next === undefined ? prev : next;
    db.prepare(
      `UPDATE models SET
        display_name = @displayName, context_window = @contextWindow,
        max_output_tokens = @maxOutputTokens,
        input_price_per_mtok = @inputPricePerMtok,
        input_price_cached_per_mtok = @inputPriceCachedPerMtok,
        output_price_per_mtok = @outputPricePerMtok,
        supports_thinking = @supportsThinking, hidden = @hidden,
        sort_order = @sortOrder, updated_at = @updatedAt
      WHERE id = @id`,
    ).run({
      displayName: typeof input.displayName === "string" ? input.displayName : existing.display_name,
      contextWindow: keep(input.contextWindow, existing.context_window),
      maxOutputTokens: keep(input.maxOutputTokens, existing.max_output_tokens),
      inputPricePerMtok: keep(input.inputPricePerMtok, existing.input_price_per_mtok),
      inputPriceCachedPerMtok: keep(input.inputPriceCachedPerMtok, existing.input_price_cached_per_mtok),
      outputPricePerMtok: keep(input.outputPricePerMtok, existing.output_price_per_mtok),
      supportsThinking: (input.supportsThinking ?? existing.supports_thinking === 1) ? 1 : 0,
      hidden: (input.hidden ?? existing.hidden === 1) ? 1 : 0,
      sortOrder: keep(input.sortOrder, existing.sort_order),
      updatedAt: now,
      id: existing.id,
    });
    return getModel(db, existing.id) as ModelRecord;
  }

  const id = `mdl_${randomUUID()}`;
  db.prepare(
    `INSERT INTO models (
      id, provider_id, model_id, display_name, context_window, max_output_tokens,
      input_price_per_mtok, input_price_cached_per_mtok, output_price_per_mtok,
      supports_thinking, hidden, sort_order, created_at, updated_at
    ) VALUES (
      @id, @providerId, @modelId, @displayName, @contextWindow, @maxOutputTokens,
      @inputPricePerMtok, @inputPriceCachedPerMtok, @outputPricePerMtok,
      @supportsThinking, @hidden, @sortOrder, @createdAt, @updatedAt
    )`,
  ).run({
    id,
    providerId,
    modelId: input.modelId,
    displayName: input.displayName ?? input.modelId,
    contextWindow: input.contextWindow ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    inputPricePerMtok: input.inputPricePerMtok ?? null,
    inputPriceCachedPerMtok: input.inputPriceCachedPerMtok ?? null,
    outputPricePerMtok: input.outputPricePerMtok ?? null,
    supportsThinking: (input.supportsThinking ?? false) ? 1 : 0,
    hidden: (input.hidden ?? false) ? 1 : 0,
    sortOrder: input.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  });
  return getModel(db, id) as ModelRecord;
}

export function updateModel(
  db: SqliteDatabase,
  id: string,
  patch: Partial<ModelInput>,
): ModelRecord | undefined {
  const existing = getModel(db, id);
  if (!existing) return undefined;
  return upsertModel(db, existing.providerId, { ...existing, ...patch });
}

export function deleteModel(db: SqliteDatabase, id: string): boolean {
  const res = db.prepare("DELETE FROM models WHERE id = ?").run(id);
  return res.changes > 0;
}

export function deleteModelsByProvider(db: SqliteDatabase, providerId: string): void {
  db.prepare("DELETE FROM models WHERE provider_id = ?").run(providerId);
}

/** Look up pricing for a provider+model (round-24: cost tracking). */
export function lookupPricing(
  db: SqliteDatabase,
  providerId: string,
  modelId: string,
): { inputPricePerMtok: number | null; outputPricePerMtok: number | null } {
  const row = db
    .prepare("SELECT input_price_per_mtok, output_price_per_mtok FROM models WHERE provider_id = ? AND model_id = ?")
    .get(providerId, modelId) as
    | { input_price_per_mtok: number | null; output_price_per_mtok: number | null }
    | undefined;
  if (!row) return { inputPricePerMtok: null, outputPricePerMtok: null };
  return { inputPricePerMtok: row.input_price_per_mtok, outputPricePerMtok: row.output_price_per_mtok };
}

/* ── ROUND-43 (R43-3 / task 6-b): the built-in OpenRouter model catalog ──────
 *
 * The previous default model (stealth/ox-alpha) was DELETED upstream by
 * OpenRouter — every chat that referenced it died with a provider error.
 * This static catalog is the code-side replacement source of truth:
 *
 * - FREE_MODEL_CATALOG: every CURRENT free chat model from the live
 *   openrouter.ai/api/v1/models snapshot of 2026-08-26 (17 ids ending
 *   `:free` + the `openrouter/free` meta-router; the two zero-priced
 *   google/lyria-* entries are music generation, NOT chat — excluded).
 *   All $0.00 pricing, real context windows, and per-model capability
 *   flags taken from `supported_parameters` / `architecture`.
 * - PAID_MODEL_CATALOG: ~30 well-known paid models with real per-Mtok
 *   pricing from the same snapshot (the "All models" side of the
 *   free-only filter).
 *
 * Migration 0013 uses the same id set to rewrite dead model references
 * in existing databases; ensureDefaultAgent seeds DEFAULT_MODEL_ID.
 * The DB `models` table stays the per-provider override store — this
 * catalog is constants, not rows.
 */

export interface CatalogModel {
  /** OpenRouter model id — the identifier sent to the API. */
  modelId: string;
  displayName: string;
  /** Total context tokens (input+output), from the live snapshot. */
  contextWindow: number;
  /** Max completion tokens the top provider allows (null = unspecified). */
  maxOutputTokens: number | null;
  /** USD per 1M input tokens. */
  inputPricePerMtok: number;
  /** USD per 1M cached input tokens (null = no cached tier). */
  inputPriceCachedPerMtok: number | null;
  /** USD per 1M output tokens. */
  outputPricePerMtok: number;
  /** $0 prompt+completion (the free tier set). */
  free: boolean;
  /** `tools` in supported_parameters — REQUIRED for agentic turns. */
  supportsTools: boolean;
  /** `structured_outputs` in supported_parameters. */
  supportsStructuredOutputs: boolean;
  /** image input modality. */
  supportsVision: boolean;
}

/**
 * The app-wide default model (R43 owner directive): free, 256K ctx, tools +
 * structured outputs — purpose-built for long-horizon agentic coding.
 */
export const DEFAULT_MODEL_ID = "z-ai/glm-5.2:free";

/** Planned sub-agent default (R43-5 wires the picker; constant lands now). */
export const SUBAGENT_DEFAULT_MODEL_ID = "nvidia/nemotron-3.5-lightning:free";

/**
 * Ordered "recommended" pins surfaced at the top of model pickers: the
 * default first, then the researched alternates (main / sub-agent / coding /
 * resilience meta-router that auto-survives single-model deprecation).
 */
export const RECOMMENDED_MODEL_IDS: readonly string[] = [
  DEFAULT_MODEL_ID,
  "minimax/minimax-m3:free",
  "thinkingmachines/inkling-small:free",
  SUBAGENT_DEFAULT_MODEL_ID,
  "poolside/laguna-s-2.1:free",
  "cohere/north-mini-code:free",
  "openrouter/free",
];

/** All current free chat models (recommended order first, then the rest). */
export const FREE_MODEL_CATALOG: readonly CatalogModel[] = [
  {
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2",
    contextWindow: 256000,
    maxOutputTokens: 230400,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "minimax/minimax-m3:free",
    displayName: "MiniMax: MiniMax M3",
    contextWindow: 1048576,
    maxOutputTokens: 943718,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "thinkingmachines/inkling-small:free",
    displayName: "Thinking Machines: Inkling Small",
    contextWindow: 1048576,
    maxOutputTokens: 262144,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "nvidia/nemotron-3.5-lightning:free",
    displayName: "NVIDIA: Nemotron 3.5 Lightning",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "poolside/laguna-s-2.1:free",
    displayName: "Poolside: Laguna S 2.1",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "cohere/north-mini-code:free",
    displayName: "Cohere: North Mini Code",
    contextWindow: 256000,
    maxOutputTokens: 64000,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "openrouter/free",
    displayName: "Free Models Router",
    contextWindow: 200000,
    maxOutputTokens: null,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "dots-studio/dots-3-note-preview:free",
    displayName: "Dots Studio: Dots3-Note Preview",
    contextWindow: 512000,
    maxOutputTokens: 460800,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "google/gemma-4-26b-a4b-it:free",
    displayName: "Google: Gemma 4 26B A4B",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "google/gemma-4-31b-it:free",
    displayName: "Google: Gemma 4 31B",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "liquid/lfm-2.5-2.6b:free",
    displayName: "LiquidAI: LFM2.5-2.6B",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "minimax/minimax-m2.7:free",
    displayName: "MiniMax: MiniMax M2.7",
    contextWindow: 196608,
    maxOutputTokens: 176947,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    displayName: "NVIDIA: Nemotron 3 Nano Omni",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "nvidia/nemotron-3-super-120b-a12b:free",
    displayName: "NVIDIA: Nemotron 3 Super",
    contextWindow: 262144,
    maxOutputTokens: 235929,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
    displayName: "NVIDIA: Nemotron 3 Ultra",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "nvidia/nemotron-3.5-content-safety:free",
    displayName: "NVIDIA: Nemotron 3.5 Content Safety",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: false,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
  {
    modelId: "poolside/laguna-xs-2.1:free",
    displayName: "Poolside: Laguna XS 2.1",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "thinkingmachines/inkling:free",
    displayName: "Thinking Machines: Inkling",
    contextWindow: 1048576,
    maxOutputTokens: 262144,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0,
    free: true,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: true,
  },
];

/** Well-known paid models with real snapshot pricing ("All models" side). */
export const PAID_MODEL_CATALOG: readonly CatalogModel[] = [
  {
    modelId: "anthropic/claude-opus-4.5",
    displayName: "Anthropic: Claude Opus 4.5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePerMtok: 5,
    inputPriceCachedPerMtok: 0.5,
    outputPricePerMtok: 25,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "anthropic/claude-sonnet-4.5",
    displayName: "Anthropic: Claude Sonnet 4.5",
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    inputPricePerMtok: 3,
    inputPriceCachedPerMtok: 0.3,
    outputPricePerMtok: 15,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "anthropic/claude-haiku-4.5",
    displayName: "Anthropic: Claude Haiku 4.5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePerMtok: 1,
    inputPriceCachedPerMtok: 0.1,
    outputPricePerMtok: 5,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-5.2",
    displayName: "OpenAI: GPT-5.2",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputPricePerMtok: 1.75,
    inputPriceCachedPerMtok: 0.175,
    outputPricePerMtok: 14,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-5.1",
    displayName: "OpenAI: GPT-5.1",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputPricePerMtok: 1.25,
    inputPriceCachedPerMtok: 0.125,
    outputPricePerMtok: 10,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-5-mini",
    displayName: "OpenAI: GPT-5 Mini",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputPricePerMtok: 0.25,
    inputPriceCachedPerMtok: 0.025,
    outputPricePerMtok: 2,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-5-nano",
    displayName: "OpenAI: GPT-5 Nano",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    inputPricePerMtok: 0.05,
    inputPriceCachedPerMtok: 0.005,
    outputPricePerMtok: 0.4,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/o4-mini",
    displayName: "OpenAI: o4 Mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePerMtok: 1.1,
    inputPriceCachedPerMtok: 0.275,
    outputPricePerMtok: 4.4,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/o3",
    displayName: "OpenAI: o3",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePerMtok: 2,
    inputPriceCachedPerMtok: 0.5,
    outputPricePerMtok: 8,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-4.1",
    displayName: "OpenAI: GPT-4.1",
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    inputPricePerMtok: 2,
    inputPriceCachedPerMtok: 0.5,
    outputPricePerMtok: 8,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-4o",
    displayName: "OpenAI: GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePerMtok: 2.5,
    inputPriceCachedPerMtok: 1.25,
    outputPricePerMtok: 10,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "openai/gpt-4o-mini",
    displayName: "OpenAI: GPT-4o-mini",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePerMtok: 0.15,
    inputPriceCachedPerMtok: 0.075,
    outputPricePerMtok: 0.6,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "google/gemini-3.1-pro-preview",
    displayName: "Google: Gemini 3.1 Pro Preview",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    inputPricePerMtok: 2,
    inputPriceCachedPerMtok: 0.2,
    outputPricePerMtok: 12,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "google/gemini-3.7-flash",
    displayName: "Google: Gemini 3.7 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0.375,
    inputPriceCachedPerMtok: 0.0375,
    outputPricePerMtok: 1.875,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "google/gemini-2.5-pro",
    displayName: "Google: Gemini 2.5 Pro",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    inputPricePerMtok: 1.25,
    inputPriceCachedPerMtok: 0.125,
    outputPricePerMtok: 10,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "google/gemini-2.5-flash",
    displayName: "Google: Gemini 2.5 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65535,
    inputPricePerMtok: 0.3,
    inputPriceCachedPerMtok: 0.03,
    outputPricePerMtok: 2.5,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "x-ai/grok-4.6",
    displayName: "xAI: Grok 4.6",
    contextWindow: 500000,
    maxOutputTokens: 450000,
    inputPricePerMtok: 2,
    inputPriceCachedPerMtok: 0.5,
    outputPricePerMtok: 6,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "x-ai/grok-build-0.1",
    displayName: "xAI: Grok Build 0.1",
    contextWindow: 256000,
    maxOutputTokens: 230400,
    inputPricePerMtok: 1,
    inputPriceCachedPerMtok: 0.2,
    outputPricePerMtok: 2,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "deepseek/deepseek-v3.2",
    displayName: "DeepSeek: DeepSeek V3.2",
    contextWindow: 163840,
    maxOutputTokens: 147456,
    inputPricePerMtok: 0.26,
    inputPriceCachedPerMtok: 0.13,
    outputPricePerMtok: 0.38,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "deepseek/deepseek-r1",
    displayName: "DeepSeek: R1",
    contextWindow: 64000,
    maxOutputTokens: 16000,
    inputPricePerMtok: 0.7,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 2.5,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "qwen/qwen3-max",
    displayName: "Qwen: Qwen3 Max",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0.78,
    inputPriceCachedPerMtok: 0.156,
    outputPricePerMtok: 3.9,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "qwen/qwen3-coder",
    displayName: "Qwen: Qwen3 Coder 480B A35B",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    inputPricePerMtok: 0.3,
    inputPriceCachedPerMtok: 0.1,
    outputPricePerMtok: 1,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "moonshotai/kimi-k2-thinking",
    displayName: "MoonshotAI: Kimi K2 Thinking",
    contextWindow: 262144,
    maxOutputTokens: 100352,
    inputPricePerMtok: 0.6,
    inputPriceCachedPerMtok: 0.15,
    outputPricePerMtok: 2.5,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "moonshotai/kimi-k2",
    displayName: "MoonshotAI: Kimi K2 0711",
    contextWindow: 131072,
    maxOutputTokens: 100352,
    inputPricePerMtok: 0.57,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 2.3,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: false,
    supportsVision: false,
  },
  {
    modelId: "z-ai/glm-4.6",
    displayName: "Z.ai: GLM 4.6",
    contextWindow: 204800,
    maxOutputTokens: 131072,
    inputPricePerMtok: 0.5,
    inputPriceCachedPerMtok: 0.1,
    outputPricePerMtok: 2,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "minimax/minimax-m2.7",
    displayName: "MiniMax: MiniMax M2.7",
    contextWindow: 204800,
    maxOutputTokens: 131072,
    inputPricePerMtok: 0.3,
    inputPriceCachedPerMtok: 0.06,
    outputPricePerMtok: 1.2,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: false,
  },
  {
    modelId: "meta-llama/llama-4-maverick",
    displayName: "Meta: Llama 4 Maverick",
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    inputPricePerMtok: 0.2,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: 0.8,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
  {
    modelId: "mistralai/mistral-large-2512",
    displayName: "Mistral: Mistral Large 3 2512",
    contextWindow: 262144,
    maxOutputTokens: 209715,
    inputPricePerMtok: 0.5,
    inputPriceCachedPerMtok: 0.05,
    outputPricePerMtok: 1.5,
    free: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsVision: true,
  },
];

/** Free + paid, one list — recommended ids first (stable order after that). */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  ...FREE_MODEL_CATALOG,
  ...PAID_MODEL_CATALOG,
];

/** Set of every catalog id (used by migration 0013's conservative guard). */
export const CATALOG_MODEL_IDS: readonly string[] = MODEL_CATALOG.map((m) => m.modelId);

const catalogById = new Map<string, CatalogModel>(MODEL_CATALOG.map((m) => [m.modelId, m]));

/** Catalog lookup by OpenRouter model id. */
export function getCatalogModel(modelId: string): CatalogModel | undefined {
  return catalogById.get(modelId);
}

/**
 * Free-tier detection for ANY model id (catalog or live-fetched):
 * OpenRouter `:free` suffix, the `openrouter/free` meta-router, or an
 * explicit $0 catalog/override price.
 */
export function isFreeModelId(
  modelId: string,
  inputPricePerMtok?: number | null,
): boolean {
  if (modelId === "openrouter/free" || modelId.endsWith(":free")) return true;
  if (inputPricePerMtok === 0) return true;
  const entry = catalogById.get(modelId);
  return entry !== undefined && entry.free;
}

/** Catalog membership (the migration's "known-good id" guard). */
export function isKnownCatalogModelId(modelId: string): boolean {
  return catalogById.has(modelId);
}

/**
 * The shared free-only filter used by Settings → Providers and (next wave)
 * the chat composer's model picker: when `freeOnly` is true only free models
 * survive; false passes everything through untouched.
 */
export function filterCatalogByFreeOnly<T extends { modelId: string; inputPricePerMtok?: number | null }>(
  models: readonly T[],
  freeOnly: boolean,
): T[] {
  if (!freeOnly) return [...models];
  return models.filter((m) => isFreeModelId(m.modelId, m.inputPricePerMtok));
}

/**
 * Sort helper for pickers: RECOMMENDED_MODEL_IDS first (in recommendation
 * order), remaining free models next, paid last; within groups the incoming
 * order is preserved.
 */
export function orderCatalogRecommended<T extends { modelId: string; free?: boolean }>(
  models: readonly T[],
): T[] {
  const rank = new Map(RECOMMENDED_MODEL_IDS.map((id, i) => [id, i]));
  return [...models].sort((a, b) => {
    const ra = rank.get(a.modelId);
    const rb = rank.get(b.modelId);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    const fa = a.free === undefined ? isFreeModelId(a.modelId) : a.free;
    const fb = b.free === undefined ? isFreeModelId(b.modelId) : b.free;
    if (fa !== fb) return fa ? -1 : 1;
    return 0;
  });
}
