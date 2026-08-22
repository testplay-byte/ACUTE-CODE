-- Schema v1 (Phase 2 Wave 1). Types per shared/src/index.ts; ids, enums, and
-- timestamps are TEXT (ISO-8601). JSON columns hold JSON-encoded strings.

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id   TEXT,
  model         TEXT,
  vision_model  TEXT,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  memory_policy TEXT NOT NULL DEFAULT 'none'
                CHECK (memory_policy IN ('none', 'on-start', 'every-turn')),
  skills        TEXT NOT NULL DEFAULT '[]',
  max_turns     INTEGER NOT NULL DEFAULT 40,
  temperature   REAL NOT NULL DEFAULT 0.2,
  version       INTEGER NOT NULL DEFAULT 1,
  is_template   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  base_url   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  mode       TEXT NOT NULL CHECK (mode IN ('single', 'auto-team', 'manual')),
  status     TEXT NOT NULL,
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_status ON sessions (status);

-- Append-only event log (ADR-0010): one monotonic seq per session.
CREATE TABLE session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  ts         TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  ts            TEXT NOT NULL
);

CREATE INDEX idx_usage_events_session ON usage_events (session_id);
CREATE INDEX idx_usage_events_ts ON usage_events (ts);
CREATE INDEX idx_usage_events_provider_model ON usage_events (provider, model);

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  agent_id    TEXT,
  tool_call   TEXT,
  category    TEXT NOT NULL,
  status      TEXT NOT NULL,
  decided_by  TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

-- Insert-only; no API ever updates or deletes rows (ARCHITECTURE §5.1).
CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  actor    TEXT,
  action   TEXT,
  target   TEXT,
  decision TEXT,
  details  TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
