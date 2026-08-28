-- 0017_browser_cookies.sql
-- ROUND-46 (R46-d): BROWSER-PROXY COOKIE PERSISTENCE. The R43 embedded
-- browser was a fetch-based URL-rewriting proxy with NO cookie handling at
-- all (the honest v1 note in browser-proxy.ts: "logins do NOT persist") —
-- every hop was credentially naked, so any site needing a session cookie
-- logged the embedded browser out on every page load. This migration adds
-- the durable per-project cookie store behind the new CookieJar
-- (storage/browser-cookies.ts + browser-proxy.ts wiring).
--
-- One row per (project_id, name, domain, path) — the RFC 6265 cookie
-- identity. `value` is the cookie VALUE ONLY (never logged, never routed,
-- never shown in tool output — the browser_control get_state surface is
-- unchanged). `expires_at` NULL = a session cookie; session cookies are
-- stored DURABLY ON PURPOSE: surviving a sidecar restart is the entire
-- point of this table (a normal browser would hold them in memory, but our
-- "browser" is the sidecar process itself — losing them on restart would
-- reintroduce the bug this migration closes). Expired rows are dropped by
-- the storage layer at restore AND at save, so the table self-prunes.
--
-- Profiles: cookies are scoped to a browser-session PROFILE id. Real
-- profiles are project ids (POST /browser/session accepts body.projectId);
-- sessions minted without one share the "_default" profile. Jars never
-- cross profiles.

CREATE TABLE browser_cookies (
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '/',
  value       TEXT NOT NULL,
  expires_at  TEXT,
  host_only   INTEGER NOT NULL DEFAULT 0,
  secure      INTEGER NOT NULL DEFAULT 0,
  http_only   INTEGER NOT NULL DEFAULT 0,
  stored_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, name, domain, path)
);

CREATE INDEX idx_browser_cookies_project ON browser_cookies (project_id);

-- Audit trail (pattern shared with 0013/0014/0015/0016).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0017',
  'browser.cookies.create',
  'browser_cookies',
  'applied',
  'R46-d: durable per-project cookie jar for the embedded-browser proxy — one row per (project_id, name, domain, path), session cookies durable by design (restart survival), expired rows pruned at restore+save'
);
