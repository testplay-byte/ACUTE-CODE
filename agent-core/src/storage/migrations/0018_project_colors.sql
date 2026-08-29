-- 0018_project_colors.sql
-- ROUND-48 (R48-a): PER-PROJECT COLORS. createProject has defaulted EVERY
-- project to the same flame orange (#FF6B2C) since migration 0003, so the
-- owner's sidebar showed an identical tile color for every project (owner:
-- "projects should be given different colors; currently all get the exact
-- same color"). The palette now lives in storage/projects.ts (PROJECT_PALETTE
-- — 8 hex hues, flame orange kept as palette[0]) and new projects take the
-- LEAST-USED palette color at creation.
--
-- This migration backfills EXISTING rows: every project still carrying the
-- old default EXACTLY (#FF6B2C — nobody chose it by hand, it was the default)
-- is reassigned palette colors ROUND-ROBIN in creation order (created_at,
-- then id — a stable total order), starting at palette[0]: the earliest
-- project keeps the brand orange and later ones spread across the 8 hues.
-- Projects with any other color (user-set via the POST /projects hex
-- validation) are untouched. The modulo wraps when an install has more than
-- 8 legacy rows — the best possible spread.
--
-- Plain SQL only, same shape as 0013's conservative repair: one UPDATE (the
-- ROW_NUMBER window + UPDATE…FROM is materialized before the writes, so the
-- color changes cannot feed back into the ordering) + the shared audit row.

WITH ordered AS (
  SELECT id, (ROW_NUMBER() OVER (ORDER BY created_at, id) - 1) % 8 AS slot
    FROM projects
   WHERE color = '#FF6B2C'
)
UPDATE projects
   SET color = CASE o.slot
          WHEN 0 THEN '#FF6B2C'  -- flame orange (palette[0] — the original default)
          WHEN 1 THEN '#3B82F6'  -- blue
          WHEN 2 THEN '#14B8A6'  -- teal
          WHEN 3 THEN '#8B5CF6'  -- violet
          WHEN 4 THEN '#F43F5E'  -- rose
          WHEN 5 THEN '#F59E0B'  -- amber
          WHEN 6 THEN '#84CC16'  -- lime
          WHEN 7 THEN '#EC4899'  -- pink
          ELSE '#FF6B2C'
       END
  FROM ordered AS o
 WHERE projects.id = o.id;

-- Audit trail (pattern shared with 0013/0014/0015/0016/0017).
INSERT INTO audit_log (ts, actor, action, target, decision, details)
VALUES (
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration-0018',
  'projects.colors.backfill',
  'projects',
  'applied',
  'R48-a: legacy default-color rows (#FF6B2C) reassigned the 8-color PROJECT_PALETTE round-robin by created_at — new projects default to the least-used palette color (storage/projects.ts)'
);
