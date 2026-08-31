//! Browser backends, by round:
//!
//! - ROUND-39/41: `open_browser_window` & friends — a separate, persistent
//!   in-app browser WINDOW built on Tauri's WebviewWindow API. The window's
//!   user-data directory is scoped to a per-app "browser-profile" folder under
//!   the app's local data dir — cookies, login state, and localStorage survive
//!   across app launches, and they are ISOLATED from the system browser (a
//!   different WebView2 profile entirely — NOT the system Edge's profile, NOT
//!   the system Chrome's profile). The owner (R41): "I want it to be a
//!   full-fledged native browser rather than utilizing some other
//!   pre-installed browser on the device."
//!
//! - ROUND-50 (R50-a): the NATIVE EMBEDDED BROWSER — `browser_tab_*`. The
//!   owner rejected the R43 fetch-proxy iframe ("browser proxy ticket
//!   missing, expired or invalid" on some sites, no CSS/JS on others) and
//!   asked for "a proper full-fledged browser of our own… going with
//!   Chromium as the base". On Windows, Tauri's WebView2 IS Chromium, so
//!   instead of shipping a Chromium fork we host one CHILD WEBVIEW per
//!   browser tab INSIDE the main app window (Tauri multiwebview), positioned
//!   exactly over the BrowserPanel's page area. No proxy, no tickets, full
//!   CSS/JS — real Chromium rendering. The R41 window commands below are
//!   SUPERSEDED for the in-app panel by `browser_tab_*` (kept registered and
//!   working: the BrowserPanel's "pop out" button still opens the R41
//!   window, and they are harmless if unused).
//!
//! - ROUND-58 (R58-b): Windows field-report fixes. `open_browser_window`
//!   went ASYNC — a sync command runs on the MAIN thread, and
//!   `WebviewWindowBuilder::build` blocks on a channel to that same main
//!   thread, the documented WebView2 deadlock (the pop-out window used to
//!   render completely WHITE/half-created on Windows; same rationale as
//!   `browser_tab_create` below). The nav overlay now rides the builder's
//!   `initialization_script` (WebView2's AddScriptToExecuteOnDocumentCreated
//!   — runs at document-start on EVERY new document, before page scripts)
//!   instead of the post-build/on_navigation `eval`s, which fired before the
//!   page load committed and never appeared. And `open_external_url` hands
//!   a URL to the OS default browser from Rust (window.open inside a
//!   WebView2 webview is silently swallowed by wry).
//!
//! How the child-webview dance works:
//!  1. The frontend creates a tab webview (`browser_tab_create`) with a
//!     starting URL. Rust creates it at 1×1 logical px at (0,0) and
//!     immediately HIDES it.
//!  2. The frontend measures its placeholder <div> (getBoundingClientRect —
//!     the main webview fills the whole window, so viewport-relative CSS px
//!     == window-relative logical px) and calls `browser_tab_set_bounds` to
//!     position the webview exactly over the panel's page area, then
//!     `browser_tab_set_visible(true)`.
//!  3. On every navigation the `on_navigation` hook emits a
//!     `browser-navigated` event `{tab_id, url}` so the panel can keep the
//!     address bar + the sidecar's server-side history truthful (the agent's
//!     `browser_control` tool reads that history).
//!  4. Hiding the panel (tab switch / sidebar collapse) calls
//!     `browser_tab_set_visible(false)` — the webview STAYS ALIVE so the
//!     browsing session persists, exactly like switching tabs in a real
//!     browser. Closing the browser tab in the tab strip calls
//!     `browser_tab_close`.
//!
//! What this is NOT: a full Chrome clone. It's the platform webview
//! (WebView2 on Windows, WebKit on macOS) configured with its OWN profile
//! dir. On Windows the WebView2 runtime IS Chromium-based (same rendering
//! engine as Edge) but it is NOT the system Edge — it's a separate WebView2
//! instance with its own profile, cookies, and login state.

use std::path::PathBuf;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder,
};

/// The label for the persistent browser window (Tauri requires unique labels
/// per window; we re-use this label so re-opening focuses the existing window
/// instead of spawning a duplicate).
const BROWSER_WINDOW_LABEL: &str = "acute-browser";

/// ROUND-50: child-webview labels are `acute-tab-<right-sidebar tab id>` —
/// unique per browser tab, and a prefix we can sweep in
/// `browser_tabs_close_all`. Must not collide with `BROWSER_WINDOW_LABEL`
/// ("acute-browser" does not start with "acute-tab-").
const TAB_LABEL_PREFIX: &str = "acute-tab-";

/// ROUND-50: the main app window (tauri.conf.json default label). All tab
/// webviews are children of this window so they float over the UI.
const MAIN_WINDOW_LABEL: &str = "main";

/// ROUND-50: the `browser-navigated` event payload (serde field names stay
/// snake_case — the frontend reads `event.payload.tab_id` /
/// `event.payload.url`).
#[derive(Clone, serde::Serialize)]
struct BrowserNavigated {
    tab_id: String,
    url: String,
}

/// `acute-tab-<tab_id>` — the webview label for a browser tab.
fn tab_label(tab_id: &str) -> String {
    format!("{TAB_LABEL_PREFIX}{tab_id}")
}

/// Parses and validates a URL for the native tabs: http/https only. The
/// child webviews render arbitrary remote pages; other schemes (file:, data:,
/// tauri:) would escape that contract and are rejected with a message the
/// panel can surface.
fn parse_http_url(url: &str) -> Result<Url, String> {
    let parsed: Url = url
        .parse()
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "only http/https URLs are supported by the embedded browser (got \"{url}\")"
        ));
    }
    Ok(parsed)
}

/// Looks up the child webview for a browser tab (None when the tab has no
/// native webview yet — e.g. a fresh tab that never navigated).
///
/// `Manager::get_webview` is gated behind the "unstable" feature (enabled in
/// Cargo.toml for exactly this multiwebview API surface).
fn find_tab_webview(app: &AppHandle, tab_id: &str) -> Option<Webview> {
    app.get_webview(&tab_label(tab_id))
}

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
/// with the page's own layout; the buttons walk the page's own session
/// history (window.history / location).
///
/// R58-b DELIVERY: registered via `WebviewWindowBuilder::initialization_script`
/// (WebView2's AddScriptToExecuteOnDocumentCreated) — it runs at
/// DOCUMENT-START on EVERY new document (initial load, link clicks,
/// redirects, form submits), before any page script. The old delivery — a
/// post-build `eval` plus a re-`eval` inside `on_navigation` — fired before
/// the page load committed, so the overlay never appeared on Windows.
/// Document-start means `<html>`/`<head>` may not exist yet, hence the
/// readyState/DOMContentLoaded guard: the body waits for the DOM while the
/// document is still loading and runs inline otherwise; the
/// `__acuteBrowserOverlay` flag keeps same-document re-runs idempotent.
///
/// Kept inline (no asset file) so the binary stays self-contained.
const NAV_OVERLAY_INIT: &str = r#"
(function () {
  // Don't double-inject — the script runs once per NEW document (a fresh
  // document means a fresh JS context, so the flag resets naturally), but
  // a same-document re-run must be a no-op.
  if (window.__acuteBrowserOverlay) return;
  window.__acuteBrowserOverlay = true;

  var install = function () {
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
    // Pad the page so the bar doesn't cover content. (head fallback: a
    // degenerate document can reach install() without <head> — a <style>
    // applies from anywhere in the DOM, never crash the overlay for it.)
    var style = document.createElement('style');
    style.textContent = 'html { padding-top: 38px !important; }';
    (document.head || document.documentElement).appendChild(style);

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
  };

  // R58-b document-start guard: initialization scripts run BEFORE the parser
  // has built <html>/<head> — everything install() touches may not exist yet.
  // While the document is still loading, wait for DOMContentLoaded (fires
  // once, after the DOM exists); otherwise install inline.
  if (document.readyState === 'loading' || document.documentElement === null) {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
"#;

/// `open_browser_window(url)` — opens (or focuses) the persistent in-app
/// browser window at the given URL. The window's user-data dir is scoped to
/// app_local_data_dir/browser-profile — logins persist across app launches
/// AND are isolated from the system browser.
///
/// ROUND-50 (R50-a): for the in-app browser PANEL this is superseded by the
/// `browser_tab_*` child-webview commands below (the owner wants the pages
/// INSIDE the main window, not in a separate OS window). Kept registered: the
/// BrowserPanel's "pop out" affordance still opens this window, and removing
/// a registered command would break any persisted frontend that still calls it.
///
/// R58-b WHY THIS COMMAND IS `async` (mirrors `browser_tab_create` below):
/// `WebviewWindowBuilder::build` creates the window AND its webview, which
/// blocks on a channel to the MAIN thread (`WindowBuilder::with_webview` —
/// the same mechanism as `Window::add_child`). Tauri runs SYNC commands on
/// the main thread, so a sync build() ends up waiting for a thread that is
/// waiting for us — the documented WebView2 deadlock (tauri's WebviewBuilder
/// docs: "On Windows, this function deadlocks when used in a synchronous
/// command… You should use async commands and separate threads"). On the
/// owner's Windows machine the sync build deadlocked mid-creation and the
/// pop-out window rendered completely WHITE/blank. Async commands run on
/// the tokio runtime via `async_runtime::spawn`, off the main thread — the
/// documented workaround. (The eval/set_focus calls below only use
/// fire-and-forget dispatchers, safe from any thread.)
#[tauri::command]
pub async fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    // If the browser window already exists, focus it + navigate to the URL.
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        // eval() navigates the existing webview to the new URL.
        let init = format!(
            "window.location = {};",
            serde_json::to_string(&url).map_err(|e| format!("url encode failed: {e}"))?
        );
        let _ = existing.eval(&init);
        let _ = existing.set_focus();
        // No overlay re-inject: the initialization_script registered when the
        // window was built runs on EVERY new document this webview ever loads
        // (AddScriptToExecuteOnDocumentCreated), this navigation included.
        return Ok(());
    }

    let profile = browser_profile_dir(&app)?;
    let parsed_url: Url = url
        .parse()
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;

    WebviewWindowBuilder::new(&app, BROWSER_WINDOW_LABEL, WebviewUrl::External(parsed_url))
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
        .data_directory(profile)
        // R58-b: the nav overlay rides the INITIALIZATION script — WebView2's
        // AddScriptToExecuteOnDocumentCreated runs NAV_OVERLAY_INIT at
        // document-start on every new document (initial load, link clicks,
        // redirects), before any page script. This replaces the old post-build
        // `eval` AND the on_navigation re-`eval` (both fired before the page
        // load committed, so on Windows the overlay never appeared). With the
        // evals gone the on_navigation hook itself went too — its only job was
        // the re-inject, and the `browser-navigated` event the panel consumes
        // is emitted by `browser_tab_create`'s hook below, untouched.
        .initialization_script(NAV_OVERLAY_INIT)
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;

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
    let init = format!(
        "window.location = {};",
        serde_json::to_string(&url).map_err(|e| format!("url encode failed: {e}"))?
    );
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
        existing.close().map_err(|e| format!("close failed: {e}"))?;
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

/// `open_external_url(url)` — open `url` in the OPERATING SYSTEM's default
/// browser via tauri-plugin-shell's OS-level open (NOT the embedded
/// WebView2: `window.open` from inside a webview is silently swallowed by
/// WebView2/wry, so the handoff to the system browser must happen on the
/// Rust side).
///
/// R58-b: the BrowserPanel's explicit "Open externally" affordance invokes
/// this inside the Tauri shell. The URL is validated http/https FIRST
/// (the `parse_http_url` contract — a webview-supplied string must never
/// reach the OS handler with a file:/data:/tauri: scheme). This is the
/// RUST-side `ShellExt::open` call, which does NOT go through the JS ACL
/// permission wall (the shell plugin's own JS `open` command validates
/// against the configured open scope; the Rust entry point takes the path
/// unvalidated — our own scheme check is the guard), so no capability
/// changes are needed.
///
/// (`Shell::open` is deprecated upstream in favor of tauri-plugin-opener;
/// the opener plugin is not in our dependency tree while the shell plugin
/// is already registered — the `allow(deprecated)` mirrors what the plugin
/// does on its own `open` command.)
#[tauri::command]
#[allow(deprecated)]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    // Validate BEFORE the OS ever sees it — only http/https leaves the app.
    let parsed: Url = parse_http_url(&url)?;
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(parsed.as_str(), None)
        .map_err(|e| e.to_string())
}

// ── ROUND-50 (R50-a): the native embedded browser (child webviews) ─────────
//
// One child webview per right-sidebar browser tab, hosted by the MAIN window
// and positioned over the BrowserPanel's page area by the frontend. See the
// module header for the full design rationale.

/// `browser_tab_create(tab_id, url)` — create (idempotently) the child webview
/// for a browser tab. If the webview already exists it is simply NAVIGATED to
/// the URL (this makes the command safe to call on every panel activation and
/// from every address-bar navigation). Otherwise a new child webview is added
/// to the main window at 1×1 logical px, HIDDEN — the frontend then measures
/// its placeholder, calls `browser_tab_set_bounds` and
/// `browser_tab_set_visible(true)`. Creating it hidden prevents a flash of the
/// page at the window's top-left corner before the first bounds sync.
///
/// WHY THIS COMMAND IS `async`: `Window::add_child` blocks on a channel while
/// the MAIN thread builds the webview (window/mod.rs:1129 in tauri 2.11.5).
/// Tauri runs SYNC commands on the main thread, so a sync `add_child` would
/// wait for a thread that is waiting for us — the documented WebView2
/// deadlock (tauri's WebviewBuilder docs: "On Windows, this function
/// deadlocks when used in a synchronous command… You should use async
/// commands"). Async commands run on the tokio runtime via
/// `async_runtime::spawn`, off the main thread, which is exactly the
/// documented workaround. The other tab commands below only use
/// fire-and-forget dispatchers (set_position/set_size/hide/show/navigate/
/// eval) or inline-safe getters, so they stay sync. (R58-b later moved
/// `open_browser_window` to async for exactly the same build-blocking
/// reason — see its doc comment above.)
#[tauri::command]
pub async fn browser_tab_create(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let label = tab_label(&tab_id);

    // Idempotent create: an existing webview just navigates.
    if let Some(existing) = app.get_webview(&label) {
        let parsed = parse_http_url(&url)?;
        existing
            .navigate(parsed)
            .map_err(|e| format!("navigate tab \"{tab_id}\" failed: {e}"))?;
        return Ok(());
    }

    let parsed = parse_http_url(&url)?;
    // `get_window` (not `get_webview_window`) — `add_child` lives on `Window`,
    // and a `WebviewWindow` handle does not expose it.
    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window \"{MAIN_WINDOW_LABEL}\" not found"))?;

    // ALL tabs share the one browser-profile dir (same as the R41 window) —
    // logins/cookies/localStorage are shared across tabs like a real browser
    // and persist across app launches. WebView2 supports multiple controls
    // sharing one user-data folder when they run in the same process (they
    // share the browser process), which is our case: every webview is a child
    // of the same window in the same app process. FALLBACK if WebView2 ever
    // complains about concurrent access: give each tab its own subdir
    // (`browser-profile/<tab_id>`) — sessions stay per-tab instead of shared,
    // and the profile-dir root still isolates us from the system browser.
    let profile = browser_profile_dir(&app)?;

    // Emit `browser-navigated {tab_id, url}` for EVERY http/https navigation
    // (initial load, link clicks, redirects, form submits) so the panel can
    // keep the address bar and the sidecar's server-side history in sync.
    // We never block a navigation — this is a browser, not a filter.
    let app_for_hook = app.clone();
    let hook_tab_id = tab_id.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_directory(profile)
        .on_navigation(move |nav: &Url| {
            if nav.scheme() == "http" || nav.scheme() == "https" {
                let _ = app_for_hook.emit(
                    "browser-navigated",
                    BrowserNavigated {
                        tab_id: hook_tab_id.clone(),
                        url: nav.to_string(),
                    },
                );
            }
            true
        });

    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| format!("create tab webview \"{tab_id}\" failed: {e}"))?;

    // Hidden until the frontend positions it over the panel's page area.
    webview
        .hide()
        .map_err(|e| format!("hide tab webview \"{tab_id}\" failed: {e}"))?;
    Ok(())
}

/// `browser_tab_navigate(tab_id, url)` — navigate the tab's existing webview.
/// Unlike `browser_tab_create` this is NOT idempotent-create: it errors when
/// the tab has no webview yet (the frontend uses create for that).
#[tauri::command]
pub fn browser_tab_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\" — create it first"))?;
    let parsed = parse_http_url(&url)?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("navigate tab \"{tab_id}\" failed: {e}"))
}

/// `browser_tab_set_bounds(tab_id, x, y, w, h)` — position the tab's webview
/// over the panel's page area. Coordinates are LOGICAL px, which equal CSS px
/// of the main webview (getBoundingClientRect), because the main webview fills
/// the whole window at scale factor 1. Width/height are clamped to ≥ 1 so a
/// zero-sized measurement can never create a degenerate webview.
#[tauri::command]
pub fn browser_tab_set_bounds(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position tab \"{tab_id}\" failed: {e}"))?;
    webview
        .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| format!("set_size tab \"{tab_id}\" failed: {e}"))?;
    Ok(())
}

/// `browser_tab_set_visible(tab_id, visible)` — show/hide the tab's webview.
/// Hiding is how a tab "goes to the background" (panel switched away /
/// sidebar collapsed): the webview and its session STAY ALIVE. Not-found is
/// Ok (idempotent) — hiding a tab that never created its webview is a no-op,
/// and the unmount cleanup must never crash on a fresh tab.
#[tauri::command]
pub fn browser_tab_set_visible(
    app: AppHandle,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    let Some(webview) = find_tab_webview(&app, &tab_id) else {
        return Ok(());
    };
    let res = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    res.map_err(|e| format!("set_visible({visible}) tab \"{tab_id}\" failed: {e}"))
}

/// `browser_tab_go(tab_id, direction)` — back / forward / reload through the
/// webview's OWN history (eval'd JS, so the traversal uses the page's session
/// history rather than pushing a fresh entry the way `navigate` would).
#[tauri::command]
pub fn browser_tab_go(app: AppHandle, tab_id: String, direction: String) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    let script = match direction.as_str() {
        "back" => "history.back();",
        "forward" => "history.forward();",
        "reload" => "location.reload();",
        other => {
            return Err(format!(
                "unknown direction \"{other}\" (expected back | forward | reload)"
            ))
        }
    };
    webview
        .eval(script)
        .map_err(|e| format!("go({direction}) tab \"{tab_id}\" failed: {e}"))
}

/// `browser_tab_url(tab_id)` — the webview's CURRENT url (what the user
/// actually sees, including any in-page navigation we were not told about).
#[tauri::command]
pub fn browser_tab_url(app: AppHandle, tab_id: String) -> Result<String, String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    let url = webview
        .url()
        .map_err(|e| format!("url() tab \"{tab_id}\" failed: {e}"))?;
    Ok(url.to_string())
}

/// `browser_tab_close(tab_id)` — destroy the tab's webview. The shared profile
/// (cookies, logins) survives on disk; only the live tab session is dropped.
/// Not-found is Ok — closing twice must be a no-op, and the tab-close reaper
/// on the frontend races panel unmounts.
#[tauri::command]
pub fn browser_tab_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(webview) = find_tab_webview(&app, &tab_id) {
        webview
            .close()
            .map_err(|e| format!("close tab \"{tab_id}\" failed: {e}"))?;
    }
    Ok(())
}

/// `browser_tabs_close_all()` — destroy EVERY tab webview (anything labeled
/// `acute-tab-*`). Escape hatch for app shutdown / "close all browser tabs"
/// affordances; it never touches the R41 `acute-browser` window or the main
/// webview. Closes as many as it can and reports the first failure.
#[tauri::command]
pub fn browser_tabs_close_all(app: AppHandle) -> Result<(), String> {
    let mut first_error: Option<String> = None;
    for (label, webview) in app.webviews() {
        if label.starts_with(TAB_LABEL_PREFIX) {
            if let Err(e) = webview.close() {
                first_error.get_or_insert_with(|| format!("close tab \"{label}\" failed: {e}"));
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
