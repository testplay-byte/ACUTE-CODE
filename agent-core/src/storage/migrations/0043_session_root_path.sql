-- 0043_session_root_path.sql
-- ROUND-129 (R129-S, SCREENS.md §2 law #9 — the Scratchpad): per-session
-- workspace roots. The owner's directive: "each of its sessions will get a
-- separate folder in of itself, a separate workspace" — a Scratchpad
-- conversation's files must never share (and never pollute) another
-- Scratchpad conversation's folder, and deleting a session deletes its
-- whole folder (normal projects/sessions keep their files untouched — the
-- R129 delete-materiality law, §2 law #8).
--
--   · root_path TEXT — NULL for every NORMAL session (the project's
--     root_path IS the workspace — exactly the pre-R129 behavior; every
--     existing row composes byte-identically); set ONLY for Scratchpad
--     sessions, to <dataDir>/scratchpad/<sessionId>/ (created by
--     ensureScratchpadSessionWorkspace at session create; the row and the
--     folder are written together).
--
-- prepareTurn threads it as the EFFECTIVE ROOT override (tools, prompt
-- environment, modes, skills, custom rules, the system prompt's
-- "PROJECT: … at <root>" line — the model must believe its workspace is
-- the session folder), while the memory/index SCOPE stays project-scoped
-- (projectScope: project.id — the Scratchpad's project memory is
-- app-level; the FILE workspace is per-session). The delete path guards
-- the folder removal with a path-shape containment check (a DIRECT child
-- of the scratchpad root only — removeScratchpadSessionWorkspace).
--
-- No index: the column is read with the session row itself (PK lookup);
-- nothing scans sessions by root. Idempotent by the schema_migrations
-- bookkeeping (the house runner applies each file once, in one transaction
-- with its bookkeeping row — the same pattern every ADD COLUMN migration
-- since 0002 uses).

ALTER TABLE sessions ADD COLUMN root_path TEXT;

-- Audit trail (pattern shared with 0014/0041).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0043',
  'schema.column.add',
  'sessions',
  'applied',
  'R129 Scratchpad per-session workspace roots: sessions.root_path (NULL = the project root is the workspace — the pre-R129 behavior; set only for Scratchpad sessions to <dataDir>/scratchpad/<sessionId>/, threaded as prepareTurn''s effective root and deleted with the session, containment-guarded)'
);
