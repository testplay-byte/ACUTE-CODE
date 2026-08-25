-- ROUND-37 (owner: every provider is deletable, including the built-in
-- presets). The seed at openDatabase re-inserts missing built-ins; a
-- tombstone records the owner's deliberate delete so the seed skips the id.
-- Re-adding the provider (Add Provider → preset) clears the tombstone.
CREATE TABLE IF NOT EXISTS provider_tombstones (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
