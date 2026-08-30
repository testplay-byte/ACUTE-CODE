-- 0020_permission_modes_attachments.sql
-- ROUND-50 (R50-c1, the owner's composer round): two additive columns for
-- the new chat composer backend.
--
-- 1) sessions.permission_mode — the composer's permission-mode switcher
--    (Full Access / Ask / Plan / Editor). Stored PER SESSION (the mode is a
--    property of the conversation, not the agent); sub-agent children copy
--    their parent's mode at delegation (orchestrator.ts createSession), so
--    delegated work can never outrun the posture the owner picked. Existing
--    rows default to 'ask' — EXACTLY today's behavior (ask-tier approval
--    gates wait on the owner; the full tool set stays available). The mode
--    is enforced at turn time in runtime.ts prepareTurn (the effective tool
--    set) and approvals.ts (ask-tier gates auto-approve in 'full' mode;
--    denylist-supreme refusals are never bypassed in ANY mode).
--
-- 2) usage_events.cached_input_tokens — the context meter's cache-hit-rate
--    line. OpenRouter reports prompt tokens served from its cache as
--    `prompt_tokens_details.cached_tokens`; AI SDK v7 surfaces that as
--    usage.inputTokenDetails.cacheReadTokens, which chat.ts now normalizes
--    into the turn's usage record. Nullable: providers without a cached
--    tier (and rows written before this migration) legitimately have no
--    value — SUMs treat NULL as 0.

ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';

ALTER TABLE usage_events ADD COLUMN cached_input_tokens INTEGER;

-- Audit trail (pattern shared with 0013/0014/0015/0016/0017/0018/0019).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0020',
  'sessions.permission_mode+usage_events.cached_input_tokens',
  'sessions,usage_events',
  'applied',
  'R50-c1 composer backend: per-session permission modes (full|ask|plan|editor, default ask = pre-R50 behavior) + cached prompt-token capture for the context meter cache hit rate'
);
