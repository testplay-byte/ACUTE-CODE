-- 0016_web_host_rules.sql
-- ROUND-45 (audit P0-5): WEB TOOLS GATE. web_fetch (and browser_control
-- navigate) made ungated outbound calls with arbitrary, model-controlled
-- URLs — an exfiltration channel for prompt-injected content. The spec
-- requires every outbound call to be gated.
--
-- Gating model (approvals.ts decideWebFetch / requestWebFetchApproval):
--   1. host on the project's always-allow list (this table)  → run (rule)
--   2. host on the curated global default allowlist          → run (auto)
--   3. anything else                                         → ASK the owner
--      (interactive streamed turns wait for the decision — "always allow"
--      on the approval card INSERTS a row here; sync turns + sub-agent
--      children fail fast with a clear note). Non-http(s) schemes deny.
--
-- web_search stays auto-tier: it only talks to FIXED endpoints
-- (html.duckduckgo.com / lite.duckduckgo.com / en.wikipedia.org) — the
-- user/model-controlled part is the QUERY, which is secret-scrubbed in
-- tools/index.ts before it leaves the machine.
--
-- The USER-driven browser panel (typing in the address bar) is a human
-- action, not an agent tool call — ungated by design.

CREATE TABLE web_host_rules (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  host        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, host)
);

CREATE INDEX idx_web_host_rules_project ON web_host_rules (project_id);

-- Audit trail (pattern shared with 0013/0014/0015).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0016',
  'security.web-host-rules.create',
  'web_host_rules',
  'applied',
  'P0-5: per-project always-allow host rules gating web_fetch and browser_control navigate (audit round-42 Track 1)'
);
