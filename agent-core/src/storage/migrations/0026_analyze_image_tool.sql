-- 0026_analyze_image_tool.sql
-- ROUND-66 (R66, B3): the GENERAL image-analysis tool (analyze_image —
-- describe any local/URL image with the dedicated vision model, Settings →
-- Image Analysis) joins TOOL_NAMES. It is always registered like web_fetch,
-- so explicit-allowlist agents need it in their lists to use it.
--
-- SCOPE — the 0021 lessons baked in:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_CATALOG carries it since R66).
--   · COMPANION rule: a row whose allowlist lacks web_fetch has no
--     general-capability baseline and gets nothing appended.
--
-- Idempotent: rows that already list the tool are left untouched.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'analyze_image'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'web_fetch')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'analyze_image');

-- Audit trail (pattern shared with 0014/0021).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0026',
  'agent.tools.append',
  'agents',
  'applied',
  'appended analyze_image to template/default allowlists that include web_fetch ([] rows mean ALL tools; user curation untouched)'
);
