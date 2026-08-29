-- 0019_repair_default_agent_tools.sql
-- ROUND-49: THE MIGRATION-DAMAGE REPAIR. Migrations 0014 + 0015 appended
-- delegate_task, browser_control and the three memory_* tools to
-- `(is_template = 1 OR id = 'agt_default_nova')` rows "when missing". But
-- the DEFAULT agent (agt_default_nova) is seeded with allowed_tools = '[]'
-- which per ADR-0019 means "ALL tools" — and json_insert on an empty array
-- turns that semantic into an EXPLICIT allowlist of exactly the appended
-- tools. On every existing install the default "Acute" agent therefore lost
-- its ENTIRE project tool set (list_dir, read_file, write_file, edit_file,
-- create_dir, delete_file, search_files, search_code, git_*, run_command,
-- todo_write, web_fetch, web_search, index_project) and kept only
-- [delegate_task, browser_control, memory_save, memory_recall, memory_list].
-- Both the main agent AND every sub-agent child (children run the parent's
-- agent row) then honestly reported "I have no file tools" — the owner's
-- round-48 Windows test hit exactly this.
--
-- The repair is FINGERPRINT-SCOPED, never blind: a row is reset to '[]'
-- (= ALL tools) only when its entire allowlist is a non-empty SUBSET of the
-- five tools migrations 0014/0015 could have appended. Any list that also
-- contains a real project tool (write_file, …) is a deliberate owner
-- restriction and is left untouched; templates were seeded with the full
-- TOOL_NAMES and are not touched by this migration.

UPDATE agents
SET allowed_tools = '[]',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'agt_default_nova'
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND NOT EXISTS (
    SELECT 1 FROM json_each(allowed_tools) AS t
    WHERE t.value NOT IN (
      'delegate_task', 'browser_control',
      'memory_save', 'memory_recall', 'memory_list'
    )
  );

-- Audit trail (pattern shared with 0013/0014/0015).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0019',
  'agent.tools.repair',
  'agents',
  'applied',
  'reset the default Acute agent allowlist to [] (ALL tools) when it was migration-damaged down to only the 0014/0015-appended orchestration/browser/memory tools'
);
