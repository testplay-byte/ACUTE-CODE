-- 0034_computer_element_map.sql
-- ROUND-93 (R93, the computer-use v2 rework — the owner's "full-fledged
-- computer use functionality" directive): the LEARNING layer. Three tables
-- give the computer-use module persistent element identity, scan diffing
-- (new/lost deltas), per-app profiles, and action reliability counters.
-- See docs/architecture/COMPUTER-USE-V2.md §2.3 for the design truth.
--
-- Deliberately SEPARATE from the session/snapshot machinery: this is
-- observation memory (what the agent has SEEN), not control state. Nothing
-- existing reads these tables — only computer/element-map.ts writes and
-- reads them, so the module stays independently editable.

-- One row per observation (a registered snapshot from get_app_state or
-- find_elements). The agent-facing scan deltas ride the tool results; the
-- rows are the queryable history (the UI's scan log + future analytics).
CREATE TABLE IF NOT EXISTS computer_scan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  app_pid INTEGER,
  window_title TEXT NOT NULL,
  window_id INTEGER,
  duration_ms INTEGER NOT NULL,
  total INTEGER NOT NULL,
  by_category TEXT NOT NULL DEFAULT '{}',
  new_count INTEGER NOT NULL DEFAULT 0,
  lost_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_computer_scan_session ON computer_scan(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_computer_scan_app ON computer_scan(app_name, ts);

-- The per-app element REGISTRY — the identity that survives scans and
-- restarts. identity_hash = app + window title + kind + name + quantized
-- rect (see element-map.ts; quantization tolerates ~8px jitter so a
-- re-rendered window does not fork every row).
CREATE TABLE IF NOT EXISTS computer_element (
  identity_hash TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  window_title TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  path TEXT,
  category TEXT,
  via TEXT,
  interactive INTEGER NOT NULL DEFAULT 1,
  rect_json TEXT,
  flags_json TEXT,
  click_count INTEGER NOT NULL DEFAULT 0,
  verify_success_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_computer_element_app ON computer_element(app_name, window_title);

-- Per-app learned structure: which windows exist, how stable the elements
-- are, and the last scan's delta (the "it learns programs" summary).
CREATE TABLE IF NOT EXISTS computer_app_profile (
  app_name TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  scan_count INTEGER NOT NULL DEFAULT 1,
  window_titles TEXT NOT NULL DEFAULT '[]',
  element_count INTEGER NOT NULL DEFAULT 0,
  stable_element_count INTEGER NOT NULL DEFAULT 0,
  last_scan_json TEXT
);

-- Audit trail (the 0014/0033 pattern).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0034',
  'schema.computer_element_map',
  'computer_scan, computer_element, computer_app_profile',
  'applied',
  'the computer-use v2 learning layer: scan history + element identity registry + per-app profiles (R93)'
);
