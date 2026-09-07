-- 0027_task_modes.sql
-- ROUND-73 (R73-b, the task-modes round): the POSTURE tier of the owner's
-- directive ("proper detailed system prompts which the agent accesses when
-- required and on the basis of the task"). Two pieces land here:
--
-- 1) sessions.active_mode — the session's ACTIVE TASK MODE id (NULL = the
--    default posture; migration default is NULL, so every existing session
--    stays EXACTLY today's behavior). Set/cleared via PATCH /sessions/:id
--    { activeMode: "…" | null } and the switch_mode tool; resolved at turn
--    time against resolveEffectiveModes(project root) — a VANISHED custom
--    mode (.acute/agents/<file>.md removed) is cleared honestly by
--    prepareTurn with a one-turn notice. While set, the mode's deep posture
--    module rides the system prompt's ACTIVE TASK MODE section (the prompt
--    registry's "active-mode" entry; the available-mode INDEX rides
--    "task-modes" right after "skills").
--
-- 2) switch_mode joins TOOL_NAMES (the always-registered session capability
--    that activates/clears/lists task modes). Explicit-allowlist agents need
--    it in their lists to use it.
--
-- SCOPE — the allowlist append, the 0021/0026 lessons baked in:
--   · '[]' rows mean "ALL tools" (ADR-0019) — already include it; untouched.
--   · Curation respect: template rows + the default Acute agent only;
--     user-authored agents are never widened (the agent form lists the tool
--     — TOOL_NAMES carries it since R73).
--   · COMPANION rule: a row whose allowlist lacks read_skill has no
--     mode-capable baseline (a mode-capable agent is one that can read
--     skills — the R73 pairing: posture picks the stance, skills carry the
--     craft) and gets nothing appended.
--
-- Idempotent: rows that already list the tool are left untouched. The ALTER
-- is one-shot by the schema_migrations bookkeeping (the house runner applies
-- each file once, in one transaction with its bookkeeping row — the same
-- pattern every ADD COLUMN migration since 0002 uses).

ALTER TABLE sessions ADD COLUMN active_mode TEXT;

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'switch_mode'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'read_skill')
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'switch_mode');

-- Audit trail (pattern shared with 0014/0021/0026).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0027',
  'agent.tools.append',
  'agents',
  'applied',
  'R73 task modes: sessions.active_mode column (NULL default = pre-R73 behavior) + switch_mode appended to template/default allowlists that include read_skill ([] rows mean ALL tools; user curation untouched)'
);
