<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 56 — The launch-choice round: the launcher ASKS app-or-site (the owner's request), engine failure is never a dead end, and the self-update runs the new code TODAY

**Date:** 2026-08-31 · **Branch:** `main` · **Version:** 0.56.0 · **Owner directives:** the ninth Windows test session's report, blunt and actionable: *"still not working it faild and i think in the acute.bat it should ask how to launch the app or the site."* Two readings, both answered: a REQUEST (the launcher should ask how to launch — app or site) and a SYMPTOM (it failed again, and the launcher gave no way out). No new diagnostics were attached this time — the previous round's fixes (0.55.0: EISDIR + the credential namespace) shipped after the owner's last captured log, so this round also hardened every failure path so the NEXT report names itself.

## The audit — what could still fail on 0.55.0, checked one by one

With no new log to dissect, the round began by auditing the entire 0.55.0
packaged boot path for any remaining packaged-only crash candidate — the same
discipline that found EISDIR:

| Candidate | Verdict |
|---|---|
| `simplified_path` verbatim stripping (R55 fix) | Correct — applied before any derived path; program/script/cwd all plain Win32 (src-tauri/src/sidecar.rs) |
| better-sqlite3 native ABI vs pinned Node 24.20.0 | Sound — v13.0.3 ships N-API prebuilds (`prebuilds/win32-x64.node`, node-gyp-build layout): ABI-stable across Node 24; node-pty 1.1.0 the same, and it loads defensively (terminal-sessions.ts wraps the import — failure degrades, never crashes) |
| CORS for the packaged webview | Sound — `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost` all in the strict allowlist (agent-core/src/server.ts), headers also ride the hijacked SSE route |
| Tauri CSP blocking fetch to 127.0.0.1 | Sound — `csp: null` (no restriction) in tauri.conf.json |
| The installer bundle | Sound — stage-sidecar.mjs stages exact lockfile versions + vendored `shared` with a runnable package.json; the resource map lands at `<resource_dir>/sidecar/app/dist/main.js` |
| `ACUTE_DB_PATH` / state dir | Sound — `%APPDATA%\acute-code\` (plain path from env, not resource_dir) |
| The launcher's one-run-delayed self-update | **REAL DEFECT** — every launcher improvement arrived exactly one run LATE (see below) |
| The engine watch's timeout path | **REAL DEFECT** — blind: printed "did not report ready within 45s" with ZERO diagnostics (the exact silence shape that hid EISDIR for three sessions) |
| The desktop dead-end | **REAL UX DEFECT** — the owner's request itself: after an engine failure the launcher just waited on a dead console; there was no way to choose the site |

The two launcher defects plus the UX gap are this round's work. Nothing in
the Rust/JS engine code changed — 0.55.0's boot fixes stand as shipped.

## Fix 1 — the launch question (the owner's request, verbatim)

`ask_launch_mode()` (launcher/acute_launcher.py): every interactive run asks
how to launch ACUTE-CODE —

- **[1] Desktop app** — the packaged window with the embedded browser + the
  bundled engine (recommended)
- **[2] Site** — the local servers + the browser at `http://localhost:5173`

**Enter keeps the last choice** (first run defaults to the desktop app); the
answer persists in `.acute-launch-pref.json` next to the launcher and becomes
the next Enter default. Resolution precedence (`resolve_launch_mode(cmd)`):

1. explicit command — `app` / `desktop` vs `site` / `web`
2. explicit flag — `--app` / `--desktop` vs `--site` / `--web` /
   `--no-desktop`
3. non-Windows → always the site (the packaged app is Windows-only)
4. non-interactive stdin → the remembered choice (or desktop on first
   contact) — never a blocked prompt
5. interactive → ASK

The ask runs AFTER the update pass + self-update re-exec, so the question
always comes from the newest launcher code. The startup plan panel is
mode-aware (desktop plan / site plan / an honest both-paths plan while the
question is pending). `ACUTE.bat start` still skips the update check but
asks; `status` and `update` never launch anything, so they never ask.

## Fix 2 — engine-failure recourse (never a dead console)

`_desktop_watch_engine` now returns an outcome — `'up' | 'failed' |
'timeout' | 'app-exited'` — and `desktop_flow` acts on it:

- On any non-up outcome the launcher prints the engine's log tail (the
  timeout path TOO — see fix 3) and asks **`_ask_engine_recourse()`**:
  - **[1] retry** — close the app, relaunch, one retry round (default;
    Enter)
  - **[2] site** — close the app and fall through to the dev-servers flow
    (the exact escape the owner asked for)
  - **[3] keep** — keep the desktop app (its offline screen has
    Restart-engine + Copy diagnostics)
- The launch line now names the version ("ACUTE-CODE 0.56.0 is running
  (pid …)") so any copied report identifies the build.

## Fix 3 — the engine watch's timeout is no longer blind

The old timeout printed "did not report ready within 45s" with no
diagnostics — on the owner's machine that is the ONLY console output a
slow/failed cold boot would produce. The watch now runs **75s** (closer to
the Rust handshake's 3-attempt worst case) and on timeout prints the
engine's last output lines (`_print_engine_tail`, 14-line cap) — same as the
explicit-startup-failure path. `startup failed` and `listening on` detection
are unchanged.

## Fix 4 — the self-update re-exec (new launcher logic runs THIS session)

The old contract — "copied over, takes effect on the NEXT double-click" —
meant the R55 launcher improvements (What's-new panel, and R56's question)
were invisible on the run where they mattered most: the run that upgraded
the app. `self_update_check()` now RE-EXECs the fresh copy in place:

- `os.execve(sys.executable, [python, launcher] + original_args, env)` —
  same process, same console, same arguments, exit code propagates to the
  .bat wrapper
- loop guard: `ACUTE_LAUNCHER_REEXEC=1` in the exec'd environment — a
  second pass that still sees differing hashes warns and continues instead
  of exec'ing again (failure-safe)
- `ACUTE.bat` still cannot self-overwrite (Windows locks the running .bat)
  — the warning + re-download instruction stays

Verified with a REAL process replacement in-sandbox: a stub "repo copy"
exec'd, printed `REEXEC-OK ['site', '--verbose']`, exited 42 — the driver's
post-exec line never ran, arguments and exit code were preserved; the guard
run printed the warn and continued.

## Fix 5 — `status` tells the launch story

`ACUTE.bat status` (read-only) now reports:
- the remembered launch preference (or "asks every run")
- the engine's last successful boot line from
  `%APPDATA%\acute-code\sidecar.log` (or "no successful boot on record")

These two lines turn the next vague "it failed" report into a diagnosable
one: which mode, which build, and whether the engine has EVER booted on
that machine.

## Verification

- **Launcher logic (in-sandbox, against the real file):**
  - mode resolution: commands, flags, non-Windows, non-interactive stdin,
    saved pref, no-pref — 21 checks green
  - `ask_launch_mode` parsing: `1`/`2`/`app`/`site`/`browser`/Enter-with-pref/
    Enter-no-pref/garbage×3-fallback/garbage-then-valid + persistence
    round-trip — green
  - `_ask_engine_recourse` parsing: all answers + fallback — green
  - `_desktop_watch_engine` outcomes: failed/listening/app-exited/timeout
    with lines appended AFTER the watch starts (threaded) + non-Windows
    short-circuit — green
  - `desktop_flow` recourse branches end-to-end (patched internals): site
    (closes app, returns False), retry (2 launches, second comes up → True),
    keep (1 launch → True), app-exited→site, up-first-try (no prompt) — green
  - `main()` dispatch: ask→site, ask→desktop, `site`/`app`/`desktop`
    commands, `--web`/`--site` flags, `status` no-dispatch, default-run asks
    — green
  - self-update re-exec: real exec (args + exit code preserved) + loop guard
    honored — green
  - `py_compile` clean; ACUTE.bat kept byte-verified CRLF (normalized +
    `file`-checked after the edit)
- **JS gates:** lint clean, typecheck clean, **1071/1071 in 76 files** (the
  JS suite is unchanged — R56 is a launcher round).
- **Rust:** `cargo check` GREEN on x86_64-pc-windows-gnu (tauri.conf.json
  version bump regenerates the build context; the Rust source itself is
  unchanged from R55).
- **docs:check 146/0, license:audit clean (133 deps), version:check 0.56.0
  ×4.**
- **Live battery (dev stack):** /health 200 · providers openrouter
  hasKey=true · project + session (`agt_tpl_coder`, 202) created · real-key
  streamed turn answered EXACTLY `R56-LAUNCH-CHOICE-VERIFIED` · session
  resting state `queued` · the dev log shows the turn `ok:true` with zero
  new errors.

## The owner's upgrade path (the ONE test that matters)

Double-click ACUTE.bat → the launcher pulls the repo → **the self-update
copies the R56 launcher and RE-EXECs it immediately** (first time this has
ever happened — the console will say "restarting the launcher with the new
version") → the desktop app upgrades 0.55.0 → 0.56.0 → keys re-seeded →
**the launch question appears for the first time** — press Enter (desktop
app) or 2 (site) → the engine watch prints `✓ agent-core is up — sidecar
listening on port N`, or, if the engine fails again, the log tail + the
retry/site/keep question. Either way you end up with a running app and a
copyable diagnosis.

If the engine STILL fails after 0.55.0's path fix, the recourse prompt's
log tail (and `ACUTE.bat status`'s last-boot line) will finally carry the
NEXT root cause's name — that output pasted back is the fastest possible
fix.

## What's next

The R50 queue (command watchdog, sub-agent supervision stats, terminal
output in the UI, usage screen section 2, model-selector hover, plugin tool
system), installer code-signing research, and the owner's Windows re-test
of 0.56.0.
