<!-- last-reviewed: 2026-09-08 round-79 -->
# Round 55 — The engine-boot round: the EISDIR verbatim-path crash (why the packaged engine NEVER started) + the Credential-Manager namespace split (why the packaged app never saw the launcher's keys)

**Date:** 2026-08-31 · **Branch:** `main` · **Version:** 0.55.0 · **Owner directives:** the eighth Windows test session's report — the 0.54.0 install itself went cleanly (`✓ installed desktop app 0.54.0 is current`, `✓ ACUTE-CODE.exe is running (pid 6752)`) and the R54 diagnostics finally delivered the engine's own crash text: `Error: EISDIR: illegal operation on a directory, lstat 'C:'` on every handshake attempt, plus `sidecar: no provider keys found in Credential Manager` seconds after the launcher had stored all four keys. "Make sure that you handle each and everything properly… in the most optimal way."

**The owner's log carried the two exact root causes — for the first time with the crash text itself:**

1. `spawning \`\\?\C:\Users\khurr\AppData\Local\ACUTE-CODE\sidecar\node.exe
   \\?\C:\Users\khurr\AppData\Local\ACUTE-CODE\sidecar\app\dist\main.js\` in
   \`\\?\C:\...\sidecar\app\`` — every path handed to the child carried the
   Windows verbatim (extended-length) `\\?\` prefix, followed by
   `Error: EISDIR: illegal operation on a directory, lstat 'C:'` from
   `Object.realpathSync` inside node's own `resolveMainPath`. The engine died
   before the first line of agent-core code — on EVERY attempt, since the
   first packaged build. R53's connection gate and R54's retries/zombie-fix
   were all correct work racing an engine that could never boot.
2. `sidecar: no provider keys found in Credential Manager` printed ~1s after
   the launcher's `✓ stored ACUTE-CODE/provider/openrouter (length 73)` ×4 —
   the store and the read were using different target names.

## Root cause 1 — the verbatim-path EISDIR crash

Tauri's `resource_dir()` on Windows canonicalizes the install path and
returns `\\?\C:\…` **verbatim** paths (the `std::fs::canonicalize` behavior —
verbatim prefixes are the Win32 "extended-length path" opt-out of MAX_PATH).
`resolve_sidecar_command` derived the pinned `node.exe`, the `main.js` script
argument, and the cwd from it and passed all three to `Command` verbatim.

node.exe itself accepts a verbatim PROGRAM path (CreateProcess resolves it),
but its CommonJS module resolver does not: `resolveMainPath` →
`Module._findPath` → `toRealPath` → `fs.realpathSync('\\?\C:\…\main.js')`
degenerates the verbatim root to a bare `C:` and `lstat`s it → `EISDIR` →
the process exits before running one line of user code. Handshake failure
was therefore 100% deterministic in the packaged app and 0% in dev (dev.mjs
passes plain POSIX paths).

**The fix — `simplified_path(path)`** (sidecar.rs): strips `\\?\C:\…` →
`C:\…` and `\\?\UNC\server\…` → `\\server\…`, applied to the resource dir
BEFORE any derived path exists, so the program, the script argument, and the
cwd are all plain Win32 paths. Verbatim prefixes exist to exceed MAX_PATH
(260 chars); the install tree is nowhere near that, so stripping is always
safe here. Unit tests pin the transform against the EXACT paths from the
owner's log (drive form, UNC form, pass-through).

## Root cause 2 — the Credential-Manager namespace split

The launcher stores keys with
`cmdkey /generic:ACUTE-CODE/provider/<id> /user:api-key /pass:…`. The app
read (and the Settings UI wrote) through the keyring crate's
`Entry::new(service, user)` — and keyring 4.x on Windows derives the
credential's TargetName as `{user}.{service}`, i.e.
`api-key.ACUTE-CODE/provider/openrouter`. Two disjoint namespaces since the
first packaged build: the launcher's four seeded keys were structurally
invisible to the app — every spawn logged "no provider keys found", and a
key saved in Settings never reached the next spawn either.

**The fix — `src-tauri/src/wincred.rs`** (NEW): direct
`CredReadW`/`CredWriteW`/`CredDeleteW` FFI (windows-sys) with exact
TargetName control, replacing the keyring crate entirely:

- Reads and writes use the launcher's canonical
  `ACUTE-CODE/provider/<id>` targets, user `api-key` — byte-identical to
  cmdkey (same credential type, persistence, and user name).
- The pre-R55 keyring-form targets (`api-key.ACUTE-CODE/provider/<id>`) are
  still READ as a legacy fallback, so keys saved through ≤ 0.54.0 app builds
  keep working; a Settings save retires the legacy entry after the canonical
  write (one namespace from now on).
- Blob encoding: UTF-16LE on write (the native generic-credential charset —
  what cmdkey writes); a dual decoder (UTF-16 with parity +
  printable-ASCII validation, then UTF-8/ASCII fallback) on read — the two
  encodings are unambiguous for printable-ASCII payloads, and keys seeded by
  cmdkey, the Settings UI, or older keyring builds all round-trip.
- keys.rs keeps the Tauri command surface identical (`store_provider_key`,
  `provider_key_status`) and now also owns the spawn-injection env mapping;
  sidecar.rs's `spawn_and_handshake` calls into it — the sidecar.log line on
  the owner's machine becomes `sidecar: injected provider keys: openrouter
  (len 73), openrouter-slot2 (len 73), …`.
- Non-Windows dev checkouts get an honest stub (`Ok(None)` /
  "Windows-only") instead of a secret-service dependency — dev keys flow
  from dev.mjs env injection, as they always have.

## Launcher (delivered by the launcher's self-update on the owner's next double-click)

- `_print_whats_new(version)` — after installing a new desktop version, the
  console shows that version's changelog summary panel ("What's new in
  0.55.0 — …") straight from the repo's CHANGELOG.md. A silent version bump
  reads as "nothing happened"; now the console answers "what changed?".
- The post-launch green panel is explicit about how to start the app next
  time: the desktop shortcut, or ACUTE.bat (= update + start), keys picked
  up automatically, and what the offline screen offers if it ever appears.

## Verification

- `cargo check --target x86_64-pc-windows-gnu` GREEN (and `--all-targets`,
  type-checking the new unit tests: verbatim-drive/UNC/pass-through path
  simplification; blob round-trips in both encodings + the
  misread/garbage/empty rejections; target-name pinning incl. the legacy
  form; provider-id validation) via the user-local mingw toolchain; `cargo
  fmt` clean. The keyring crate is gone from the dependency tree.
- JS gates untouched-but-rerun: lint clean, typecheck clean, **1071/1071**
  in 76 files, docs:check 145/0, license clean, version:check 0.55.0 ×4.
- Live battery on the dev stack (agent-core unchanged this round — the Rust
  shell is packaged-app-only): project `r55-battery` created via POST, a
  session on `agt_tpl_coder`, a real-key turn answered exactly
  `R55-ENGINE-OK`, session returns to its designed resting state, zero
  dev-log errors.
- Launcher logic verified in-sandbox: `_print_whats_new` extraction executed
  against the real CHANGELOG.md (pulls the 0.54.0 summary correctly);
  `python3 -m py_compile` on the launcher.

## The proof the owner should see next session

`ACUTE.bat` → `✓ upgrading the desktop app 0.54.0 → 0.55.0` → the What's-new
panel → keys stored → `✓ ACUTE-CODE.exe is running` → **`✓ agent-core is up
— sidecar listening on port N`** — the line that has never appeared on the
owner's machine, because the engine has never once booted there.
