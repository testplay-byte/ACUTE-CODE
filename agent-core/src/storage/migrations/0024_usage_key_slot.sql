-- 0024_usage_key_slot.sql
-- ROUND-64 (R64-e, owner directive): PER-API-KEY usage stats. The owner:
-- "I want the ability to track each individual API key's stats, like the
-- total usage of that API key, total tokens used on that API key, and all
-- other stuff like that… in the usage section."
--
-- What lands here (schema only — the aggregation lives in
-- storage/usage.ts getDetailedUsage, the threading in agents/runtime.ts):
--   · usage_events.key_slot — which key-pool slot served the call
--     (0 = the provider's PRIMARY key, N ≥ 2 = ACUTE_PROVIDER_<ID>_SLOT<N>,
--     the pool slots the orchestrator prefers for sub-agent children per
--     ADR-0022). Default 0 keeps every pre-R64 row (and every caller that
--     cannot know a slot — main-session turns run on the primary key) honest:
--     slot 0 IS the primary.
--   · idx_usage_events_provider_slot — the GROUP BY (provider, key_slot)
--     index the usage screen's per-key aggregate scans (same naming
--     convention as 0001's idx_usage_events_provider_model).
--
-- No backfill: pre-0024 rows genuinely ran on the primary key (children only
-- got pool slots after ADR-0022, and nothing recorded WHICH slot before this
-- migration), so DEFAULT 0 is the truthful reading of history, not a guess.
--
-- Threading (R64-e): runSingleAgentTurn/runStreamedAgentTurn read
-- TurnDeps.keySlot (set by the orchestrator on child deps from the slot it
-- acquired; omitted = primary) and pass it to recordUsage's third parameter.
-- shared/UsageRecord is deliberately untouched — the slot is a storage
-- dimension, not a message field.

ALTER TABLE usage_events ADD COLUMN key_slot INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_usage_events_provider_slot ON usage_events (provider, key_slot);

-- Audit trail (pattern shared with 0014/0015/0021/0022/0023).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0024',
  'usage.key.slot.add',
  'usage_events',
  'applied',
  'R64: usage_events.key_slot column (0 = primary key, N = pool slot) + provider/slot index for the per-key usage aggregate on the /usage screen'
);
