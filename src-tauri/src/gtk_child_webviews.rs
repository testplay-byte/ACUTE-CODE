//! ROUND-105 (R105-A): the Linux child-webview GEOMETRY layer — the fix for
//! the owner's v0.101.0 Linux field report ("the whole application was split
//! into two parts: the top part showed me the application itself and the
//! bottom part showed me the preview of the web page").
//!
//! THE ROOT CAUSE (verified at every layer of the stack):
//!
//! * `tauri-runtime-wry` routes `Window::add_child` on Linux to
//!   `window.default_vbox()` + `builder.build_gtk(vbox)` — every child
//!   webview is `pack_start`-ed into tao's VERTICAL `GtkBox`, BELOW the
//!   main app webview. A vertical box STACKS its children: the window
//!   literally renders as [app | browser] halves. That is exactly the
//!   owner's "split into two parts" screenshot-in-words.
//! * wry's `set_bounds` (`set_position`/`set_size` land there) only moves a
//!   webview when it was built into a `GtkFixed` (`is_in_fixed_parent`);
//!   for box-packed webviews every geometry command is a silent NO-OP. The
//!   BrowserPanel's bounds syncs were firing all along and doing nothing.
//! * The wry docs themselves prescribe the shape for positionable Linux
//!   child webviews: a `gtk::Fixed` container (their example builds the
//!   webview with `build_gtk(&fixed)`).
//!
//! THE FIX — a one-time, idempotent widget-tree surgery per window that
//! hosts browser tabs (the main window + the pop-out), performed on the
//! GTK main thread via `Webview::with_webview`:
//!
//! ```text
//! tao's default GtkBox (vbox)                ← untouched, still the window's child
//! └── gtk::Overlay (pack_start expand/fill)  ← NEW — gets the full client area
//!     ├── the window's chrome webview        ← the Overlay's BASE child —
//!     │                                        still gets the full allocation
//!     │                                        (Overlay bases fill it), so the
//!     │                                        app renders exactly as before
//!     └── gtk::Fixed (halign/valign Fill,    ← NEW — the TAB LAYER: full-size,
//!         pass-through input)                  ABOVE the app, transparent to
//!                                              clicks outside the tab webviews
//!         ├── tab webview 1  (put/move_ + size_request — GtkFixed positions)
//!         └── tab webview 2  …
//! ```
//!
//! Every property of that tree is source-verified against GTK 3.24:
//!
//! * `gtk_overlay_get_child_position` with `GTK_ALIGN_FILL` allocates the
//!   overlay child the Overlay's FULL size (width/height legs both take the
//!   `MAX(alloc, main_alloc)` branch), so the Fixed covers the window.
//! * `gtk_fixed_size_allocate` re-allocates each VISIBLE child at its
//!   recorded `move_()` position with its REQUISITION — `set_size_request`
//!   pins that requisition — so `move_` + `set_size_request` is DURABLE
//!   across window resizes (exactly the pair wry itself uses for fixed
//!   children), and a direct `size_allocate` gives the IMMEDIATE effect
//!   for live repositioning.
//! * Overlay children get their own input window
//!   (`gtk_overlay_create_child_window`); `pass-through` (implemented via
//!   `gdk_window_set_pass_through`) makes that window transparent to
//!   pointer events — clicks outside a tab webview fall through to the app
//!   UI underneath, while the tab webviews' own (higher-stacked) windows
//!   keep receiving theirs.
//! * `gtk_overlay_forall` visits the base child AND every overlay child,
//!   so the structural `find_browser_fixed` walk (children() DFS) sees the
//!   Fixed.
//!
//! The layer is STATELESS: no registry, no window-label bookkeeping — the
//! widget tree IS the state. A destroyed pop-out takes its overlay with it;
//! the next `browser_tab_create` in a fresh window re-runs the (idempotent)
//! surgery. A webview that somehow stays in the vbox (a missed adoption) is
//! SELF-HEALING: the first `position_tab` call pulls it into the Fixed at
//! the commanded bounds.
//!
//! All functions here dispatch their GTK work through `Webview::with_webview`
//! — Tauri runs that closure on the event-loop thread, which on Linux IS the
//! GTK main thread (the only thread allowed to touch the widget tree). The
//! commands that call into this module run on Tauri's command threads, so
//! the dispatch can never deadlock against itself.

use gtk::{prelude::*, Allocation, Align, Box as GtkBox, Fixed, Overlay, Widget};
use tauri::{Webview, Window};

use crate::browser::TAB_LABEL_PREFIX;

/// Finds THIS window's browser Fixed: the `gtk::Fixed` whose parent is the
/// `gtk::Overlay` this layer installed (`ensure_fixed_overlay`). Structural
/// and stateless — walks from any widget up to the toplevel, then DFS for
/// the one Fixed-in-Overlay pair our surgery created. The app owns its whole
/// widget tree (tao + tauri + us), so the pair is unique per window.
fn find_browser_fixed(from: &Widget) -> Option<Fixed> {
    fn visit(w: &Widget) -> Option<Fixed> {
        if let Some(f) = w.downcast_ref::<Fixed>() {
            let parent_is_overlay = f.parent().map(|p| p.is::<Overlay>()).unwrap_or(false);
            if parent_is_overlay {
                return Some(f.clone());
            }
        }
        // gtk_container_get_children on a GtkOverlay returns the base child
        // AND the overlay children (gtk_overlay_forall visits both), so the
        // DFS reaches the Fixed from any ancestor.
        if let Some(container) = w.downcast_ref::<gtk::Container>() {
            for child in container.children() {
                if let Some(f) = visit(&child) {
                    return Some(f);
                }
            }
        }
        None
    }
    from.toplevel().as_ref().and_then(visit)
}

/// Installs the Overlay+Fixed structure into ONE window (idempotent — a
/// no-op when the chrome's parent is already the Overlay). Called from
/// `browser_tab_create` BEFORE `add_child` on Linux, for whichever window
/// will host the tab (main window or the pop-out).
///
/// The surgery picks the window's CHROME webview — the first webview that
/// is not itself a browser tab — and restructures around it while the tree
/// is otherwise quiet. The chrome stays VISIBLE throughout (remove + add in
/// the same main-loop callback — GTK paints nothing in between), and as the
/// Overlay's base child it still receives the full client-area allocation,
/// so the app's rendering is pixel-identical to before.
pub fn ensure_fixed_overlay(window: &Window) {
    let webviews = window.webviews();
    // The chrome: not a tab webview (the main window's "main" webview; the
    // pop-out's content page — which, by label, IS `acute-tab-popout` and
    // therefore falls through to the first-created fallback, which is it).
    let chrome = webviews
        .iter()
        .find(|wv| !wv.label().starts_with(TAB_LABEL_PREFIX))
        .or_else(|| webviews.first());
    let Some(chrome) = chrome else {
        // No webview in this window yet — nothing to restructure. The tab
        // webview will land in the vbox (the pre-R105 behavior) rather than
        // risking surgery on an unknown tree.
        return;
    };
    let _ = chrome.with_webview(|wv| {
        let chrome_widget = wv.inner().upcast::<Widget>();
        install_overlay_around(&chrome_widget);
    });
}

/// The surgery itself — runs ON the GTK main thread (inside with_webview).
/// See the module docs for the target tree shape.
fn install_overlay_around(chrome: &Widget) {
    let Some(parent) = chrome.parent() else {
        // Detached chrome — nothing sensible to do.
        return;
    };
    if parent.is::<Overlay>() {
        // Already installed (idempotent re-run: a second tab in this window).
        return;
    }
    let Ok(vbox) = parent.downcast::<GtkBox>() else {
        // Unexpected container (not tao's default GtkBox) — leave the tree
        // alone; tabs degrade to the pre-R105 stacked behavior instead of a
        // broken window.
        return;
    };

    let overlay = Overlay::new();
    let fixed = Fixed::new();
    // FILL/FILL: gtk_overlay_get_child_position takes the MAX(alloc,
    // main_alloc) branch for Fill, so the Fixed gets the Overlay's full
    // client area — tab bounds anywhere in the window are reachable.
    fixed.set_halign(Align::Fill);
    fixed.set_valign(Align::Fill);
    // Overlay children get their own INPUT window; pass-through makes it
    // transparent to pointer events so the app UI underneath stays fully
    // clickable. The tab webviews' own gdk windows stack ABOVE that input
    // window and keep receiving their events.
    overlay.set_overlay_pass_through(&fixed, true);
    overlay.add_overlay(&fixed);

    // Reparent the LIVE chrome webview: remove from the vbox → Overlay's
    // base child → Overlay into the vbox at the chrome's old slot. All
    // within one main-loop callback — no intermediate paint, no flicker.
    vbox.remove(chrome);
    overlay.add(chrome);
    vbox.pack_start(&overlay, true, true, 0);
    // Shows the Overlay (and re-asserts the chrome + the empty Fixed — both
    // no-ops on already-visible widgets).
    overlay.show_all();
}

/// Moves a freshly-created tab webview OUT of tao's vbox INTO the window's
/// browser Fixed, at its 1×1 birth position. Called right after
/// `Window::add_child` while the webview is still HIDDEN — a hidden widget
/// takes no vbox space and paints nothing, so the vbox-split the packing
/// would cause is never VISIBLE for even one frame.
///
/// If the window has no Fixed yet (surgery never ran / failed), this is a
/// quiet no-op and the tab keeps the pre-R105 behavior — position_tab's
/// self-healing adoption catches it on the first bounds sync afterwards.
pub fn adopt_tab_webview(webview: &Webview) {
    let _ = webview.with_webview(|wv| {
        let widget = wv.inner().upcast::<Widget>();
        let Some(fixed) = find_browser_fixed(&widget) else {
            return;
        };
        // Bind the parent Option first — the downcast_ref borrow must
        // outlive the is_some_and comparison (an inline and_then would
        // return a reference to its own parameter: E0515).
        let parent = widget.parent();
        let in_fixed = parent
            .as_ref()
            .and_then(|p| p.downcast_ref::<Fixed>())
            .is_some_and(|f| f == &fixed);
        if in_fixed {
            fixed.move_(&widget, 0, 0);
        } else {
            if let Some(p) = parent {
                if let Ok(vbox) = p.downcast::<GtkBox>() {
                    vbox.remove(&widget);
                }
            }
            fixed.put(&widget, 0, 0);
        }
        // The birth requisition — GtkFixed re-allocates children at their
        // recorded position with this size on every layout pass.
        widget.set_size_request(1, 1);
    });
}

/// Positions a tab webview over the panel's page area — the Linux leg of
/// `browser_tab_set_bounds` (Tauri's `set_position`/`set_size` are silent
/// no-ops for box-packed webviews: wry honors geometry only for GtkFixed
/// children, and its `is_in_fixed_parent` flag is captured at BUILD time —
/// so even our reparented webviews must be moved through GTK directly).
///
/// Coordinates are LOGICAL px — the same space the frontend measures
/// (getBoundingClientRect CSS px) and the same space wry's own fixed path
/// feeds to `size_allocate`. Self-adopting: a webview still sitting in the
/// vbox (an adoption miss, a re-created tab) is pulled into the Fixed AT
/// these bounds — the geometry command IS the recovery path.
pub fn position_tab(webview: &Webview, x: f64, y: f64, w: f64, h: f64) {
    // The same ≥1 floor browser_tab_set_bounds applies — a zero-sized
    // measurement must never produce a degenerate webview.
    let (x, y, w, h) = (
        x.round() as i32,
        y.round() as i32,
        w.max(1.0).round() as i32,
        h.max(1.0).round() as i32,
    );
    let _ = webview.with_webview(move |wv| {
        let widget = wv.inner().upcast::<Widget>();
        let Some(fixed) = find_browser_fixed(&widget) else {
            return;
        };
        // Bind the parent Option first — the downcast_ref borrow must
        // outlive the is_some_and comparison (an inline and_then would
        // return a reference to its own parameter: E0515).
        let parent = widget.parent();
        let in_fixed = parent
            .as_ref()
            .and_then(|p| p.downcast_ref::<Fixed>())
            .is_some_and(|f| f == &fixed);
        if in_fixed {
            fixed.move_(&widget, x, y);
        } else {
            if let Some(p) = parent {
                if let Ok(vbox) = p.downcast::<GtkBox>() {
                    vbox.remove(&widget);
                }
            }
            fixed.put(&widget, x, y);
        }
        // DURABLE size: GtkFixed re-allocates each visible child at its
        // recorded position with its REQUISITION — set_size_request pins
        // that requisition so window resizes keep the commanded geometry.
        widget.set_size_request(w, h);
        // IMMEDIATE effect for live repositioning (wry's own set_bounds
        // path for fixed children does exactly this). Hidden webviews rely
        // on the durable pair above — their first show lays them out at the
        // recorded position/size in the next layout pass.
        if widget.is_visible() {
            widget.size_allocate(&Allocation::new(x, y, w, h));
        }
    });
}
