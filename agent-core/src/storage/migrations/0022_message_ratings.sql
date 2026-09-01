-- 0022_message_ratings.sql
-- ROUND-59 (R59-D, owner directive: "add the options to mark the responses
-- as good or bad, and all of these will be tracked and saved. I can send
-- you each one of those, and you can determine what went wrong: did it
-- perform the request which it was given properly or not? The full context
-- will be properly shared."): the RESPONSE RATING system. Every assistant
-- reply can be rated good/bad (with an optional owner note); the rating is
-- persisted WITH A FULL CONTEXT SNAPSHOT captured at rate time (the turn's
-- user message, the reply, the tool calls, any turn error) so the dev agent
-- can analyze what went wrong and improve the system prompts. The snapshot
-- lives in context_json (built by storage/ratings.ts, bounded: content
-- fields capped, tool events capped) and makes each rating IMMUTABLE
-- EVIDENCE — later revert/fork/delete of the session cannot alter what was
-- rated.
--
-- No FK on sessions — the repo's deliberate no-FK convention (schema v1;
-- see the deleteSession comment in storage/sessions.ts). Two consequences,
-- both intended:
--   · deleting a session LEAVES its rating rows behind (the rating outlives
--     the conversation: context_json is self-contained, so the analysis
--     path keeps working on the evidence);
--   · UNIQUE (session_id, assistant_seq) can never collide with a new
--     session (ids are fresh uuids).
-- UNIQUE (session_id, assistant_seq) is the upsert key: re-rating the same
-- reply OVERWRITES rating/note/context in place (storage/ratings.ts keeps
-- created_at, updates updated_at) — one verdict per reply, changeable.

CREATE TABLE message_ratings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  assistant_seq INTEGER NOT NULL,
  rating        TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  note          TEXT,
  context_json  TEXT NOT NULL,
  model         TEXT,
  agent_id      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (session_id, assistant_seq)
);

CREATE INDEX idx_message_ratings_session ON message_ratings (session_id, assistant_seq);

-- Audit trail (pattern shared with 0014/0015/0018/0021).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0022',
  'ratings.system.create',
  'message_ratings',
  'applied',
  'R59-D: created the response-rating table (good|bad per assistant reply, optional note, full context snapshot in context_json) — no FK on sessions by the repo convention, ratings deliberately outlive session delete/revert/fork'
);
