<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 60 — The thirteenth owner session: pop-out view rounding + gutter scrollbar, settings deep-clean, the title-bar sidebar toggle, and the browser-panel fixes

**Date:** 2026-09-01 · **Branch:** `main` · **Version:** 0.60.0 · **Owner directives:** the thirteenth Windows test session (0.59.0) — the rounded window was confirmed PERFECT (*"It looks way too good, even better than what I imagined it to be or hoped for it to be… I think you can keep it as a part of our design language"*) and the pop-out browser *"fully satisfied… the same clean beautiful UI which I wanted"* — followed by the polish list: round the VIEW's corners, move the scrollbar OUTSIDE the content section (custom themed on every page), the API-key field consistency (same-slot show/hide, smooth copy, NO rotate — paste-to-replace), models EMPTY by default with the Free/All toggle in the Add-model picker, strip the settings padding, fix the scroll-reflow width-shrink, remove the sidebar logo + collapse button in favor of the TITLE-BAR identity toggle, and the right-browser-panel fixes (new-tab options hidden BEHIND the native webview, customization options not working, layout management).

## The round's shape

Six workstreams with strict file ownership (Task 0 shared-layer + four sub-agents + the integration wave):

| ID | Workstream | Files owned |
|---|---|---|
| Task 0 (orch) | Shared Rust + bridge layer: scrollbar init-script, scroll_state/scroll_to/set_zoom commands | src-tauri/src/{browser,lib}.rs, native-browser.ts, popout-tab.ts |
| R60-A | Pop-out view rounding + the GUTTER SCROLLBAR | src/popout/** (PopoutApp, GutterScrollbar, tests) |
| R60-B | Settings deep-clean: key field, models empty-default, padding, scroll gutter | settings/ModelsProvidersTab*, SettingsPage*, index.css |
| R60-C | Sidebar refactor: title-bar identity toggle | shell/{Sidebar,TitleBar,AppShell}* + project-chat-store |
| R60-D | Browser-panel fixes: popover z-index, real zoom, viewport bar | right-sidebar/{BrowserPanel,RightSidebar}* + popover-webview-guard |
| Integration (orch) | Rating polish, verify, docs, ship | AgentChatPanel*, round docs, version |

Suite: **1302 → 1348 tests in 91 files** (+46), lint/typecheck clean.

## Task 0 — the shared Rust + bridge layer (the scroll channel + real zoom)

The owner's scrollbar directive needed a way to READ a page's scroller state out of a native child webview — external pages carry no Tauri IPC bridge, and every "lightweight" channel (navigation hacks, fetch beacons) fails on some class of real sites. The answer shipped in tauri 2.11: **`Webview::eval_with_callback`** (verified in the docs before writing a line) — JavaScript evaluated INTO the page with the serialized result returned to Rust. Three new Rust commands (browser.rs, registered in lib.rs):

- **`browser_tab_scroll_state(tab_id)`** — evaluates a probe returning `{y, vh, ch, css}` (scroll offset, viewport height, content height, and whether our themed-scrollbar style actually APPLIED — a CSP-blocked `<style>` has `sheet === null`). Async with a 2s channel timeout: a wedged page must never hang the poller.
- **`browser_tab_scroll_to(tab_id, y)`** — `window.scrollTo(0, y)` (finite, ≥ 0, validated in Rust).
- **`browser_tab_set_zoom(tab_id, factor)`** — REAL DPI-level zoom via `Webview::set_zoom` (WebView2's zoomFactor), factor clamped 0.1–5.0. This retires the R50 "divide the viewport by zoom" approximation whose premise ("WebView2's zoomFactor is not exposed through Tauri's webview API") stopped being true in tauri 2.11.

And **`browser_tab_create`'s optional `hide_viewport_scrollbar`**: a document-start `initialization_script` (AddScriptToExecuteOnDocumentCreated — runs on EVERY new document before page scripts, so there is no visible reflow) that installs the themed-pill scrollbar CSS (the R59 floating-pill language in neutral gray — external pages carry no CSS variables) on every tab webview, PLUS the viewport-hide rules (`html{scrollbar-width:none!important}` + the webkit fallbacks) when the pop-out passes the flag. CSP honesty: a strict `style-src` page blocks the `<style>` — the element exists but `sheet` stays null, which is exactly what the scroll-state probe reports, so the pop-out's gutter scrollbar hides and the page's own viewport bar remains the ONE scrollbar. Best effort on every page, hard failure never, two scrollbars never.

## 1. The pop-out view rounding + the GUTTER SCROLLBAR (R60-A)

The owner: *"the thing which was not rounded off was the actual view. It should be a bit more rounded, actually like the actual web pages and such, on the corners"* and *"The scroll bar should be custom themed on every single page. It should not show inside the section but on the right side outside it."*

The content area is now a content ROW: **[the rounded CONTENT CARD] + [the 12px gutter column]**. The card applies the title-bar/URL-bar card language to the view itself — `rounded-[14px]`, hairline border, subtle background — with the webview placeholder inset 4px so the native square's corners stay inside the card's corner curve (the R59 m-1.5 honesty math, now with a real visible border). The webview is a native square that floats above all HTML; the visible card frame is what makes the corners READ rounded — the honest maximum for a native child webview.

The **GutterScrollbar** (src/popout/GutterScrollbar.tsx) is the window's OWN scrollbar living in the frame gutter, OUTSIDE the card:

- **Data**: polls `browser_tab_scroll_state` every 250ms (one probe in flight; while a drag is active the poll pauses — the drag owns the position optimistically until pointerup).
- **Geometry**: thumb = max(24px, track·vh/ch), top = (track−thumb)·y/maxScroll, measured from the column's rect via ResizeObserver + window-resize (the PopoutApp bounds-sync pattern).
- **Interaction**: pointer-captured thumb drag (rAF-throttled `browser_tab_scroll_to`), track click = page-jump then continue-drag with the thumb centered, full keyboard contract on the focusable `role="scrollbar"` track (Arrows ±40px, PageUp/Down ±vh, Home/End) with live `aria-value*`.
- **Visual**: the R59-A floating pill — a 4px painted pill in a 10px slot (3px transparent border, `background-clip: padding-box`), 22%→40% text color on hover/focus/drag, transparent track until gutter hover (6%).
- **Honesty**: hidden when the probe returns nothing (webview gone/timed out/invalid), when `css:false` (the CSP-strict page keeps its own bar — never two), when the page doesn't overflow, or before the track is measured; the COLUMN stays mounted always so the card never reflows when a page starts/stops scrolling; every `scroll_to` rejection is a console.warn, never a UI error — the chrome never crashes the window.

## 2. The settings deep-clean (R60-B)

**The API-key field** (the owner: *"the show and hide button should be in the exact same place. The copy button should appear smoothly and not in a bad way. There is actually no need to give the rotate key option at all — the user can directly paste in the new key"*):

ONE unified row `[value input][eye toggle][context action]`. The eye is a single button in the exact same slot in every state (Eye masked → spinner loading → EyeOff revealed — proven by DOM-node identity in the tests); the input selects-all on focus and any typed/pasted change swaps to edit mode (`keyDraft`) with **Save key** (accent) + **Cancel** (Escape restores) in the context slot; **Rotate is GONE** (state, button, testids — deleted). Copy fades/widths in (framer-motion `AnimatePresence`, 200ms) only while revealed — it belongs to the stored value, never a draft. Save keeps the existing PUT + status messages + invalidations.

**Models empty by default** (the owner: *"By default none of the models should be added there… only after that they will be shown"*): the list shows ONLY configured (stored) rows — the catalog→list merge is disabled (`mergeCatalogIntoModels(models, [], staticCatalog)`, the `includeCatalog` plumbing deleted). The empty state is one honest line; the count chip counts configured rows; the list-level Free/All segmented control is GONE (it moved into the picker).

**The Add-model picker toggle** (the owner: *"in the add model for the open router, there should be an option to switch between free only and all models properly"*): the "Free only ↔ All models" segmented control now lives in the AddModelsDialog next to the search input, riding the SHARED persisted `useSettingsStore.modelsFreeOnly` (the same pref the chat composer picker honors — the round-43 "one choice everywhere" design). Rows filter by `meta ? meta.free : isFreeModelEntry(...)` BEFORE the 300-row cap. Free-model customization: every listed row is a stored row → the pencil config dialog (pricing, context, max output, thinking, hidden) + FREE badge cover it — pinned by tests.

**The padding** (the owner: *"a lot of extra unnecessary padding on the right and left sides… minimize the padding as much as possible"*): header `px-4 md:px-6`, content `px-4 md:px-6 py-4`; the Models & Providers tab is `w-full` (no max-w, no mx-auto — measured live: 974px of a 1280px viewport, 12px from the edge); other tabs keep a readable `max-w-4xl`.

**The scroll-reflow fix** (the owner: *"when I scrolled… the whole section shrank a little bit in its width. As I stopped scrolling it increased in its width again"*): root cause — `.auto-scroll` toggled `scrollbar-width: none ↔ thin` when the useScrollFade `.scrolling` class arrived, so the scrollbar's layout space appeared/disappeared. Now `.auto-scroll` keeps `scrollbar-width: thin` + **`scrollbar-gutter: stable`** ALWAYS (thumb transparent until `.scrolling`, tinted 20% after): the gutter is reserved permanently, so the width can never shift. Verified live via `getComputedStyle`: `{thin, stable, transparent}`.

## 3. The title-bar sidebar toggle (R60-C)

The owner: *"I don't want you to show me the app's logo on the left side bar and I also don't want you to show me the collapse sidebar button at all either… I would need to click on the app's logo at the top left corner of the application… Also I can click that exact same one to show the sidebar again."*

- The sidebar's header logo + the collapse button + the entire 64px RAIL mode (COLLAPSE_KEY, collapsed state, all the collapsed-prop plumbing through nav sections) are DELETED — the sidebar is either fully visible (fixed 270px) or fully absent.
- The **TitleBar identity block (logo + app name) is now the toggle button**: click → hide the sidebar (main content takes the full width); click again → show (200ms framer fade/nudge). It carries `aria-pressed` + "Hide/Show sidebar" affordance and deliberately carries NO `data-tauri-drag-region` (a drag region swallows clicks — the same mechanism that makes the window buttons work); the surrounding header keeps the drag attribute.
- `appSidebarVisible` is now GLOBAL (visible on every route including chat routes — the round-15/32 chat-route auto-hide is gone; the owner's click is the one and only control). Web dev mode keeps the floating-logo fallback (there is no title bar to click in a browser); the mobile drawer is untouched (its trigger logo is the only mobile affordance).
- `AcuteLogo` renders a real `<button>` only when given `onClick` — decorative marks render a `<span>` (nesting legality inside the TitleBar's button).

## 4. The right-browser-panel fixes (R60-D)

**The new-tab popover z-index** (the owner: *"When I click the new tab option then the options get hidden behind the actual browser window itself"*): native child webviews are OS layers above ALL app HTML, so while the QuickMenu/SubAgentPicker popover is open AND the active right-sidebar tab is a browser tab, the sidebar hides that tab's webview (`browser_tab_set_visible false` — the existing background-tab mechanism, the session stays alive) and restores it on close (guarded: only when the sidebar is still open + that tab still active). **`popover-webview-guard.ts`** covers the RACE where a webview is CREATED while a popover is already open (its create-promise would re-show itself over the popover): the panel's create path refuses to show while its tab is suppressed; the sidebar clears the suppression exactly when it restores visibility + on unmount. Plain module state — a transient overlay never survives a reload.

**Real zoom** (the owner: *"The customization options apparently don't seem to be working at all"*): the viewport-divide approximation is deleted — `effectiveViewport = {width: viewW, height: viewH}` directly, and native mode drives `browser_tab_set_zoom` on zoom changes, on tab/webview activation, and after navigations. The zoom select actually zooms now (media queries and rem layout re-evaluate like a browser's Ctrl+± — which is what display-size testing needs). The proxy/iframe path keeps its transform-scale exactly.

**The viewport bar** (the owner: *"the layout could be handled better… cleaner, beautiful, and much more proper"*): the row is a `rounded-[12px]` bordered card with TWO visible groups — [size: preset | W×H | zoom] and [view: rotate | fit] — separated by a hairline divider, `flex-wrap` + `min-h-8` (a ~380px sidebar never clips/overflows), rounded-full selects, the honest readout at the row end. **Fit is honestly DISABLED in native mode** (bounds are already clamped to the panel; the title explains instead of a dead click) and fully functional in proxy mode. Bounds re-sync on viewport/natural changes fires immediately (effect deps include the effective viewport — no waiting on the 500ms safety interval).

## 5. The rating polish (integration wave)

The owner confirmed the loop works (*"marked 1 as good and also marked 1 as bad and it asked me for the reason and clicked save and it got saved properly… maybe we might need to look into the things a bit better"*): re-rating a SAVED bad reply now opens the note editor PRE-FILLED with the existing note (editing context, never losing it), a saved note renders a tiny **"noted" chip** on the cluster (hover shows the note; click reopens the editor pre-filled — the feedback loop is discoverable instead of hiding in the DB), and the editor's Escape/cancel semantics were re-verified.

## Verification

- **Root suite: 1348/1348 in 91 files** (was 1302/88; +48: popout +18, settings +10, shell +8, right-sidebar net +8, rating +2, SettingsPage +3, minus rewritten rotate tests). `pnpm lint` CLEAN · `pnpm typecheck` CLEAN · `pnpm docs:check` clean.
- **Live browser battery (agent-browser, :5173 + the live sidecar)**: the models list renders EMPTY by default with count 0 + the honest empty state; Add models → free-only default (every row `:free`), "All models" → 300 mixed rows; adding `z-ai/glm-5.2:free` → count 1 + FREE badge + pencil/delete (then deleted back to 0, leaving the DB as found); the API-key field: masked → Show → full key revealed in the SAME input node + Copy fading in + eye flips to Hide in the same node → Hide re-masks → pasting a draft swaps to Save/Cancel → Cancel restores the stored display with ZERO key PUTs (the real key never touched); `.auto-scroll` computed style `{thin, stable, transparent}` (the reflow fix, live); the settings main area 974px wide of a 1280px viewport (12px from the edge); the sidebar: no logo, no collapse button, fixed 270px, present on the dashboard AND the chat route, store flip → 0 asides + the floating logo appears → flip back → the panel returns; popout.html serves (200, web-mode notice); zero console errors through the whole battery.
- **Rust honesty**: no cargo toolchain in this sandbox — the browser.rs/lib.rs changes (init script, `eval_with_callback`, `set_zoom`, the new commands' registration) are doc-verified against tauri 2.11.5 (set_zoom + eval_with_callback both confirmed in the docs/release-notes) and CI's cargo check is the compile gate, same as every prior round that touched Rust without a local toolchain.

## Owner-visible summary (for the next session's verdict)

1. The pop-out's page view now sits in a rounded, bordered card matching the chrome.
2. The pop-out's scrollbar lives OUTSIDE the content card — a themed floating pill in the window's right gutter, fully draggable/clickable/keyboardable, on every page (with the honest one-scrollbar-only fallback on CSP-locked pages).
3. The API-key field: same-slot show/hide eye, smooth Copy, no Rotate — paste a new key and Save.
4. The models list starts EMPTY; Add models → the picker with the Free-only ↔ All-models toggle (default free, persisted); every added model (incl. free) opens the full config dialog.
5. Settings lost their side padding; the api tab fills the width.
6. Scrolling no longer shifts the providers list's width (stable scrollbar gutter).
7. The sidebar's logo + collapse button are GONE; the title-bar logo/name toggles the sidebar (hide/show) — the sidebar is present on every route including chat until hidden.
8. The browser panel: the new-tab options render ABOVE the preview (the webview yields to the popover), the zoom select actually zooms (real DPI zoom), the viewport bar is a clean two-group card, fit is honestly disabled in native mode.
9. Bad-rating notes are pre-filled on re-rate and surface as a "noted" chip.
