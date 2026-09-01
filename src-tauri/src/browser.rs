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
//!   `browser_tab_create` below). The nav overlay rode the builder's
//!   `initialization_script` (WebView2's AddScriptToExecuteOnDocumentCreated
//!   — runs at document-start on EVERY new document, before page scripts)
//!   instead of the post-build/on_navigation `eval`s, which fired before the
//!   page load committed and never appeared. And `open_external_url` hands
//!   a URL to the OS default browser from Rust (window.open inside a
//!   WebView2 webview is silently swallowed by wry).
//!
//! - ROUND-59 (R59-b): the pop-out window got OUR chrome. The owner's
//!   verdict on R58: the pop-out works and shares the profile, BUT "the
//!   native title bar is still there… It should be a custom one but
//!   apparently it was not". The window is now built DECORATIONLESS hosting
//!   `popout.html` — a SECOND vite entry (vite.config.ts) that is a small
//!   standalone React page painting the drag-region title bar + themed URL
//!   bar itself; the page CONTENT is a child webview the page creates via
//!   `browser_tab_create` with its OWN window label (the same
//!   child-webview architecture as the in-app panel, same shared
//!   browser-profile dir). The R58 NAV_OVERLAY_INIT injection is GONE — the
//!   overlay only existed because an EXTERNAL page cannot render our React
//!   chrome; the app page owns the chrome natively, so there is nothing to
//!   inject. The initial URL travels through the `POPOUT_PENDING_URL` stash
//!   + `popout_initial_url` command (see the static's doc comment for the
//!   why-not-query-param reasoning).
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
use std::sync::Mutex;
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

/// ROUND-59 (R59-b): the fixed browser-tab id whose webview hosts the pop-out
/// window's page content. Fixed (not generated) because there is exactly ONE
/// pop-out; its webview label is `acute-tab-popout` (TAB_LABEL_PREFIX
/// formation, globally unique, found by the label-lookup commands and swept
/// by `browser_tabs_close_all` — it also dies with its window regardless).
const POPOUT_TAB_ID: &str = "popout";

/// ROUND-59 (R59-b): honest pop-out sizing. The defaults are the R41 values;
/// the minimum matches `min_inner_size` below (what the window enforces).
const POPOUT_DEFAULT_W: f64 = 1200.0;
const POPOUT_DEFAULT_H: f64 = 800.0;
const POPOUT_MIN_W: f64 = 640.0;
const POPOUT_MIN_H: f64 = 480.0;
/// The share of the primary monitor's WORK AREA the pop-out asks for — never
/// more (the R59 owner directive: handle window sizing honestly on small
/// screens instead of opening a window larger than the desktop).
const POPOUT_WORK_AREA_FRACTION: f64 = 0.70;

/// ROUND-59 (R59-b): the URL the pop-out window should open at. Written by
/// `open_browser_window` on EVERY call (the create path AND the focus path —
/// the focus path can race the page still mounting) and read by the
/// popout.html page on mount via the `popout_initial_url` command.
///
/// A command instead of a query param on the App URL: tauri joins
/// `WebviewUrl::App(path)` onto the app origin (`url.join(path)` in
/// manager/webview.rs), and how a smuggled `?url=…` survives that join + the
/// production asset resolver is not a contract we want to lean on; the stash
/// is deterministic in dev AND prod. Kept (not taken) rather than cleared on
/// read, so a page reload restores the last requested URL instead of an
/// empty window.
static POPOUT_PENDING_URL: Mutex<Option<String>> = Mutex::new(None);

/// Publishes the pending pop-out URL (see the static's doc comment).
fn set_popout_pending_url(url: String) -> Result<(), String> {
    let mut guard = POPOUT_PENDING_URL
        .lock()
        .map_err(|e| format!("popout pending-url lock poisoned: {e}"))?;
    *guard = Some(url);
    Ok(())
}

/// Reads the pending pop-out URL (None until `open_browser_window` ran).
fn popout_pending_url() -> Result<Option<String>, String> {
    let guard = POPOUT_PENDING_URL
        .lock()
        .map_err(|e| format!("popout pending-url lock poisoned: {e}"))?;
    Ok(guard.clone())
}

/// ROUND-59 (R59-b): clamp the pop-out's INITIAL size against the primary
/// monitor's work area. Pure math over LOGICAL px (the caller converts the
/// monitor's physical work area) so it is unit-testable without a monitor.
///
/// Per dimension: `min(default, POPOUT_WORK_AREA_FRACTION × work)`, then
/// floored at the window's minimum inner size — on an absurdly small screen
/// the minimum WINS (a usable browser beats a sliver, and `min_inner_size`
/// enforces the same floor, so the number here is what actually opens).
/// Degenerate work-area data (NaN / ≤ 0 — a lying monitor) falls back to the
/// defaults rather than a zero-sized window.
fn clamp_popout_size(default_w: f64, default_h: f64, work_w: f64, work_h: f64) -> (f64, f64) {
    let usable = work_w.is_finite() && work_w > 0.0 && work_h.is_finite() && work_h > 0.0;
    if !usable {
        return (default_w, default_h);
    }
    let w = (default_w.min(POPOUT_WORK_AREA_FRACTION * work_w)).max(POPOUT_MIN_W);
    let h = (default_h.min(POPOUT_WORK_AREA_FRACTION * work_h)).max(POPOUT_MIN_H);
    (w, h)
}

/// ROUND-59 (R59-b): the monitor-aware wrapper around `clamp_popout_size` —
/// converts the primary monitor's PHYSICAL work area to logical px and falls
/// back to the defaults when no monitor can be identified (`primary_monitor`
/// returning Ok(None), or an error — both mean "guess honestly").
fn popout_initial_size(app: &AppHandle) -> (f64, f64) {
    let monitor = match app.primary_monitor() {
        Ok(Some(m)) => m,
        _ => return (POPOUT_DEFAULT_W, POPOUT_DEFAULT_H),
    };
    let scale = monitor.scale_factor();
    if !(scale.is_finite() && scale > 0.0) {
        return (POPOUT_DEFAULT_W, POPOUT_DEFAULT_H);
    }
    let work = monitor.work_area();
    clamp_popout_size(
        POPOUT_DEFAULT_W,
        POPOUT_DEFAULT_H,
        work.size.width as f64 / scale,
        work.size.height as f64 / scale,
    )
}

/// ROUND-59 (R59-b): the `popout-navigate` event payload — emitted when the
/// pop-out window exists but its content webview does not yet (the page is
/// still mounting), so the page — which owns the webview — can finish the
/// navigation itself. Serde field names stay snake_case (the page reads
/// `event.payload.url`, same convention as `BrowserNavigated`).
#[derive(Clone, serde::Serialize)]
struct PopoutNavigate {
    url: String,
}

/// `open_browser_window(url)` — opens (or focuses) the pop-out browser window
/// at the given URL. The pop-out shares the ONE browser profile
/// (app_local_data_dir/browser-profile — attached to its content webview by
/// `browser_tab_create`), so logins persist across app launches, are shared
/// with the in-app panel, and stay isolated from the system browser.
///
/// ROUND-59 (R59-b): the window is now an APP-HOSTED page with custom chrome.
/// The owner rejected the native Windows title bar on the pop-out ("It
/// should be a custom one but apparently it was not"), so the window is built
/// with `decorations(false)` hosting `popout.html` — a second vite entry that
/// paints the drag-region title bar + themed URL bar itself (the R58
/// NAV_OVERLAY_INIT injection is gone: the overlay only existed because an
/// external page cannot render our React chrome; the app page can). The page
/// CONTENT is a child webview the page creates via `browser_tab_create` with
/// its OWN window label — the same architecture as the in-app panel.
///
/// The initial URL travels via the `POPOUT_PENDING_URL` stash + the
/// `popout_initial_url` command (the static's doc comment explains why not a
/// query param). When the window already exists it is focused and its
/// CONTENT webview navigated (the pre-R59 behavior — focus + navigate —
/// preserved); if the page has not created its webview yet, the
/// `popout-navigate` event lets the page finish the navigation. The URL is
/// validated http/https up front — that is the contract of the child webview
/// that will render it (tightened from R58's any-scheme parse; every caller
/// passes the panel's http/https currentUrl).
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
/// documented workaround. (`primary_monitor` below also round-trips the
/// event loop, but from this async thread the loop is free to answer — the
/// deadlock only exists when the MAIN thread is the one waiting on us.)
#[tauri::command]
pub async fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    // Validate http/https FIRST — the child webview that will render this URL
    // only supports those schemes (the `parse_http_url` contract), and a bad
    // URL must stash nothing and open nothing.
    parse_http_url(&url)?;

    // Publish BEFORE anything else: the popout.html page reads this stash on
    // mount, whichever path below runs.
    set_popout_pending_url(url.clone())?;

    // Existing window: focus it + navigate its CONTENT webview. (Pre-R59 this
    // eval'd `window.location = url` into the WINDOW webview — back then that
    // webview WAS the browser page. Now it hosts the app chrome, and
    // navigating it would blow the chrome away, so `acute-tab-popout` is the
    // navigation target.)
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        let _ = existing.set_focus();
        if let Some(content) = app.get_webview(&tab_label(POPOUT_TAB_ID)) {
            let parsed = parse_http_url(&url)?;
            content
                .navigate(parsed)
                .map_err(|e| format!("navigate pop-out content failed: {e}"))?;
        } else {
            // The page is still mounting (its browser_tab_create hasn't run
            // yet) — broadcast; the page's popout-navigate listener finishes
            // the navigation. Not an error: the window IS open.
            let _ = app.emit("popout-navigate", PopoutNavigate { url });
        }
        return Ok(());
    }

    // R59-b: honest sizing — 70% of the primary monitor's WORK AREA, never
    // above the 1200×800 default, floored at the 640×480 minimum, defaults
    // when no monitor can be identified (see clamp_popout_size).
    let (width, height) = popout_initial_size(&app);

    WebviewWindowBuilder::new(&app, BROWSER_WINDOW_LABEL, WebviewUrl::App("popout.html".into()))
        .title("Acute Browser")
        .inner_size(width, height)
        .min_inner_size(POPOUT_MIN_W, POPOUT_MIN_H)
        .center()
        .resizable(true)
        .fullscreen(false)
        // R59-b: NO native decorations — popout.html paints the title bar
        // (drag region + min/max/restore/close), the R59-A design language.
        // The window-control permissions are already in
        // capabilities/default.json for BOTH "main" and "acute-browser".
        .decorations(false)
        // No data_directory HERE: this webview hosts the APP page and uses
        // the same default WebView2 user-data dir as the main window's app
        // webview. The browser profile is attached to the CONTENT child
        // webview by browser_tab_create — ONE shared profile across panel +
        // pop-out (the owner's explicit demand, R58).
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;

    Ok(())
}

/// `popout_initial_url()` — the URL the pop-out window should open its
/// content webview at (`open_browser_window`'s stash; see
/// `POPOUT_PENDING_URL`). Null when this page wasn't opened through that
/// command (e.g. a plain web-dev visit of popout.html) — the popout page
/// then shows its idle state and the first address-bar Go creates the
/// webview.
///
/// ROUND-59 (R59-b).
#[tauri::command]
pub fn popout_initial_url() -> Result<Option<String>, String> {
    popout_pending_url()
}

/// `navigate_browser(url)` — navigate the EXISTING pop-out window's CONTENT
/// webview to a new URL (without re-creating the window). Err when the
/// window isn't open.
///
/// R59-b: pre-R59 this eval'd `window.location = url` into the window's
/// webview (which WAS the browser page); the window webview is now the app
/// chrome, so the CHILD webview (`acute-tab-popout`) is the navigation
/// target. When the child doesn't exist yet (page still mounting — or the
/// panel racing a just-opened window), the pending-url stash +
/// `popout-navigate` event let the page finish the navigation.
///
/// Call sites: registered since R41; the BrowserPanel's address bar drives
/// the pop-out through `open_browser_window` (which focuses too), so no
/// live frontend call site remains — kept registered and honest for any
/// future or external caller.
#[tauri::command]
pub fn navigate_browser(app: AppHandle, url: String) -> Result<(), String> {
    parse_http_url(&url)?;
    if let Some(content) = app.get_webview(&tab_label(POPOUT_TAB_ID)) {
        let parsed = parse_http_url(&url)?;
        return content
            .navigate(parsed)
            .map_err(|e| format!("navigate browser window failed: {e}"));
    }
    // No content webview: either the pop-out window isn't open at all (the
    // honest R41 error below) or its page is still mounting — focus the
    // window and hand the navigation to the page.
    if let Some(existing) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        set_popout_pending_url(url.clone())?;
        let _ = existing.set_focus();
        let _ = app.emit("popout-navigate", PopoutNavigate { url });
        return Ok(());
    }
    Err("browser window not open — call open_browser_window first".to_string())
}

/// `close_browser_window()` — close the pop-out browser window. The profile
/// survives on disk; re-opening picks up where the user left off. The
/// window's content webview (`acute-tab-popout`) is destroyed WITH its
/// window — a webview cannot outlive its window — so there is nothing extra
/// to clean up here.
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
// and positioned over the BrowserPanel's page area by the frontend
// (ROUND-59/R59-b: plus the pop-out window's own content webview, hosted by
// the pop-out window — see browser_tab_create's window_label). See the
// module header for the full design rationale.

/// R60 (owner: "The scroll bar should be custom themed on every single
/// page"): the themed-scrollbar CSS every tab webview injects at
/// DOCUMENT-START (AddScriptToExecuteOnDocumentCreated — runs on every new
/// document before page scripts, so there is no visible reflow). Neutral gray
/// pills — external pages do not carry our CSS variables, and a mid-gray
/// translucent capsule reads on both light and dark pages. Track and corner
/// fully transparent; the thumb is inset by 3px of transparent border
/// (background-clip: padding-box) so it reads as a floating capsule that
/// never touches content edges — the app's R59 floating-pill language
/// restated for pages we do not own.
///
/// CSP honesty: a page with a strict `style-src` (GitHub and friends) blocks
/// inline `<style>` elements — there the injection is a silent no-op (the
/// element exists in the DOM but `element.sheet` stays null, which is exactly
/// how the R60 pop-out scrollbar detects the failure and keeps the page's own
/// viewport scrollbar visible instead of doubling it). Best effort on every
/// page, hard failure never.
const TAB_SCROLLBAR_CSS: &str = "\
*::-webkit-scrollbar{width:10px;height:10px}\
*::-webkit-scrollbar-track{background:transparent}\
*::-webkit-scrollbar-corner{background:transparent}\
*::-webkit-scrollbar-thumb{background:rgba(128,128,140,0.35);border:3px solid transparent;border-radius:9999px;background-clip:padding-box}\
*::-webkit-scrollbar-thumb:hover{background:rgba(128,128,140,0.55);background-clip:padding-box}";

/// R60 (owner: the pop-out scrollbar "should not show inside the section but
/// on the right side outside it"): when a tab webview is created with
/// `hide_viewport_scrollbar`, the page's VIEWPORT scrollbar is hidden — the
/// pop-out window paints its OWN gutter scrollbar OUTSIDE the content card
/// (positioned in the window chrome, driven by `browser_tab_scroll_state` /
/// `browser_tab_scroll_to` below). `scrollbar-width: none` on the root hides
/// the viewport bar in modern Chromium (121+); the `::-webkit-scrollbar`
/// rules cover older engines and WebKit. Only the VIEWPORT is hidden — inner
/// scrollables keep (themed) bars, and if CSP blocks the style the page
/// simply keeps its native viewport bar (the gutter scrollbar then stays
/// absent — never two bars).
const TAB_VIEWPORT_HIDE_CSS: &str = "\
html{scrollbar-width:none!important}\
html::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}";

/// The document-start script that installs the themed scrollbar CSS. The
/// element is id-stamped so the scroll-state probe can check BOTH presence
/// and application (`sheet !== null` — a CSP-blocked style element has a
/// null sheet). Wrapped in try/catch: an init script that throws would abort
/// the rest of the page's init scripts.
fn tab_scrollbar_init_script(hide_viewport_scrollbar: bool) -> String {
    let css = if hide_viewport_scrollbar {
        format!("{TAB_SCROLLBAR_CSS}{TAB_VIEWPORT_HIDE_CSS}")
    } else {
        TAB_SCROLLBAR_CSS.to_string()
    };
    format!(
        "(function(){{try{{var s=document.createElement('style');\
s.id='acute-scrollbar-style';\
s.textContent='{css}';\
(document.head||document.documentElement).appendChild(s);}}catch(e){{}}}})();"
    )
}

/// `browser_tab_create(tab_id, url, [window_label], [hide_viewport_scrollbar])`
/// — create (idempotently) the child webview for a browser tab. If the webview
/// already exists it is simply NAVIGATED to the URL (this makes the command
/// safe to call on every panel activation and from every address-bar
/// navigation). Otherwise a new child webview is added to the host window at
/// 1×1 logical px, HIDDEN — the frontend then measures its placeholder, calls
/// `browser_tab_set_bounds` and `browser_tab_set_visible(true)`. Creating it
/// hidden prevents a flash of the page at the window's top-left corner before
/// the first bounds sync.
///
/// R59-b: the OPTIONAL `window_label` decides which window the webview is a
/// child of. Omitted (None — every pre-R59 call site: the invoke bridge maps
/// a missing key to None, so the BrowserPanel's `{tabId, url}` payloads are
/// backward-compatible) it defaults to the MAIN window; the pop-out page
/// passes its OWN label (`acute-browser`) so its content webview floats over
/// the pop-out window. Bounds/visibility/go/navigate/url/close resolve the
/// webview through its globally-unique LABEL (`Manager::get_webview`), so
/// they are window-agnostic and needed no change.
///
/// R60: the OPTIONAL `hide_viewport_scrollbar` (the pop-out passes true)
/// injects the viewport-hide CSS so the pop-out's OWN gutter scrollbar can
/// replace the in-page bar (outside the content card, per the owner). The
/// themed inner-scrollbar CSS is injected either way. Initialization scripts
/// persist for the webview's LIFETIME (they re-run on every navigation), so
/// the idempotent-navigate path never needs re-injection.
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
pub async fn browser_tab_create(
    app: AppHandle,
    tab_id: String,
    url: String,
    window_label: Option<String>,
    hide_viewport_scrollbar: Option<bool>,
) -> Result<(), String> {
    let label = tab_label(&tab_id);

    // Idempotent create: an existing webview just navigates. The scrollbar
    // init script rides the webview for its whole lifetime (R60) — no
    // re-injection needed here, and the flag only matters at creation.
    if let Some(existing) = app.get_webview(&label) {
        let parsed = parse_http_url(&url)?;
        existing
            .navigate(parsed)
            .map_err(|e| format!("navigate tab \"{tab_id}\" failed: {e}"))?;
        return Ok(());
    }

    let parsed = parse_http_url(&url)?;
    // R59-b: the host window. `get_window` (not `get_webview_window`) —
    // `add_child` lives on `Window`, and a `WebviewWindow` handle does not
    // expose it.
    let host_label = window_label.unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());
    let host_window = app
        .get_window(&host_label)
        .ok_or_else(|| format!("window \"{host_label}\" not found"))?;

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
    let init_script = tab_scrollbar_init_script(hide_viewport_scrollbar.unwrap_or(false));
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .data_directory(profile)
        .initialization_script(init_script)
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

    let webview = host_window
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

/// R60: the JS the scroll-state probe evaluates in the page. Returns a JSON
/// string with the main scroller's geometry PLUS whether our themed-scrollbar
/// style element actually APPLIED (`css: true` — a CSP-blocked `<style>` has
/// `sheet === null`). Everything is wrapped so a hostile/broken page yields a
/// well-formed (but css:false) answer instead of a rejection.
const TAB_SCROLL_STATE_JS: &str = r#"(function(){
try {
  var el = document.getElementById('acute-scrollbar-style');
  var css = !!(el && el.sheet !== null);
  var de = document.documentElement;
  var b = document.body;
  var y = window.scrollY || window.pageYOffset || 0;
  var vh = window.innerHeight;
  var ch = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0);
  return JSON.stringify({ y: Math.round(y), vh: Math.round(vh), ch: Math.round(ch), css: css });
} catch (e) {
  return JSON.stringify({ y: 0, vh: 0, ch: 0, css: false });
}})()"#;

/// `browser_tab_scroll_state(tab_id)` — R60: the pop-out window's gutter
/// scrollbar data source. Evaluates a probe in the page (via
/// `eval_with_callback` — tauri 2.11, the ONLY channel that reads data back
/// out of an external page without injecting IPC into it) and returns the
/// JSON string `{y, vh, ch, css}` (scroll offset, viewport height, content
/// height, whether the themed-scrollbar CSS applied).
///
/// ASYNC on purpose: the callback arrives from the webview's renderer thread
/// and we block a channel until it does (2s timeout — a page whose JS is
/// wedged must never hang the poller; the frontend treats a rejection as
/// "no data" and hides the gutter scrollbar).
#[tauri::command]
pub async fn browser_tab_scroll_state(app: AppHandle, tab_id: String) -> Result<String, String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    webview
        .eval_with_callback(TAB_SCROLL_STATE_JS, move |result: String| {
            let _ = tx.send(result);
        })
        .map_err(|e| format!("eval scroll state tab \"{tab_id}\" failed: {e}"))?;
    match rx.recv_timeout(std::time::Duration::from_millis(2000)) {
        Ok(json) => Ok(json),
        Err(_) => Err(format!(
            "scroll state tab \"{tab_id}\" timed out (page JS unresponsive)"
        )),
    }
}

/// `browser_tab_scroll_to(tab_id, y)` — R60: scroll the page's main scroller
/// to an absolute offset (the pop-out gutter scrollbar's drag/click driver).
/// Fire-and-forget eval like `browser_tab_go`. `y` is clamped to ≥ 0 (the
/// page itself clamps to its own max — scrolling past the end is a no-op).
#[tauri::command]
pub fn browser_tab_scroll_to(app: AppHandle, tab_id: String, y: f64) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    if !y.is_finite() || y < 0.0 {
        return Err(format!("scroll offset {y} is not a non-negative finite number"));
    }
    let script = format!("window.scrollTo(0, {y});");
    webview
        .eval(&script)
        .map_err(|e| format!("scroll_to tab \"{tab_id}\" failed: {e}"))
}

/// `browser_tab_set_zoom(tab_id, factor)` — R60: the REAL DPI-level page zoom
/// (WebView2's zoomFactor through tauri's `Webview::set_zoom`), replacing the
/// R50 divide-the-viewport approximation the BrowserPanel used because the
/// API "was not exposed" then (it is, in tauri 2.11). Media queries and
/// rem-based layout re-evaluate exactly like a browser's Ctrl+± zoom, which
/// is what display-size testing needs. Factor is clamped to 0.1–5.0.
#[tauri::command]
pub fn browser_tab_set_zoom(app: AppHandle, tab_id: String, factor: f64) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    if !factor.is_finite() || !(0.1..=5.0).contains(&factor) {
        return Err(format!("zoom factor {factor} out of range (0.1–5.0)"));
    }
    webview
        .set_zoom(factor)
        .map_err(|e| format!("set_zoom tab \"{tab_id}\" failed: {e}"))
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
/// affordances; it never touches the pop-out WINDOW or the main webview
/// (R59-b: the pop-out's content webview IS `acute-tab-popout` and IS swept —
/// it is a tab webview by label, and it cannot outlive its window anyway).
/// Closes as many as it can and reports the first failure.
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

// ── ROUND-59 (R59-b): unit tests ──────────────────────────────────────────
//
// Pure functions only (the keys.rs/sidecar.rs tests-module pattern): the
// window/webview plumbing needs a running Tauri shell. CI runs `cargo
// check`; these compile + run under `cargo test`.
#[cfg(test)]
mod tests {
    use super::{
        clamp_popout_size, popout_pending_url, set_popout_pending_url, POPOUT_DEFAULT_H,
        POPOUT_DEFAULT_W, POPOUT_MIN_H, POPOUT_MIN_W,
    };

    /// 70% of a large work area EXCEEDS the defaults → the defaults win
    /// (never larger than 1200×800, never larger than the desktop).
    #[test]
    fn popout_size_defaults_win_on_large_screens() {
        let (w, h) = clamp_popout_size(POPOUT_DEFAULT_W, POPOUT_DEFAULT_H, 2560.0, 1440.0);
        assert_eq!((w, h), (POPOUT_DEFAULT_W, POPOUT_DEFAULT_H));
    }

    /// A mid-sized work area (a laptop with taskbar) shrinks the window to
    /// 70% — the honest small-screen behavior the owner asked for.
    /// (0.7 is not binary-exact, hence the tolerance.)
    #[test]
    fn popout_size_takes_70_percent_of_a_mid_sized_work_area() {
        let (w, h) = clamp_popout_size(POPOUT_DEFAULT_W, POPOUT_DEFAULT_H, 1600.0, 900.0);
        assert!((w - 1120.0).abs() < 1e-6, "width was {w}");
        assert!((h - 630.0).abs() < 1e-6, "height was {h}");
    }

    /// On a small work area the minimum inner size WINS (both dimensions) —
    /// a usable browser beats a sliver, and min_inner_size enforces the
    /// same floor, so this is what actually opens.
    #[test]
    fn popout_size_floors_at_the_minimum_on_small_screens() {
        let (w, h) = clamp_popout_size(POPOUT_DEFAULT_W, POPOUT_DEFAULT_H, 900.0, 620.0);
        assert_eq!((w, h), (POPOUT_MIN_W, POPOUT_MIN_H));
    }

    /// The clamp is per-dimension: a wide-short work area shrinks only the
    /// height to the floor while the width takes its 70% share.
    #[test]
    fn popout_size_clamps_per_dimension() {
        // 70% of 1440 = 1008 (fits, no floor); 70% of 620 = 434 → floored.
        let (w, h) = clamp_popout_size(POPOUT_DEFAULT_W, POPOUT_DEFAULT_H, 1440.0, 620.0);
        assert!((w - 1008.0).abs() < 1e-6, "width was {w}");
        assert_eq!(h, POPOUT_MIN_H);
    }

    /// Degenerate monitor data (NaN / zero / negative) falls back to the
    /// defaults — never a zero-sized or NaN window.
    #[test]
    fn popout_size_degenerate_work_area_falls_back_to_defaults() {
        for (work_w, work_h) in [
            (0.0, 900.0),
            (1600.0, 0.0),
            (-1.0, 900.0),
            (f64::NAN, 900.0),
            (1600.0, f64::NAN),
        ] {
            let (w, h) = clamp_popout_size(POPOUT_DEFAULT_W, POPOUT_DEFAULT_H, work_w, work_h);
            assert_eq!((w, h), (POPOUT_DEFAULT_W, POPOUT_DEFAULT_H));
        }
    }

    /// The pending-url stash round-trips and the LAST write wins (the
    /// focus-path re-open must supersede the create-path URL for a page
    /// that mounts late). One test function because the stash is a shared
    /// static — parallel sibling tests must not interleave writes.
    #[test]
    fn popout_pending_url_roundtrips_and_last_write_wins() {
        set_popout_pending_url("https://first.example/".to_string())
            .expect("first stash write");
        assert_eq!(
            popout_pending_url().expect("stash read"),
            Some("https://first.example/".to_string())
        );
        set_popout_pending_url("https://second.example/".to_string())
            .expect("second stash write");
        assert_eq!(
            popout_pending_url().expect("stash re-read"),
            Some("https://second.example/".to_string())
        );
    }
}
