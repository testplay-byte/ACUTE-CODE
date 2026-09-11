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
//! `run_update_installer(path)`:
//!  · validates `path` — it must EXIST, be a `.exe`, and be a plausible
//!    installer (> 10 MB; the real bundle is ~35 MB, a stray error page
//!    is a few KB). No path escapes: any other extension is refused.
//!  · hands it to the OS `open` verb (ShellExecute "open") via the shell
//!    plugin — exactly the OS handoff `open_external_url` already uses,
//!    but for a LOCAL file the plugin's Rust-side entry accepts it.
//!  · schedules the APP's own exit 1.5s later. The NSIS installer
//!    replaces the running exe — Windows locks a running executable's
//!    file, so the app must close for the install to land. 1.5s is enough
//!    for the invoke's reply to reach the webview so the UI can say
//!    "installer launched" before the window goes away.
//!
//! ASYNC on purpose (the R91-B1 lesson, same as open_browser_window): a
//! sync command runs on the main thread, and nothing in THIS command
//! blocks on the event loop — but the shell plugin's open spawns a process
//! and the 1.5s exit timer rides the tokio runtime; async keeps the whole
//! flow off the main thread by construction.

use std::path::Path;
use tauri::AppHandle;

/// The minimum plausible installer size (bytes). The real bundle is ~35 MB;
/// anything smaller is an error page / JSON body the download step saved
/// by mistake — refuse to execute it.
const MIN_INSTALLER_BYTES: u64 = 10 * 1024 * 1024;

/// `run_update_installer(path)` — launch the downloaded update installer
/// and schedule the app's exit. See the module header for the contract.
#[tauri::command]
pub async fn run_update_installer(app: AppHandle, path: String) -> Result<(), String> {
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

    // The OS handoff — tauri-plugin-shell's Rust-side open (the same
    // entry open_external_url uses; a LOCAL path needs no ACL walk, and
    // the extension/existence gates above are the path-escape guard).
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell()
        .open(&path, None)
        .map_err(|e| format!("launching the installer failed: {e}"))?;

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
