-- 0025_vision_settings.sql
-- ROUND-66 (R66-2-b, owner directive B3+B5): the vision model moves OUT of
-- computer use into its OWN dedicated settings section (Settings → Image
-- Analysis). The owner: "remove the vision model from [computer use] and
-- create a DEDICATED section… allow the user to select it much more
-- properly… provider and model… paste in the API key", plus "without using
-- the computer use skill, the agent can just generally use [image
-- analysis]" — so the configuration becomes GLOBAL (computer-use
-- screenshots, embedded-browser screenshots, and the new analyze_image
-- tool all read it) and lives in its own keys.
--
-- What lands here (settings ROWS only — no DDL; behavior lives in
-- agent-core/src/storage/vision.ts + tools/plugins/vision.ts):
--   · vision.mode / vision.provider / vision.modelId — seeded from the R61
--     legacy rows (computerUse.vision.mode/provider/modelId) with
--     INSERT … SELECT: an ABSENT source key inserts nothing, and
--     INSERT OR IGNORE keeps any vision.* row the engine already wrote
--     (idempotent on every reopen + converges when only some legacy keys
--     exist).
--   · The legacy computerUse.vision.* rows STAY in the table (deliberately
--     not deleted — read-only compatibility): storage/computer-use.ts no
--     longer reads them, and getVisionSettings keeps the lazy fallback for
--     databases this migration has not touched.
--
-- No agent allowed_tools append: analyze_image registers through the
-- core-vision plugin for every turn (ADR-0019 — '[]' = ALL tools already
-- covers it; explicit USER-curated lists are the owner's authored surface,
-- the 0014/0021 curation-respect lesson). The tool is honest when vision
-- is OFF (a refusal pointing at Settings → Image Analysis), so it rides
-- un-gated by design — unlike the computer-use tools, which stay behind
-- the settings master switch.

INSERT OR IGNORE INTO settings (key, value)
SELECT 'vision.mode', value FROM settings WHERE key = 'computerUse.vision.mode';

INSERT OR IGNORE INTO settings (key, value)
SELECT 'vision.provider', value FROM settings WHERE key = 'computerUse.vision.provider';

INSERT OR IGNORE INTO settings (key, value)
SELECT 'vision.modelId', value FROM settings WHERE key = 'computerUse.vision.modelId';

-- Audit trail (pattern shared with 0014/0015/0021/0022/0023/0024).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0025',
  'vision.settings.split',
  'settings',
  'applied',
  'R66: vision.mode/provider/modelId seeded from the R61 computerUse.vision.* rows (INSERT…SELECT + OR IGNORE — absent sources insert nothing); legacy rows kept for read-only compatibility; ComputerUseSettings drops the vision block'
);
