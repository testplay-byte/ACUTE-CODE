mod browser;
mod dialogs;
mod keys;
// ROUND-64 (R64-b): the always-on-top floating computer-use mini monitor
// window (open/close_computer_mini — see src/mini for the page it hosts).
mod mini;
mod sidecar;
// ROUND-55 (R55): direct Windows Credential Manager FFI — replaced the
// keyring crate whose `{user}.{service}` TargetName never matched the
// launcher's cmdkey targets (see src/wincred.rs for the post-mortem).
mod wincred;

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
            // ROUND-53 (R53): the connection splash / offline banner poll this
            // for the lifecycle phase + the REAL startup error, and the Retry
            // button drives restart_sidecar (crashed backend → no app restart).
            sidecar::sidecar_status,
            sidecar::restart_sidecar,
            sidecar::ping_sidecar,
            // ROUND-54 (R54): the offline screen renders the last lines of
            // sidecar.log in-app (with a copy-diagnostics button) — the owner
            // no longer has to hunt for %APPDATA%\acute-code by hand.
            sidecar::sidecar_log_tail,
            keys::store_provider_key,
            keys::provider_key_status,
            // ROUND-90 (R90-A5): the delete-provider flow's missing half —
            // purges the OS-stored key + the custom-provider note line after
            // the sidecar's DELETE /providers/:id succeeds.
            keys::remove_provider_key,
            // ROUND-61 (R61): the separate vision-model key slot (Settings →
            // Computer Use): credential write + note + in-memory handoff.
            keys::store_vision_key,
            keys::vision_key_status,
            // ROUND-87 (R87): the application-wide reset's credential purge.
            keys::purge_provider_keys,
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
            // ROUND-59 (R59-b): the pop-out window's custom-chrome page
            // (popout.html) asks for its initial URL on mount — the stash
            // open_browser_window published.
            browser::popout_initial_url,
            // ROUND-58 (R58-b): hand a URL to the OS default browser from
            // Rust — the BrowserPanel's "Open externally" affordance
            // (window.open inside WebView2 is silently swallowed by wry).
            browser::open_external_url,
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
            browser::browser_tabs_close_all,
            // ROUND-60 (R60): the pop-out gutter scrollbar's data + control
            // channel (eval_with_callback reads the page's scroller geometry
            // back out without injecting IPC into external pages), and the
            // REAL DPI zoom for the panel's viewport testing.
            browser::browser_tab_scroll_state,
            browser::browser_tab_scroll_to,
            browser::browser_tab_set_zoom,
            browser::browser_tab_eval,
            // ROUND-90 (R90-C2): the menu overlay window — the sidebar's
            // popovers render in an OWNED transparent OS window so they
            // float ON TOP of the live browser webview (the "browser paused
            // while the menu is open" retirement).
            browser::menu_overlay_prewarm,
            browser::menu_overlay_show,
            browser::menu_overlay_hide,
            browser::menu_overlay_pending,
            // ROUND-64 (R64-b): the always-on-top floating computer-use
            // monitor — auto-opened by the main app the moment live
            // computer-use activity starts; the page (mini.html) closes
            // itself when the control session ends.
            mini::open_computer_mini,
            mini::close_computer_mini
        ])
        .build(tauri::generate_context!())
        .expect("error while running the tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
