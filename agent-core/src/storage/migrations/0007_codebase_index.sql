-- 0007_codebase_index.sql
-- Round 28 WS-G: project indexing & codebase awareness.
--
-- Owner R28 directive: "Implement proper project or such indexing so that
-- our model properly knows about the project, can manage it, can handle
-- things."
--
-- A lightweight regex-based symbol index (no full AST — keeps the dep tree
-- tiny). The index_project tool walks the tree, extracts functions/classes/
-- constants/types/interfaces/imports per file, and stores rows here. The
-- runtime injects an "index summary" into the system prompt context so the
-- agent has codebase awareness without needing to list_dir + read_file
-- every file every turn.

CREATE TABLE IF NOT EXISTS codebase_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                 -- root-relative, '/' separators
  symbol TEXT NOT NULL,               -- function/class/const/variable name
  kind TEXT NOT NULL CHECK (kind IN ('function','class','const','variable','import','type','interface')),
  line INTEGER NOT NULL,              -- 1-based
  line_end INTEGER,                   -- for multi-line symbols (nullable)
  signature TEXT,                      -- function signature, class heritage, etc.
  docstring TEXT,                      -- first comment block (nullable)
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, path, symbol, line)
);

CREATE INDEX IF NOT EXISTS idx_codebase_index_project ON codebase_index(project_id);
CREATE INDEX IF NOT EXISTS idx_codebase_index_symbol ON codebase_index(project_id, symbol);
CREATE INDEX IF NOT EXISTS idx_codebase_index_path ON codebase_index(project_id, path);
