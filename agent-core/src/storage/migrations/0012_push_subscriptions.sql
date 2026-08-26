-- ROUND-42: Web Push subscriptions (owner: "after a task is completed I
-- should get a desktop notification" — including when the app window is
-- CLOSED; only a service worker + Web Push can do that from a browser app).
-- One row per browser PushSubscription (endpoint is unique + authoritative;
-- re-subscribes upsert). The VAPID keypair lives OUTSIDE the DB (next to it,
-- vapid.json in the same directory as the SQLite file) because it is a
-- machine-scoped identity, not app data — but subscriptions ARE app data
-- (they die with the profile that created them).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
