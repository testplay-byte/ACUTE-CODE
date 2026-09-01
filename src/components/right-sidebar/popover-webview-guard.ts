/**
 * R60-D — the popover-over-webview suppression guard.
 *
 * The RightSidebar's QuickMenu / SubAgentPicker popovers are portaled to
 * document.body with position:fixed — in WEB mode that is enough to render
 * above the panel. In TAURI mode the browser panel's page renderer is a
 * NATIVE CHILD WEBVIEW: an OS-level layer that floats above ALL app HTML,
 * so while a popover is open the active browser tab's webview must be
 * HIDDEN (`browser_tab_set_visible` false — the same background-tab
 * mechanism the panel itself uses; the session stays alive).
 *
 * The sidebar's effect dispatches that hide, but a webview CREATED while
 * the popover is already open (an agent-driven `openBrowser` landing while
 * the owner browses the quick menu, or a keyboard tab switch — paths that
 * never fire the popover's outside-mousedown close) resolves its
 * `nativeCreate` promise AFTER the hide invoke already landed as a Rust
 * no-op (not-found = Ok), and its `.then` would then SHOW itself over the
 * popover. This module is the shared truth both sides consult at the last
 * moment: the panel's `nativeCreate` refuses to show while its tab is
 * suppressed; the sidebar clears the suppression exactly when it restores
 * visibility (and on unmount, so no webview can stay hidden forever).
 *
 * Plain module state — no store, no persistence: a transient UI overlay
 * must never survive a reload. Import-only (nothing here touches the
 * native-browser bridge itself).
 */

/** The tab id whose webview is currently hidden under an open popover. */
let suppressedTabId: string | null = null;

/**
 * Record which tab's webview must stay hidden (an open popover covers it),
 * or null when no popover is suppressing anything.
 */
export function setPopoverWebviewSuppression(tabId: string | null): void {
  suppressedTabId = tabId;
}

/** Whether `tabId`'s webview must stay hidden right now. */
export function isPopoverWebviewSuppressed(tabId: string): boolean {
  return suppressedTabId === tabId;
}
