-- 0038_search_symbols_tool.sql
-- ROUND-98 (R98-F3): the SYMBOL-INDEX query tool (search_symbols — the
-- owner's "Implement grep functionality. Handle it properly. Look into
-- indexing… essential for larger projects with a lot of files, folders,
-- subfolders") joins TOOL_NAMES in the search family next to search_code.
--
-- SCOPE — the 0021/0026/0033/0036 lessons baked in verbatim:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_CATALOG carries it since R98).
--   · COMPANION rule: a row whose allowlist lacks search_code has no
--     code-search baseline and gets nothing appended (search_symbols is the
--     index-query sibling of the content-search pair).
--
-- Idempotent: rows that already list the tool are left untouched.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'search_symbols'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'search_code')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'search_symbols');

-- Audit trail (pattern shared with 0014/0021/0026/0033/0036).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0038',
  'agent.tools.append',
  'agents',
  'applied',
  'appended search_symbols to template/default allowlists that include search_code ([] rows mean ALL tools; user curation untouched)'
);
