-- 0036_search_skills_tool.sql
-- ROUND-96 (R96-D): the skills DISCOVERY tool (search_skills — fuzzy search
-- over the effective skills index: names, descriptions, reference titles)
-- joins TOOL_NAMES next to read_skill.
--
-- SCOPE — the 0021/0026/0033 lessons baked in verbatim:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_CATALOG carries it since R96).
--   · COMPANION rule: a row whose allowlist lacks read_skill has no skills
--     baseline and gets nothing appended (search_skills is the discovery
--     sibling of the loader pair).
--
-- Idempotent: rows that already list the tool are left untouched.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'search_skills'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'read_skill')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'search_skills');

-- Audit trail (pattern shared with 0014/0021/0026/0033).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0036',
  'agent.tools.append',
  'agents',
  'applied',
  'appended search_skills to template/default allowlists that include read_skill ([] rows mean ALL tools; user curation untouched)'
);
