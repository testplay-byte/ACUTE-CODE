-- ROUND-40 (owner: "add notification functionality"): app-level notifications
-- for task complete/failed, permission requests, sub-agent transitions. The
-- owner wants the app to notify the user on various occasions — this table is
-- the persistent record; the SSE route (GET /api/v1/notifications/stream)
-- pushes live ones to the UI.
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  session_id  TEXT,
  project_id  TEXT,
  read        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notifications_ts   ON notifications(ts);
CREATE INDEX idx_notifications_read ON notifications(read);
