//! ROUND-64 (R64-b): the ALWAYS-ON-TOP floating computer-use mini monitor.
//!
//! The owner's directive (R64): the floating monitor "is not good looking…
//! It needs to be very minimal. It needs to be clean. It needs to be
//! beautiful. It should be a floating one. It will be shown at the top of
//! each and every single one of the screens… so that I can easily stop it
//! from there. When I feel like something is going wrong… The floating one
//! will automatically show up as soon as the agent starts to use the
//! computer skill and starts to interact with the device."
//!
//! That is an OS-level window, not an in-app card: while the agent drives
//! OTHER applications the owner must still see the monitor + its STOP kill
//! switch, so the window is built `always_on_top` + `skip_taskbar` and parks
//! at the TOP-RIGHT of the monitor the owner is looking at. The window hosts
//! `mini.html` (a THIRD vite entry — see vite.config.ts), a 360×96 page whose
//! own bundle polls the sidecar's `/computer-use/session` endpoint directly
//! and invokes `close_computer_mini` on itself when the session ends.
//!
//! The lifecycle is driven from the MAIN app (src/components/
//! ComputerMiniWindow.tsx): live SSE computer-use frames flip the monitor
//! store's `liveActivity` → `open_computer_mini` fires (once per burst);
//! the session ending (`session_stop` frame) → `close_computer_mini` after a
//! grace period. Both commands are idempotent (open focuses an existing
//! window, close is a no-op when absent).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The mini monitor window's label (unique per app, re-used so a re-open
/// focuses the existing window instead of stacking a second one — the
/// browser.rs BROWSER_WINDOW_LABEL pattern).
const MINI_WINDOW_LABEL: &str = "acute-computer-mini";

/// The main app window's label (tauri.conf.json default) — its CURRENT
/// monitor is where the owner is looking, so the mini window parks on that
/// monitor's work area (falling back to the primary monitor).
const MAIN_WINDOW_LABEL: &str = "main";

/// The fixed logical size — the page's layout is designed for exactly this
/// (one status row + one activity row + the STOP pill; NO scroll, NO stats
/// grid, NO event list: the owner's "very minimal, clean" verdict).
const MINI_DEFAULT_W: f64 = 360.0;
const MINI_DEFAULT_H: f64 = 96.0;

/// Logical-px inset from the work area's top-right corner (the floating
/// bar must never touch the screen edge).
const MINI_MARGIN: f64 = 16.0;

/// Honest guess when no monitor can be identified: top-right of a
/// conservative 1280×720 work area (1280 − 360 − 16 = 904).
const MINI_FALLBACK_X: f64 = 904.0;

/// The top-right anchor within a monitor's work area, in LOGICAL px (the
/// caller divides the physical work area by the monitor's scale factor).
/// Pure math so it is unit-testable without a monitor — the browser.rs
/// clamp_popout_size discipline.
///
/// Guards: a lying monitor (NaN / non-finite / absurdly small work area —
/// smaller than the window plus margins on EITHER axis) falls back to the
/// conservative default rather than a NaN or negative position.
fn mini_position_for_work_area(work_w: f64, work_h: f64) -> (f64, f64) {
    let usable = work_w.is_finite()
        && work_h.is_finite()
        && work_w > MINI_DEFAULT_W + 2.0 * MINI_MARGIN
        && work_h > MINI_DEFAULT_H + 2.0 * MINI_MARGIN;
    if !usable {
        return (MINI_FALLBACK_X, MINI_MARGIN);
    }
    (work_w - MINI_DEFAULT_W - MINI_MARGIN, MINI_MARGIN)
}

/// The monitor-aware wrapper: resolves the MAIN window's current monitor
/// (where the owner is looking), falling back to the primary monitor, then
/// to the honest default when neither answers. `current_monitor` /
/// `primary_monitor` round-trip the event loop — safe from an async command
/// thread (the browser.rs `popout_initial_size` note: the deadlock only
/// exists when the MAIN thread is the one waiting).
fn mini_initial_position(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|win| win.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let monitor = match monitor {
        Some(m) => m,
        None => return (MINI_FALLBACK_X, MINI_MARGIN),
    };
    let scale = monitor.scale_factor();
    if !(scale.is_finite() && scale > 0.0) {
        return (MINI_FALLBACK_X, MINI_MARGIN);
    }
    let work = monitor.work_area();
    mini_position_for_work_area(
        work.size.width as f64 / scale,
        work.size.height as f64 / scale,
    )
}

/// `open_computer_mini()` — open (or focus) the always-on-top floating
/// monitor window. Called by the main app the moment live computer-use
/// activity starts (the monitor store's `liveActivity` edge), so the owner
/// can hit STOP while the agent drives other applications.
///
/// WHY THIS COMMAND IS `async` (mirrors `open_browser_window` in browser.rs):
/// `WebviewWindowBuilder::build` creates the window AND its webview, which
/// blocks on a channel to the MAIN thread (`WindowBuilder::with_webview`).
/// Tauri runs SYNC commands on the main thread, so a sync build() ends up
/// waiting for a thread that is waiting for us — the documented WebView2
/// deadlock (tauri's WebviewBuilder docs: "On Windows, this function
/// deadlocks when used in a synchronous command… You should use async
/// commands and separate threads"). On the owner's Windows machine the R58
/// sync build deadlocked mid-creation and the pop-out rendered WHITE/blank.
/// Async commands run on the tokio runtime off the main thread — the
/// documented workaround.
#[tauri::command]
pub async fn open_computer_mini(app: AppHandle) -> Result<(), String> {
    // Existing window: focus it (the burst re-open path — the main app
    // invokes this once per activity burst; a second burst while the window
    // is still up must not stack a duplicate).
    if let Some(existing) = app.get_webview_window(MINI_WINDOW_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    // Top-right of the monitor the owner is looking at (logical px).
    let (x, y) = mini_initial_position(&app);

    WebviewWindowBuilder::new(&app, MINI_WINDOW_LABEL, WebviewUrl::App("mini.html".into()))
        .title("Acute Monitor")
        .inner_size(MINI_DEFAULT_W, MINI_DEFAULT_H)
        // Frameless: the page IS the chrome (its own drag region). The
        // native title bar was the owner's R59 verdict on the pop-out and
        // a 96px monitor has no room for one anyway.
        .decorations(false)
        // Fixed size — the minimal bar, never a resizable panel.
        .resizable(false)
        // A monitor, not an app: never in the taskbar.
        .skip_taskbar(true)
        // THE point of the window: float above EVERYTHING (the agent may be
        // driving other apps fullscreen) so STOP is always one click away.
        .always_on_top(true)
        // OS-level soft shadow so the bar reads as floating over the
        // desktop (Windows: works with decorations off).
        .shadow(true)
        // Appear WITHOUT stealing focus — the owner may be typing when the
        // agent starts moving the mouse; clicking the window focuses it.
        .focused(false)
        .position(x, y)
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;

    Ok(())
}

/// `close_computer_mini()` — close the floating monitor window if it is
/// open (a no-op when absent). Called by the mini page itself when the
/// control session has ended (its own poll is the primary path) and by the
/// main app's backstop timer on `session_stop` (browser.rs
/// `close_browser_window` pattern: idempotent, async to keep the
/// open/close pair symmetric — both are safe to call from any thread).
#[tauri::command]
pub async fn close_computer_mini(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(MINI_WINDOW_LABEL) {
        existing.close().map_err(|e| format!("close failed: {e}"))?;
    }
    Ok(())
}

// ── ROUND-64 (R64-b): unit tests ──────────────────────────────────────────
//
// Pure functions only (the browser.rs tests-module pattern): the window
// plumbing needs a running Tauri shell; CI runs `cargo check`, these compile
// + run under `cargo test`.
#[cfg(test)]
mod tests {
    use super::{mini_position_for_work_area, MINI_DEFAULT_H, MINI_DEFAULT_W, MINI_MARGIN};

    /// A normal desktop work area anchors the bar at its top-right corner,
    /// MINI_MARGIN in from the edges.
    #[test]
    fn mini_position_anchors_top_right_of_a_normal_work_area() {
        let (x, y) = mini_position_for_work_area(1920.0, 1040.0);
        assert_eq!((x, y), (1920.0 - MINI_DEFAULT_W - MINI_MARGIN, MINI_MARGIN));
    }

    /// A small-but-real laptop work area still anchors top-right (the window
    /// fits with margins on both axes).
    #[test]
    fn mini_position_small_work_area_still_top_right() {
        let (x, y) = mini_position_for_work_area(1280.0, 660.0);
        assert_eq!((x, y), (1280.0 - MINI_DEFAULT_W - MINI_MARGIN, MINI_MARGIN));
    }

    /// Degenerate monitor data (NaN / zero / negative / smaller than the
    /// window itself) falls back to the honest default — never NaN, never a
    /// negative or off-screen position.
    #[test]
    fn mini_position_degenerate_work_area_falls_back() {
        for (work_w, work_h) in [
            (0.0, 900.0),
            (1600.0, 0.0),
            (-1.0, 900.0),
            (f64::NAN, 900.0),
            (1600.0, f64::NAN),
            // Smaller than the window + margins on either axis.
            (300.0, 700.0),
            (1600.0, 100.0),
        ] {
            let (x, y) = mini_position_for_work_area(work_w, work_h);
            assert!(
                x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0,
                "({work_w}, {work_h}) produced ({x}, {y})"
            );
            assert_eq!(y, MINI_MARGIN);
        }
    }
}
