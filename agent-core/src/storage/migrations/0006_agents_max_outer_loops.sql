-- 0006_agents_max_outer_loops.sql
-- Round 28 WS-F: multi-turn agentic continuation.
--
-- Owner R28 directive: "It should automatically continue with the next
-- sessions… 4, 5, 6, or 7 iterations… research → save files → restart →
-- next research."
--
-- Adds max_outer_loops (default 5) — the runtime's outer-loop cap. After the
-- AI SDK's internal multi-step loop ends (up to max_turns tool round-trips),
-- the runtime checks if the task is genuinely complete (explicit completion
-- signal AND all todos completed); if not, it starts a NEW SDK call with the
-- continued conversation context. 5 outer loops × 80 max_turns = 400 tool
-- round-trips max per user message.
--
-- Also bumps the default max_turns 40 → 80 for more headroom on complex tasks.

ALTER TABLE agents ADD COLUMN max_outer_loops INTEGER NOT NULL DEFAULT 5;

-- Backfill: existing agents with the old default 40 get the new 80; any with
-- max_outer_loops NULL (shouldn't happen with DEFAULT 5, but defensive) get 5.
UPDATE agents SET max_turns = 80 WHERE max_turns = 40 OR max_turns IS NULL;
UPDATE agents SET max_outer_loops = 5 WHERE max_outer_loops IS NULL OR max_outer_loops = 0;
