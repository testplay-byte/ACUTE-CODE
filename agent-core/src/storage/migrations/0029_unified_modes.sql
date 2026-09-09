-- 0029_unified_modes.sql
-- ROUND-81 (R81, the owner-directed unified mode picker): ONE selector of
-- exactly THREE operating modes — Full Access ("full"), Ask ("ask"),
-- Plan ("plan") — replacing BOTH the four-value permission switcher
-- (full/ask/plan/editor, R50-c1) AND the six-builtin task-mode picker
-- (plan/debug/build/review/explore/refactor, R73/R75) in the UI. The
-- task-mode tier survives as NON-ENFORCING posture guidance the agent
-- self-selects via switch_mode (ADR-0029); the permission tier carries
-- ALL enforcement.
--
-- DATA MAPPING (both statements are the safety net for the R75
-- read-only guarantee — do not skip either):
--
-- 1) editor → ask: the retired "editor" value (file tools, no run_command)
--    maps to "ask" — FAIL-CLOSED. Editor had no terminal at all, and ask
--    is the only operating mode that still gates commands, so nothing the
--    owner had is silently widened. (Mapping to "full" would GRANT
--    unattended terminal access the owner never had.)
--
-- 2) read-only postures → plan: under R75, a session whose active_mode was
--    plan/review/explore was HARD read-only regardless of its permission
--    mode (the task-mode policy narrowed after the permission gate). The
--    enforcement moves entirely to the permission tier in R81, so those
--    sessions become permission_mode='plan' — the owner demonstrably
--    wanted read-only, and erring read-only is fail-closed (one click
--    switches to Ask). Sessions in the working postures (debug/build/
--    refactor, customs, NULL) keep their permission mode unchanged.
--
-- active_mode itself is KEPT (ADR-0029 Option A: the posture pointer rides
-- the row; switch_mode + PATCH /sessions/:id {activeMode} remain the
-- posture surface). No CHECK constraints exist on either column (verified
-- against migrations 0020/0027 — plain ADD COLUMN), so nothing to alter.
--
-- Idempotent: pure UPDATE statements (no schema change) — re-running on an
-- already-migrated database matches zero rows. One-shot by the
-- schema_migrations bookkeeping (the house runner applies each file once,
-- in one transaction with its bookkeeping row).

UPDATE sessions SET permission_mode = 'ask' WHERE permission_mode = 'editor';

UPDATE sessions
SET permission_mode = 'plan'
WHERE active_mode IN ('plan', 'review', 'explore')
  AND permission_mode <> 'plan';

-- Audit trail (pattern shared with 0014/0021/0026/0027/0028).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0029',
  'session.mode.unify',
  'sessions',
  'applied',
  'R81 unified operating modes: editor permission_mode → ask (fail-closed); read-only R75 postures (active_mode plan/review/explore) → permission_mode plan; active_mode kept as the non-enforcing posture pointer (ADR-0029)'
);
