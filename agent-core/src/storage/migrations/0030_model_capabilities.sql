-- 0030_model_capabilities.sql
-- ROUND-82 (R82, owner: "when editing the models … proper options … vision,
-- audio, video" capability support selection): per-model capability flags.
--
-- DESIGN (the spec's risk-#10 decision): the new columns are NULLABLE
-- TRI-STATE — NULL = unknown, 0 = explicitly off, 1 = explicitly on. The
-- 0004-era columns (supports_thinking, supports_vision) are NOT NULL
-- DEFAULT 0, which conflates "false" with "unknown" — exactly the lie the
-- owner is complaining about for NIM/custom rows (no catalog source ever
-- sets them, so they render as OFF when the truth is "unknown"). The new
-- columns never conflate: a NIM row starts NULL (unknown) and the edit
-- dialog's tri-state control shows it as such.
--
-- BACKFILL: code-side (db.ts calls backfillModelCapabilityFlags after the
-- migrations run — see storage/models.ts). Catalog rows scoped to the
-- OPENROUTER provider get their supports_tools bit from the ROUND-43
-- catalog; everything else stays NULL until the owner sets it. The catalog
-- describes OpenRouter-hosted variants, so the scoping is honest — a NIM
-- row sharing the model_id string must not inherit OpenRouter's metadata.
--
-- No supports_thinking/supports_vision ALTERs here: those columns keep
-- their NOT NULL 0/1 contract (the whole test surface pins them); the
-- dialog renders their "unknown" case only for never-touched rows via the
-- same backfill hint. (Renaming supportsThinking → "Reasoning" is
-- API-speak only — the field name is wire-compatible.)

ALTER TABLE models ADD COLUMN supports_tools INTEGER;
ALTER TABLE models ADD COLUMN supports_audio INTEGER;
ALTER TABLE models ADD COLUMN supports_video INTEGER;
