-- 0028_delegation_task_id.sql
-- ROUND-79 (R79-a, the orchestrator round: delegate_task task_id/background/
-- resume): the ADDRESSABLE-delegation tier of the R71 sub-agent discipline.
-- Two pieces land here:
--
-- 1) sessions.delegate_task_id — the PARENT's own address for a delegated
--    child (the task_id the parent model chose at delegation time). NULL =
--    an ordinary unaddressed delegation (every pre-R79 child and every
--    task_id-less delegate_task call stays EXACTLY today's behavior; the
--    migration default is NULL). Set ONLY through createSession's
--    SessionInput.taskId (the delegate_task tool path, after the
--    ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ validation + the duplicate/cap gates
--    in the orchestrator); it is immutable for the child's lifetime (a
--    resumed child keeps its address — resume resolves by it).
--
-- 2) idx_sessions_parent_task — the composite (parent_session_id,
--    delegate_task_id) index the R79 readers hit: the duplicate-task_id
--    refusal check, the ≥10-outstanding fan-out cap, and prepareTurn's
--    cheap background-tasks guard query (the per-turn reminder only pays
--    for children WITH an address — every other session composes
--    byte-identically and costs one indexed LIMIT 1 probe).
--
-- No agent-allowlist curation touches this migration (delegate_task needs
-- no new tool name — the SAME tool gained task_id/background/resume
-- parameters). Idempotent: the ALTER is one-shot by the
-- schema_migrations bookkeeping (the house runner applies each file once,
-- in one transaction with its bookkeeping row — the same pattern every
-- ADD COLUMN migration since 0002 uses).

ALTER TABLE sessions ADD COLUMN delegate_task_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_parent_task
  ON sessions(parent_session_id, delegate_task_id);

-- Audit trail (pattern shared with 0014/0021/0026/0027).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0028',
  'schema.column.add',
  'sessions',
  'applied',
  'R79 delegation addressing: sessions.delegate_task_id column (NULL default = pre-R79 behavior) + idx_sessions_parent_task(parent_session_id, delegate_task_id) for the duplicate/cap/guard lookups'
);
