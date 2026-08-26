//! ROUND-39/41: a separate, persistent in-app browser window built on
//! Tauri's WebviewWindow API. The window's user-data directory is scoped
//! to a per-app "browser-profile" folder under the app's local data dir —
//! cookies, login state, and localStorage survive across app launches, and
//! they are ISOLATED from the system browser (a different WebView2 profile
//! entirely — NOT the system Edge's profile, NOT the system Chrome's
//! profile). The owner (R41): "I want it to be a full-fledged native
//! browser rather than utilizing some other pre-installed browser on the
//! device."
//!
//! ROUND-41 improvements:
//!  - `open_browser_window(url)` now ALSO injects a small navigation
//!    overlay (back / forward / reload / address bar) into the browser
//!    window so it FEELS like a real browser, not just a bare webview.
//!  - `navigate_browser(url)` lets the BrowserPanel's address bar drive
//!    the open window's URL without re-creating it.
//!  - `close_browser_window()` closes the persistent window (the profile
//!    survives on disk; re-opening picks up where the user left off).
//!  - Better error strings so the BrowserPanel can surface exactly what
//!    failed (profile-dir creation, URL parse, webview build).
//!
//! What this is NOT: a full Chrome clone. It's the platform webview
//! (WebView2 on Windows, WebKit on macOS) configured with its OWN profile
//! dir. The user can have a different Gmail/GitHub/etc. login in this
//! browser than in their system Chrome/Edge — exactly what the owner asked
//! for. On Windows the WebView2 runtime IS Chromium-based (same rendering
//! engine as Edge) but it is NOT the system Edge — it's a separate
//! WebView2 instance with its own profile, cookies, and login state.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindowBuilder, WebviewUrl, Url};

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

/// The nav-overlay init script — injects a small fixed-position bar at the
/// top of the browser window with Back / Forward / Reload / address input.
/// The bar is a separate DOM layer (`z-index: 9999`) so it doesn't interfere
/// with the page's own layout. Clicking the buttons calls Tauri's webview
/// navigation APIs via the global `__acuteBrowser` handle.
///
/// Kept inline (no asset file) so the binary stays self-contained.
const NAV_OVERLAY_INIT: &str = r#"
(function () {
  // Don't double-inject (Tauri eval is idempotent but the script may run
  // again on a same-page navigation).
  if (window.__acuteBrowserOverlay) return;
  window.__acuteBrowserOverlay = true;

  var bar = document.createElement('div');
  bar.id = 'acute-browser-nav';
  bar.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'right: 0',
    'height: 38px',
    'display: flex',
    'align-items: center',
    'gap: 6px',
    'padding: 0 8px',
    'background: #1a1816',
    'color: #f5f3ef',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size: 12px',
    'z-index: 2147483647',
    'box-shadow: 0 1px 3px rgba(0,0,0,0.4)',
  ].join(';');
  bar.innerHTML =
    '<button id="acute-back" title="Back" style="background:none;border:none;color:#f5f3ef;padding:4px 8px;cursor:pointer;border-radius:6px;font-size:14px">←</button>' +
    '<button id="acute-fwd" title="Forward" style="background:none;border:none;color:#f5f3ef;padding:4px 8px;cursor:pointer;border-radius:6px;font-size:14px">→</button>' +
    '<button id="acute-reload" title="Reload" style="background:none;border:none;color:#f5f3ef;padding:4px 8px;cursor:pointer;border-radius:6px;font-size:14px">⟳</button>' +
    '<input id="acute-addr" type="text" placeholder="Search or enter address" style="flex:1;min-width:0;background:#2a2622;border:1px solid #3a342e;color:#f5f3ef;padding:4px 10px;border-radius:8px;font-size:12px;outline:none" />' +
    '<button id="acute-go" title="Go" style="background:#FF6B2C;border:none;color:#1a1816;padding:4px 12px;cursor:pointer;border-radius:8px;font-size:12px;font-weight:600">Go</button>';
  document.documentElement.appendChild(bar);
  // Pad the page so the bar doesn't cover content.
  var style = document.createElement('style');
  style.textContent = 'html { padding-top: 38px !important; }';
  document.head.appendChild(style);

  // Wire nav buttons to the webview's history (window.history) + reload.
  document.getElementById('acute-back').onclick = function () { window.history.back(); };
  document.getElementById('acute-fwd').onclick = function () { window.history.forward(); };
  document.getElementById('acute-reload').onclick = function () { window.location.reload(); };

  // The address input: on Enter or "Go" click, navigate.
  var addr = document.getElementById('acute-addr');
  var go = function () {
    var v = (addr.value || '').trim();
    if (!v) return;
    // URL-or-search heuristic (same as the BrowserPanel frontend).
    var url;
    if (/^https?:\/\//i.test(v)) url = v;
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) url = v;
    else if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v)) url = 'https://' + v;
    else url = 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
    window.location.href = url;
  };
  document.getElementById('acute-go').onclick = go;
  addr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

  // Sync the address input with the current URL on load + on navigation.
  var sync = function () { addr.value = window.location.href; };
  sync();
  window.addEventListener('popstate', sync);
  // Also poll every 500ms — SPA navigations don't always fire popstate.
  setInterval(sync, 500);
})();
"#;

/// `open_browser_window(url)` — opens (or focuses) the persistent in-app
/// browser window at the given URL. The window's user-data dir is scoped to
/// app_local_data_dir/browser-profile — logins persist across app launches
/// AND are isolated from the system browser.
#[tauri::command]
pub fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    // If the browser window already exists, focus it + navigate to the URL.
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        // eval() navigates the existing webview to the new URL.
        let init = format!("window.location = {};", serde_json::to_string(&url).map_err(|e| format!("url encode failed: {e}"))?);
        let _ = existing.eval(&init);
        let _ = existing.set_focus();
        // Re-inject the nav overlay (it may have been lost on a fresh load).
        let _ = existing.eval(NAV_OVERLAY_INIT);
        return Ok(());
    }

    let profile = browser_profile_dir(&app)?;
    let parsed_url: Url = url
        .parse()
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;

    let builder = WebviewWindowBuilder::new(
        &app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("Acute Browser")
    .inner_size(1200.0, 800.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .fullscreen(false)
    .decorations(true)
    // WebView2 (Windows): the persistent user-data dir is where cookies +
    // login state live. WebKit (macOS): same dir for website data.
    // (Tauri 2 renamed the builder method from user_data_dir to
    // data_directory — this is the 2.x name, verified against tauri 2.11.5.)
    .data_directory(profile);

    // Inject the nav overlay on every navigation (initial load + every
    // subsequent same-page navigation). In Tauri 2 the on_navigation hook
    // lives on the BUILDER (WebviewWindowBuilder::on_navigation, taking
    // &Url and returning bool — false cancels the navigation), NOT on the
    // built WebviewWindow. Verified against tauri 2.11.5 docs.
    let app_for_hook = app.clone();
    let builder = builder.on_navigation(move |_url: &Url| {
        let _ = app_for_hook
            .get_webview_window(BROWSER_WINDOW_LABEL)
            .and_then(|w| w.eval(NAV_OVERLAY_INIT).ok());
        true
    });

    let window = builder
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;

    // Also inject immediately (the first navigation may already be complete).
    let _ = window.eval(NAV_OVERLAY_INIT);

    Ok(())
}

/// `navigate_browser(url)` — navigate the EXISTING browser window to a new
/// URL (without re-creating it). No-op + Err if the window isn't open yet.
/// Used by the BrowserPanel's address bar to drive the open browser window.
#[tauri::command]
pub fn navigate_browser(app: AppHandle, url: String) -> Result<(), String> {
    let existing = app
        .get_webview_window(BROWSER_WINDOW_LABEL)
        .ok_or_else(|| "browser window not open — call open_browser_window first".to_string())?;
    let init = format!("window.location = {};", serde_json::to_string(&url).map_err(|e| format!("url encode failed: {e}"))?);
    existing
        .eval(&init)
        .map_err(|e| format!("navigate eval failed: {e}"))?;
    Ok(())
}

/// `close_browser_window()` — close the persistent browser window. The
/// profile survives on disk; re-opening picks up where the user left off.
#[tauri::command]
pub fn close_browser_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        existing
            .close()
            .map_err(|e| format!("close failed: {e}"))?;
    }
    Ok(())
}

/// `is_browser_window_open()` — returns whether the persistent browser
/// window is currently mounted (the BrowserPanel uses this to show an
/// "Open in browser" vs "Focus browser" button state).
#[tauri::command]
pub fn is_browser_window_open(app: AppHandle) -> bool {
    app.get_webview_window(BROWSER_WINDOW_LABEL).is_some()
}
