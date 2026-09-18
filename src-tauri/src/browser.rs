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
//! - ROUND-95 (R95-C): LOCAL FILES. The owner's report: "I gave it a file path
//!   for a local HTML file and after giving it that, it gave me this error:
//!   'Native browser unavailable. Only HTTP/HTTPS URLs are supported by the
//!   embedded browser.' … It should be able to open up local HTML files too."
//!   The gate (`parse_web_url`, formerly `parse_http_url`) now accepts
//!   http/https/FILE for every tab/pop-out navigation — WebView2 renders
//!   file:// pages natively with the same initialization scripts — and the
//!   `on_navigation` hook emits `browser-navigated` for file pages too, so the
//!   address bar + server-side history stay in sync on local files. The
//!   OS-browser handoff (`open_external_url`) stays http/https-only: a local
//!   file belongs to the app's own browser, not the system default. The
//!   frontend normalizes local paths (C:\…, /home/…) into file:// URLs before
//!   invoking these commands (src/lib/local-url.ts), and the agent's
//!   `browser_control` tool + the sidecar accept file:// URLs end to end.
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
/// ("acute-browser" does not start with "acute-tab-"). R105-A: also read
/// by the Linux geometry layer (gtk_child_webviews) to pick a window's
/// CHROME webview out of its webview list.
pub(crate) const TAB_LABEL_PREFIX: &str = "acute-tab-";

/// ROUND-50: the main app window (tauri.conf.json default label). All tab
/// webviews are children of this window so they float over the UI.
const MAIN_WINDOW_LABEL: &str = "main";

/// ROUND-100 (R100-A): the browser panel's USER AGENT — the de-brand leg of
/// the honest-browser rework. The owner's report: "it is still utilizing
/// the Microsoft Edge browser under the hood" — the WebView2 evergreen
/// runtime's default UA carries `Edg/153…` tokens, so every page the agent
/// asked (and every `navigator.userAgent` read) answered "Microsoft Edge".
/// This constant replaces the default UA on every CONTENT webview
/// (`browser_tab_create` — the single chokepoint for panel tabs AND the
/// pop-out's content): the engine-lineage tokens stay HONEST (Chromium's
/// AppleWebKit/Chrome tokens on Windows — sites gatekeep on them), the
/// Microsoft Edge brand token is GONE, and our own `AcuteBrowser/1.0`
/// identity rides last. On Linux the webview is WebKitGTK (genuinely not
/// Chromium) so that platform's string keeps WebKit's honest shape.
/// Bump rule: when the evergreen floor moves past 153 (the `Chrome/` token
/// below), bump this once — UA-version pinning is standard practice and
/// sites feature-detect via JS APIs, not UA version numbers.
#[cfg(windows)]
const PANEL_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 AcuteBrowser/1.0";
/// The Linux leg — WebKitGTK's lineage, our identity token, no Chromium
/// pretense (the panel on Linux IS WebKit: the honest string says so).
#[cfg(all(unix, not(target_os = "macos")))]
const PANEL_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) acutewebviewer/1.0 Safari/537.36 AcuteBrowser/1.0";
/// Other targets (macOS is not shipped): no override marker — the empty
/// string means "keep the default UA" at the call site's cfg gate below.
#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
const PANEL_USER_AGENT_STR: &str = "";
#[cfg(any(windows, all(unix, not(target_os = "macos"))))]
const PANEL_USER_AGENT_STR: &str = PANEL_USER_AGENT;

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

/// R91-B2: the LAST BOUNDS every tab's webview was told to occupy. A
/// webview is BORN at 1×1 logical px, HIDDEN — the frontend's bounds sync
/// is what positions it over the panel's page area. If that sync ever
/// races a hide/show transition (a guard flap, an activation churn, a
/// wedged invoke), the webview can end up SHOWN at its degenerate 1×1
/// birth bounds — alive (evals answer) but invisible (the owner's v0.88.0
/// field report: "nothing was being shown at all"). `browser_tab_set_bounds`
/// records every commanded geometry here, and `browser_tab_set_visible
/// (true)` RE-ASSERTS the recorded bounds in the same breath as the show,
/// so a show can never land without its geometry. Cleared when the tab
/// closes. (The map lives only in memory — a fresh app boot re-creates
/// every webview at 1×1 anyway, and the panel's first sync re-positions.)
static TAB_LAST_BOUNDS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64, f64)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Records `tab_id`'s commanded bounds (clamped to sane positives — the
/// same floor `browser_tab_set_bounds` itself applies).
fn remember_tab_bounds(tab_id: &str, x: f64, y: f64, w: f64, h: f64) {
    if let Ok(mut map) = TAB_LAST_BOUNDS.lock() {
        map.insert(
            tab_id.to_string(),
            (
                x,
                y,
                if w.is_finite() && w >= 1.0 { w } else { 1.0 },
                if h.is_finite() && h >= 1.0 { h } else { 1.0 },
            ),
        );
    }
}

/// Parses and validates a URL for the native tabs: http, https AND file.
///
/// ROUND-95 (R95-C): `file:` joins the allowlist — the owner's directive
/// that the native browser open LOCAL files ("It should be able to open up
/// local HTML files too"). WebView2 renders file:// pages natively in a
/// child webview exactly like a remote page — same rendering path, same
/// initialization scripts (the themed-scrollbar and hands-boot scripts are
/// injected at DOCUMENT CREATION on every navigation, file pages included)
/// — so `WebviewUrl::External` and `navigate` need no special-casing for
/// it. The remaining schemes (about:, data:, javascript:, tauri:) stay
/// REFUSED as top-level navigations: they are the attack surface (a
/// webview-supplied string must never smuggle app-internal or synthesized
/// content into the page area), and no legitimate browsing needs them as an
/// address.
fn parse_web_url(url: &str) -> Result<Url, String> {
    let parsed: Url = url
        .parse()
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" && scheme != "file" {
        return Err(format!(
            "only http/https/file URLs are supported by the native browser (got \"{url}\")"
        ));
    }
    Ok(parsed)
}

/// The http/https-only twin for the OS-browser handoff (`open_external_url`):
/// a local file belongs to the app's OWN browser (the panel and the pop-out
/// render it natively via `parse_web_url`), never to the system default
/// browser, so the shell-plugin open keeps its pre-R95 contract. ROUND-95
/// (R95-C): split out of the old `parse_http_url` when that gate grew its
/// file arm.
fn parse_http_url(url: &str) -> Result<Url, String> {
    let parsed = parse_web_url(url)?;
    if parsed.scheme() == "file" {
        return Err(format!(
            "only http/https URLs can be handed to the system browser — local files open in the app's own browser (got \"{url}\")"
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
/// validated http/https/file up front — that is the contract of the child
/// webview that will render it (R95-C grew the contract from http/https to
/// include local files; every caller passes the panel's currentUrl).
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
    // Validate http/https/file FIRST — the child webview that will render this
    // URL is the native browser's own (`parse_web_url` contract, R95-C: a
    // local file renders natively), and a bad URL must stash nothing and open
    // nothing.
    parse_web_url(&url)?;

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
            let parsed = parse_web_url(&url)?;
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
    parse_web_url(&url)?;
    if let Some(content) = app.get_webview(&tab_label(POPOUT_TAB_ID)) {
        let parsed = parse_web_url(&url)?;
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

// ── ROUND-90 (R90-C2): THE MENU OVERLAY WINDOW ─────────────────────────────
//
// The owner's verdict on the R62/R89 popover guard: "Whenever a page was
// open in the browser and I clicked on any of the elements (like the new
// tab button), the browser window would close, and it would show 'Browser
// paused while the menu is open'… This is not supposed to happen. The menu
// was supposed to be shown on top of the browser window itself."
//
// WHY that was structurally impossible in-window: the sidebar's popovers
// render in the MAIN webview, and a browser tab's page is an OS-level CHILD
// WEBVIEW of the main window that floats above ALL app HTML — no DOM menu
// can ever paint over it. Hiding the webview while a popover covers it
// (R62's guard, R89's geometric refinement) was the only in-window answer,
// and to the owner it read as the browser "closing".
//
// THE R90 ANSWER: the right sidebar's two popovers (the quick menu + the
// sub-agent picker) render in their OWN tiny OS window — transparent,
// borderless, shadowless, never in the taskbar, not focusable — OWNED by
// the main window. Win32 owned windows are ALWAYS above their owner (and
// everything inside it, the browser child webviews included), so the menu
// genuinely floats ON TOP of the LIVE browser: the browser never pauses,
// the menu never hides. The window hosts menu-overlay.html (the 4th vite
// entry — popout.html's exact pattern), reads its payload from the pending
// stash on mount (the popout pending-URL pattern) or from the
// "menu-overlay-data" event on reuse, and reports interactions through the
// "menu-overlay-pick" / "menu-overlay-close" events that the main window's
// bridge (src/lib/menu-overlay.ts) subscribes to.
//
// Lifecycle: ONE window, created hidden at sidebar mount (`menu_overlay_
// prewarm`), repositioned + shown per popover (`menu_overlay_show`), hidden
// on pick/close/outside-click (`menu_overlay_hide`). It is never destroyed
// until the app exits (an owned window dies with its owner).

/// The menu overlay window's label (capabilities/default.json lists it).
const MENU_OVERLAY_LABEL: &str = "acute-menu-overlay";

/// The pending menu payload — the stash the window's page reads on mount so
/// the create race can never lose data (the POPOUT_PENDING_URL pattern).
static MENU_PENDING_PAYLOAD: Mutex<Option<String>> = Mutex::new(None);

/// The shared creation path for the menu overlay window (created hidden by
/// the prewarm, visible by `menu_overlay_show`). `focusable(false)` = the
/// menu never steals keyboard focus from the main window (menus are click
/// surfaces; Escape keeps working in the main window, which owns closing).
/// Returns the BUILT window (the builder borrows the app handle with a
/// lifetime — returning the window itself keeps the signature clean).
fn menu_overlay_create(
    app: &AppHandle,
    visible: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<tauri::WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(
        app,
        MENU_OVERLAY_LABEL,
        WebviewUrl::App("menu-overlay.html".into()),
    )
    .title("Acute menu")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible(visible)
    // LOGICAL units — the builder's position/inner_size take (f64, f64)
    // pairs directly (verified against tauri 2.11.5's signatures).
    .position(x, y)
    .inner_size(w.max(1.0), h.max(1.0));
    // OWNERSHIP is the whole trick: an owned window rides above the owner
    // (and its child webviews). Windows: `.owner`; Linux: `transient_for`;
    // macOS: `parent` (adds it as a child window — fine for a menu).
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    #[cfg(windows)]
    let builder = builder
        .owner(&main)
        .map_err(|e| format!("owner failed: {e}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let builder = builder
        .transient_for(&main)
        .map_err(|e| format!("transient_for failed: {e}"))?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .parent(&main)
        .map_err(|e| format!("parent failed: {e}"))?;
    builder
        .build()
        .map_err(|e| format!("create menu overlay failed: {e}"))
}

/// `menu_overlay_prewarm()` — create the menu overlay window HIDDEN at the
/// app's idle spot (off-stage). The first real menu open is then a cheap
/// set_position + show instead of a webview spawn (a ~200ms blank-window
/// risk on the very first + click would have reinforced exactly the
/// "overlay, not part of the app" feel this round retires). Failure is the
/// caller's problem to ignore — the sidebar falls back to the DOM popover.
///
/// R91-B1: THIS COMMAND IS `async` — the R90-C2 version was sync, and a SYNC
/// command runs on the MAIN THREAD where `WebviewWindowBuilder::build` is the
/// DOCUMENTED Windows deadlock (tauri's own WebviewWindowBuilder docs: "On
/// Windows, this function deadlocks when used in a synchronous command…
/// You should use async commands and separate threads when creating
/// windows" — the same lesson browser.rs already learned for
/// `open_browser_window` in R58-b and `browser_tab_create` in R50-a).
/// v0.88.0 shipped the sync version; on the owner's machine the browser
/// panel rendered nothing while the UI kept working — the exact partial
/// wedge this deadlock class produces. Async commands run on the tokio
/// runtime, off the main thread: the documented, safe path.
#[tauri::command]
pub async fn menu_overlay_prewarm(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(MENU_OVERLAY_LABEL).is_some() {
        return Ok(());
    }
    // Off-stage: a 1×1 window parked at the screen origin, invisible until
    // a real show positions it. `prevent_overflow` would fight the off-stage
    // position, so it is deliberately absent.
    menu_overlay_create(&app, false, 0.0, 0.0, 1.0, 1.0).map(|_| ())
}

/// `menu_overlay_show(x, y, w, h, payload)` — position + show the menu
/// overlay window at LOGICAL SCREEN coordinates and deliver its payload.
/// Reuses the prewarmed window when present; creates it visible otherwise
/// (first-call fallback). The payload is a JSON string the page renders;
/// it is BOTH stashed (a page still mounting reads the stash) and emitted
/// (a live page re-renders in place).
///
/// R91-B1: `async` for the same deadlock reason as `menu_overlay_prewarm`
/// above — the create-on-first-call branch builds a window, and a sync
/// command doing that on the main thread is the documented Windows hang.
///
/// ROUND-96 (R96-G): the payload space grew a fourth kind — the USAGE rich
/// card (`kind: "usage"`, the ContextDonut hover popover's structured
/// content) — so hovering the token usage over the browser area rides THIS
/// window instead of a DOM popover that can never paint above the tab
/// webviews (the owner: "when I try to hover over the total number of token
/// usage that has been done, it apparently hides the browser… This is not
/// a great experience"). The Rust side needs NO new plumbing for it: the
/// payload is forwarded opaquely (no size cap beyond the JSON-object shape
/// check below — a usage card is ~2-4KB), and the geometry clamps already
/// cover it (the card is 300 logical px wide and capped at the space above
/// the composer). The overlay page also reports the usage card's pointer
/// enter/leave back through the "menu-overlay-hover" event so the main
/// window keeps its hover-grace close semantics across the window boundary.
#[tauri::command]
pub async fn menu_overlay_show(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    payload: String,
) -> Result<(), String> {
    let trimmed = payload.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Err("menu payload must be a JSON object string".into());
    }
    // Sanitize the geometry: a menu is a small thing, and a bad measurement
    // must never spawn a giant transparent window eating clicks.
    let w = w.clamp(120.0, 800.0);
    let h = h.clamp(40.0, 900.0);
    let x = x.clamp(-4096.0, 16384.0);
    let y = y.clamp(-4096.0, 16384.0);

    *MENU_PENDING_PAYLOAD
        .lock()
        .map_err(|_| "menu pending payload lock poisoned".to_string())? = Some(trimmed.to_string());

    if let Some(existing) = app.get_webview_window(MENU_OVERLAY_LABEL) {
        let _ = existing.set_position(LogicalPosition::new(x, y));
        let _ = existing.set_size(LogicalSize::new(w, h));
        let _ = existing.show();
    } else {
        menu_overlay_create(&app, true, x, y, w, h).map(|_| ())?;
    }
    let _ = app.emit("menu-overlay-data", trimmed.to_string());
    Ok(())
}

/// `menu_overlay_hide()` — hide the menu overlay window (it stays alive for
/// the next open). Not-found is Ok (idempotent). Stays sync by necessity —
/// hide() only ever dispatches a fire-and-forget window message, never a
/// build (see the R91-B1 notes on its siblings for why that distinction
/// matters).
#[tauri::command]
pub fn menu_overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(MENU_OVERLAY_LABEL) {
        let _ = existing.hide();
    }
    Ok(())
}

/// `menu_overlay_pending()` — the stashed payload for a page that is still
/// mounting (None until the first show; kept, not cleared, so a reload
/// re-renders the last menu instead of a blank window).
#[tauri::command]
pub fn menu_overlay_pending() -> Result<Option<String>, String> {
    MENU_PENDING_PAYLOAD
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "menu pending payload lock poisoned".to_string())
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
/// reach the OS handler with a file:/data:/tauri: scheme; R95-C: a local
/// file is deliberately NOT handed to the system browser — it renders in
/// the app's own native browser via `parse_web_url` instead). This is the
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
    // R90-D1: the ALWAYS-VISIBLE CURSOR's boot script — chained after the
    // scrollbar script as ONE initialization script (the hands-boot the main
    // app builds in src/lib/agent-hands-boot.ts). It runs at DOCUMENT
    // CREATION on EVERY navigation of this webview, so the agent's cursor is
    // painted from the first frame of every page at a natural resting spot —
    // never "disappearing" between actions. The script is idempotent and
    // CSP-tolerant; the agent-hands runtime (installed by the first action's
    // eval) ADOPTS the boot's cursor via `window.__acuteHandsRest`.
    // (Plain `//` — doc comments are not legal on fn parameters in Rust.)
    hands_init_script: Option<String>,
) -> Result<(), String> {
    let label = tab_label(&tab_id);

    // Idempotent create: an existing webview just navigates. The scrollbar
    // init script rides the webview for its whole lifetime (R60) — no
    // re-injection needed here, and the flag only matters at creation.
    if let Some(existing) = app.get_webview(&label) {
        let parsed = parse_web_url(&url)?;
        existing
            .navigate(parsed)
            .map_err(|e| format!("navigate tab \"{tab_id}\" failed: {e}"))?;
        return Ok(());
    }

    // R95-C: a file:// URL works with `WebviewUrl::External` unchanged —
    // WebView2 renders local files natively (the init scripts run on every
    // navigation, file pages included); the profile/data-directory logic
    // below applies to a local page exactly like a remote one.
    let parsed = parse_web_url(&url)?;
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

    // R105-A (Linux): make sure THIS window's widget tree can host
    // positionable child webviews before the tab is born — the one-time,
    // idempotent Overlay+Fixed surgery (see gtk_child_webviews). Windows
    // is untouched: WebView2 child webviews honor set_position/set_size
    // natively.
    #[cfg(target_os = "linux")]
    gtk_child_webviews::ensure_fixed_overlay(&host_window);

    // Emit `browser-navigated {tab_id, url}` for EVERY http/https/file
    // navigation (initial load, link clicks, redirects, form submits) so the
    // panel can keep the address bar and the sidecar's server-side history
    // in sync. R95-C: file navigations are included — the panel used to be
    // told only about http(s), so a file page's in-page link walks desynced
    // the address bar/history silently. We never block a navigation — this
    // is a browser, not a filter.
    let app_for_hook = app.clone();
    let hook_tab_id = tab_id.clone();
    // R90-D1: ONE combined initialization script — the scrollbar CSS plus
    // (when provided) the hands boot (already a self-invoking, idempotent
    // IIFE — appended as-is; a single initialization_script() call keeps the
    // builder's accumulation semantics out of the question).
    let init_script = match hands_init_script.as_deref() {
        Some(hands) if !hands.trim().is_empty() => {
            format!("{}\n{}\n", tab_scrollbar_init_script(hide_viewport_scrollbar.unwrap_or(false)), hands)
        }
        _ => tab_scrollbar_init_script(hide_viewport_scrollbar.unwrap_or(false)),
    };
    let builder = if PANEL_USER_AGENT_STR.is_empty() {
        WebviewBuilder::new(label, WebviewUrl::External(parsed))
            .data_directory(profile)
            .initialization_script(init_script)
    } else {
        WebviewBuilder::new(label, WebviewUrl::External(parsed))
            .data_directory(profile)
            // R100-A: the de-branded panel UA (see PANEL_USER_AGENT above) —
            // set at the CONTENT-webview chokepoint so every tab (panel +
            // pop-out) presents ACUTE's identity; the app's own pages
            // (main/mini/popout chrome) keep their default UA (local content
            // never sees a UA).
            .user_agent(PANEL_USER_AGENT_STR)
            .initialization_script(init_script)
    };
    let builder = builder
        .on_navigation(move |nav: &Url| {
            // R95-C: file joins http/https — see the comment above the hook.
            if nav.scheme() == "http" || nav.scheme() == "https" || nav.scheme() == "file" {
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

    // R105-A (Linux): pull the (hidden) tab webview out of tao's vertical
    // GtkBox into the window's browser Fixed — while hidden, so the vbox
    // split the box-packing would cause never becomes visible. On Windows
    // the WebView2 child needs no adoption.
    #[cfg(target_os = "linux")]
    gtk_child_webviews::adopt_tab_webview(&webview);
    Ok(())
}

/// `browser_tab_exists(tab_id)` — does this tab's native webview exist
/// RIGHT NOW? An in-memory manager lookup only (no dispatcher round-trip,
/// no main-thread work) — the R91-B3 frontend watchdog can poll this cheaply
/// to distinguish "webview never got created" (→ recreate it) from "webview
/// created but wedged" (→ the re-assert heals it / the timeout surfaces it).
#[tauri::command]
pub fn browser_tab_exists(app: AppHandle, tab_id: String) -> bool {
    find_tab_webview(&app, &tab_id).is_some()
}

/// `browser_tab_navigate(tab_id, url)` — navigate the tab's existing webview.
/// Unlike `browser_tab_create` this is NOT idempotent-create: it errors when
/// the tab has no webview yet (the frontend uses create for that).
#[tauri::command]
pub fn browser_tab_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\" — create it first"))?;
    let parsed = parse_web_url(&url)?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("navigate tab \"{tab_id}\" failed: {e}"))
}

/// `browser_tab_set_bounds(tab_id, x, y, w, h)` — position the tab's webview
/// over the panel's page area. Coordinates are LOGICAL px, which equal CSS px
/// of the main webview (getBoundingClientRect), because the main webview fills
/// the whole window at scale factor 1. Width/height are clamped to ≥ 1 so a
/// zero-sized measurement can never create a degenerate webview.
///
/// R91-B2: every commanded geometry is recorded (see `TAB_LAST_BOUNDS`)
/// so a later `browser_tab_set_visible(true)` can re-assert it — a show
/// without geometry is how a webview ends up visible-but-1×1.
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
    let safe_w = w.max(1.0);
    let safe_h = h.max(1.0);
    // R105-A: on Linux, Tauri's set_position/set_size are silent no-ops for
    // box-packed child webviews (wry honors geometry only for GtkFixed
    // children, and its is_in_fixed_parent flag is captured at BUILD time) —
    // the GTK layer moves the webview instead, and self-adopts any webview
    // still sitting in the vbox at these bounds. Windows keeps the native
    // WebView2 path.
    #[cfg(target_os = "linux")]
    {
        gtk_child_webviews::position_tab(&webview, x, y, safe_w, safe_h);
    }
    #[cfg(not(target_os = "linux"))]
    {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("set_position tab \"{tab_id}\" failed: {e}"))?;
        webview
            .set_size(LogicalSize::new(safe_w, safe_h))
            .map_err(|e| format!("set_size tab \"{tab_id}\" failed: {e}"))?;
    }
    remember_tab_bounds(&tab_id, x, y, safe_w, safe_h);
    Ok(())
}

/// `browser_tab_set_visible(tab_id, visible)` — show/hide the tab's webview.
/// Hiding is how a tab "goes to the background" (panel switched away /
/// sidebar collapsed): the webview and its session STAY ALIVE. Not-found is
/// Ok (idempotent) — hiding a tab that never created its webview is a no-op,
/// and the unmount cleanup must never crash on a fresh tab.
///
/// R91-B2: a SHOW re-asserts the tab's LAST COMMANDED BOUNDS immediately
/// after the visible flag lands. A webview born at 1×1 that gets shown
/// before (or without) its bounds sync renders nothing — alive but
/// invisible. Re-applying the remembered geometry with the show closes
/// that window entirely: whenever the webview is visible, it is visible
/// AT its intended rectangle. (Position/size dispatchers are fire-and-forget
/// window messages — safe to call from this sync command without touching
/// the main thread's build path.)
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
    res.map_err(|e| format!("set_visible({visible}) tab \"{tab_id}\" failed: {e}"))?;
    if visible {
        if let Ok(map) = TAB_LAST_BOUNDS.lock() {
            if let Some(&(x, y, w, h)) = map.get(&tab_id) {
                // R105-A: the Linux re-assert rides the GTK layer (the
                // tauri set_position/set_size pair is a no-op there); on
                // Windows the recorded bounds re-apply through the native
                // WebView2 path exactly as before.
                #[cfg(target_os = "linux")]
                {
                    gtk_child_webviews::position_tab(&webview, x, y, w, h);
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = webview.set_position(LogicalPosition::new(x, y));
                    let _ = webview.set_size(LogicalSize::new(w, h));
                }
            }
        }
    }
    Ok(())
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

/// `browser_tab_eval(tab_id, script)` — R62 (the agent-browser bridge): run
/// a JavaScript snippet INSIDE the tab's live page and return its value as a
/// JSON string. The script is wrapped in a function body, so the caller
/// returns data with `return …`; the wrapper stringifies `{ok, value}` (or
/// `{ok: false, error}` when the page JS throws) so page-level exceptions
/// surface as DATA, not command failures.
///
/// Validation: non-empty, ≤ 20_000 chars, no NUL bytes. ASYNC with a 3s
/// callback timeout (same channel as `browser_tab_scroll_state` —
/// `eval_with_callback` is the only way to read a value back out of an
/// external page). This is the engine behind the `browser_control` tool's
/// `eval` action (the agent clicking links, filling forms, reading the DOM
/// in the page the user watches live).
#[tauri::command]
pub async fn browser_tab_eval(app: AppHandle, tab_id: String, script: String) -> Result<String, String> {
    let webview = find_tab_webview(&app, &tab_id)
        .ok_or_else(|| format!("no native webview for tab \"{tab_id}\""))?;
    let trimmed_len = script.trim().len();
    if trimmed_len == 0 {
        return Err("eval script is empty".into());
    }
    if script.len() > 20_000 {
        return Err(format!(
            "eval script too large ({} bytes; max 20000)",
            script.len()
        ));
    }
    if script.contains('\0') {
        return Err("eval script contains a NUL byte".into());
    }
    // Wrap: function BODY semantics (the caller uses `return`), JSON result,
    // page exceptions as {ok:false, error} data. The double-brace escaping
    // is for the format! string below.
    let wrapped = format!(
        "(function(){{try{{var __acute_r=(function(){{{script}}})();return JSON.stringify({{ok:true,value:(__acute_r===undefined?null:__acute_r)}});}}catch(e){{return JSON.stringify({{ok:false,error:String((e&&(e.message||e))||e)}});}}}})()"
    );
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    webview
        .eval_with_callback(&wrapped, move |result: String| {
            let _ = tx.send(result);
        })
        .map_err(|e| format!("eval tab \"{tab_id}\" failed: {e}"))?;
    match rx.recv_timeout(std::time::Duration::from_millis(3000)) {
        Ok(json) => Ok(json),
        Err(_) => Err(format!(
            "eval tab \"{tab_id}\" timed out (page JS unresponsive)"
        )),
    }
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
/// on the frontend races panel unmounts. R91-B2: the remembered bounds go
/// with it (a re-created webview starts at 1×1 and gets fresh bounds from
/// the panel's sync anyway — keeping a stale rectangle around buys nothing).
#[tauri::command]
pub fn browser_tab_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Ok(mut map) = TAB_LAST_BOUNDS.lock() {
        map.remove(&tab_id);
    }
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
        clamp_popout_size, parse_http_url, parse_web_url, popout_pending_url, set_popout_pending_url,
        POPOUT_DEFAULT_H, POPOUT_DEFAULT_W, POPOUT_MIN_H, POPOUT_MIN_W,
    };

    /// R95-C: the native-tab gate accepts http, https AND file (the owner's
    /// local-HTML directive); the URL round-trips as parsed.
    #[test]
    fn web_url_accepts_http_https_and_file() {
        for url in [
            "https://example.com/page",
            "http://127.0.0.1:5173/",
            "file:///C:/Users/owner/demo.html",
            "file:///home/z/repos/demo.html",
            "file://server/share/index.html",
        ] {
            let parsed = parse_web_url(url).unwrap_or_else(|e| panic!("{url}: {e}"));
            assert_eq!(parsed.as_str(), url, "canonical round-trip for {url}");
        }
    }

    /// R95-C: everything else stays refused with the message the panel can
    /// surface — about:, data:, javascript: and tauri: are the attack surface
    /// (a webview-supplied string must never smuggle synthesized content
    /// into the page area); unparseable junk dies on the parse arm instead.
    #[test]
    fn web_url_refuses_everything_else() {
        for url in ["about:blank", "data:text/html,<h1>x</h1>", "javascript:alert(1)", "tauri://localhost"] {
            let err = parse_web_url(url)
                .err()
                .unwrap_or_else(|| panic!("{url} was accepted"));
            assert!(
                err.contains("only http/https/file URLs are supported"),
                "error was: {err}"
            );
        }
        assert!(parse_web_url("not a url").is_err());
    }

    /// R95-C: the OS-browser handoff keeps its pre-R95 http/https-only
    /// contract — a local file renders in the app's own browser instead.
    #[test]
    fn http_url_refuses_file_for_the_os_handoff() {
        let err = parse_http_url("file:///C:/Users/owner/demo.html")
            .err()
            .expect("file handed to the OS browser");
        assert!(
            err.contains("local files open in the app's own browser"),
            "error was: {err}"
        );
        // http/https still pass through the twin unchanged.
        assert!(parse_http_url("https://example.com/").is_ok());
        assert!(parse_http_url("about:blank").is_err());
    }

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
