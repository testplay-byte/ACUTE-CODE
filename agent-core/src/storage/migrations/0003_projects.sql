-- 0003 (Agentic Coding MVP): first-class projects. A project pins a workspace
-- root folder on disk; sessions reference their project via the project_id
-- column that 0001 already reserved. Deletion unregisters the row only —
-- files on disk are never touched by this migration or the API.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#FF6B2C',
  created_at TEXT NOT NULL
);
