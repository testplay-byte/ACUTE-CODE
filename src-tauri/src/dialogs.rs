//! Native dialogs (Agentic Coding MVP, owner directive: "actually select the
//! folder itself" — no pasting paths). `pick_folder` opens the OS folder
//! chooser and returns the absolute path the user selected (null on cancel).
//! No path is stored or logged here; persistence happens via POST /projects.
//!
//! ROUND-48 fix (owner report: the picker appeared BELOW every window): the
//! dialog is now PARENTED to the main webview window. An owned modal cannot
//! sink below its owner, which fixes the z-order class of bug; rfd renders
//! the modern Vista+ IFileOpenDialog file-explorer style on Windows.
//!
//! ROUND-50 (R50-c1): `pick_files` — the chat composer's multi-file picker
//! ("Add Context"). Same parenting/topmost pattern as `pick_folder`; returns
//! the chosen absolute paths (EMPTY = cancelled). rfd's `pick_files` maps to
//! the Vista+ common OpenFileDialog with multi-select.

use rfd::FileDialog;
use tauri::Manager;

#[tauri::command]
pub fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let mut dialog = FileDialog::new().set_title("Choose the project folder");
    // Parent the picker to the app's main window so it stays ON TOP (an
    // owned window can never be hidden behind its owner). Falls back to an
    // unowned dialog only in the defensive case where the window is gone.
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    let mut dialog = FileDialog::new().set_title("Choose files to attach");
    // Same z-order fix as pick_folder: owned by the main window so the
    // picker lands ON TOP of the app (and everything else).
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    // None (cancelled / dialog failed) and Some(vec![]) both map to an empty
    // Vec — the caller treats "no files" as "user cancelled".
    dialog
        .pick_files()
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}
