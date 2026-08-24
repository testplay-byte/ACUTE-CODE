-- 0005 (Checkpoints, round-25): file snapshots before agent mutations.
-- Every write_file/edit_file/delete_file stores the "before" content so the
-- user can revert any agent action. BLOB storage (not git) — simpler, no
-- git dependency, fits the sidecar model.
CREATE TABLE IF NOT EXISTS file_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  before_content BLOB,
  after_content BLOB,
  tool_name TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON file_snapshots(session_id);
