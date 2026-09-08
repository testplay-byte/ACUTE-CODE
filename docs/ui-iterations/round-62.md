<!-- last-reviewed: 2026-09-08 round-79 -->
# Round 62 — The owner's feedback round: settings + sidebar + layout polish, browser-truth fixes, and the agent-browser

**Date:** 2026-09-02 · **Branch:** `main` · **Version:** 0.62.0 · **Owner directives (verbatim):** the computer-use presence report ("the computer use was not there and also i did not get the dedicated section in the settings to enable or configure it and the agent was unable to use it"); "in the settings in the appearence make it simple easier and much better and also remove the unnecessary not configured settings"; "on the left sidebar i should be given the option at the very top to minimize it" (not just hide); "the models and providers page is not proper and the changes applied there dont reflect properly on the agent session page… i am unable to configure the per million input and output token price for the models properly"; "remove that container so there is more space — by container i mean the background with the gradient colours on it; dont remove the padding on the sides and the roundes corners"; "the browsers live view… is not repecting the dimensions set by the user instead it adapts to the dimensions on the right sidebar"; remove the bottom "Chromium (native) / Rendered by the embedded Chromium engine…" footnote; "the ai agent can interact with the right sidebar browser — navigate it, screenshot it, use it… change the view, the dimensions, the scale… get the status"; and "the browser content was showing as an overlay on top of everything so if a menu opened up then it would show under the browser".

## The round's shape

The volatile sandbox disk was WIPED between sessions (the R61 tree with it — R61 was already committed + CI-green at tip `273e8b0`, so nothing was lost; the tree was re-cloned and the baseline re-verified green before work started). The owner's computer-use report was verified LIVE against this tip: **the Computer Use settings section, the master switch, the vision model config, the readiness probe, the monitor, and the mini window are all present and working** (screenshots `r62-08-computeruse.png`) — the report matches a stale local build, not the repo. Every other directive was real and is fixed below.

| ID | Workstream | Files owned |
|---|---|---|
| R62-main (orch) | Layout (D5), sidebar minimize (D3), browser dimensions/footer/z-order (D6/D7/D9), the agent-browser stack (D8: Rust command + bridge + tool + prompts), the live battery, close-out | AppShell.tsx, Sidebar.tsx, project-chat-store.ts, test-utils.tsx, BrowserPanel.tsx, popover-webview-guard.ts, native-browser.ts, agent-browser-bridge.ts, stream-store.ts, api.ts, browser.rs, lib.rs, browser-command.ts, browser-proxy.ts, plugins/{browser,computer-use}.ts, computer-relay.ts, prompts.ts + golden, runtime.ts |
| R62-2-a (subagent) | Appearance simplification (D2) | SettingsPage.tsx + test |
| R62-2-b (subagent) | Models & Providers (D4): session reflection + per-1M pricing UX | ModelsProvidersTab.tsx + test, ModelSelector.tsx + Composer tests, api.ts docs |

Suite: **1492 → 1542 root tests in 104 files** (+50: the D3 rail 2 + R60-C reversal 1, the D6 geometry 6 + readout/fit 4, the D7 footnote 2, the D9 guard 5 + bridge 5 + panel handler 5, the D8 tool 12 + route 2, the D2 7, the D4 13), agent-core **787 → 801** (+14: browser-tool 12 new + computeCost 1 + catalog 1), lint/typecheck CLEAN on both workspaces, live battery green (the browser-selector boot crash was found live and pinned with a regression test).

## 1. D1 — computer-use presence (verified, not rebuilt)

The live battery on the dev stack walked the whole surface: `Settings → Computer Use` renders (master switch OFF by default, posture radios, Test readiness, the Vision model section with Off / Separate model / Main model, safety) — flipping the master switch ON and running **Test readiness** produced the honest headless report (`No DISPLAY — headless or Wayland session…` + the capability badges). Nothing needed repair; the report was a stale build on the owner's machine. **The action for the owner: pull the latest release/build — 0.61.0+ has it all; 0.62.0 adds everything below.**

## 2. D2 — Appearance simplified (2-a)

The tab went from 5 sections to 3: **Theme** (the light/dark segmented control merged into the theme grid's section), **Chat density**, **Tool activity** (the tiny inline mock previews deleted — label + one-line description per card now). The **Sidebar Tint section is REMOVED** (the "unnecessary setting" — the store field survives, only the UI is gone), the redundant "Changes apply live" helper text is gone, and the column rhythm tightened (gap-4). 7 new tests pin the merged structure, the removed section, and that the store field still exists.

## 3. D3 — the sidebar MINIMIZES now (a rail, not a hide)

The R60-C "expanded-only" decision is reversed per this directive: a **minimize button at the very top** of the sidebar (normal mode's first row, right-aligned; the settings-mode header row too) collapses the panel to a **64px icon rail** — restore button at the rail's very top, Dashboard/Usage icons, the project tiles (each project's own gradient mark + a live running-dot, click opens that project's chat), the collapsed NotificationBell, and the settings gear. The state (`appSidebarMinimized`) is PERSISTED (a layout preference like panel widths — it survives restarts) and orthogonal to the full hide (`appSidebarVisible`, still the title-bar identity control). The R60-C test asserting "expanded-only, no rail" is replaced with the R62 pair (minimize → rail → restore; the rail navigates), and `resetTestState()` resets the flag (the persisted-flag leak between tests was the one flake found).

## 4. D4 — Models & Providers: reflection + per-1M pricing (2-b + main)

Root causes found and fixed:
- **Session-page staleness**: the chat's model picker and the Settings tab read the same resources through DIFFERENT react-query cache keys (60s/5min staleTimes) — the tab invalidated only its own keys, so renames/hides/prices/adds stayed stale on the session screen for minutes. The tab now fans out `invalidateProvidersEverywhere()` / `invalidateModelConfigEverywhere()` from every mutation site.
- **The picker never showed config-only models** (custom gateways, unreachable catalogs) and **never filtered disabled providers** — both fixed (the flyout is the union of live catalog + config-only rows; the popover lists enabled providers only).
- **Per-1M pricing UX**: the persistence chain was already correct (R50-d tests re-verified); the defects were the labels (units only in a header, jargon aria-labels) — now "Input price / Output price / Cache read price — ($ per 1M tokens)" with decimal `inputMode` (0.075 is first-class). A **Supports vision** toggle joined the dialog (it was the one models-row field with no editor).
- **computeCost's either-null → $0 gate** (main): a partially-priced model (input-only or output-only) now costs what its KNOWN sides cost — the pre-R62 gate silently zeroed every partially-priced turn, which is exactly "unable to configure the price properly". Pinned with a per-side test.

## 5. D5 — the gradient container is gone

The AppShell's atmosphere layers (the dot grid + the three ambient accent glows — "the background with the gradient colours") are deleted; the shell background is the flat theme background. The side padding stays (p-2, one notch tighter than p-3 — more room for the three panels) and every panel + the Tauri frame's rounded content card are untouched ("dont remove the padding on the sides and the rounded corners on the whole view").

## 6. D6 — the browser live view RESPECTS the set dimensions

`computeNativeBounds` was a CLAMPER (a 1920×1080 preset in a 420px panel rendered a 420px-wide page and the readout lied about it). It is now an **aspect-fitter** (the native twin of the proxy path's scaled iframe): scale = min(1, area/vw, area/vh), the webview renders the fitted rect centered, and the scale is composed into the DPI zoom (`browser_tab_set_zoom`) so **the page sees the full preset CSS px** — a 1280×800 preset in a small panel is a scaled-down VIEW of a real 1280×800 page. The user's zoom multiplies on top; the readout reports the requested dims + an honest "fits N%" note (the "clamped from…" lie is gone); the fit button's title teaches the new truth. 10 tests pin the geometry + the composed zoom + the readout.

## 7. D7 — the Chromium footnote is gone

The whole status footnote strip (engine badge + "Rendered by the embedded Chromium engine (WebView2) — full CSS/JS, one shared profile, logins persist…" / the proxy variant) is deleted — the exact text the owner quoted. Native-failure honesty stays where it belongs: the fallback error CARD still explains a broken backend when one actually happens.

## 8. D8 — the agent interacts with the right-sidebar browser

The `browser_control` tool grew from a navigation/viewport driver into a full agent-browser surface (all pre-R62 actions byte-identical):

- **`read`** — the current page's text, fetched fresh server-side through the same extractor as web_fetch (works in EVERY mode, bounded by maxChars ≤ 16KB with an honest truncation marker).
- **`eval`** — JavaScript INSIDE the live page (native WebView2 only): a new Rust command **`browser_tab_eval`** (mirrors `browser_tab_scroll_state`'s `eval_with_callback` channel; script-as-function-body, ≤ 20k chars, 3s timeout, page exceptions as `{ok:false,error}` data) driven by the **live browser-command bridge**: the tool emits a `{type:"browser-command"}` SSE frame on the turn's stream → the frontend's `agent-browser-bridge` dispatches to the mounted BrowserPanel's handler → `POST /browser-commands/:id/result` resolves the pending tool promise (15s honest timeout; no-handler answers immediately with "no embedded browser panel is mounted… (outside the desktop app)"). Click links, fill forms, read the live DOM.
- **`screenshot`** — capture what the panel shows + a vision description: the bridge asks the panel for its on-screen rect (logical rect × scale + window origin = the PHYSICAL-px region), the **computer-use relay** (the per-turn engine registry the computer-use plugin now publishes) runs `captureRegion` (or `captureDisplay` with no region), and the same vision pipeline (separate model or main-model vision) describes it. Needs Computer Use ON — otherwise the tool fail-closes with the exact pointer to Settings → Computer Use. Records into the computer session (the monitor ring shows it).
- **`get_state`** — now with every open tab (`tabs`) + which one the user views (`activeTab`).
- The prompt section teaches the capability triad (read = fresh text, eval = live DOM, screenshot = pixels the user sees) and says to announce which was used. Golden regenerated.

**Live-verified on the dev stack with a real model turn** (`z-ai/glm-5.2:free`): the agent ran `get_state` (reported Example Domain + 1280×800 laptop), `read` (quoted the page), and `eval` (got the honest web-mode error — exactly the designed fail-fast). The NATIVE eval/screenshot paths are code-complete + unit-tested but **live-unverified in this headless sandbox** (no Tauri/WebView2 here) — the owner verifies on the desktop build; CI compiles the Rust.

## 9. D9 — no more overlay-under-webview

The R60 guard covered only the sidebar's two popovers. The general fix: **a DOM overlay watcher** (MutationObserver on document.body, 80ms-debounced, structural-mutations-only) flips a store flag while ANY overlay is open (`role=menu`, `role=dialog`, Radix popper wrappers, `[data-overlay]`; tooltips excluded — too transient), and every BrowserPanel hides its webview while the flag is up (the panel is the single visibility writer; the R60 tab-scoped popover guard is preserved and store-backed). The **live battery found the boot crash** (a stray quote in the overlay selector crashed the AppShell at mount) — fixed and pinned with a regression test that validates the selector string itself.

## 10. The honest caveats

- **Computer-use native paths** (all three platform backends) remain live-unverified on real GUIs — unchanged from R61; the checklist in `docs/runbooks/COMPUTER-USE.md` is still the owner's item.
- **The agent-browser's native paths** (`eval` in the live page, `screenshot` region capture + vision) are code-complete + unit-tested (the bridge, the tool actions, the Rust command) but could not run against a real WebView2 in this headless sandbox — the web-mode paths (`read`, `get_state`, navigate/viewport, the honest eval refusal) ARE live-verified. First desktop session: ask the agent to "open example.com in the browser panel, read it, eval `return document.title`, and screenshot it" with Computer Use on.
- The macOS `screencapture -R` region is POINT-space (not pixels) — on a Retina Mac a region capture may need the scale divided; flagged in the browser.rs doc comment; untestable here.

## Verification

Root `pnpm test` **1542/1542 in 104 files** (was 1492/103 at the R61 tip), agent-core **801/801 in 48**; `pnpm lint` + `tsc --noEmit` CLEAN on both; the live dev-stack battery (agent-browser on :5173 + the sidecar on :5178): setup wizard → dashboard (minimize at the top, rail navigation, expand) → chat screen (flat background) → browser panel (true-dims readout + preset switch + no footnote + no badge) → REAL streamed turn exercising get_state/read/eval → Settings (Appearance 3 sections, Computer Use full section + toggle + honest readiness probe, Models & Providers live catalog) — zero console errors after the selector fix.
