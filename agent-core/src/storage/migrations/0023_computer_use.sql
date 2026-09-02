-- 0023_computer_use.sql
-- ROUND-61 (R61, owner directive): the COMPUTER-USE system (per the uploaded
-- build-ready spec, computer-use-docs 01..12) + the VISION-MODEL separation
-- ("for the vision we are utilizing a separate model. The user can configure
-- our model for the vision itself… the provider completely separately", and
-- "if the main model supports vision then the user will be given an option
-- to configure that too") + user-added SKILLS ("the ability to add multiple
-- skills") + MCP SERVERS ("the ability to add MCP servers too").
--
-- What lands here (schema only — behavior lives in agent-core/src/computer/,
-- storage/computer-use.ts, storage/skills.ts, storage/mcp.ts):
--   · models.supports_vision   — per-model image-input flag, prefilled from
--     the ROUND-43 catalog's supportsVision when a model is added; editable
--     per row (same shape as supports_thinking).
--   · skills                   — SKILL.md-style prompt modules (progressive
--     disclosure: name+description ride the system prompt, the body is read
--     via the read_skill tool). source='builtin' rows are seeded by
--     storage/skills.ts at open (INSERT OR IGNORE — one fixed id per skill;
--     disabling hides them, deletion of built-ins is refused with a note).
--   · mcp_servers              — owner-configured stdio MCP servers; tools
--     bridge into the per-turn toolset as mcp__<server>__<tool> when the
--     server is enabled. Commands are OWNER-CONFIGURED ONLY (settings UI /
--     REST with the bearer wall) — never model-writable.
--
-- No agent allowed_tools append: ADR-0019 ('[]' = ALL tools already covers
-- every new tool) + the 0014/0021 curation-respect lesson (explicit user
-- allowlists are the owner's authored surface). On top of that the whole
-- computer-use plugin is gated by the settings master switch
-- (computerUse.enabled, default OFF) — no existing agent's behavior changes
-- until the owner turns it on.
--
-- Settings keys (settings table, no DDL needed): computerUse.enabled,
-- computerUse.permission, computerUse.vision.mode, computerUse.vision.provider,
-- computerUse.vision.modelId.

ALTER TABLE models ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('builtin', 'user')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (name)
);

CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  command     TEXT NOT NULL,
  args_json   TEXT NOT NULL DEFAULT '[]',
  env_json    TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (name)
);

-- TEMPLATE ALLOWLIST (the 0014/0021 lesson): read_skill is a GLOBAL
-- capability (the skills system is always-on like todo_write) — template
-- rows and the default agent get it appended so seeds can load skills on
-- day one. '[]' rows already mean ALL tools (no append needed); explicit
-- USER-curated lists are deliberately untouched (their authors can add the
-- tool in the agent form). The computer-use tools are NOT appended: they
-- are the settings-gated surface (computerUse.enabled, default OFF) — a
-- gated tool in an allowlist would be dead weight.

UPDATE agents
SET allowed_tools = json_insert(allowed_tools, '$[#]', 'read_skill'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (is_template = 1 OR id = 'agt_default_nova')
  AND json_valid(allowed_tools)
  AND json_array_length(allowed_tools) > 0
  AND NOT EXISTS (SELECT 1 FROM json_each(allowed_tools) WHERE json_each.value = 'read_skill');

-- Audit trail (pattern shared with 0014/0015/0021/0022).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0023',
  'computer.use.system.create',
  'models,skills,mcp_servers',
  'applied',
  'R61: models.supports_vision column + skills table (SKILL.md-style modules, progressive disclosure) + mcp_servers table (owner-configured stdio MCP). computer-use tools are settings-gated (default OFF) — no agent allowlist was touched (ADR-0019 + curation-respect)'
);
