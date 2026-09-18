-- 0039_provider_lessons.sql
-- ROUND-105 (R105-C): the provider LESSONS table — the "lessons learned"
-- half of the rate-limit REASON taxonomy (modeled on the oh-my-pi study,
-- MIT; docs/planning/OMP-ADOPTION-ROADMAP.md candidate #3). Every
-- rate_limit failure whose body/status says WHY (quota | rate | capacity,
-- classified by agents/error-classification.ts's classifyRateLimitReason)
-- upserts a row here: (provider, model, reason) → count + first/last ts.
--
-- The table is WRITE-ONLY this round (no UI, no routes — the design-audit
-- ratchet and the Settings surfaces stay untouched): the rows accumulate
-- honestly in the owner's DB, ready for the R106 ModelsProvidersTab
-- surfacing ("this model burned its daily cap 14 times this week") and the
-- roles/fallback-chain work (the seeded chain learns from what actually
-- fails). Reads are exposed by storage/provider-lessons.ts
-- (listProviderLessons) for tests + the future routes only.
--
-- Shape notes:
--   · PRIMARY KEY (provider_id, model, reason) — one row per triplet; the
--     upsert bumps count + last_ts (first_ts survives).
--   · reason CHECK-constrained to the taxonomy — a future reason value
--     fails loudly at write time, never silently as a free-form string.
--   · model is the model ID string exactly as the turn resolved it (the
--     models table's model_id vocabulary, or a per-send override id).
CREATE TABLE IF NOT EXISTS provider_lessons (
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('quota', 'rate', 'capacity')),
  count INTEGER NOT NULL DEFAULT 1,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model, reason)
);
