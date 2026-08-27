-- 0015_memory.sql
-- ROUND-44 (R44-a, owner directive "complete the agentic coding
-- environment"): the agent MEMORY SYSTEM. Agents forgot everything between
-- turns/sessions — every chat started from zero. This migration adds the
-- per-project persistent memory table (durable facts / decisions /
-- preferences the agent saves via memory_save and recalls across
-- sessions), plus the memory_* tools to the seed allowlists.
--
-- The `memory` table is deliberately simple and append-heavy: one row per
-- saved knowledge item, scoped to a project, kinded (fact | decision |
-- preference | note) so the UI can group + color them. Content is capped
-- at 4000 chars by storage/memory.ts (validation happens in code, not SQL,
-- so the model gets a readable tool error instead of an SQLite exception).
--
-- Like 0014, new tools never reach EXISTING databases on their own: tool
-- lists are frozen at seed time, so memory_save / memory_recall /
-- memory_list are appended here to every template row and the default
-- Acute agent. User-created agents (is_template = 0 AND id !=
-- 'agt_default_nova') keep their deliberately-authored lists. Rows that
-- already list a tool are left untouched (idempotent).

CREATE TABLE memory (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('fact', 'decision', 'preference', 'note')),
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'agent',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_memory_project_updated ON memory (project_id, updated_at DESC);

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'memory_save'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'memory_save');

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'memory_recall'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'memory_recall');

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'memory_list'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'memory_list');

-- Audit trail (pattern shared with 0013/0014).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0015',
  'memory.system.create',
  'memory',
  'applied',
  'created the project memory table (fact|decision|preference|note) and appended memory_save + memory_recall + memory_list to template/default agent tool allowlists'
);
