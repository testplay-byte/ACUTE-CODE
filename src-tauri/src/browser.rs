//! ROUND-39 (owner: "I was hoping for it to utilize its own custom separate
//! browser. Maybe look into that so that it will have completely different
//! things in it, like different logins and all other stuff like that. I was
//! hoping for it to be like that so let's do it like that, utilizing the
//! Chrome browser or something like that, like a framework of it or
//! something like that."). A separate, persistent in-app browser window
//! built on Tauri's WebviewWindow API. The window's user-data directory is
//! scoped to a per-app "browser-profile" folder under the app's data dir —
//! cookies, login state, and localStorage survive across app launches, and
//! they are ISOLATED from the system browser (a different Chrome/Edge
//! profile entirely). The agent's iframe browser (right sidebar Browser
//! tab) can't replicate this — browsers isolate iframe storage + many sites
//! block framing. This command launches a SEPARATE persistent window for
//! any URL the user (or the agent) opens from the right sidebar's "Open in
//! app browser" button.
//!
//! What this is NOT: a full Chrome clone. It's the platform webview
//! (WebView2/WebKit) configured with its OWN profile dir, so logins
//! persist. The user can have a different Gmail/GitHub/etc. login in this
//! browser than in their system Chrome — exactly what the owner asked for.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindowBuilder, WebviewUrl};

/// The label for the persistent browser window (Tauri requires unique labels
/// per window; we re-use this label so re-opening focuses the existing window
/// instead of spawning a duplicate).
const BROWSER_WINDOW_LABEL: &str = "acute-browser";

/// Resolves the persistent browser-profile directory under the app's local
/// data dir. Created on first use. WebView2 (Windows) reads cookies + login
/// state from this dir; WebKit (macOS) uses it for website data. Cross-app
/// launches reuse the SAME dir, so logins survive.
fn browser_profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir failed: {e}"))?;
    let profile = base.join("browser-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|e| format!("create_dir_all({profile:?}) failed: {e}"))?;
    Ok(profile)
}

/// `open_browser_window(url)` — opens (or focuses) the persistent in-app
/// browser window at the given URL. The window's user-data dir is scoped to
/// app_local_data_dir/browser-profile — logins persist across app launches
/// AND are isolated from the system browser.
#[tauri::command]
pub fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    // If the browser window already exists, focus it + navigate to the URL.
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        // eval() navigates the existing webview to the new URL.
        let init = format!("window.location = {url:?};");
        let _ = existing.eval(&init);
        let _ = existing.set_focus();
        return Ok(());
    }

    let profile = browser_profile_dir(&app)?;

    let mut builder = WebviewWindowBuilder::new(
        &app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::External(url.parse().map_err(|e| format!("invalid url: {e}"))?),
    )
    .title("Acute Browser")
    .inner_size(1200.0, 800.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .fullscreen(false)
    .decorations(true);

    // WebView2 (Windows): the persistent user-data dir is where cookies +
    // login state live. WebKit (macOS): same dir for website data.
    builder = builder.user_data_dir(profile);

    builder
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;
    Ok(())
}
