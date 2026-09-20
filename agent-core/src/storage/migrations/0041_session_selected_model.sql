-- 0041_session_selected_model.sql
-- ROUND-114 (R114-b, the sync foundation): the SERVER-SIDE session selected
-- model — the persistent tier between the per-send override and the agent
-- row. Until now the desktop's model pick lived ONLY in browser localStorage:
-- the phone rendered "Auto", a fresh browser started from the agent default,
-- and the two devices silently disagreed about which model the NEXT turn
-- would run on. sessions gains the pair:
--
--   · model_provider TEXT — the provider id the pick was made under (the
--     composer's picker is provider-grouped, R82); NULL when paired off.
--   · model_id       TEXT — the model id on that provider; NULL likewise.
--
-- BOTH NULL (the column default, i.e. every pre-R114 row) = "follow the
-- agent default" — exactly the pre-R114 behavior; prepareTurn's resolution
-- becomes per-send override → session.selectedModel → agent row, so an
-- absent pair composes byte-identically for every old session.
--
-- Writes flow through setSessionSelectedModel (storage/sessions.ts — the
-- storage choke point, validated at the route: complete pair, known +
-- configured provider, a models row or catalog entry match). NULLs are
-- written ONLY as a pair (the route never persists a half-pair), and the
-- read maps a half-written/corrupt row back to NULL (fail-open to the
-- agent default — a garbage row must never break a turn).
--
-- No index: the pair is read with the session row itself (PK lookup);
-- nothing scans sessions by model. Idempotent by the schema_migrations
-- bookkeeping (the house runner applies each file once, in one transaction
-- with its bookkeeping row — the same pattern every ADD COLUMN migration
-- since 0002 uses).

ALTER TABLE sessions ADD COLUMN model_provider TEXT;
ALTER TABLE sessions ADD COLUMN model_id TEXT;

-- Audit trail (pattern shared with 0014/0021/0026/0027/0028).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0041',
  'schema.column.add',
  'sessions',
  'applied',
  'R114 session selected model: sessions.model_provider + sessions.model_id (both NULL = follow the agent default — the pre-R114 behavior); three-tier prepareTurn resolution: per-send override → session.selectedModel → agent row'
);
