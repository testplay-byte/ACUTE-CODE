-- 0031_usage_calls_origin.sql
-- ROUND-83 (R83, owner: "the context, the token count … highly misleading"):
-- the usage_events truth columns + the hidden-call rows.
--
-- provider_calls INTEGER NOT NULL DEFAULT 1 — the REAL SDK-call count behind
-- a turn. Every pre-R83 row is exactly 1 (one row per turn since R24), so
-- the default keeps history precisely true; new rows carry the runtime's
-- totalRequests counter. The UI's "requests" label previously meant TURNS
-- (COUNT(*) of rows) while the REQUEST_LIMIT guard counted SDK calls and
-- the AI SDK internally counted steps — three meanings (the audit's §2.9).
-- With the column, the usage screens can say "N turns · M provider calls".
--
-- origin TEXT NOT NULL DEFAULT 'turn' — which subsystem spent the tokens.
-- The compaction summarizer (compaction.ts — a REAL chat() call over the
-- full transcript) and the debug analyst (server.ts runDebugAnalyst) never
-- recorded usage rows: real spend invisible in every usage surface (the
-- audit's §2.12). They now write rows with origin 'compaction' / 'debug';
-- every pre-R83 row stays 'turn' by default. An index keeps an
-- origin-grouped rollup cheap.
--
-- agent_id relaxed to NULLABLE (table rebuild — SQLite cannot ALTER a
-- column constraint): the hidden-call rows have NO agent behind them
-- (agentId NULL). Usage rows are grouped by session and never joined on
-- agent (usage.ts aggregates read usage_events only), so the null is safe
-- by construction — documented in shared's UsageRecord.agentId.
--
-- REBUILD mechanics: the 0001 schema's `agent_id TEXT NOT NULL` plus the
-- appended ALTER columns (0020 cached_input_tokens, 0024 key_slot) are
-- folded into one canonical CREATE; the data is copied by NAME (both fresh
-- databases mid-migration-chain and old databases carry exactly those
-- columns at this point); the original indexes are recreated (DROP TABLE
-- drops them) + the new origin index. Idempotent by the version ledger,
-- same as every migration.

CREATE TABLE usage_events_r83 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT,
  session_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cached_input_tokens INTEGER,
  cost_usd        REAL NOT NULL,
  key_slot        INTEGER NOT NULL DEFAULT 0,
  provider_calls  INTEGER NOT NULL DEFAULT 1,
  origin          TEXT NOT NULL DEFAULT 'turn',
  ts              TEXT NOT NULL
);

INSERT INTO usage_events_r83 (
  id, agent_id, session_id, provider, model, input_tokens, output_tokens,
  cached_input_tokens, cost_usd, key_slot, provider_calls, origin, ts
)
SELECT
  id, agent_id, session_id, provider, model, input_tokens, output_tokens,
  cached_input_tokens, cost_usd, key_slot, 1, 'turn', ts
FROM usage_events;

DROP TABLE usage_events;
ALTER TABLE usage_events_r83 RENAME TO usage_events;

CREATE INDEX idx_usage_events_session ON usage_events (session_id);
CREATE INDEX idx_usage_events_ts ON usage_events (ts);
CREATE INDEX idx_usage_events_provider_model ON usage_events (provider, model);
CREATE INDEX idx_usage_events_provider_slot ON usage_events (provider, key_slot);
CREATE INDEX idx_usage_events_origin ON usage_events (origin);
