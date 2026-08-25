-- ROUND-37 approvals v1 (owner: "If it tries to run some commands which are
-- not approved… it should properly and clearly highlight it with me and ask
-- me for permission and wait for my permission on it. It should also give me
-- options to allow it always or allow it this time").
--
-- The 0001 approvals table existed but was never written. This migration
-- extends it with project scoping + the remember bookkeeping, and adds the
-- project-scoped "always allow" rules (EXACT command match — prefix rules
-- are deliberately excluded: predictable and safe).
ALTER TABLE approvals ADD COLUMN project_id TEXT;
ALTER TABLE approvals ADD COLUMN remember TEXT;
ALTER TABLE approvals ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS approval_rules (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  command     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_lookup ON approval_rules (project_id, command);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);
