-- 0002 (Phase 2 Wave 2): bind a session to its agent. The Wave-1 schema kept
-- the team only inside session events; a column on the row lets the chat
-- runtime resolve its agent without replaying the append-only log.
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
