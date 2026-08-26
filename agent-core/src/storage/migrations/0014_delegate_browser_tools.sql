-- 0014_delegate_browser_tools.sql
-- ROUND-43: TOOL_NAMES (the seed allowlist for the five template agents and
-- the default Acute agent) never included delegate_task — meaning every
-- seeded agent was UNABLE to delegate to sub-agents, making the entire
-- orchestration layer unreachable from the templates the owner actually
-- uses. browser_control (R43-10) has the same staleness problem for any
-- database seeded before this round: tool lists are frozen at seed time and
-- new tools never reach existing rows.
--
-- This migration appends the two orchestration-era tools to the
-- allowed_tools JSON of every template row and the default Acute agent when
-- missing. It does not touch any other user-created agent (is_template = 0
-- AND id != 'agt_default_nova'): those were authored deliberately.
-- Child sub-agent tool sets are built in tools/index.ts and explicitly strip
-- delegate_task (one-level recursion guard) — adding it to templates/parents
-- is exactly how the design intends delegation to be reachable.
--
-- Rows that already list the tools are left untouched (idempotent).

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'delegate_task'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'delegate_task');

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'browser_control'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'browser_control');

-- Audit trail (pattern shared with 0013).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0014',
  'agent.tools.append',
  'agents',
  'applied',
  'appended delegate_task + browser_control to template/default agent tool allowlists'
);
