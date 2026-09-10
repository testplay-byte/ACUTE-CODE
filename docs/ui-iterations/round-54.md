<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 54 — The reliability round: the packaged app's "restart engine didn't work" (blind stderr + one-shot handshake + orphaned children), the launcher's registry-vs-disk trust bug, and in-app engine diagnostics

**Date:** 2026-08-30 · **Branch:** `main` · **Version:** 0.54.0 · **Owner directives:** the seventh Windows test session's report — "I launched using the acute.bat file… it said 'can't reach agent core'. I tried clicking restart engine but apparently it did not work… I deleted the whole app data folder… it opened up in the browser this time… unable to select a folder and other issues… you might need to improve the acute.bat file to handle things much better… make sure there is proper updating for the system intact… Don't rush anything. Take your time."

**The owner's console log carried three precise clues:**

1. `✓ installed desktop app 0.53.0 is current (C:\Users\khurr\AppData\Local\ACUTE-CODE)` followed two
   screens later by `! C:\Users\khurr\AppData\Local\ACUTE-CODE\ACUTE-CODE.exe not found — using the
   dev-servers flow` — the launcher read the NSIS uninstall entry (which survives manual deletion of
   the install folder), decided "current", skipped the install, and then noticed the exe was gone at
   LAUNCH time, choosing the browser fallback over the obvious repair: reinstall.
2. The packaged 0.53.0 app (which HAS the R53 offline screen + Restart-engine button) still failed to
   reach agent-core, and Restart-engine never recovered it — pointing at a failure that repeats every
   attempt in the packaged environment specifically.
3. In the browser fallback, folder selection failed again ("unable to select a folder", the same
   symptom as an earlier session) — the PowerShell OS-dialog path on the owner's machine.

## What was actually wrong in the packaged app (the code autopsy)

Three defects, all invisible from a GUI process:

- **stderr was `Stdio::inherit()` — and a GUI app inherits NOTHING.** agent-core's `main.ts` prints
  its real startup failure (`sidecar failed to start: …`) to **stderr** and exits; the Rust shell
  only observed "stdout closed before the ready line". The actual cause (blocked native addon, DB
  error, spawn failure detail) never reached sidecar.log, the offline screen, or us.
- **A failed handshake leaked the child.** `spawn_and_handshake` returned `Err` and simply DROPPED
  the `Child` handle — on Windows that leaves node.exe running (orphan), holding the SQLite database
  file while every subsequent attempt (including the Restart-engine button) spawned a competitor.
  This is the mechanism behind "restart engine did not work properly".
- **One-shot deadlines.** READY_TIMEOUT 15s / HEALTH 10s with no retry — a cold first boot
  (Defender scanning a fresh 216 MB install) is precisely the launch most likely to outrun them.

## The fixes

### `src-tauri/src/sidecar.rs`

- **stderr is piped and drained** for the child's lifetime: every line lands in sidecar.log as
  `sidecar:stderr] …` AND in an in-memory ring (`VecDeque`, 24 lines). `main.ts`'s crash reason is
  finally captured in the packaged app.
- **A failed handshake kills its child** (`kill_tree` + `wait`) — no more orphans racing the
  restart. The handshake chain is `read_ready_line().and_then(health_poll)` with the kill in the
  `Err` arm.
- **The handshake retries**: `handshake_thread` runs up to `START_ATTEMPTS = 3` attempts
  (2s pause between), staying in the `Starting` phase the whole time — the webview's connect loop
  simply keeps polling; `restart_sidecar` inherits the retries for free (it spawns the same
  thread). Budget: READY_TIMEOUT 25s (was 15), HEALTH_TIMEOUT 15s (was 10).
- **The Failed phase explains itself**: `enrich_failure()` appends the ring's last 6 lines
  (`recent engine output: …`) to the error string, so the offline screen shows the engine's own
  last words without a file read.
- **`sidecar_log_tail(lines)` command** (registered in `lib.rs`): the last N (≤200, default 60)
  lines of sidecar.log + the file's absolute path, served to the webview.

### `src/lib/sidecar-connection.ts` + `src/components/shell/ConnectionGate.tsx`

- `CONNECT_TIMEOUT_MS` 90s → **150s** (the Rust retry loop's worst case is ~125s; the UI must not
  quit first). The timeout message points at the log below instead of %APPDATA%.
- The offline screen fetches the log tail on every landing (`useEffect` keyed on the error string,
  so a failed Retry refetches) and renders it in a scrollable monospace box with the full-log path
  and a **Copy diagnostics** button (clipboard: error + path + tail). The old "check sidecar.log in
  the app's data folder" paragraph only shows when no tail is available.

### `launcher/acute_launcher.py` (delivered by self-update on the next ACUTE.bat run)

- **`_desktop_install_files()`** — verify the install ON DISK (exe + pinned `node.exe` + the
  sidecar entry; both tauri resource layouts probed) before the "is current" decision. Missing
  files → `registry says X is installed, but files are missing (…)` → **reinstall** instead of the
  dev-flow fallback. Also re-verified after a fresh install.
- **`_desktop_stop_running()`** — closes exactly the processes whose executables live under the
  install dir (PowerShell `Win32_Process` ExecutablePath `-like '<install>\*'`, `taskkill /IM`
  fallback): the app AND its bundled sidecar node, never anyone else's node. Runs before install
  (file locks) and before launch (no second window).
- **`_desktop_watch_engine()`** — after launching, polls `%APPDATA%\acute-code\sidecar.log` for the
  new `listening on 127.0.0.1:<port>` line (45s, rotation-safe via a size snapshot) and prints
  `✓ agent-core is up — sidecar listening on port N`; on `startup failed` it prints the last 12
  fresh log lines right in the console. The launcher window now tells the same story the app
  window does.

### Browser-mode folder picking (`src/lib/api.ts`, `src/components/shell/Sidebar.tsx`)

- `pickFolderViaBackend()` fetch is bounded by an `AbortController` (120s) — a hung OS dialog used
  to leave the Browse button disabled forever; the timeout message says to paste the path instead.
- The Add-project dialog shows "Opening the system folder dialog…" while picking, and every failure
  hint ends with "— paste the folder path above instead." (manual entry was always available; now
  it says so.)

## Verification

- `cargo check` GREEN on `x86_64-pc-windows-gnu` (user-local mingw; every cfg(windows) path
  type-checked in-sandbox) and on the Linux dev target up to the pre-existing GTK system-library
  gap (no gdk-3.0 in this sandbox — the Windows target is the shipping one; CI checks the real
  build on windows-latest).
- Launcher helpers logic-tested in-sandbox with `IS_WIN` patched: the owner's exact scenario
  (registry entry + deleted files → reinstall decision), both resource layouts, the PS `-like`
  pattern byte-level check (single backslash), and all three watch-engine paths (success line,
  failure tail incl. stderr lines, rotation guard, timeout).
- Frontend: +12 tests (sidecar_log_tail wrapper ×3, the R54 offline screen ×3 — tail render, the
  %APPDATA% fallback, Retry→restartSidecar; pickFolderViaBackend ×5 incl. the abort-timeout path;
  the 150s deadline repin) — full suite green, ConnectionGate.test.tsx NEW.
- Live browser battery: dev stack booted, connection gate pass-through verified, Add-project
  Browse on Linux (zenity missing → immediate error hint with the paste guidance, no eternal
  spinner), project created by pasting a path — the exact owner flow.
