<!-- last-reviewed: 2026-09-17 round-100 -->
# ADR-0031: The Linux key store — freedesktop Secret Service via the `keyring` crate

- **Status:** ACCEPTED
- **Date:** 2026-09-17 (round 100; owner-directed — "a proper Linux release")
- **Tags:** linux, keys, security, packaging

## Context

Round-100 workstream B ships the Linux release (deb + AppImage, research
`docs/research/browser-engine-and-linux-round-100.md` §C). Every other shell
subsystem is portable in-tree (sidecar's `node`/`node.exe` dual lookup, the
rfd dialogs, the WebKitGTK browser branches) — the ONE genuinely new
subsystem is the provider-key store: `src-tauri/src/wincred.rs`'s non-Windows
`mod imp` is an honest stub whose `write` errors on every call, so the
Settings UI on Linux could never persist a provider key.

Constraints:

- SPEC §7's hard rule — provider API keys live in the OS secure store, never
  on disk in plaintext, never in REST bodies, never in logs.
- The Windows side stays EXACTLY as R55 built it (direct `CredReadW`/
  `CredWriteW` FFI with exact TargetName control — the canonical-target
  discipline). The R55 TargetName complaint was Windows-specific: keyring's
  `{user}.{service}` derivation could never match the launcher's cmdkey
  targets. No launcher flow seeds keys on Linux (cmdkey is Windows-only;
  `acute.sh` stores nothing), so the constraint does not port.
- The Linux desktop already HAS an OS secure store: the freedesktop Secret
  Service (D-Bus API at `org.freedesktop.secrets`), implemented by
  gnome-keyring (GNOME/Ubuntu default) and KWallet (KDE), which encrypts
  its keyring files at rest.
- Headless Linux (CI, servers, WSL without a daemon) has no Secret Service.

## Options considered

- **Option A — the `keyring` crate (3.x) with the `sync-secret-service`
  feature.** The maintained cross-platform wrapper (MIT OR Apache-2.0);
  its Secret Service store maps an `Entry::new(service, user)` to the
  item's `service`/`username` attributes in the default collection, sync
  over zbus (pure Rust — no libdbus link). Pros: one small dep, the
  desktop-native store, no new FFI. Cons: adds zbus to the Linux build;
  no exact-control equivalent of the Windows TargetName story (moot — see
  above).
- **Option B — hand-rolled Secret Service D-Bus FFI** (the R55 precedent:
  windows-sys + raw externs). Rejected: R55 went raw because cmdkey
  interop demanded byte-exact TargetNames; on Linux there is no second
  client to be byte-compatible with, so ~500 lines of hand-rolled zbus
  wire code would be risk with zero interop payoff.
- **Option C — encrypted-file fallback (e.g. an age/openssl-encrypted
  `~/.acute/keys` file).** Rejected for the packaged app: SPEC's
  "never on disk" rule would need a key-encryption-key, which on Linux
  means… the Secret Service. A file the app can decrypt on its own is
  obfuscation, not a secure store. (The DEV env-var path below already
  covers headless honestly.)
- **Option D — `linux-native` (kernel keyutils) feature instead.**
  Rejected: keyutils sessions are not persistent across reboots and are
  not the desktop keyring daemon's encrypted-at-rest store; `linux-native`
  in keyring 3.x is documented as a kernel-keyring store, not a
  gnome-keyring one. The task here is the owner's desktop app.

## Decision

**Option A.** On Linux (`cfg(all(unix, not(target_os = "macos")))`),
`wincred.rs` gains a third `mod imp` backed by
`keyring = { version = "3", features = ["sync-secret-service"] }`
(target-gated in Cargo.toml, like `windows-sys`):

- `Entry::new(service, user)` with **service = the canonical target string**
  (`ACUTE-CODE/provider/<id>` — the same logical namespace as Windows) and
  **user = `keys.rs`'s `TARGET_USER` ("api-key")**, so the Secret Service
  item's attributes mirror the Windows credential's (TargetName, UserName)
  pair. Pool slots and vision slugs ride the same prefix, unchanged.
- `read` → `Ok(None)` on `keyring::Error::NoEntry` (normal: not stored
  yet) **and on `NoStorageAccess`** (no reachable keyring daemon — the
  honest headless fallback: a store that cannot be reached holds no key);
  honest `Err` strings otherwise. Errors NEVER carry the secret.
- `write` → `set_password`; every failure errors honestly and points at
  the `ACUTE_PROVIDER_<ID>` environment variables — the dev path that
  already works (`scripts/dev.mjs` reads env → key file → OS store).
- `delete` → `Ok(false)` when absent (or unreachable).
- Signatures are byte-identical to the Windows imp (`pub(crate) fn
  read/write/delete`), so `keys.rs` is untouched apart from making
  `TARGET_USER` `pub(crate)` for the read/delete legs.

Feature choice (verified against keyring 3.6.3, the current 3.x, docs.rs
2026-09-17): keyring 3.x has **no default features** — you must name your
store. `sync-secret-service` is the crate README's documented Linux combo
(zbus-based, synchronous — the crate's own docs note there is "really no
reason" to use the async variant since access is always blocking from this
crate). We deliberately do NOT enable the bus-encryption add-ons
(`crypto-rust`/`crypto-openssl`): at-rest encryption is the keyring
daemon's job (gnome-keyring/KWallet encrypt the keyring files); the D-Bus
transfer-encryption features would add a crypto dep tree for a
single-user session bus. The Windows FFI is untouched; the macOS stub is
re-gated so exactly ONE imp compiles per target triple.

## Consequences

- The Linux release has a real key store: Settings saves/rotates/deletes
  provider keys into gnome-keyring/KWallet; the spawn loop's env injection
  reads them back on every boot (the same `read_provider_key_lossy`
  contract — a broken store logs and degrades to "no key", never kills the
  engine).
- Headless/WSL honesty: reads return none, writes error with the env-var
  hint. WSL is a documented gap (keyring's own docs: no "default"
  collection under WSL without a daemon) — the env vars are the answer
  there. `cargo test` on a headless CI box never touches the store (the
  wincred unit tests only exercise the blob codecs).
- Linux-only dependency surface: `keyring` 3.x + secret-service 4 + zbus 4
  compile only on `unix ∧ ¬macos` targets; the Windows build is
  byte-for-byte unchanged (windows-sys gating untouched), and macOS keeps
  the honest stub. On unixes beyond Linux/FreeBSD/OpenBSD (netbsd, …)
  keyring would fall back to its in-crate MOCK store — an accepted,
  documented edge for a desktop app that ships deb/AppImage for mainline
  distros; the release targets are Linux.
- New CI gate: `.github/workflows/ci.yml` gains a `rust-linux` job
  (`cargo check` on ubuntu-latest with the WebKitGTK deps) so the Linux
  compile class is caught forever, not just at release time.
- Reversal cost is LOW: delete the imp, the Cargo.toml target-gated dep,
  and this ADR — no data migration (the Secret Service items are simply
  orphaned in the user's keyring, visible/removable via seahorse/KWallet
  UI like any other credential).
