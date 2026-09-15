-- 0037_skills_always_load.sql
-- ROUND-98 (R98-E2, the owner: "there are some skills which it must follow
-- every single time, every single session" — the webpage-design failure:
-- ui-design/frontend-craft were one-line index entries the model never
-- read): the ALWAYS-LOAD tier. A pinned skill's FULL BODY rides the system
-- prompt every turn (the "## ALWAYS-ON SKILLS" section, prompts.ts) instead
-- of waiting for read_skill.
--
-- Deliberately a DB flag (not a file-only convention) so the OWNER can pin
-- a BUILT-IN from the Settings UI — pinning ui-design is the motivating
-- case. File skills reach the same tier via SKILL.md frontmatter
-- `always-load: true` (skills-files.ts); DB rows shadow same-name files for
-- the flag exactly as they already do for the body.
--
-- Default 0: nothing is pinned on upgrade — the composed prompt stays
-- byte-identical for every existing project (pinned by the golden fixture
-- test + the r98 zero-pinned byte-identity pin). The seed's INSERT OR
-- IGNORE statement lists no always_load column, so seeds stay 0 too.

ALTER TABLE skills ADD COLUMN always_load INTEGER NOT NULL DEFAULT 0;

-- Audit trail (the 0014/0021/0026/0033/0034/0036 pattern).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0037',
  'schema.skills.always_load',
  'skills',
  'applied',
  'the always-load tier: pinned skills ride the system prompt every turn (R98-E2)'
);
