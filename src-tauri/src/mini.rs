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
//! at the TOP-CENTER of the monitor the owner is looking at (ROUND-66: the
//! owner's directive — "make it less tall and make it centered at the top,
//! not on the top right"). The window hosts `mini.html` (a THIRD vite entry
//! — see vite.config.ts), a 460×56 single-row page whose own bundle polls
//! the sidecar's `/computer-use/session` endpoint directly and invokes
//! `close_computer_mini` on itself when the session ends.
//!
//! The lifecycle is driven from the MAIN app (src/components/
//! ComputerMiniWindow.tsx): live SSE computer-use frames flip the monitor
//! store's `liveActivity` → `open_computer_mini` fires (once per burst);
//! the session ending (`session_stop` frame) → `close_computer_mini` after a
//! grace period. Both commands are idempotent (a re-open re-asserts the
//! monitor's window settings on the existing window WITHOUT touching
//! focus — ROUND-69; close is a no-op when absent).
//!
//! ROUND-68 (R68-B): the monitor is now INVISIBLE TO CAPTURE. The owner's
//! directive — "the 'agent is using your computer' should not be shown
//! because in the screenshot 'agent is using your computer' was being shown
//! and it was being captured and such… It will be an overlay kind of thing.
//! It will not be detected by our agent and it will also not be shown in the
//! screenshots which it takes and such" — is delivered by
//! `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` on the window:
//! the bar stays fully rendered on the owner's PHYSICAL display yet drops
//! out of every screen capture layered over the desktop (GDI
//! CopyFromScreen/BitBlt — exactly the agent-core captureDisplay path —
//! plus Windows.Graphics.Capture, OBS, screen share), so agent screenshots
//! show what is BEHIND the bar and the vision model never reads the
//! indicator text it used to "detect". See `exclude_from_capture` for the
//! honest pre-Windows-10-2004 caveat and the re-apply-on-reopen reasoning.
//!
//! ROUND-69 (R69-B): the monitor can no longer take focus, by
//! construction. The re-open path's `set_focus()` (fired once per activity
//! burst) stole the foreground from the app the agent was driving — the
//! frontmost-mismatch / focus-churn hazard the R68-0 gap list flagged —
//! and even a plain click on the bar would have activated it. Both are
//! gone: a re-open re-asserts the window's settings and returns WITHOUT
//! focusing, and `WS_EX_NOACTIVATE` (`never_activate` below) keeps even a
//! click on the STOP pill from moving the foreground off the driven app.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The mini monitor window's label (unique per app, re-used so a re-open
/// re-arms the existing window instead of stacking a second one — the
/// browser.rs BROWSER_WINDOW_LABEL pattern; since ROUND-69 a re-open
/// re-asserts settings WITHOUT focusing it).
const MINI_WINDOW_LABEL: &str = "acute-computer-mini";

/// The main app window's label (tauri.conf.json default) — its CURRENT
/// monitor is where the owner is looking, so the mini window parks on that
/// monitor's work area (falling back to the primary monitor).
const MAIN_WINDOW_LABEL: &str = "main";

/// The fixed logical size — the page's layout is designed for exactly this
/// (ROUND-66, the owner's directive: "way too tall… make it less tall and
/// make it centered at the top not on the top right"). ONE compact row —
/// dot + label + elapsed + one inline activity line + the STOP pill; NO
/// scroll, NO stats grid, NO event list, NO second row: the owner's
/// "very minimal, clean" verdict, tightened again.
const MINI_DEFAULT_W: f64 = 460.0;
const MINI_DEFAULT_H: f64 = 56.0;

/// Logical-px inset from the work area's top edge (the floating bar must
/// never touch the screen edge).
const MINI_MARGIN: f64 = 10.0;

/// Honest guess when no monitor can be identified: top-CENTER of a
/// conservative 1280×720 work area ((1280 − 460) / 2 = 410).
const MINI_FALLBACK_X: f64 = 410.0;

/// The TOP-CENTER anchor within a monitor's work area, in LOGICAL px (the
/// caller divides the physical work area by the monitor's scale factor).
/// Pure math so it is unit-testable without a monitor — the browser.rs
/// clamp_popout_size discipline. ROUND-66: the bar centers horizontally
/// (the owner's directive — it was top-right in R64) and clamps to ≥ margin
/// so a lying tiny work area can never push it off-screen.
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
    let x = ((work_w - MINI_DEFAULT_W) / 2.0).max(MINI_MARGIN);
    (x, MINI_MARGIN)
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

// ── ROUND-68 (R68-B): capture exclusion — the overlay the agent can't see ──

/// `WDA_EXCLUDEFROMCAPTURE` — the display-affinity value (0x11, Windows 10
/// 2004+) that keeps a window fully rendered on the physical display while
/// making it invisible to every screen-capture API. Deliberately UNGATED
/// (not `#[cfg(windows)]`) so the constant-pinning test below runs on every
/// platform that runs `cargo test`; on non-Windows builds the only would-be
/// consumer (the FFI call site) is cfg-stripped, and the `cfg_attr` keeps
/// those compiles warning-clean instead of dead-code-flagging the constant.
#[cfg_attr(not(windows), allow(dead_code))]
const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;

/// `GWL_EXSTYLE` — the `Get/SetWindowLongPtrW` index of a window's EXTENDED
/// style bits (winuser.h; the index parameters of that pair are signed
/// `int` in the ABI, and EXSTYLE lives at −20). Ungated for the same reason
/// as the affinity constant above: the pin test below runs on every
/// platform that runs `cargo test`.
#[cfg_attr(not(windows), allow(dead_code))]
const GWL_EXSTYLE: i32 = -20;

/// `WS_EX_NOACTIVATE` — the extended-style bit (0x0800_0000, winuser.h) that
/// makes a top-level window refuse activation: clicking it never makes it
/// the foreground window, and the system never raises it when other
/// windows close. Ungated like the constants around it so its pin test runs
/// everywhere too.
#[cfg_attr(not(windows), allow(dead_code))]
const WS_EX_NOACTIVATE: isize = 0x0800_0000;

// `SetWindowDisplayAffinity` — raw FFI, ABI-faithful to winuser.h's
// `BOOL SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity)`: HWND is
// pointer-sized (`isize`), DWORD is `u32`, BOOL is `i32`, calling
// convention `"system"` (stdcall on i686, C on x86_64). Exported by
// user32.dll (present since Windows 7 — the WDA_EXCLUDEFROMCAPTURE VALUE is
// what is 2004+).
//
// WHY RAW FFI and not windows-sys: the project's windows-sys dependency
// (R55) carries only the `Win32_Foundation` + `Win32_Security_Credentials`
// feature gates (CredReadW/CredWriteW), while this function lives behind
// `Win32_UI_WindowsAndMessaging`; the `windows` crate (0.61) in the lock
// file is TRANSITIVE (tauri's), not ours to import. One two-argument call
// does not justify either dependency-graph change — declare it by hand.
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetWindowDisplayAffinity(hwnd: isize, dw_affinity: u32) -> i32;

    // ROUND-69 (R69-B) — the extended-style read-modify-write pair, the
    // same raw-FFI discipline as the affinity call above (why not
    // windows-sys: identical reasoning — the vendored gates don't carry
    // `Win32_UI_WindowsAndMessaging` for these either). ABI-faithful to
    // winuser.h's `LONG_PTR GetWindowLongPtrW(HWND hWnd, int nIndex)` and
    // `LONG_PTR SetWindowLongPtrW(HWND hWnd, int nIndex, LONG_PTR
    // dwNewLong)`: LONG_PTR is pointer-sized (`isize`), the index is `i32`,
    // and the returned LONG_PTR is the PREVIOUS value (0 on failure —
    // deliberately discarded at the call site, best-effort by design).
    // Real user32 exports on x86_64 — the project's only Windows target
    // (the owner's machine, the windows-latest CI runner); on 32-bit they
    // degrade to the Get/SetWindowLongW macros, which we do not ship.
    fn GetWindowLongPtrW(hwnd: isize, nindex: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, nindex: i32, dwnewlong: isize) -> isize;
}

/// ROUND-68 (R68-B) — mark the mini monitor window `WDA_EXCLUDEFROMCAPTURE`,
/// the R64-b/R66 bar's missing second half. Windows-only.
///
/// THE OWNER'S DIRECTIVE (verbatim): "the 'agent is using your computer'
/// should not be shown because in the screenshot 'agent is using your
/// computer' was being shown and it was being captured and such. This is
/// something which needs to be handled properly. It will be an overlay kind
/// of thing. It will not be detected by our agent and it will also not be
/// shown in the screenshots which it takes and such."
///
/// The bar did the FIRST half of the monitor's job — always on top, STOP one
/// click away — while sabotaging the agent underneath it: every full-display
/// GDI capture (the agent-core captureDisplay path, CopyFromScreen of the
/// whole desktop) had the 460×56 bar burned into its top-center, occluding
/// the very UI the agent was driving AND handing the vision model the
/// indicator text to "detect" (the R68-0 root-cause list's "OVERLAY
/// CAPTURED" line — the agent literally read its own overlay).
///
/// `WDA_EXCLUDEFROMCAPTURE` (Windows 10 2004+) kills both problems at the OS
/// level in one call: the window remains FULLY visible to the owner on the
/// physical display but is excluded from EVERY capture API layered over the
/// desktop — GDI CopyFromScreen/BitBlt (ours), Windows.Graphics.Capture,
/// PrintWindow, OBS, screen share. Captures show what is BEHIND the bar;
/// vision never "detects" the indicator. (Honest corollary of the semantics:
/// the OWNER's own recordings/screen-shares of a session won't show the bar
/// either — the exclusion is global, not agent-specific. That is exactly the
/// "overlay kind of thing" the owner asked for.)
///
/// HONEST failure mode — best-effort, NEVER fatal: on hosts older than
/// Windows 10 2004 the affinity value is invalid and the BOOL returns 0 —
/// the monitor still opens, still floats, still stops sessions; it just ALSO
/// appears in captures there, exactly as it did before this round. Same for
/// a `hwnd()` that can't resolve (a webview still mid-creation). mini.rs has
/// no log channel, so the failure is silent BY DESIGN; the re-open path's
/// re-application is the self-heal. The command never errors, never panics.
///
/// WHY RE-APPLICATION ON RE-OPEN IS SAFE (and wanted): display affinity is
/// per-window state and the call is idempotent (same value → same state) at
/// the cost of one user32 syscall, so `open_computer_mini` asserts it on
/// EVERY burst — if a Windows update, a WebView2 child-window recreation, or
/// anything else ever drops the affinity on a LIVE monitor window, the next
/// burst re-arms it. Cheap insurance against a regression nobody would
/// otherwise notice until the owner's next screenshot.
///
/// Windows-only (`#[cfg]`): the macOS/Linux computer backends are separate
/// agent-core concerns with no capture-exclusion need in this app — on
/// those hosts the function and its two call sites simply do not exist.
///
/// Threading: `WebviewWindow::hwnd()` round-trips the event loop for the raw
/// handle — safe from this async command's tokio worker thread (the
/// `mini_initial_position` / `current_monitor` discipline: the deadlock only
/// exists when the MAIN thread is the one waiting). The affinity call itself
/// is a plain user32 leaf call, no re-entrancy.
#[cfg(windows)]
fn exclude_from_capture(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Ok(hwnd) = window.hwnd() {
            // SAFETY: `hwnd` is tauri's own raw handle for a live window
            // (HWND whose `.0` is pointer-sized, cast to `isize` per the
            // extern's ABI-faithful signature); the affinity is a plain
            // `u32`. SetWindowDisplayAffinity is a leaf user32 call — no
            // callbacks, no re-entrancy — and the returned BOOL is
            // deliberately discarded: pre-2004 hosts treat 0x11 as invalid
            // and fail the call, which is non-fatal by design (see the
            // honesty note above — the monitor still works there).
            let _ =
                unsafe { SetWindowDisplayAffinity(hwnd.0 as isize, WDA_EXCLUDEFROMCAPTURE) };
        }
    }
}

/// ROUND-69 (R69-B) — OR `WS_EX_NOACTIVATE` into the mini monitor's extended
/// window style: the last of the monitor's focus holes. Windows-only.
///
/// WHY: the monitor is a session READ plus one STOP pill — it must never own
/// the foreground while the agent drives another app. R68 already made the
/// window APPEAR without stealing focus (`focused(false)` at build) and
/// invisible to capture (`exclude_from_capture`), but two holes remained:
///   1. the re-open path called `set_focus()` once per activity BURST —
///      yanking the foreground off the app the agent is mid-action on is
///      exactly the `frontmost_pid_mismatch` / focus-churn failure class
///      (the R68-0 gap list's #6). That call is now DELETED — see
///      `open_computer_mini`.
///   2. even with it gone, an ordinary mouse click on the bar (the drag
///      region, the STOP pill) would ACTIVATE the window and take keyboard
///      focus away from the driven app.
/// `WS_EX_NOACTIVATE` closes hole 2 at the OS level — the Windows
/// magnifier / touch-keyboard pattern: the window stays topmost and still
/// receives every mouse click (STOP still stops, the drag region still
/// moves the bar — mouse input delivery is independent of activation), but
/// it never becomes the foreground window and never takes keyboard focus,
/// not even when clicked — so the foreground PID the agent-core input gate
/// keys on stays the app being driven.
///
/// NOT `WS_EX_TRANSPARENT` (click-through) — deliberately, and worth
/// pinning why: the frontend is NOT display-only. `src/mini/MiniApp.tsx`
/// exists for the interactive STOP kill switch (`mini-stop-button`, the
/// danger pill) plus the `data-tauri-drag-region` row that lets the owner
/// move the bar; a click-through overlay would neuter both and leave the
/// owner with no way to stop the agent FROM the monitor — the R64
/// directive that created it. NOACTIVATE only.
///
/// Read-modify-write, idempotent, re-asserted on every re-open for the same
/// reason as the affinity (cheap self-heal if a Windows update or a WebView2
/// child-window recreation ever drops the bit). HONEST failure modes, all
/// best-effort and NEVER fatal: an unresolvable `hwnd()` skips everything;
/// a `GetWindowLongPtrW` that returns 0 skips the write (this window is
/// ALWAYS on top, so an honest ex-style always carries WS_EX_TOPMOST 0x8 —
/// literal 0 can only be a failed read, and writing `0 | WS_EX_NOACTIVATE`
/// would wipe TOPMOST and sink the bar out of the top of the z-order);
/// a failing `SetWindowLongPtrW` leaves the style as it was. The
/// previous-value return is discarded; nothing here can error or panic.
///
/// Windows-only (`#[cfg]`) + threading: same shape as
/// `exclude_from_capture` — the `hwnd()` round-trip is the event-loop
/// discipline (safe from this async command's tokio worker thread; the
/// deadlock only exists when the MAIN thread is the one waiting), and both
/// style calls are plain user32 leaf calls — no callbacks, no re-entrancy.
#[cfg(windows)]
fn never_activate(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Ok(hwnd) = window.hwnd() {
            // SAFETY: `hwnd` is tauri's own raw handle for a live window
            // (HWND whose `.0` is pointer-sized, cast to `isize` per the
            // extern's ABI-faithful signature); `GWL_EXSTYLE` is a plain
            // `i32` index and the style a pointer-sized LONG_PTR. Both calls
            // are leaf user32 calls — no callbacks, no re-entrancy. The
            // read's 0-on-failure result is guarded BEFORE the write (see
            // the honesty note above), and SetWindowLongPtrW's previous-value
            // return is deliberately discarded (failure is non-fatal by
            // design — the monitor still works, it just stays activatable).
            unsafe {
                let style = GetWindowLongPtrW(hwnd.0 as isize, GWL_EXSTYLE);
                if style != 0 {
                    let _ =
                        SetWindowLongPtrW(hwnd.0 as isize, GWL_EXSTYLE, style | WS_EX_NOACTIVATE);
                }
            }
        }
    }
}

/// `open_computer_mini()` — open (or, on a re-open, re-arm) the always-on-top
/// floating monitor window — WITHOUT ever taking focus (ROUND-69). Called by
/// the main app the moment live computer-use activity starts (the monitor
/// store's `liveActivity` edge), so the owner can hit STOP while the agent
/// drives other applications.
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
    // Existing window: the burst re-open path — the main app invokes this
    // once per activity burst; a second burst while the window is still up
    // must not stack a duplicate. The lifecycle is build-or-CLOSE (grep:
    // nothing ever hides this window — the page self-closes via
    // close_computer_mini and the main app backstops it), so an existing
    // window is a VISIBLE one and there is nothing to show.
    //
    // ROUND-69 (R69-B): the old `existing.set_focus()` here is DELETED. It
    // fired once per burst while the agent was mid-action on some OTHER
    // app — stealing the foreground from it is precisely the
    // frontmost_pid_mismatch / focus-churn failure class (the R68-0 gap
    // list's #6), and tao 0.35.3's set_focus goes further: its
    // force_window_active fallback SYNTHESIZES an ALT-key SendInput pair to
    // grab foreground permission — stray keyboard input injected while the
    // agent is driving is exactly the corruption the R68-C input stack was
    // rebuilt to prevent. The monitor is a display + STOP pill, not an app;
    // it has nothing worth focusing, and with WS_EX_NOACTIVATE (re-asserted
    // below) it would not hold the foreground usefully anyway. No
    // replacement call: `show()` would be a no-op on the always-visible
    // window, and tao's post-creation show rides SW_SHOW — an ACTIVATING
    // show — so it would reintroduce the steal this round exists to remove.
    if app.get_webview_window(MINI_WINDOW_LABEL).is_some() {
        // ROUND-68 (R68-B): re-assert capture-exclusion — idempotent, one
        // syscall, self-heals an affinity that a Windows update or WebView2
        // recreation could have dropped on the live monitor (see
        // `exclude_from_capture`).
        #[cfg(windows)]
        exclude_from_capture(&app, MINI_WINDOW_LABEL);
        // ROUND-69 (R69-B): and the same for the no-activate extended style
        // (see `never_activate`) — the pair of re-asserts is the burst
        // self-heal.
        #[cfg(windows)]
        never_activate(&app, MINI_WINDOW_LABEL);
        return Ok(());
    }

    // Top-center of the monitor the owner is looking at (logical px).
    let (x, y) = mini_initial_position(&app);

    WebviewWindowBuilder::new(&app, MINI_WINDOW_LABEL, WebviewUrl::App("mini.html".into()))
        .title("Acute Monitor")
        .inner_size(MINI_DEFAULT_W, MINI_DEFAULT_H)
        // Frameless: the page IS the chrome (its own drag region). The
        // native title bar was the owner's R59 verdict on the pop-out and
        // a 56px monitor has no room for one anyway.
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
        // agent starts moving the mouse (ROUND-69: and `never_activate`
        // below keeps a later CLICK on the bar from stealing focus too).
        .focused(false)
        .position(x, y)
        .build()
        .map_err(|e| format!("WebviewWindowBuilder.build failed: {e}"))?;

    // ROUND-68 (R68-B): the fresh monitor is fully registered by build(),
    // so the by-label lookup inside the helper finds it — exclude it from
    // capture immediately, before the agent's very next screenshot can
    // frame the bar. Pre-2004 hosts: the call fails silently, documented
    // (the monitor still opens — non-fatal by design).
    #[cfg(windows)]
    exclude_from_capture(&app, MINI_WINDOW_LABEL);

    // ROUND-69 (R69-B): same moment, same reasoning for the no-activate
    // extended style — the window is fully registered by build(), so the
    // helper's by-label lookup finds it, and the bar can no longer take
    // focus before the owner has even seen it. `focused(false)` kept the
    // APPEARANCE quiet; this keeps every later CLICK quiet too.
    #[cfg(windows)]
    never_activate(&app, MINI_WINDOW_LABEL);

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
    // (MINI_DEFAULT_H is deliberately NOT imported: no test below reads it —
    // the R64 import list carried it unused, which `cargo check --tests`
    // flags; ROUND-69 trimmed it while touching this list.)
    use super::{
        mini_position_for_work_area, GWL_EXSTYLE, MINI_DEFAULT_W, MINI_MARGIN,
        WDA_EXCLUDEFROMCAPTURE, WS_EX_NOACTIVATE,
    };

    /// A normal desktop work area anchors the bar at its TOP-CENTER,
    /// MINI_MARGIN in from the top edge (ROUND-66: the owner's directive —
    /// it anchored top-right in R64).
    #[test]
    fn mini_position_anchors_top_center_of_a_normal_work_area() {
        let (x, y) = mini_position_for_work_area(1920.0, 1040.0);
        assert_eq!((x, y), ((1920.0 - MINI_DEFAULT_W) / 2.0, MINI_MARGIN));
    }

    /// A small-but-real laptop work area still anchors top-center (the
    /// window fits with margins on both axes).
    #[test]
    fn mini_position_small_work_area_still_top_center() {
        let (x, y) = mini_position_for_work_area(1280.0, 660.0);
        assert_eq!((x, y), ((1280.0 - MINI_DEFAULT_W) / 2.0, MINI_MARGIN));
    }

    /// ROUND-68 (R68-B): the affinity is a magic number handed to raw FFI —
    /// pin it so a silent typo can never change the monitor's capture
    /// behavior (0x11 = WDA_EXCLUDEFROMCAPTURE, winuser.h; its dangerous
    /// neighbor 0x1 = WDA_MONITOR would paint the bar BLACK into captures
    /// instead of showing what's behind it — and 0x0 is no exclusion at
    /// all). Runs on every platform (the const is deliberately ungated);
    /// cargo test is the only consumer on non-Windows builds.
    #[test]
    fn wda_exclude_from_capture_constant_is_pinned() {
        assert_eq!(WDA_EXCLUDEFROMCAPTURE, 0x11);
    }

    /// ROUND-69 (R69-B): the no-activate style parameters are more magic
    /// numbers handed to raw FFI — pin them. GWL_EXSTYLE must stay −20 (a
    /// wrong index reads/writes some OTHER window datum, or fails);
    /// WS_EX_NOACTIVATE must stay 0x0800_0000 (winuser.h; its neighbor
    /// 0x0008 is WS_EX_TOPMOST — the always-on-top bit the helper's
    /// read-modify-write exists to PRESERVE, which is exactly why a silent
    /// value typo here could sink the bar out of the top of the z-order).
    /// Runs on every platform (the consts are deliberately ungated);
    /// cargo test is the only consumer on non-Windows builds.
    #[test]
    fn no_activate_style_constants_are_pinned() {
        assert_eq!(GWL_EXSTYLE, -20);
        assert_eq!(WS_EX_NOACTIVATE, 0x0800_0000);
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
