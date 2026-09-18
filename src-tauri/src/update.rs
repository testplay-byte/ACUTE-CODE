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

    // R104: the kind dispatch + PLATFORM COHERENCE. The sidecar now picks
    // the platform's own asset (setup.exe on Windows, the arch-matched
    // AppImage on Linux), but a stale staged file from a pre-R104 download
    // (or a hand-typed invoke) must still be refused honestly instead of
    // launching a Windows installer on Linux — the exact v0.100.0 report
    // ("Restarting into 0.100.0" → "Connecting to Agent Core" → still
    // 0.99.0) was this module accepting the .exe path and failing deep
    // inside the Windows-only launch.
    let is_appimage = ext == "appimage";
    let is_windows_setup = ext == "exe";
    if !is_appimage && !is_windows_setup {
        return Err(format!(
            "refusing to run \"{path}\" — only this platform's update installer (.exe on Windows, .AppImage on Linux) can be launched"
        ));
    }
    if is_windows_setup && !cfg!(windows) {
        return Err(
            "the Windows setup.exe cannot install on this platform — run \"Check for updates\" to pick this machine's update, or use the Releases page".to_string(),
        );
    }
    if is_appimage && !cfg!(target_os = "linux") {
        return Err("the AppImage update only installs on Linux — use the Releases page".to_string());
    }

    let meta = std::fs::metadata(parsed)
        .map_err(|e| format!("the installer file is not reachable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{path}\" is not a regular file"));
    }
    // R104: the plausibility floor rides the KIND — the setup.exe is ~37 MB
    // (10 MB floor, unchanged since R91-E), the AppImage is ~130 MB (50 MB
    // floor). The sidecar already enforced the same floor at verify time;
    // this is the shell-side belt (the file could have been swapped).
    let floor = if is_appimage {
        appimage::MIN_APPIMAGE_BYTES
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

    // ROUND-104 (R104): THE LINUX APPIMAGE REPLACE — stage → kill → rename
    // → delayed relaunch. Everything before the kill can fail harmlessly
    // (the app + engine live on untouched); the kill is inside the module
    // so the Windows ordering contract stays the single place it lives.
    #[cfg(target_os = "linux")]
    {
        if is_appimage {
            appimage::install(&app, parsed)?;
            schedule_exit(&app);
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
    // the frontend sends): ShellExecuteW with "/S /R" — the NSIS silent
    // flag + tauri's template restart flag (see the module header: the
    // relaunch rides the template's .onInstSuccess RunAsUser, and the
    // launch is as detached as the interactive leg the shell plugin
    // serves). INTERACTIVE (absent/false — the About tab's fallback
    // button): the shell plugin's Rust-side open (the same entry
    // open_external_url uses; a LOCAL path needs no ACL walk, and the
    // extension/existence gates above are the path-escape guard).
    if silent.unwrap_or(false) {
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

    /// How long the relauncher waits before starting the new AppImage
    /// (seconds) — the old app exits 1.5s after this command replies, so 3s
    /// clears the dying instance with margin (the sidecar is already dead;
    /// this guards the webview/data-dir side).
    const RELAUNCH_DELAY_SECS: u64 = 3;

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

        // 5. The DELAYED RELAUNCH: `sh -c 'sleep 3; exec <path>'`, detached,
        // null stdio. The shell outlives this app's exit; the new AppImage
        // starts after the old instance is gone.
        let script = format!(
            "sleep {}; exec {}",
            RELAUNCH_DELAY_SECS,
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
