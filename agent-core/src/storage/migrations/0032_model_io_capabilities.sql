-- 0032_model_io_capabilities.sql
-- ROUND-87 (R87, owner: "configure which kinds of inputs this model accepts …
-- configure which kinds of outputs this model can provide"): the INPUT/OUTPUT
-- capability columns + the human-facing size label.
--
-- DESIGN (follows migration 0030's tri-state contract exactly):
--   NULL = unknown (never set, no catalog source — the honest default)
--   0    = explicitly off
--   1    = explicitly on
--
-- INPUT side:
--   supports_pdf — PDF document input. Text is always accepted (locked in
--   the UI), images ride the R61 supports_vision column, videos the R82
--   supports_video column; PDF is the only NEW input column.
--
-- OUTPUT side:
--   supports_text_output / supports_image_output / supports_video_output /
--   supports_audio_output — what the model can PRODUCE. Text output is
--   the chat-completions default (the dialog renders unknown as ON for
--   text and the user can turn it off); image/video/audio default
--   unknown → rendered OFF.
--
--   The R82 tool-use (supports_tools) and reasoning (supports_thinking)
--   flags stay in the schema untouched — the app DETECTS those at runtime
--   (the model test probe + the R82 sub-agent gate); R87 only removes
--   them from the user-facing config dialog, per the owner's directive.
--
-- size_label TEXT — a human-facing parameter-size string ("70B", "405B
-- MoE", …) for the config dialog's detail row. NULL = unspecified.

ALTER TABLE models ADD COLUMN supports_pdf INTEGER;
ALTER TABLE models ADD COLUMN supports_text_output INTEGER;
ALTER TABLE models ADD COLUMN supports_image_output INTEGER;
ALTER TABLE models ADD COLUMN supports_video_output INTEGER;
ALTER TABLE models ADD COLUMN supports_audio_output INTEGER;
ALTER TABLE models ADD COLUMN size_label TEXT;
