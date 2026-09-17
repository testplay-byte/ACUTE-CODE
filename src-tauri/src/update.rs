//! ROUND-91 (R91-E): THE IN-APP UPDATER — the Rust half.
//!
//! The owner's directive: "there was no inbuilt update system. I would like
//! you to add an inbuilt update system to it, like I can update the
//! application from within the app itself rather than going anywhere, like
//! using the app store."
//!
//! Division of labor (why the download lives in the SIDECAR, not here):
//! the repo is PRIVATE, so the setup.exe asset download needs the
//! launcher's GitHub PAT in an Authorization header. The sidecar already
//! reads that token for /system/updates (R89-A2) — so it also STREAMS the
//! installer to disk with live progress (GET /system/updates/download +
//! GET /system/updates/download/progress). This module is the SHELL's
//! half: taking the verified installer the sidecar produced and RUNNING it
//! — the one thing only the OS-side process can do (a webview cannot
//! ShellExecute, and tauri-plugin-shell's JS `open` would fight the
//! app-content scope).
//!
//! `run_update_installer(path, silent?)`:
//!  · validates `path` — it must EXIST, be a `.exe`, and be a plausible
//!    installer (> 10 MB; the real bundle is ~35 MB, a stray error page
//!    is a few KB). No path escapes: any other extension is refused.
//!  · KILLS THE SIDECAR TREE FIRST (R96-I — `sidecar::shutdown_before_install`):
//!    the graceful `POST /internal/shutdown`, a 5s bounded wait for a real
//!    exit, `taskkill /T /F` on the tree if the wait expires, then a reap
//!    + 300ms handle-release grace. The v0.93 report ("Error opening file
//!    for writing" on `win32 x64.node`, then `node.exe`) was the old
//!    launch-first-quit-later ordering: the NSIS File instructions raced
//!    the still-running node tree, and a kill being ISSUED is not the
//!    files being WRITABLE — TerminateProcess closes handles
//!    asynchronously. By the time the installer below is launched, nothing
//!    the app spawned holds the install directory.
//!  · hands it to the OS — R99-C adds the SILENT leg (below); the legacy
//!    leg is the shell plugin's `open` verb (ShellExecute "open"), exactly
//!    the OS handoff `open_external_url` already uses, for a LOCAL file.
//!  · schedules the APP's own exit 1.5s later. The NSIS installer
//!    replaces the running exe — Windows locks a running executable's
//!    file, so the app must close for the install to land. 1.5s is enough
//!    for the invoke's reply to reach the webview so the UI can say
//!    "installer launched" before the window goes away. (The sidecar is
//!    already dead by this point — the exit only has to close the app's
//!    own exe; the RunEvent::Exit shutdown in lib.rs finds no child and
//!    returns immediately.)
//!
//! ROUND-99 (R99-C): THE ONE-CLICK SILENT UPDATE. The owner's directive:
//! "I click the update button in the application and everything else
//! happens automatically afterwards by itself without me having to make
//! any changes." The optional `silent` IPC arg (camelCase `silent` on the
//! invoke, identical on both legs of the auto-conversion) switches the
//! launch to ShellExecuteW with the parameter string `/S /R`:
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

/// `run_update_installer(path, silent?)` — launch the downloaded update
/// installer and schedule the app's exit. See the module header for the
/// contract. R99-C: `silent: Some(true)` runs the NSIS installer with
/// `/S /R` (silent install + the template's post-success relaunch);
/// `None`/`Some(false)` keeps the interactive setup wizard.
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
    if ext != "exe" {
        return Err(format!(
            "refusing to run \"{path}\" — only the update installer (.exe) can be launched"
        ));
    }
    let meta = std::fs::metadata(parsed)
        .map_err(|e| format!("the installer file is not reachable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{path}\" is not a regular file"));
    }
    if meta.len() < MIN_INSTALLER_BYTES {
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

    // R96-I — THE PRE-INSTALL KILL, in ORDER: the sidecar tree dies (and its
    // handles are RELEASED) BEFORE the installer launches, or the NSIS File
    // instructions race the node processes holding $INSTDIR\sidecar\* open —
    // the owner's v0.93 report ("Error opening file for writing" on
    // `win32 x64.node`, then `node.exe`, both clicked through with Ignore).
    // This is the graceful ask → 5s bounded wait → taskkill /T /F → reap +
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

    // Give the reply time to reach the webview, then close the app so the
    // NSIS installer can replace the executable (Windows locks a running
    // exe's file). A plain OS thread — tauri's async_runtime would also
    // carry it, but a 1.5s sleep needs no runtime; AppHandle is Send.
    let exit_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        exit_handle.exit(0);
    });
    Ok(())
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
