mod browser;
mod dialogs;
mod keys;
mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            sidecar::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_info,
            sidecar::ping_sidecar,
            keys::store_provider_key,
            keys::provider_key_status,
            dialogs::pick_folder,
            // ROUND-50 (R50-c1): the composer's multi-file "Add Context"
            // picker — same parenting/topmost pattern as pick_folder.
            dialogs::pick_files,
            // ROUND-41: the standalone browser window (superseded for the
            // in-app panel by the browser_tab_* commands below, still used by
            // the BrowserPanel's "pop out" button).
            browser::open_browser_window,
            browser::navigate_browser,
            browser::close_browser_window,
            browser::is_browser_window_open,
            // ROUND-50 (R50-a): the native embedded browser — one child
            // webview per browser tab inside the main window (Chromium/
            // WebView2 rendering, no proxy).
            browser::browser_tab_create,
            browser::browser_tab_navigate,
            browser::browser_tab_set_bounds,
            browser::browser_tab_set_visible,
            browser::browser_tab_go,
            browser::browser_tab_url,
            browser::browser_tab_close,
            browser::browser_tabs_close_all
        ])
        .build(tauri::generate_context!())
        .expect("error while running the tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
