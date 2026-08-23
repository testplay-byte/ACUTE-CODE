-- 0004 (Model Management, round-19): per-provider model metadata + pricing.
-- Custom models are user-defined rows; preset provider models (e.g. the full
-- OpenRouter catalog) are also materialized here so hiding/overrides work
-- uniformly. The provider row gains an api_format column so custom providers
-- can declare their wire format (chat-completions | anthropic-messages |
-- responses).
ALTER TABLE providers ADD COLUMN api_format TEXT NOT NULL DEFAULT 'chat-completions';

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,             -- the identifier sent to the API (e.g. "anthropic/claude-sonnet-4")
  display_name TEXT NOT NULL DEFAULT '',
  context_window INTEGER,             -- total context tokens (input+output)
  max_output_tokens INTEGER,
  input_price_per_mtok REAL,         -- USD per 1M input tokens
  input_price_cached_per_mtok REAL,  -- USD per 1M cached input tokens
  output_price_per_mtok REAL,        -- USD per 1M output tokens
  supports_thinking INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, -- hidden from chat model picker, shown in settings
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
