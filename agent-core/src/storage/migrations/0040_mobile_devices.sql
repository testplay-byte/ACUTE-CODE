-- 0040_mobile_devices.sql
-- ROUND-106 (R106-S1, the sidecar mobile-link round): the MOBILE DEVICES
-- table — the desktop side of the LINKING-PROTOCOL pairing contract
-- (docs/planning/LINKING-PROTOCOL.md §2, ANDROID-R3-OWNER-RULINGS.md §1.2
-- + §1.3). Each row is ONE paired phone: the device token the phone holds
-- in its Android Keystore is verified by this table's token_hash (SHA-256
-- hex of the presented bearer — the token itself is NEVER stored), and
-- revocation is DELETE (the LINKING-PROTOCOL wording: "revocation deletes
-- the token row; the phone's next request falls back to the pairing
-- screen").
--
-- The auto-reconnect guarantee (the owner's ruling: PC off/on → the phone
-- reconnects with ZERO re-setup) rides this table's persistence: rows live
-- in the owner's SQLite, so a reboot changes nothing the phone depends on
-- (stable cert + stable token row). Devices carry NO expiry by default —
-- last_seen_at is display-only staleness (the R3 §1.3 ruling); revocation
-- is the owner's manual act.
--
-- Shape notes:
--   · id — opaque per-device id (the QR-claim route mints a UUID).
--   · token_hash UNIQUE — SHA-256 hex of the 32-byte device token; the
--     bearer wall looks the presented token up BY HASH (see routes/mobile
--     + server.ts for why a hash lookup is not a timing oracle).
--   · scopes — the capability registry (R3 §1.6): a JSON array, v1 always
--     ["view-input"] (see results, send input; nothing processes on the
--     phone). Future tokens can be scoped narrower — additive rows, never
--     protocol surgery.
--   · created_at / last_seen_at — epoch ms (INTEGER, the provider_lessons
--     idiom); last_seen_at is written throttled (≥60s apart per device)
--     by the bearer wall so a chatty phone does not turn every request
--     into a write.
CREATE TABLE IF NOT EXISTS mobile_devices (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL DEFAULT '["view-input"]',
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
