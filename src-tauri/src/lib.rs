/// Placeholder command proving the IPC surface is wired; removed once real
/// commands land.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Future duty (Phase 2+): spawn the agent-core Node sidecar as a child
/// process (bundled binary), pass it an auth token + port via environment,
/// wait for its /health endpoint, and shut it down cleanly on exit.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}
