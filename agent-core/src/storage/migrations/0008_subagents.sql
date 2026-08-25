-- ROUND-36 (ADR-0022): sub-agent sessions. Children are real sessions with a
-- parent link + the delegated role; excluded from GET /sessions by default.

ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN sub_role TEXT;

CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
