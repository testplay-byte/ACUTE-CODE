-- 0021_background_job_tools.sql
-- ROUND-52 (R52-a): the background-job supervision tools (job_status,
-- job_stop) join TOOL_NAMES — run_command now resolves detached launches
-- (`start /B … > log 2>&1`, `… &`, nohup) immediately with a job id, and the
-- agent needs these tools to poll and stop what it started (the owner's
-- round-52 case: the agent started a server and then waited 10+ minutes
-- without ever checking status).
--
-- SCOPE — two lessons from earlier migrations are baked in:
--   · LESSON 0019: allowed_tools '[]' means "ALL tools" (ADR-0019) —
--     appending to an empty array would turn that semantic into an explicit
--     allowlist of ONLY the appended tools and strip every project tool.
--     '[]' rows already include every tool by definition; no append needed.
--   · LESSON 0014 (curation respect): the append follows the 0014/0015
--     SCOPE — template rows + the default Acute agent only. User-created
--     agents are deliberately authored and never widened (their authors can
--     add the tools in the agent form — TOOL_CATALOG lists them since R52).
--     Within that scope the COMPANION rule applies: a row whose allowlist
--     lacks run_command has nothing to supervise and gets no job tools.
--
-- Idempotent: rows that already list a tool are left untouched.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'job_status'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'run_command')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'job_status');

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'job_stop'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'run_command')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'job_stop');

-- Audit trail (pattern shared with 0014).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0021',
  'agent.tools.append',
  'agents',
  'applied',
  'appended job_status + job_stop to template/default allowlists that include run_command ([] rows mean ALL tools; user curation untouched)'
);
