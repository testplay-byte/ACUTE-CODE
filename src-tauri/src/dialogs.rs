//! Native dialogs (Agentic Coding MVP, owner directive: "actually select the
//! folder itself" — no pasting paths). `pick_folder` opens the OS folder
//! chooser and returns the absolute path the user selected (null on cancel).
//! No path is stored or logged here; persistence happens via POST /projects.

use rfd::FileDialog;

#[tauri::command]
pub fn pick_folder() -> Option<String> {
    FileDialog::new()
        .set_title("Choose the project folder")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}
