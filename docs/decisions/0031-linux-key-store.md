<!-- last-reviewed: 2026-09-19 round-108 -->
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

---

## Addendum (round 102, R102-A): the reliability layer + the disclosed key-file fallback

- **Status:** ACCEPTED
- **Date:** 2026-09-17 (round 102; owner-directed — the v0.99.0 field report)

### Context

The owner ran v0.99.0 on Linux and reported: *"I was having issues with
saving the API keys. The API keys were not being properly saved at all in
the Linux version. I tried saving them but apparently nothing was happening
at all."* Live verification against the real `keyring` 3.x
`sync-secret-service` backend (a standalone harness on a daemon-less Linux;
see `docs/ui-iterations/round-102.md` §2 A) surfaced three defects in the
round-100 design:

1. **The freeze.** The key shell commands were SYNC, and Tauri runs sync
   commands on the MAIN thread. `sync-secret-service` rides the C libdbus
   (`dbus-secret-service` → `libdbus-sys`), whose D-Bus round-trips block
   without a deadline — a locked keyring whose unlock prompt cannot display,
   a half-dead daemon, or a missing session bus can therefore freeze the
   whole window while the invoke never resolves: exactly "nothing was
   happening at all".
2. **The classification gap.** On a machine with no reachable Secret
   Service, the backend reports `PlatformFailure` ("Unable to autolaunch a
   dbus-daemon…"), NOT `NoStorageAccess` — the round-100 code only treated
   `NoStorageAccess` as "no store", so reads ERRORED on every keyless
   provider and writes errored into a small red note that read as "nothing
   happened".
3. **The honesty dead-end.** The round-100 fallback for headless machines
   was "error + point at `ACUTE_PROVIDER_<ID>` env vars". For a desktop app
   user (the owner's own machine class), env vars are not an answer — the
   app must either store the key somewhere or admit it cannot.

### Options

| Option | Verdict |
| --- | --- |
| Keep Secret Service only; fix the freeze + surface the error loudly | Fixes the hang, but the owner's desktop STILL cannot save a key — the round's actual complaint |
| Encrypted file with an app-embedded key | Security theater: the "encryption" key ships in the same binary (Electron safeStorage's basic_text does this and says so); adds a crypto dep tree for zero real protection |
| File-backed key store, owner-only perms, FULL disclosure (chosen) | The AWS CLI (`~/.aws/credentials`), kubectl (`~/.kube/config`), and gh CLI precedent: plaintext at strict perms with loud disclosure; honest about what it is |
| Require env vars / refuse to save | The round-100 behavior the owner just rejected |

### Decision

1. **Bounded I/O, off the main thread.** Every keyring Entry operation runs
   on a dedicated thread under a 20-second deadline (`wincred::imp::
   bounded`); all key shell commands in `keys.rs` are `async` (Tauri runs
   them on the runtime, never the main thread). A hang costs one detached
   thread + one honest error, never the window.
2. **Only `NoEntry` proves the service ANSWERED.** Every other verdict
   (`NoStorageAccess`, `PlatformFailure`, timeout, worker crash) memoizes
   the service DOWN for the process (one probe per boot, not 20s × N
   targets) and routes to the key file.
3. **The disclosed key file.** A key the Secret Service cannot take lands
   in `~/.acute/provider-keys.json`: one JSON map keyed by the canonical
   credential target, 0600 from birth (atomic tmp+rename), `~/.acute`
   tightened to 0700, lock-serialized writes, empty map → no file. Reads
   consult it whenever the Secret Service holds nothing; deletes clear
   both stores; a later successful Secret Service write RETIRES the file
   copy (migration on the next re-save, one namespace).
4. **The UI tells the truth.** The save commands return a `KeyStoreReport`
   (`store`: `credential-manager` | `secret-service` | `key-file`, plus the
   note); Settings renders a key-file save as an AMBER disclosure (the
   path, the perms, how to move the key into the encrypted store) — never
   a green "saved to the secure store", never a silent catch.

This deliberately bends SPEC §7's "never on disk" hard rule for the
Linux-no-secure-store case, per the owner's directive and the CLI-tool
precedent. The rule's intent (no lazy plaintext default, no leaks through
logs/REST/transcripts) is preserved: the Secret Service remains the
PRIMARY store and is always tried first; the file is a last-resort
destination that the UI, the docs, and the file's own 0600/0700 perms all
disclose.

### Consequences

- Keys save on EVERY Linux desktop the app can run on: working keyring →
  encrypted store; broken/absent keyring → disclosed key file + amber note.
- A transient Secret Service failure degrades to the file for the session
  (fully functional, re-probed next boot) instead of erroring on every
  keyless status check — the safer side of the trade.
- WSL/headless: the round-100 "documented gap" becomes a working path
  (the file store), still disclosed.
- The spawn loop's env injection reads through the same unified path, so
  a key-file key is injected on the next boot exactly like a keyring key.
- `purge_provider_keys` (R87 reset) clears the key file too.
- Sandbox-verified: the linux imp compiled + 10/10 tests green against the
  real `keyring` 3.6 + libdbus stack on a daemon-less Linux (the harness
  also caught the `PlatformFailure` classification defect before it could
  ship). CI's `rust-linux`/`rust-linux-arm64` `cargo check` legs remain
  the per-push compile gate.
