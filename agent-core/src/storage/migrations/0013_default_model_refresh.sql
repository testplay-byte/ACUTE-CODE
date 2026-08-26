-- 0013_default_model_refresh.sql
-- ROUND-43 (R43-3): the app's default model (stealth/ox-alpha, hardcoded in
-- the round-15 default-agent seed and the setup wizard prefill) was DELETED
-- upstream by OpenRouter — every chat that referenced it died with a provider
-- error (the owner's R42 verdict: "model dead (cut off)").
--
-- This migration repairs EXISTING databases to point at the new default,
-- z-ai/glm-5.2:free ($0, 256K ctx, tools + structured outputs; the head of
-- the built-in catalog in agent-core/src/storage/models.ts). It is
-- deliberately conservative:
--
--   * Only OpenRouter-bound agents are examined (provider_id = 'openrouter')
--     — custom providers (Ollama, gateways, …) keep whatever ids they use.
--   * An id is rewritten ONLY when it is NOT a current free id (no `:free`
--     suffix, not the `openrouter/free` meta-router) AND NOT one of the 46
--     known-good catalog ids inlined below (20-ish free + notable paid from
--     the 2026-08-26 openrouter.ai/api/v1/models snapshot). Anything else on
--     OpenRouter is, by definition, a dead/unknown slug — e.g. the deleted
--     stealth/ox-alpha.
--   * Per-provider override rows in `models` are only touched when they carry
--     the KNOWN-DEAD ids themselves (stealth/ox-alpha / openrouter/ox-alpha);
--     user overrides for any other model are preserved untouched.
--   * Historical telemetry is never falsified: usage_events rows and
--     session_events payloads keep the model ids that actually served those
--     turns.
--
-- Fresh databases are unaffected operationally (agents is empty when
-- migrations run); ensureDefaultAgent then seeds the new DEFAULT_MODEL_ID.

-- 1) Default-model repair: dead/unknown OpenRouter model ids -> the new
--    free default. vision_model gets the same treatment (it would otherwise
--    point the vision router at a dead slug).
UPDATE agents
   SET model = 'z-ai/glm-5.2:free',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE provider_id = 'openrouter'
   AND model IS NOT NULL
   AND model != ''
   AND model NOT LIKE '%:free'
   AND model NOT IN (
        -- free set (meta-router + the suffix rule covers the rest)
        'openrouter/free',
        -- paid set (current catalog, snapshot 2026-08-26)
        'anthropic/claude-opus-4.5',
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-haiku-4.5',
        'openai/gpt-5.2',
        'openai/gpt-5.1',
        'openai/gpt-5-mini',
        'openai/gpt-5-nano',
        'openai/o4-mini',
        'openai/o3',
        'openai/gpt-4.1',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'google/gemini-3.1-pro-preview',
        'google/gemini-3.7-flash',
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash',
        'x-ai/grok-4.6',
        'x-ai/grok-build-0.1',
        'deepseek/deepseek-v3.2',
        'deepseek/deepseek-r1',
        'qwen/qwen3-max',
        'qwen/qwen3-coder',
        'moonshotai/kimi-k2-thinking',
        'moonshotai/kimi-k2',
        'z-ai/glm-4.6',
        'minimax/minimax-m2.7',
        'meta-llama/llama-4-maverick',
        'mistralai/mistral-large-2512'
       );

UPDATE agents
   SET vision_model = 'z-ai/glm-5.2:free',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE provider_id = 'openrouter'
   AND vision_model IS NOT NULL
   AND vision_model != ''
   AND vision_model NOT LIKE '%:free'
   AND vision_model NOT IN (
        'openrouter/free',
        'anthropic/claude-opus-4.5',
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-haiku-4.5',
        'openai/gpt-5.2',
        'openai/gpt-5.1',
        'openai/gpt-5-mini',
        'openai/gpt-5-nano',
        'openai/o4-mini',
        'openai/o3',
        'openai/gpt-4.1',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'google/gemini-3.1-pro-preview',
        'google/gemini-3.7-flash',
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash',
        'x-ai/grok-4.6',
        'x-ai/grok-build-0.1',
        'deepseek/deepseek-v3.2',
        'deepseek/deepseek-r1',
        'qwen/qwen3-max',
        'qwen/qwen3-coder',
        'moonshotai/kimi-k2-thinking',
        'moonshotai/kimi-k2',
        'z-ai/glm-4.6',
        'minimax/minimax-m2.7',
        'meta-llama/llama-4-maverick',
        'mistralai/mistral-large-2512'
       );

-- 2) Per-provider override rows for the KNOWN-DEAD ids are removed (the
--    models behind them no longer exist upstream; the shipped catalog +
--    live /models fetch cover the new free set). Every other override row —
--    including ids not in the shipped catalog — is kept.
DELETE FROM models
 WHERE provider_id = 'openrouter'
   AND model_id IN ('stealth/ox-alpha', 'openrouter/ox-alpha');

-- 3) Bookkeeping: record the refresh in the audit log so support can see a
--    repair happened (actor 'migration-0013'; details name the new default).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0013',
  'model.default.refresh',
  'openrouter',
  'applied',
  'dead model ids rewritten to z-ai/glm-5.2:free (default agent + openrouter-bound agents); stealth/ox-alpha override rows removed'
);
