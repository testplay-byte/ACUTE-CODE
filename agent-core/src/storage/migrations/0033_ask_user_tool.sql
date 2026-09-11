-- 0033_ask_user_tool.sql
-- ROUND-87 (R87): the mid-task interactive question tool (ask_user — the
-- chat renders a question card with option pills + a custom answer input,
-- the turn waits for the owner) joins TOOL_NAMES.
--
-- SCOPE — the 0021/0026 lessons baked in verbatim:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_CATALOG carries it since R87).
--   · COMPANION rule: a row whose allowlist lacks todo_write has no
--     planning baseline and gets nothing appended (ask_user is the
--     clarification sibling of the planning pair).
--
-- Idempotent: rows that already list the tool are left untouched.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'ask_user'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'todo_write')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'ask_user');

-- Audit trail (pattern shared with 0014/0021/0026).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0033',
  'agent.tools.append',
  'agents',
  'applied',
  'appended ask_user to template/default allowlists that include todo_write ([] rows mean ALL tools; user curation untouched)'
);
