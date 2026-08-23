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
      displayName: input.displayName ?? existing.display_name,
      contextWindow: input.contextWindow ?? existing.context_window,
      maxOutputTokens: input.maxOutputTokens ?? existing.max_output_tokens,
      inputPricePerMtok: input.inputPricePerMtok ?? existing.input_price_per_mtok,
      inputPriceCachedPerMtok: input.inputPriceCachedPerMtok ?? existing.input_price_cached_per_mtok,
      outputPricePerMtok: input.outputPricePerMtok ?? existing.output_price_per_mtok,
      supportsThinking: (input.supportsThinking ?? existing.supports_thinking === 1) ? 1 : 0,
      hidden: (input.hidden ?? existing.hidden === 1) ? 1 : 0,
      sortOrder: input.sortOrder ?? existing.sort_order,
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
