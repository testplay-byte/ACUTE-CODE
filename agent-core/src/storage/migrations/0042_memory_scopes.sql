-- 0042_memory_scopes.sql
-- ROUND-117 (R117-b, the owner: the memory system "apparently does not work"
-- root cause #3: "Workspace memory and system memory were never built —
-- SPEC §F8/ARCHITECTURE/API.md document a Hermes-style per-agent markdown
-- memory (incl. phantom REST endpoints) that has zero code. Only project-
-- scoped memory exists."): the WORKSPACE memory tier. Cross-project facts
-- (the owner's identity/preferences/environment truths) get a real scope
-- alongside project memory, and future sessions compose BOTH digests.
--
-- The scope is additive to the existing table:
--   · scope TEXT NOT NULL DEFAULT 'project' CHECK (project|workspace) —
--     every pre-0042 row is project memory by definition (the default
--     carries the entire legacy table over verbatim).
--   · project_id becomes NULLABLE: a workspace row carries project_id NULL
--     + scope 'workspace' (it belongs to no project). SQLite cannot ALTER a
--     column's NOT NULL constraint, so this migration is the sanctioned
--     12-step TABLE REBUILD — create memory_scoped, copy, drop, rename. The
--     memory table is leaf data (no foreign keys point at it, no other
--     table references it — verified: the only SQL over `memory` lives in
--     storage/memory.ts), so the rebuild is a plain copy inside one
--     transaction.
--   · Indexes: the legacy (project_id, updated_at DESC) index is recreated
--     scoped to project rows, plus a partial workspace index
--     (updated_at DESC WHERE scope = 'workspace') — the two listing/digest
--     paths each get their covering index.
--
-- The episodic leg of the same round: session_recall (the model-facing
-- search over PAST SESSIONS — storage/sessions.ts searchSessions) joins
-- TOOL_NAMES in the memory family. The 0038 scope lessons verbatim:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_CATALOG carries it since R117-b).
--   · COMPANION rule: a row whose allowlist lacks memory_recall has no
--     memory baseline and gets nothing appended (session_recall is the
--     episodic sibling of the memory-recall pair).
-- Idempotent: rows that already list the tool are left untouched.

CREATE TABLE memory_scoped (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  scope       TEXT NOT NULL DEFAULT 'project'
              CHECK (scope IN ('project', 'workspace')),
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('fact', 'decision', 'preference', 'note')),
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'agent',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO memory_scoped (id, project_id, scope, kind, content, source, created_at, updated_at)
SELECT id, project_id, 'project', kind, content, source, created_at, updated_at FROM memory;

DROP TABLE memory;
ALTER TABLE memory_scoped RENAME TO memory;

CREATE INDEX idx_memory_project_updated ON memory (project_id, updated_at DESC);
CREATE INDEX idx_memory_workspace_updated ON memory (updated_at DESC) WHERE scope = 'workspace';

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'session_recall'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'memory_recall')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'session_recall');

-- Audit trail (pattern shared with 0014/0038).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0042',
  'memory.scopes.create',
  'memory',
  'applied',
  'rebuilt the memory table with the scope column (project|workspace; project_id now nullable for workspace rows) and appended session_recall to template/default allowlists that include memory_recall'
);
