//! ROUND-91 (R91-E): THE IN-APP UPDATER — the Rust half.
//!
//! The owner's directive: "there was no inbuilt update system. I would like
//! you to add an inbuilt update system to it, like I can update the
//! application from within the app itself rather than going anywhere, like
//! using the app store."
//!
//! Division of labor (why the download lives in the SIDECAR, not here):
//! the repo is PRIVATE, so the asset download needs the launcher's GitHub
//! PAT in an Authorization header. The sidecar already reads that token
//! for /system/updates (R89-A2) — so it also STREAMS the update asset to
//! disk with live progress (GET /system/updates/download +
//! GET /system/updates/download/progress). This module is the SHELL's
//! half: taking the verified file the sidecar produced and making it THE
//! APP — the one thing only the OS-side process can do.
//!
//! ── ROUND-123 (R123): THE VISIBLE INSTALL — no more dark period.
//!
//! The owner's report: "it does not show me any kind of animation while it
//! is processing… I feel like that nothing is happening and it won't auto
//! start but it does auto start with some delay, which is not ideal", plus
//! "the update system… not working that properly both on Windows and both
//! on Linux". Two structural answers this round:
//!
//!  · WINDOWS — THE OVERLAY INSTALL (mod overlay): the app renames its own
//!    exe to `<exe>.old` (the Chrome/VS Code trick — a running exe CAN
//!    rename itself, which frees the install path for NSIS to write the
//!    new exe), launches the installer via CreateProcessW to OWN its
//!    handle, and then STAYS OPEN showing the animated Restarting splash
//!    while a watcher thread waits on the install — the whole 10-40s
//!    silent stretch is VISIBLE, and when it ends WE relaunch the new exe
//!    and exit: no invisible gap, no template-timer relaunch delay. A
//!    refusing rename (AV/fileystem lock) falls back to the R99-C flow
//!    verbatim (ShellExecuteW /S /R + the 1.5s exit). A launch failure
//!    after a successful rename RESTORES the exe's name before erroring —
//!    the app stays runnable. A watcher timeout emits the honest
//!    `update-install-failed` event for the frontend's recovery instead of
//!    exiting. `<exe>.old` left behind by a crash mid-flow is cleaned up
//!    best-effort at every startup (cleanup_renamed_exe, wired in lib.rs).
//!
//!  · LINUX — THE .DEB LEG (mod deb): a .deb install's "Restarting into
//!    vX… → Connecting to Agent Core → still the old version" symptom was
//!    the AppImage replace refusing ("the app is not running from an
//!    AppImage") + the R101-B recovery restarting the engine over an
//!    un-updated app. The sidecar now picks the arch-matched .deb for a
//!    packaged install (APPIMAGE env absent), and this module installs it
//!    VISIBLY: `pkexec dpkg -i <staged.deb>` (polkit's own GUI prompt is
//!    the only interaction) runs while the app STAYS OPEN on the Restarting
//!    splash — Linux can replace a running binary's file, so the current
//!    process is never at risk — then a watcher thread waits on dpkg,
//!    relaunches the exe at its now-updated path, and exits. A failed
//!    dpkg (cancelled prompt, dependency error) emits
//!    `update-install-failed` and the app LIVES ON untouched (the frontend
//!    recovery restarts the engine; the old binary is still the running
//!    one — dpkg's failure left the package unpacked-but-unconfigured at
//!    worst, never a half-written binary). The AppImage replace leg is
//!    unchanged except its relauncher now WAITS for the old pid to exit
//!    (the R104 fixed 3s guess retired — no WebKitGTK cache/data-dir race,
//!    no double window, ever).
//!
//! ROUND-104 (R104): THE LINUX LEG. The owner's v0.100.0 report: "It was
//! saying 'Restarting into 0.100.0' and then it said 'Connecting to Agent
//! Core' but apparently it did not get updated… It was version 0.99.0 in
//! the About section." Root cause: the sidecar picked the WINDOWS
//! setup.exe on every platform (fixed sidecar-side this round), and this
//! module had NO Linux install at all — the `.exe` launch rejected, the
//! frontend's R101-B recovery restarted the sidecar ("Connecting to Agent
//! Core"), and the app lived on un-updated. The command now dispatches on
//! the STAGED FILE's extension, platform-coherently:
//!   · `.exe`      → Windows only: the NSIS legs below (silent `/S /R` or
//!                   the legacy interactive wizard). Refused on any other
//!                   platform — a Windows setup.exe cannot install there.
//!   · `.AppImage` → Linux only: the AppImage replace (mod appimage below)
//!                   — stage a copy BESIDE the running AppImage (same
//!                   filesystem → atomic rename), make it executable, kill
//!                   the sidecar tree, rename over the AppImage path, spawn
//!                   a delayed detached relaunch, exit. Refused on any
//!                   other platform.
//! `run_update_installer(path, silent?)`:
//!  · validates `path` — it must EXIST, be a regular file, be the platform's
//!    own update kind (`.exe` on Windows / `.AppImage` on Linux), and be a
//!    plausible size (> 10 MB for the setup.exe, > 50 MB for the AppImage —
//!    the real bundles are ~37 MB / ~130 MB; a stray error page is a few
//!    KB). No path escapes: any other extension is refused.
//!  · KILLS THE SIDECAR TREE (R96-I — `sidecar::shutdown_before_install`):
//!    the graceful `POST /internal/shutdown`, a 5s bounded wait for a real
//!    exit, a force-kill on the tree if the wait expires, then a reap +
//!    300ms handle-release grace. By the time the install runs, nothing
//!    the app spawned holds the install directory or the data files the
//!    replacement instance will open.
//!  · hands the update to the OS — per platform, see the legs below.
//!  · schedules the APP's own exit 1.5s later: Windows locks a running
//!    executable's file (the NSIS installer must replace it), and on Linux
//!    the replacement instance must not contend with the dying one (the
//!    delayed relauncher waits out this exit). 1.5s is enough for the
//!    invoke's reply to reach the webview so the UI can say "Restarting
//!    into vX" before the window goes away.
//!
//! ROUND-99 (R99-C): THE ONE-CLICK SILENT UPDATE — Windows. The owner's
//! directive then: "I click the update button in the application and
//! everything else happens automatically afterwards by itself without me
//! having to make any changes." ROUND-104 splits the flow at the owner's
//! new directive ("the ability to download it then confirm to update it")
//! — the FRONTEND now stops at a verified download and asks before this
//! command runs; the command itself is unchanged in shape. The optional
//! `silent` IPC arg (camelCase `silent` on the invoke, identical on both
//! legs of the auto-conversion) switches the Windows launch to
//! ShellExecuteW with the parameter string `/S /R`:
//!  · `/S` is NSIS's own silent flag — no wizard pages, no prompts, and a
//!    currentUser install reuses the existing $INSTDIR by default (no
//!    path re-derivation, no elevation prompt).
//!  · `/R` is tauri's NSIS-template RESTART flag: on a successful silent
//!    install the template's `.onInstSuccess` relaunches
//!    `$INSTDIR\ACUTE-CODE.exe` via `nsis_tauri_utils::RunAsUser` (the
//!    same leg tauri-plugin-updater rides) — the app comes back by
//!    itself, which the MUI2 finish-page "run app" checkbox can never do
//!    in silent mode (the finish page is skipped). A FAILED install does
//!    not relaunch (`.onInstSuccess` never fires) — honest.
//!  · `silent: None` / `Some(false)` keeps the legacy INTERACTIVE wizard
//!    (the escape hatch the About tab offers when the silent launch
//!    rejects — pathological machines keep a working path).
//! On LINUX the flag is deliberately IGNORED — the AppImage replace IS
//! the install (there is no wizard to show or skip); both values run the
//! same replace-and-relaunch.
//!
//! WHY hand-rolled ShellExecuteW instead of `app.shell().open(path, …)`:
//! the shell plugin's second parameter is an `open::Program` ENUM (the
//! named opener/browser programs the `open` crate knows), NEVER a
//! free-form parameter string — the plugin's `open` delegates to the
//! `open` crate's `that_detached`, which calls ShellExecuteExW with
//! lpParameters left null. ShellExecuteW takes the parameter string
//! directly, and — like the ShellExecuteExW leg the interactive flow
//! rides (proven on the owner's machine since R91) — the launched
//! process is fully detached from this process's lifetime: it survives
//! the 1.5s exit below, and it joins no Job-Object leash (only the
//! explicitly-assigned sidecar children are in the R94-B job, never the
//! installer).
//!
//! ASYNC on purpose (the R91-B1 lesson, same as open_browser_window): a
//! sync command runs on the main thread, and nothing in THIS command
//! blocks on the event loop — but the shell plugin's open spawns a
//! process and the 1.5s exit timer rides the tokio runtime; async keeps the
//! whole flow off the main thread by construction. The R96-I kill adds a
//! BLOCKING section (up to ~5.3s worst case) inside this async command's
//! runtime thread — a one-shot, pre-exit call with nothing else left to
//! serve, and strictly cheaper than the §2.4 exit path which blocks the
//! MAIN thread for the same shape of wait on every plain quit. The
//! webview stays live the whole time; its await settles only when the
//! installer has really launched, so the "launched" reply stays honest.

use std::path::Path;
use tauri::{AppHandle, Emitter};

/// The minimum plausible installer size (bytes). The real bundle is ~35 MB;
/// anything smaller is an error page / JSON body the download step saved
/// by mistake — refuse to execute it.
const MIN_INSTALLER_BYTES: u64 = 10 * 1024 * 1024;

/// ROUND-123 (R123): the minimum plausible .deb (bytes) — the real bundle
/// is ~68 MB; the sidecar enforces the same floor at verify time, this is
/// the shell-side belt (the file could have been swapped).
const MIN_DEB_BYTES: u64 = 20 * 1024 * 1024;

/// ROUND-123 (R123): the overlay watcher's budget — how long the watcher
/// thread waits on the installer process before declaring the install
/// hung (the real silent install is 10-40s; ten minutes is ~15x headroom
/// for a slow disk or an AV scan, and past it the honest answer is a
/// failure the app can recover from, not an eternal splash).
const INSTALL_WAIT_BUDGET_SECS: u64 = 600;

/// `run_update_installer(path, silent?)` — install the downloaded update
/// and schedule the app's exit. See the module header for the contract.
/// R99-C: `silent: Some(true)` runs the NSIS installer with `/S /R` (silent
/// install + the template's post-success relaunch); `None`/`Some(false)`
/// keeps the interactive setup wizard. R104: on Linux the argument is
/// ignored — the AppImage replace is the install.
#[tauri::command]
pub async fn run_update_installer(
    app: AppHandle,
    path: String,
    silent: Option<bool>,
) -> Result<(), String> {
    let parsed = Path::new(&path);
    if parsed.is_absolute() {
        // Absolute is the expected form (the sidecar passes its own temp
        // path). Continue to the extension + existence checks.
    } else {
        return Err("the installer path must be absolute".to_string());
    }
    let ext = parsed
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    // R104 + R123: the kind dispatch + PLATFORM COHERENCE. The sidecar now
    // picks the platform's own asset (setup.exe on Windows, the
    // arch-matched AppImage on an AppImage-launched Linux, the arch-matched
    // .deb on a packaged Linux install — R123), but a stale staged file
    // from a pre-R104 download (or a hand-typed invoke) must still be
    // refused honestly instead of launching a Windows installer on Linux —
    // the exact v0.100.0 report ("Restarting into 0.100.0" → "Connecting to
    // Agent Core" → still 0.99.0) was this module accepting the .exe path
    // and failing deep inside the Windows-only launch.
    let is_appimage = ext == "appimage";
    let is_windows_setup = ext == "exe";
    let is_linux_deb = ext == "deb";
    if !is_appimage && !is_windows_setup && !is_linux_deb {
        return Err(format!(
            "refusing to run \"{path}\" — only this platform's update installer (.exe on Windows, .AppImage or .deb on Linux) can be launched"
        ));
    }
    if is_windows_setup && !cfg!(windows) {
        return Err(
            "the Windows setup.exe cannot install on this platform — run \"Check for updates\" to pick this machine's update, or use the Releases page".to_string(),
        );
    }
    if (is_appimage || is_linux_deb) && !cfg!(target_os = "linux") {
        return Err("the Linux update (.AppImage / .deb) only installs on Linux — use the Releases page".to_string());
    }

    let meta = std::fs::metadata(parsed)
        .map_err(|e| format!("the installer file is not reachable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{path}\" is not a regular file"));
    }
    // R104 + R123: the plausibility floor rides the KIND — the setup.exe is
    // ~37 MB (10 MB floor, unchanged since R91-E), the AppImage is ~130 MB
    // (50 MB floor), the .deb is ~68 MB (20 MB floor). The sidecar already
    // enforced the same floor at verify time; this is the shell-side belt
    // (the file could have been swapped).
    let floor = if is_appimage {
        appimage::MIN_APPIMAGE_BYTES
    } else if is_linux_deb {
        MIN_DEB_BYTES
    } else {
        MIN_INSTALLER_BYTES
    };
    if meta.len() < floor {
        return Err(format!(
            "the installer file is only {} bytes — refusing to run a truncated download",
            meta.len()
        ));
    }

    // ROUND-101 (R101-B): tell the webview BEFORE the kill. The frontend
    // sets `updateInFlight` on the About-tab leg (before this invoke even
    // starts), but this event is the belt-and-suspenders leg — any future
    // entry point that launches an installer gets the same calm
    // hand-off: the ConnectionGate swaps to the Restarting splash, the
    // watchdog/connect loop suppress the offline flip for the deliberately
    // dead backend, and the v0.98.0 "the environment crashed" flash can
    // not recur. Payload-less: the version (when the UI knows it) rides
    // the store, and the `let _` keeps a dead-webview edge non-fatal.
    let _ = app.emit("update-installing", ());

    // ROUND-104 (R104) + ROUND-123 (R123): THE LINUX LEGS — the AppImage
    // replace (stage → kill → rename → pid-wait relaunch) and the .deb
    // install (kill → pkexec dpkg -i watched → relaunch). Everything
    // before the kill can fail harmlessly (the app + engine live on
    // untouched); the kill is inside the module so the Windows ordering
    // contract stays the single place it lives.
    #[cfg(target_os = "linux")]
    {
        if is_appimage {
            appimage::install(&app, parsed)?;
            schedule_exit(&app);
            return Ok(());
        }
        if is_linux_deb {
            deb::install(&app, parsed)?;
            // R123: the deb leg's WATCHER owns the exit — dpkg runs while
            // this window stays open on the Restarting splash, and the
            // relaunch + exit fire only after a successful install (a
            // failed dpkg emits update-install-failed and the app LIVES
            // ON — the recovery restarts the engine over the still-running
            // old binary). No schedule_exit here: the invoke's Ok reply
            // lands while the splash owns the screen.
            return Ok(());
        }
    }

    // R96-I — THE PRE-INSTALL KILL, in ORDER: the sidecar tree dies (and its
    // handles are RELEASED) BEFORE the installer launches, or the NSIS File
    // instructions race the node processes holding $INSTDIR\sidecar\* open —
    // the owner's v0.93 report ("Error opening file for writing" on
    // `win32 x64.node`, then `node.exe`, both clicked through with Ignore).
    // This is the graceful ask → 5s bounded wait → force-kill → reap +
    // 300ms handle-release grace contract (sidecar::shutdown_before_install);
    // it blocks this command's runtime thread for at most that budget and
    // logs every step to sidecar.log — the app's one diagnostics channel.
    // R101-B: the phase flips to Stopped AND the webview already knows why
    // (the event above) — the UI's health polling is suppressed, so the
    // offline banner no longer flashes for the ~1.5s before the exit below.
    let kill_outcome = crate::sidecar::shutdown_before_install(&app);
    crate::sidecar::log_line(&format!(
        "update: installer launch proceeding after pre-install kill — {}",
        kill_outcome.describe()
    ));

    // The OS handoff — R99-C's two legs. SILENT (the one-click default
    // the frontend sends): R123 tries THE OVERLAY INSTALL first (the app
    // renames its own exe, launches the installer with an OWNED handle,
    // and STAYS OPEN on the animated Restarting splash for the whole
    // install — see mod overlay); a refusing self-rename (AV/filesystem
    // lock) falls back to the R99-C leg verbatim: ShellExecuteW with
    // "/S /R" — the NSIS silent flag + tauri's template restart flag (see
    // the module header: the relaunch rides the template's .onInstSuccess
    // RunAsUser, and the launch is as detached as the interactive leg the
    // shell plugin serves). INTERACTIVE (absent/false — the About tab's
    // fallback button): the shell plugin's Rust-side open (the same entry
    // open_external_url uses; a LOCAL path needs no ACL walk, and the
    // extension/existence gates above are the path-escape guard).
    if silent.unwrap_or(false) {
        match overlay::install_with_overlay(&app, parsed) {
            Ok(true) => {
                // The overlay flow is LIVE: the watcher thread owns the
                // install's visibility, the relaunch, and this process's
                // exit — no schedule_exit (the window must SURVIVE until
                // the new exe is ready to take over).
                crate::sidecar::log_line(
                    "update: the OVERLAY install is live — the window stays open until the new version is ready",
                );
                return Ok(());
            }
            Ok(false) => {
                crate::sidecar::log_line(
                    "update: the overlay rename was refused — falling back to the /S /R silent flow",
                );
            }
            Err(e) => return Err(e),
        }
        silent_launch::open_with_parameters(&path, silent_launch::ARGS)
            .map_err(|e| format!("launching the silent installer failed: {e}"))?;
    } else {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        app.shell()
            .open(&path, None)
            .map_err(|e| format!("launching the installer failed: {e}"))?;
    }

    schedule_exit(&app);
    Ok(())
}

/// The shared exit timer: give the invoke's reply time to reach the webview
/// (the "Restarting into vX" line + splash render from it), then close the
/// app so the replacement can take over — Windows locks a running exe's
/// file, and on Linux the delayed AppImage relauncher waits out this exit
/// before starting the new instance. A plain OS thread — tauri's
/// async_runtime would also carry it, but a 1.5s sleep needs no runtime;
/// AppHandle is Send.
fn schedule_exit(app: &AppHandle) {
    let exit_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        exit_handle.exit(0);
    });
}

// ── R104: the LINUX AppImage replace leg ────────────────────────────────────
//
// The owner's Linux report, answered: "It properly detects the new version
// and downloads it too but after downloading it… It was not updating it at
// all." The AppImage is a self-contained executable — installing the update
// means REPLACING the AppImage file the user launched, then starting it
// again. The mechanism (the same family tauri-plugin-updater rides on
// Linux, hand-rolled to keep the shell's existing kill/log/exit contracts):
//
//   1. Resolve the CURRENT AppImage path from the `APPIMAGE` environment
//      variable — the AppImage runtime exports it for exactly this
//      purpose; `current_exe()` is useless here (it resolves inside the
//      runtime's mounted squashfs, /tmp/.mount_…). A missing/relative
//      value means the app is not running from an AppImage (a .deb
//      install, a dev checkout) — refused honestly with the Releases-page
//      answer instead of guessing at a path.
//   2. STAGE the verified download BESIDE the current AppImage as
//      `.ACUTE-CODE-update-<pid>.AppImage` — same directory = same
//      filesystem = the final rename is ATOMIC (a cross-FS rename degrades
//      to copy+delete and can tear mid-move; a torn AppImage would brick
//      the install). The copy also PROVES the directory is writable before
//      anything is killed. The staged file is chmod 0755 (executable) and
//      fsynced (a power-cut after the rename must never leave a
//      half-written new AppImage owning the name).
//   3. KILL the sidecar tree (the same shutdown_before_install contract as
//      the Windows leg) — the replacement instance spawns its own sidecar,
//      and two engines on one SQLite file is a lock the owner should never
//      debug.
//   4. RENAME the staged file over the AppImage path. Rename atomically
//      swaps the directory entry: the OLD inode stays alive through the
//      running process's open mount handle (the app keeps working for its
//      last seconds), the NEW inode takes the public name. Never torn,
//      never half-old.
//   5. RELAUNCH the new AppImage through a detached `sh -c` that sleeps
//      3s first — the old app's exit timer fires at 1.5s, so the new
//      instance starts only after the old one is gone (no WebKitGTK
//      cache/data contention, no double window). Null stdio: the
//      relauncher must not hold this process's terminal fds alive.
//   6. The caller schedules the app's exit (schedule_exit) once this
//      returns Ok — the reply lands, the Restarting splash shows, the
//      window closes, the new version opens.
//
// FAILURE HONESTY (every leg mapped):
//   · stage copy fails (read-only directory, disk full) → Err BEFORE the
//     kill: the app + engine live on untouched; the message names the
//     writable-directory requirement.
//   · the rename fails (the target's parent lost write permission between
//     the stage and the rename — rare) → the staged file is cleaned up and
//     the Err maps to the frontend's R101-B recovery (updateInFlight
//     cleared, the sidecar restarts): the RUNNING app is untouched — the
//     old inode still owns its mount and the old file is still the old
//     file (rename is atomic: either the old name or the new one, never
//     both, never torn).
//   · the relaunch spawn fails AFTER a successful replace → Err with the
//     honest "the update is installed, reopen the app by hand" message;
//     the recovery restarts the engine and the CURRENT process keeps
//     serving from its still-alive old mount; the next manual start runs
//     the new version.
#[cfg(target_os = "linux")]
mod appimage {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use tauri::AppHandle;

    /// The minimum plausible AppImage (bytes) — the real bundle is ~130 MB
    /// (v0.100.0's aarch64 build is 132.7 MB); anything smaller is a saved
    /// error page or a truncated download.
    pub const MIN_APPIMAGE_BYTES: u64 = 50 * 1024 * 1024;

    /// R123: the post-exit settle (seconds) the relauncher waits AFTER the
    /// old pid is confirmed gone — a small WebKitGTK cache-flush grace,
    /// deliberately NOT the whole wait (the old process's EXIT is what the
    /// relauncher waits for now, not a guessed delay).
    const RELAUNCH_SETTLE_SECS: u64 = 1;

    /// The current AppImage's path, from the runtime's own `APPIMAGE`
    /// export. An absolute path is required — anything else (missing,
    /// empty, relative) means the app is NOT running from an AppImage and
    /// the replace has no target.
    fn current_appimage_path() -> Result<PathBuf, String> {
        match std::env::var("APPIMAGE") {
            Ok(value) if !value.is_empty() && Path::new(&value).is_absolute() => {
                Ok(PathBuf::from(value))
            }
            _ => Err(
                "the app is not running from an AppImage — a .deb install updates through the Releases page".to_string(),
            ),
        }
    }

    /// Single-quote a path for the relauncher's `sh -c` script (the
    /// canonical POSIX-safe form: every `'` becomes `'\''`).
    fn sh_single_quoted(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    /// The AppImage replace itself — stage → kill → rename → relaunch.
    /// Returns Ok only when the new AppImage owns the name AND the
    /// relaunch is scheduled; every failure keeps the caller's app alive
    /// and honest (see the module comment in update.rs for the mapping).
    pub fn install(app: &AppHandle, downloaded: &Path) -> Result<(), String> {
        let target = current_appimage_path()?;
        let dir = target
            .parent()
            .ok_or_else(|| "the AppImage has no parent directory".to_string())?
            .to_path_buf();
        let staged = dir.join(format!(".ACUTE-CODE-update-{}.AppImage", std::process::id()));

        // 1+2. STAGE: copy beside the target (proves writability), size-check
        // the copy, chmod 0755, fsync — all BEFORE anything is killed.
        let copied = fs::copy(downloaded, &staged).map_err(|e| {
            format!(
                "staging the new AppImage beside the current one failed: {e} — is the AppImage's directory writable by this user?"
            )
        })?;
        if copied < MIN_APPIMAGE_BYTES {
            let _ = fs::remove_file(&staged);
            return Err(format!(
                "the staged AppImage is only {copied} bytes — refusing to install a truncated download"
            ));
        }
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("making the staged AppImage executable failed: {e}"))?;
        // Durability, best-effort: fsync on the read-only handle is legal on
        // Linux and flushes the data blocks; a failure never blocks the
        // install (the rename's atomicity is the real safety property).
        if let Ok(handle) = fs::File::open(&staged) {
            let _ = handle.sync_all();
        }

        // 3. KILL — the same ordering contract as the Windows leg, shared
        // verbatim (graceful ask → bounded wait → force-kill → reap +
        // handle-release grace; see sidecar::shutdown_before_install).
        let kill_outcome = crate::sidecar::shutdown_before_install(app);
        crate::sidecar::log_line(&format!(
            "update: AppImage replace proceeding after pre-install kill — {}",
            kill_outcome.describe()
        ));

        // 4. The ATOMIC replace. On failure the running app is untouched
        // (the old inode still owns its name and mount) — clean the staged
        // file and let the frontend's recovery restart the engine.
        if let Err(e) = fs::rename(&staged, &target) {
            let _ = fs::remove_file(&staged);
            return Err(format!(
                "replacing the AppImage failed: {e} — the running app is untouched"
            ));
        }
        crate::sidecar::log_line("update: the AppImage was replaced — scheduling the relaunch");

        // 5. The PID-WAIT RELAUNCH (R123): `sh -c 'while kill -0 <pid>
        //    2>/dev/null; do sleep 0.2; done; sleep 1; exec <path>'`,
        //    detached, null stdio. The shell outlives this app's exit and
        //    starts the new AppImage only AFTER the old instance is really
        //    gone — the R104 fixed 3s guess could lose the race to a slow
        //    WebKitGTK teardown (two instances briefly alive, cache/data
        //    contention); waiting on the pid is deterministic, and the 1s
        //    settle after it covers the cache flush.
        let script = format!(
            "while kill -0 {} 2>/dev/null; do sleep 0.2; done; sleep {}; exec {}",
            std::process::id(),
            RELAUNCH_SETTLE_SECS,
            sh_single_quoted(&target.to_string_lossy())
        );
        match Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "the AppImage update is installed, but scheduling the relaunch failed: {e} — reopen the app by hand to run the new version"
            )),
        }
    }
}

// ── ROUND-123 (R123): the LINUX .DEB leg ─────────────────────────────────────
//
// The packaged-install twin of the AppImage replace: the sidecar picks the
// arch-matched .deb when the APPIMAGE env is absent (a .deb install, a
// future package-managed shape), and this leg installs it VISIBLY:
//
//   1. Resolve the CURRENT exe path (std::env::current_exe — on a packaged
//      install this is the real /usr/bin (or /opt) path dpkg will replace).
//   2. KILL the sidecar tree (the shared ordering contract — dpkg's file
//      replacements include $INSTDIR-sidecar files only on the AppImage
//      shape, but the SQLite data files the fresh instance will open are
//      held by the sidecar either way).
//   3. LAUNCH `pkexec dpkg -i <staged.deb>` detached — polkit's own GUI
//      prompt (the ONLY interaction: the owner's password) — and WAIT on
//      it from a watcher thread while this window stays open on the
//      Restarting splash. Linux can replace a running binary's file, so
//      THIS process is never at risk while dpkg works.
//   4. On success the watcher relaunches the exe at its (now updated)
//      path, detached, and exits this process after the reply's splash
//      leg. On failure (cancelled prompt, dependency error, timeout) the
//      watcher emits `update-install-failed` with dpkg's honest exit
//      status and the app LIVES ON: the frontend's recovery clears
//      updateInFlight and restarts the engine over the still-running old
//      binary (dpkg's failure leaves the package unpacked-but-unconfigured
//      at worst — never a half-written executable).
//
// The staged .deb itself is the sidecar's verified temp file — nothing is
// copied or moved (dpkg reads it as root through pkexec; the tmp dir is
// world-readable by default).
#[cfg(target_os = "linux")]
mod deb {
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tauri::{AppHandle, Emitter};

    /// How long the watcher waits on `pkexec dpkg -i` before declaring the
    /// install hung — the PARENT MODULE's shared INSTALL_WAIT_BUDGET_SECS
    /// (one budget for every watched install leg: the Windows overlay's
    /// WaitForSingleObject and this try_wait loop; a real dpkg -i is
    /// seconds, but polkit can wait on the owner's password input, so the
    /// budget is generous while the splash honestly says "installing").
    const DPKG_WAIT_BUDGET_SECS: u64 = super::INSTALL_WAIT_BUDGET_SECS;

    /// Single-quote a path for the `sh -c` script (the appimage module's
    /// canonical POSIX-safe form).
    fn sh_single_quoted(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    /// The .deb install — kill → pkexec dpkg -i (watched) → relaunch.
    /// Returns Ok once the WATCHER owns the flow (the caller's Ok reply
    /// renders while the splash owns the screen); every pre-spawn failure
    /// is an honest Err the frontend's recovery maps (engine restart over
    /// the untouched running binary).
    pub fn install(app: &AppHandle, downloaded: &Path) -> Result<(), String> {
        // 1. The exe path dpkg will replace (resolved BEFORE anything dies).
        let exe = std::env::current_exe()
            .map_err(|e| format!("resolving the running executable's path failed: {e}"))?;

        // 2. KILL — the shared ordering contract (graceful ask → bounded
        //    wait → force-kill → reap; see sidecar::shutdown_before_install).
        let kill_outcome = crate::sidecar::shutdown_before_install(app);
        crate::sidecar::log_line(&format!(
            "update: deb install proceeding after pre-install kill — {}",
            kill_outcome.describe()
        ));

        // 3. LAUNCH the watched install: `sh -c 'exec pkexec dpkg -i <deb>'`
        //    detached with null stdio. The SHELL is what the watcher waits
        //    on — its exit code IS dpkg's (exec replaces the shell), and a
        //    cancelled polkit prompt surfaces as a non-zero exit exactly
        //    like a failed dpkg.
        let script = format!("exec pkexec dpkg -i {}", sh_single_quoted(&downloaded.to_string_lossy()));
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                // The spawn itself refused (no sh — unreachable in practice,
                // or a fork failure). Nothing has been installed; the Err
                // maps to the frontend recovery (engine restart).
                format!(
                    "launching pkexec dpkg -i failed: {e} — is polkit installed on this desktop?"
                )
            })?;
        crate::sidecar::log_line("update: pkexec dpkg -i launched — the watcher owns the flow");

        // 4. The WATCHER: wait on the install, then relaunch or fail
        //    honestly. A plain OS thread (the schedule_exit precedent —
        //    AppHandle is Send; tauri's runtime carries the emit).
        let watcher_app = app.clone();
        let watcher_exe = exe.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(DPKG_WAIT_BUDGET_SECS);
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            break None;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                    Err(_) => break None,
                }
            };
            match status {
                Some(status) if status.success() => {
                    crate::sidecar::log_line("update: dpkg -i succeeded — relaunching the new version");
                    let _ = watcher_app.emit("update-installed", ());
                    // The relaunch: the exe at its (now updated) path,
                    // detached, null stdio — the shell outlives this exit.
                    let relaunch = Command::new("sh")
                        .arg("-c")
                        .arg(format!("exec {}", sh_single_quoted(&watcher_exe.to_string_lossy())))
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                    match relaunch {
                        Ok(_) => {
                            std::thread::sleep(std::time::Duration::from_millis(700));
                            watcher_app.exit(0);
                        }
                        Err(e) => {
                            // The package IS installed — the honest answer is
                            // the reopen-by-hand line, and the app LIVES ON
                            // (running the old binary from memory; the next
                            // manual start runs the new one).
                            let _ = watcher_app.emit(
                                "update-install-failed",
                                format!(
                                    "the new version is installed, but relaunching it failed: {e} — reopen the app by hand"
                                ),
                            );
                        }
                    }
                }
                maybe_status => {
                    // dpkg failed (cancelled prompt / dependency error) or
                    // the wait budget expired. The app is UNTOUCHED — emit
                    // the honest failure for the frontend's recovery.
                    let detail = match maybe_status {
                        Some(status) => format!("dpkg exited with status {status}"),
                        None => "the install did not finish within the wait budget".to_string(),
                    };
                    crate::sidecar::log_line(&format!("update: the deb install failed — {detail}"));
                    let _ = watcher_app.emit(
                        "update-install-failed",
                        format!("the .deb install failed — {detail}; the app keeps running the current version (the Releases page always has the latest)"),
                    );
                }
            }
        });
        Ok(())
    }
}

/// Non-Linux builds: the AppImage floor is only referenced by the Linux
/// leg's dispatch, so keep a compile-time placeholder that preserves the
/// message shape without a dead constant.
#[cfg(not(target_os = "linux"))]
mod appimage {
    /// The AppImage plausibility floor as seen by the cross-platform
    /// validation gate (kept identical to the Linux leg's constant so the
    /// refusal messages agree everywhere).
    pub const MIN_APPIMAGE_BYTES: u64 = 50 * 1024 * 1024;
}

// ── R99-C: the SILENT-install launch leg (Windows) ──────────────────────────
//
// ShellExecuteW is the one Win32 entry that both (a) launches a local .exe
// through the shell — the SAME detachment family the interactive leg rides
// (the `open` crate the shell plugin delegates to calls ShellExecuteExW; the
// launched process outlives this app's exit and joins no job object) — and
// (b) accepts a free-form PARAMETER string, which the shell plugin's `open`
// cannot express (its second argument is the named `open::Program` enum).
// Hand-rolled FFI mirrors the R55 wincred.rs precedent (direct CredReadW/
// CredWriteW): enabling windows-sys's Win32_UI_Shell feature for one call
// is a wider blast radius than six declared word/pointer arguments. No
// structs, no GetLastError plumbing — ShellExecuteW reports success as a
// return value > 32 and its own SE_ERR_* codes at or below that (32 itself
// is SE_ERR_DLLNOTFOUND — the R99-H review catch: a > 31 boundary would
// misclassify a missing DLL as success and the app would exit in 1.5s
// claiming an install that never ran).
#[cfg(windows)]
pub(crate) mod silent_launch {
    /// The parameter string for the silent leg: NSIS's `/S` (silent
    /// install — no wizard, no prompts) + tauri's NSIS-template `/R`
    /// (relaunch `$INSTDIR\ACUTE-CODE.exe` via the template's
    /// `.onInstSuccess` → nsis_tauri_utils::RunAsUser after a SUCCESSFUL
    /// install — the finish-page "run app" checkbox never renders
    /// silently, so the template's own restart flag is the relaunch leg).
    pub const ARGS: &str = "/S /R";

    // SAFETY-of-declaration: six word/pointer-sized scalar arguments and an
    // integer return — no structs, so there is no layout to get wrong. The
    // `#[link]` attribute pulls shell32.lib in for the MSVC linker.
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show: i32,
        ) -> isize;
    }

    /// SW_SHOWNORMAL (winuser.h). NSIS `/S` renders no UI either way; the
    /// flag keeps the call honest for any future non-silent parameter leg.
    const SW_SHOWNORMAL: i32 = 1;

    /// Opens `path` with the default "open" verb and `parameters` as the
    /// launched process's command line. Buffers are NUL-terminated UTF-16
    /// and outlive the call (the shell copies what it needs before
    /// returning). Errors carry ShellExecuteW's own SE_ERR code.
    pub fn open_with_parameters(path: &str, parameters: &str) -> Result<(), String> {
        let file: Vec<u16> = wide(path);
        let params: Vec<u16> = wide(parameters);
        // SAFETY: `file`/`params` are NUL-terminated UTF-16 buffers alive
        // until the call returns; the null hwnd (no owner window), null
        // verb (the default "open" verb), and null directory (the target's
        // own directory) are each explicitly documented as legal nulls.
        let result = unsafe {
            ShellExecuteW(
                0,
                std::ptr::null(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // Win32 contract: a value > 32 means success (an HINSTANCE);
        // 0..=32 is SE_ERR_* — INCLUDING 32 = SE_ERR_DLLNOTFOUND.
        if result > 32 {
            Ok(())
        } else {
            Err(describe_se_err(result))
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The honest SE_ERR_* reading (shellapi.h) — the reachability of
    /// 2/3 was already proven impossible by the existence gates above,
    /// so each hint stays one line, never a guess.
    fn describe_se_err(code: isize) -> String {
        let hint = match code {
            0 => "the OS is out of memory or resources".to_string(),
            2 => "the installer file was not found".to_string(),
            3 => "the installer's directory was not found".to_string(),
            5 => "the OS refused the launch (access denied)".to_string(),
            26 => "a sharing violation blocked the launch".to_string(),
            27 => "the file association is incomplete".to_string(),
            28 => "the command timed out".to_string(),
            31 => "no program is associated with the installer".to_string(),
            other => format!("ShellExecuteW error code {other}"),
        };
        format!("ShellExecuteW answered {code} — {hint}")
    }
}

/// Non-Windows dev checkouts: the silent installer launch is a
/// packaged-Windows-app concern (the wincred.rs imp-stub pattern — keep
/// every call site honest instead of silently pretending).
#[cfg(not(windows))]
pub(crate) mod silent_launch {
    pub const ARGS: &str = "";

    pub fn open_with_parameters(_path: &str, _parameters: &str) -> Result<(), String> {
        Err("the silent installer launch is only available in the packaged Windows app".to_string())
    }
}

// ── ROUND-123 (R123): THE WINDOWS OVERLAY INSTALL ────────────────────────────
//
// The owner's report: "it does not show me any kind of animation while it is
// processing… I feel like that nothing is happening and it won't auto start
// but it does auto start with some delay, which is not ideal." The R99-C
// flow exits the app 1.5s after launching the silent NSIS installer, so the
// 10-40s install runs COMPLETELY INVISIBLY (no window, no progress — the
// "delay" before the template's /R relaunch), and the only visible moments
// were the pre-exit splash and the post-relaunch "Setting up" splash.
//
// The overlay flow makes the WHOLE install visible:
//   1. RENAME the running exe to `<exe>.old` — the Chrome/VS Code update
//      trick: a running executable CAN rename its own file on Windows
//      (the file stays locked, but the NAME is free), which frees the
//      install path for NSIS to write the new exe while THIS process
//      lives on. A refusing rename (an AV/filesystem lock on the entry)
//      is not an error — the caller falls back to the R99-C flow.
//   2. LAUNCH the installer with CreateProcessW (NOT ShellExecuteW) to
//      OWN the process handle: `"<installer>" /S` — no /R, because HERE
//      the relaunch is OURS (the watcher below), not the template's
//      timer. DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP keeps the
//      installer off this console and out of Ctrl+C groups.
//   3. KEEP THE APP OPEN: the webview is already showing the animated
//      Restarting splash (updateInFlight was set before the invoke), and
//      it now stays alive for the WHOLE install — the watcher thread
//      waits on the installer handle (WaitForSingleObject, bounded by
//      INSTALL_WAIT_BUDGET_SECS).
//   4. ON SUCCESS the watcher emits `update-installed` (the splash swaps
//      its line to "installed — restarting now"), relaunches the NEW exe
//      at the original path via ShellExecuteW (the detached shell-open
//      family the interactive leg has ridden since R91), and exits this
//      process 700ms later (the new instance's "Setting up vX" splash,
//      via the R118-F marker, takes over seamlessly).
//   5. ON FAILURE the watcher emits `update-install-failed` with the
//      honest message and LEAVES THE APP ALIVE: the frontend's recovery
//      clears updateInFlight and restarts the engine — the running
//      (renamed) binary keeps serving; whatever NSIS managed to write
//      before failing is at the original path for the next manual start.
//
// The `.old` file this flow leaves behind is deletable only after this
// process exits (a running exe's file stays locked) —
// `cleanup_renamed_exe` (wired into lib.rs's setup) removes any stale
// `<current_exe>.old` at every startup, best-effort.
#[cfg(windows)]
pub(crate) mod overlay {
    use std::path::Path;
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    /// The watcher's wait budget, imported from the parent module's
    /// INSTALL_WAIT_BUDGET_SECS (one shared constant for the Windows
    /// overlay and the Linux deb watcher — the deb module reads it
    /// directly from its own scope; the cast is width-honest: 600s * 1000
    /// fits u32 with orders of magnitude to spare).
    const WAIT_BUDGET_MS: u32 = super::INSTALL_WAIT_BUDGET_SECS as u32 * 1000;

    /// WaitForSingleObject's own return codes (winbase.h).
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 0x102;

    /// HANDLE is a raw pointer and therefore not `Send` by default; this
    /// newtype carries the ownership discipline that makes the move sound:
    /// the handle came from OUR CreateProcessW call, nobody else holds it,
    /// and exactly ONE thread (the watcher below) touches it from the move
    /// until its single CloseHandle. The Win32 handle itself is a plain
    /// kernel value valid on any thread.
    struct SendHandle(windows_sys::Win32::Foundation::HANDLE);
    // SAFETY: see the struct comment — exclusive single-owner discipline.
    unsafe impl Send for SendHandle {}

    /// The installer argument string for the overlay leg: NSIS's `/S`
    /// (silent) with NO `/R` — the relaunch is OURS here (the watcher
    /// relaunches the new exe the moment the install finishes), not the
    /// template's .onInstSuccess timer (which would race US to it).
    const OVERLAY_ARGS: &str = "/S";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The suffix appended to the renamed exe (the `.old` file
    /// cleanup_renamed_exe removes at startup).
    pub const RENAMED_SUFFIX: &str = ".old";

    /// Try the overlay install. Returns:
    ///   · Ok(true)  — the flow is LIVE (rename done, installer launched,
    ///                 watcher owns the exit); the caller must NOT exit.
    ///   · Ok(false) — the self-rename refused (AV/filesystem lock); the
    ///                 caller falls back to the R99-C /S /R flow verbatim.
    ///   · Err(e)    — the installer launch failed AFTER a successful
    ///                 rename; the exe's name has been RESTORED and the
    ///                 app is fully alive — the frontend's recovery maps
    ///                 this exactly like a rejected /S /R launch.
    ///
    /// The sidecar kill has ALREADY happened (the command's shared
    /// ordering contract) — every path here runs with the engine down,
    /// and every non-live path relies on the frontend's recovery to bring
    /// it back.
    pub fn install_with_overlay(app: &AppHandle, installer: &Path) -> Result<bool, String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("resolving the running executable's path failed: {e}"))?;
        let exe_old = {
            let mut p = exe.clone().into_os_string();
            p.push(RENAMED_SUFFIX);
            std::path::PathBuf::from(p)
        };

        // 1. THE SELF-RENAME. Windows locks a running exe's FILE, but the
        //    directory ENTRY is renamable — after this, NSIS can write a
        //    brand-new exe at the original path while we keep running from
        //    the renamed one. A pre-existing .old (a prior overlay whose
        //    process is gone) is removable; one still held by ANOTHER live
        //    instance (two apps running) makes the rename fail → the
        //    honest fallback (that machine updates the R99-C way).
        if let Err(e) = std::fs::rename(&exe, &exe_old) {
            // Best-effort: clear a stale .old from a previous run, then
            // retry once (the common case — a crash mid-flow last time).
            let _ = std::fs::remove_file(&exe_old);
            if let Err(e2) = std::fs::rename(&exe, &exe_old) {
                crate::sidecar::log_line(&format!(
                    "update: the overlay self-rename refused ({e}, retry {e2}) — the silent /S /R fallback applies"
                ));
                return Ok(false);
            }
        }
        crate::sidecar::log_line("update: the overlay self-rename landed — the install path is free");

        // 2. LAUNCH the installer with an OWNED handle. CreateProcessW's
        //    command line must be MUTABLE UTF-16 (the documented contract)
        //    with the executable path QUOTED (spaces in $TMP paths).
        //    STARTUPINFOW: windows-sys does not derive Default for it, so
        //    the classic Win32 zero-init applies (an all-zero C struct of
        //    plain integers/pointers — the documented-safe shape) with cb
        //    set to the struct's own size (the Win32 contract).
        let cmdline = format!("\"{}\" {}", installer.to_string_lossy(), OVERLAY_ARGS);
        let mut cmdline_wide = wide(&cmdline);
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut proc_info = PROCESS_INFORMATION {
            hProcess: INVALID_HANDLE_VALUE,
            hThread: INVALID_HANDLE_VALUE,
            dwProcessId: 0,
            dwThreadId: 0,
        };
        // SAFETY: every argument is either null (the four optional
        // attribute/environment/directory pointers) or a live, NUL-bearing
        // buffer this frame owns; the two OUT structs are zero-initialized
        // locals of the exact windows-sys types; the creation flags are
        // plain constants. The returned BOOL is checked before any handle
        // is used.
        let ok = unsafe {
            CreateProcessW(
                std::ptr::null(),
                cmdline_wide.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut proc_info,
            )
        };
        if ok == 0 {
            // RESTORE the exe's name before erroring — the install never
            // started, and the app must stay normally launchable.
            let _ = std::fs::rename(&exe_old, &exe);
            let code = unsafe { GetLastError() };
            let err = std::io::Error::from_raw_os_error(code as i32);
            return Err(format!(
                "launching the installer failed: {err} — the running app is untouched"
            ));
        }
        // The thread handle is not needed (we only wait on the process).
        unsafe { CloseHandle(proc_info.hThread) };

        // R123: tell the webview WHICH flow is live — the splash's subline
        // is flow-dependent ("this window stays open while it installs" vs
        // the fallback's "the window will close for a moment"). The `let _`
        // keeps a dead-webview edge non-fatal.
        let _ = app.emit("update-overlay", ());

        // 3+4+5. THE WATCHER — a plain OS thread (the schedule_exit
        //    precedent; AppHandle is Send).
        let watcher_app = app.clone();
        let watcher_exe = exe.clone();
        let process = SendHandle(proc_info.hProcess);
        std::thread::spawn(move || {
            // R123 (the disjoint-capture lesson): destructure the wrapper INSIDE
            // the closure so the closure captures `process` — the Send newtype —
            // as a WHOLE. Rust 2021's disjoint field captures would otherwise
            // capture the raw-pointer FIELD directly and lose the Send impl.
            // SAFETY: the handle came from a successful CreateProcessW and is
            // closed exactly once on every path below (the watcher's join).
            let SendHandle(handle) = process;
            let wait = unsafe { WaitForSingleObject(handle, WAIT_BUDGET_MS) };
            match wait {
                WAIT_OBJECT_0 => {
                    // The install finished — the new exe owns the original
                    // path. Tell the splash, relaunch, exit.
                    crate::sidecar::log_line(
                        "update: the overlay install finished — relaunching the new version",
                    );
                    let _ = watcher_app.emit("update-installed", ());
                    if let Err(e) = relaunch_detached(&watcher_exe) {
                        // The new version IS installed at the path — the
                        // honest answer is the reopen-by-hand line; the app
                        // LIVES ON (this process still runs from .old).
                        let _ = watcher_app.emit(
                            "update-install-failed",
                            format!(
                                "the new version is installed, but relaunching it failed: {e} — reopen the app by hand"
                            ),
                        );
                        unsafe { CloseHandle(handle) };
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    unsafe { CloseHandle(handle) };
                    watcher_app.exit(0);
                }
                WAIT_TIMEOUT => {
                    // The budget expired. The installer MIGHT still be
                    // running (a huge AV scan) — the honest answer is the
                    // failure event: the app recovers, the owner retries
                    // when the machine calms down. The installer process
                    // itself is left alone (killing a mid-write NSIS is
                    // worse than letting it finish late).
                    crate::sidecar::log_line(
                        "update: the overlay install exceeded the wait budget — recovering",
                    );
                    let _ = watcher_app.emit(
                        "update-install-failed",
                        "the silent install did not finish within ten minutes — the app keeps running the current version; try the update again (or use the Releases page)",
                    );
                    unsafe { CloseHandle(handle) };
                }
                _ => {
                    // WAIT_FAILED (or anything unexpected) — the wait itself
                    // broke; treat it exactly like the timeout (the app
                    // recovers over the still-running old binary).
                    crate::sidecar::log_line(
                        "update: waiting on the installer failed — recovering",
                    );
                    let _ = watcher_app.emit(
                        "update-install-failed",
                        "waiting on the installer failed — the app keeps running the current version; try the update again (or use the Releases page)",
                    );
                    unsafe { CloseHandle(handle) };
                }
            }
        });
        Ok(true)
    }

    /// Relaunch the (newly installed) exe at `path` — ShellExecuteW with
    /// the plain open verb (the SAME detachment family the interactive
    /// installer leg has ridden since R91: the launched process outlives
    /// this app's exit and joins no job object).
    fn relaunch_detached(path: &Path) -> Result<(), String> {
        super::silent_launch::open_with_parameters(&path.to_string_lossy(), "")
    }
}

/// Non-Windows dev checkouts: the overlay is a packaged-Windows-app concern
/// (the wincred.rs imp-stub pattern — the call site stays honest: the
/// fallback leg runs, exactly like a Windows machine whose rename refused).
#[cfg(not(windows))]
pub(crate) mod overlay {
    use std::path::Path;
    use tauri::AppHandle;

    pub fn install_with_overlay(_app: &AppHandle, _installer: &Path) -> Result<bool, String> {
        Ok(false)
    }
}

/// ROUND-123 (R123): the `.old` startup cleanup — remove any stale
/// `<current_exe>.old` left behind by a previous overlay flow (a crash
/// mid-install, or a machine that powered off before the exit). The file
/// is deletable only when no process runs from it: this runs at STARTUP,
/// before any rename happens this session, so a leftover is always stale
/// UNLESS two instances are running (the remove simply fails then —
/// best-effort by design, never a startup blocker). Called from lib.rs's
/// setup on Windows only.
#[cfg(windows)]
pub(crate) fn cleanup_renamed_exe() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut old = exe.into_os_string();
    old.push(overlay::RENAMED_SUFFIX);
    let old = std::path::PathBuf::from(old);
    if old.exists() {
        match std::fs::remove_file(&old) {
            Ok(()) => {
                crate::sidecar::log_line("update: removed a stale .old exe from a previous update flow");
            }
            Err(_) => {
                // A live instance may still run from it (two apps open) —
                // its own next startup will clear it. Silence is honest.
            }
        }
    }
}

/// Non-Windows builds: the cleanup is a Windows-only concern (the overlay
/// flow's .old file); the call site in lib.rs is cfg-gated to match.
#[cfg(not(windows))]
pub(crate) fn cleanup_renamed_exe() {}
