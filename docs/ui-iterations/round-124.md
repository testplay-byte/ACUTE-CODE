<!-- last-reviewed: 2026-09-24 round-124 -->
# ROUND 124 — the Android updater + the quick-nav verdicts + the Add-Model configure-first + the mobile polish wave

**The owner's directive (the v0.116 report, six fronts):**

1. *The Android updater* — "first and foremost… There should be an update functionality for the Android
   application too. Like within the Android application, there should be an option to easily update it
   and download the latest version and be able to install the APK."
2. *The desktop quick-nav's four verdicts* — "if I hover on top of the pill, then the pill does not get
   wider. Like the pill should get more wider, but apparently it becomes a circle" … "the highlighted
   pill should be the appropriate one. Because currently when I tried clicking on the very top pill,
   still the bottom pill was highlighted" … "if I click on any one of the pills, it automatically
   scrolls there, but the message does not automatically disappear" … "the pills should be fully
   aligned to the left side, like to the very border of the conversation window, just leaving a small
   padding" (and the small-window overlap: "the conversation pills start showing on top of the text").
3. *Add Model* — "If I click on Add Model and I click on any of the models on my PC to add it, it opens
   up the Configure Model section, and there it does not load anything… But if I do the same thing on
   my mobile, then it does pre-load the context window, max output, input-output prices, the size, and
   everything" … "when I click the Add button, then the modal directly gets added… it is showing me the
   Configure Model menu, but the model has already been added" … batch add: "All the models' data should
   be properly fetched… if it cannot fetch the data of some models, then it should most definitely show
   me some animations for them, so that I am aware of whether it even tried."
4. *The mobile quality-of-life wave* — the Task list: "If I click on any one of the tasks there, it
   automatically marks them as done or marks them as undone… It should ask for confirmation there" …
   the queue prompt: "It was saying, queue a message behind the running turn… It should just say queue a
   message. It should just say that and nothing else" … "the retrying attempts, they are apparently
   shown at the very top of the conversation rather than showing at the very bottom" … "The thoughts is
   still given a dedicated block of itself. It is not that well cleanly managed."
5. *The mobile dashboard + the bottom menus* — "the complete UI redesign of the dashboard page… at the
   very top it shows me the three options: 14 days, 30 days, three months. That is definitely not the
   place for it to be… The daily token charts are not proper. The model's last month donut chart is not
   proper. It is looking ugly and bad" … "the bottom up menus are most definitely not proper. They have
   bad animations."
6. *The browser screenshots (the ledger's verdicts)* — "if I have the application closed, then it cannot
   take screenshots of the inbuilt browser… if the browser window is way too small, then the resolution
   of the screenshot is way too less… the screenshot… should not be based on the actual device's
   resolution, but it should be based on some other factors."

Plus the standing self-improvement ask: the ZCode study (context compression, memory, continuation)
became a knowledge-base artifact — `agent-ctx/research/zcode-context-compression.md`.

## §1 The Android in-app updater — the phone's own update lifecycle

The owner's FIRST improvement, built as three layers plus the manifest plumbing:

**THE NATIVE MODULE (`mobile/modules/acute-installer/`)** — five functions, one purpose (an APK never
crosses the JS bridge): `downloadApk({url, headers?, fileName})` streams via OkHttp into the app's
PRIVATE cache (`cacheDir/updates/`), emitting throttled `progress` events (~1% steps; honest
byte-counts when the server sends no Content-Length) — never an in-memory blob; `cancelDownload()`
(the honest stop — the partial file is deleted); `installApk({path})` hands the cached APK to the OS
package installer through a FileProvider content URI (`ACTION_VIEW` +
`application/vnd.android.package-archive` + `FLAG_GRANT_READ_URI_PERMISSION` — the system's own
confirm dialog is the confirmation an APK install deserves); `canRequestInstalls()` — the honest
Android 8+ "Install unknown apps" runtime-grant probe; `openInstallPermissionSettings()` — the
one-tap path to this app's grant page. Single-flight by design (a second download rejects `"busy"`).
A SEPARATE module from acute-net on purpose: acute-net's identity is the TOFU pin (every byte to the
DESKTOP rides pinned TLS); an APK comes from GitHub over ordinary public-CA TLS.

**THE MANIFEST PLUMBING (`mobile/plugins/with-android-apk-installer.js`)** — a config plugin that
re-applies two things every prebuild: `REQUEST_INSTALL_PACKAGES` in the manifest (also added to
app.json's permissions list) and a DEDICATED FileProvider (authority `${applicationId}.acuteinstaller`
— never the conventional `.fileprovider`, so no library collision) whose path whitelist
(`res/xml/acute_installer_paths.xml`) contains EXACTLY ONE cache-path: `updates/` — the provider can
share nothing else.

**THE POLICY (`mobile/src/update/`)** — three files following the repo's floors discipline:
`core.ts` (pure, jest-pinned: tag parsing, version comparison, asset picking for BOTH workflow naming
eras — `ACUTE-CODE_<v>_android-arm64.apk` and the legacy `app-arm64-v8a-release.apk`, release
interpretation into the four honest states, byte formatting); `installer-floor.ts` (the SINGLE
runtime import site of the native module — the native-transport discipline — plus the GitHub HTTP leg
via acute-net's pin-free `request()`); `updater.ts` (the orchestration: **ANONYMOUS-FIRST** checks —
the R123 desktop inversion mirrored, the optional token in SecureStore only ever accelerates a
rate-limited/private-repo retry; the download's own anonymous-first + token-retry legs; the 24 h
startup auto-check, silent on failure, cached in AsyncStorage for the settings row's caption).

**THE UI** — `app/settings/update.tsx` ("App updates", a phone-own row in the settings hub below
Appearance — never needs a linked host): the version card, the Check card (busy state on the button;
up-to-date / available-with-notes-and-size / rate-limited-with-token-suggestion / error all render
inline), the Download card (a REAL determinate animated bar — the R123 motion law — with counts +
Cancel), the Install card (the honest gate: when the runtime grant is missing, "Allow installs from
this source" opens the system page FIRST), and the optional-token card (R123's grammar verbatim:
"Optional — the repository is public"). The 24 h auto-check wires into `app/_layout.tsx`
(fire-and-forget, 2 s after boot).

## §2 The desktop quick-nav — the four verdicts, answered in geometry

`MessageTimeline.tsx`'s R123 geometry had four flaws the owner named; R124 answers each:

| verdict | the R124 law |
|---|---|
| "it becomes a circle" | **WIDTH-DOMINANT growth** — the magnified chip is 28×9 (nearly triple the width, +3px of height): a clearly WIDER pill, never R123's 22×24 near-square that `rounded-full` read as a circle |
| "the bottom pill would always be the highlighted one" | **the SCROLL-OWNED highlight** — `activeIndexFromScroll` (pure, exported, pinned) picks the exchange owning the viewport's upper-middle (or the LAST while pinned within 72 px of the bottom); a click sets it immediately and the arriving scroll confirms. The forever-bottom `i === length-1` is dead |
| "the message does not automatically disappear" | **the CLICK-DISMISSED preview** — clicking a row dismisses the popover on the spot; it stays dismissed until the pointer genuinely travels (>6 px); the magnification keeps tracking throughout |
| "the pills should be fully aligned to the left side… just leaving a small padding" | **the BORDER-HUGGING rail** — `left-1` + LEFT-ANCHORED chips (`pl-1.5`: the pill's left edge 10 px from the border), growth extends RIGHTWARD into the w-9 corridor; and the reading column's left padding now carries a FLOOR (`pl-11`/`pl-12` at every width — `CONTENT_H_PAD_CLASS`) that clears the widest magnified chip, so "the conversation pills start showing on top of the text" is dead at EVERY window size |

The R123 corridor contract stands (hover-near registers; the corridor's edges are the limit); the
scroll listener is one rAF-throttled passive observer on the panel's `scrollRef`, re-reading anchor
positions — without the prop the rail degrades honestly to the pinned-bottom default. 14/14 tests
pin the new contract (structure, width-dominant math, click-dismiss + wake, scroll ownership pure +
wired, click-sets-active).

## §3 Add-Model — configure-first, the smart pre-fill, the batch's visible fetch

Three verdicts on `ModelsProvidersTab.tsx`:

**CONFIGURE-FIRST (the R95-A add-then-configure upsert retired).** The owner: "it is showing me the
Configure Model menu, but the model has already been added." The picker's Add button (and the manual
by-id form) now hands the prefill to the parent, which opens `ModelConfigDialog` in ADD mode —
**zero upserts until Save**; Cancel adds nothing. The dialog's Save button reads "Add model" in add
mode; a failed Save surfaces the honest inline error IN THE DIALOG (nothing half-added).

**THE SMART PRE-FILL (the mobile's R120-M, on the desktop).** `ProviderModelCatalogEntry` now carries
the backend's ADDITIVE `details` leg (context window, max output, the pricing trio, tool/vision/audio/
video hints — `GET /providers/:id/models` already served them; the desktop threw them away). The
prefill merges static-catalog-first + live-details-fill-blanks; the dialog itself runs the smart
blank-fill on open (add OR edit mode — only-blank policy, a filled value is never overwritten) with an
honest status line: "fetching the model's live details…" → "live details fetched — blank fields were
filled" → "the provider's catalog served no details for this model".

**THE BATCH'S VISIBLE FETCH.** "Add N models" now runs the enrichment pipeline: ONE fresh catalog
read with a spinner on every selected row, then per-row OUTCOME chips ("✓ live details" / "— no
details served" — the owner: "show me some animations for them, so that I am aware of whether it even
tried"), then the upserts, then a held summary ("Added 3 — 2 with live details, 1 without") before the
picker closes. A failed enrichment read does NOT fail the add (the honest "none" chips).

**The model-test error's auto-dismiss** (the same verdict family): a FAIL verdict now dismisses
itself after 12 s (`useModelTest`'s own timer — both views, the list band and the dialog's footer
line; a fresh test re-arms; PASS verdicts keep their 10 s auto-fold). R118-F's "a fail band NEVER
auto-collapses" is superseded by the owner's new ruling; the pin moved with the law. 96/96 tests
green (8 rewritten to the new contract, +1 auto-dismiss pin).

## §4 The mobile quality-of-life wave

- **THE TASK LIST'S CONFIRMATION** (`app/session/[id].tsx`): a tap ARMS the row instead of toggling —
  the row swaps to the confirm affordance ("Mark as done?" / "Mark as not done?" + Confirm/Cancel
  quiet pills, the checkbox staying visible); Confirm fires the real optimistic flip + POST, Cancel
  (or arming another row, or a list change) disarms. The R88 write path is untouched.
- **THE QUEUE PROMPT** (`src/components/composer.tsx`): "Queue a message behind the running turn…" →
  **"Queue a message…"** — "It should just say that and nothing else." The a11y label and hint follow.
- **THE RETRY POSITION** (PC, `AgentChatPanel.tsx`): the retry ladder card + the overflow-recovery
  note moved from the live block's TOP to its BOTTOM EDGE — under the streaming text / the thinking
  placeholder, right where the pinned reader sits. R75's "sits ABOVE everything" buried the card
  thousands of pixels up during long agentic turns; the R124 verdict supersedes it.
- **THE THINKING AFFORDANCE** (`transcript.tsx`): a SETTLED turn's thinking no longer renders as its
  own standing dim block — it collapses behind a ONE-LINE affordance ("Thought for 8s ▾", the same
  duration word the rail summarizes with) that expands to the dim text on tap (the 20-line cap + Show
  all survive; "Hide" collapses). LIVE thinking still streams in place — it IS the stream. The tool
  rows stay first-class visible underneath (the R123 law).

## §5 The mobile dashboard redesign + the sheet's motion (the subagent leg)

`dashboard.tsx` + `usage-cards.tsx` + `chart-donut.tsx` + `usage-format.ts`:
- **THE RANGE SELECTOR** moved INTO the chart's own card — compact `RangeChips` (the tab-pill grammar
  on `TAB_SPRING`) instead of the page's top hero. The page opens with the stat grid under a
  self-describing "Usage · last 14 days" header.
- **THE DAILY CHART**: one axis grammar for all three windows (`chartAxisTicks` — ≤5 evenly spaced
  ticks, first+last always, the "today" anchor in accentDeep), a real selected-day backdrop, honest
  GhostBars for empty days, dashed gridlines, the peak label, the in/out legend.
- **THE DONUT**: the R120 wire-hoop retired — a proportionate 140–200dp ring BESIDE the ranked legend
  (scaled solid stroke ~11% of diameter), the center carrying the window total or the tapped model's
  numbers, humanized `cleanModelName` rows (cap 8 + "+N more"), the FadeInUp entrance rhythm.

`sheet.tsx` — the bottom menus' motion, rebuilt: **drag-to-dismiss** (RNGH `Gesture.Pan()` on the
header band — ±12px vertical activates, ±24px horizontal fails, finger-follow 1:1 down, a rubber band
up, the two-leg dismissal law: ≥900px/s fling OR ≥40% travel, a frame-identical dismissal fold into
the ordinary `onClose`); **exit mirrors enter** (`withSpring(0, SHEET_SPRING)` + completion-callback
unmount); **the dim breathes with the sheet** (scrim opacity = entrance fade × visible extent);
reduced motion snaps; `onFinalize` never strands a cancelled drag. Zero API-contract change — the
KeyActionsSheet, the model sheet, add-key/rename/add-model, projects, and the composer all ride the
same component.

## §6 The browser screenshots — the staged high-res capture (the subagent leg)

The owner's three ledger verdicts, answered by `src/lib/agent-browser-capture.ts` + the new
`POST /api/v1/browser-capture` sidecar route (`browser-proxy.ts` + `tools/plugins/browser.ts`):

- **FIXED HIGH RESOLUTION** — `BROWSER_CAPTURE_WIDTH/HEIGHT = 1280×720` (agent-core's browser plugin
  is the source of truth; the frontend twins are fallback defaults; the cross-side lockstep is pinned
  by both suites). The capture is a STAGED one: `browser_tab_set_bounds` at the fixed resolution +
  zoom 1 → the page lays out and paints at true CSS pixels → the grab through the same platform
  screen-region backends the sidecar already owns → restore bounds/zoom/visibility in a `finally`.
  A target wider than the window is CLAMPED + FLAGGED (`clamped: true`), never fabricated.
- **CAPTURE WHILE HIDDEN** — the webview already outlives its panel (the R87 keep-alive); the stage
  merely *shows* a live page. With NO panel mounted (the owner in Settings), the bridge's module-level
  fallback drives the choreography directly; a missing webview / minimized window is an honest named
  refusal. A route swap MID-GRAB no longer corrupts the raster (the deferred-hide law: the unmount
  cleanup defers its hide to the capture's restore, with a post-latch sweep).
- **HONEST VERSION SKEW** — an older app's "unknown browser command" falls back to the legacy
  `screenshot_meta` path verbatim; the new app's refusals surface verbatim.

9 agent-core browser/computer suites 334/334 (the new `r124-browser-capture.test.ts` carries 13:
the tool contract, the constants lockstep, the clamp, the refusals, both skew legs, the route's
validation/error/auth ladder); 9 frontend suites 295/295 (`agent-browser-capture` 21, `BrowserPanel`
57 with the hidden-tab fixed-res + route-swap-mid-capture pins).

## §7 The self-improvement leg — the ZCode knowledge base

`agent-ctx/research/zcode-context-compression.md` (717 lines): the ZCode inventory with file:line
quotes (the compact engine at `apps/zcode-cli/packages/core/src` — three triggers [manual/auto/reactive],
the ~83% threshold with output reserve + buffer, the never-summarized prefix, the verbatim last round
with durable `preservedSegment` anchors, the 9-section summary briefing, the two circuit breakers
ACUTE lacks [3-consecutive-failure disable + the rapid-refill breaker], post-compact Read-state
re-injection), the KV-cache awareness (ephemeral breakpoints, attachment bubbling, provider-usage
token anchoring), the memory system (MEMORY.md index + background extraction subagent with the
memory-root-confined tool firewall), the ACUTE-shipped-vs-absent table, the 10 ranked adoption
recommendations (provider-usage anchoring + typed decision reasons first), and the navigation map
for future agents.

## §8 Verification

- **Root**: tsc CLEAN · eslint 0 on every touched file · vitest **267 files / 4709 passed** (was 4676:
  MessageTimeline 14 — the four-verdict contract, ModelsProvidersTab 96 — the configure-first +
  smart-fill + batch-visibility + auto-dismiss pins, agent-browser-capture 21, BrowserPanel 57,
  RightSidebar 15, stream-store 69, ScreenshotRow 5, the bridge 10) · design-audit **clean** (R2
  re-pinned 1626→1629 via the sanctioned path: the three additions are the picker's per-row fetch
  chip `text-[10px]` — the row's own id-subtitle voice — and the batch summary + the smart-fill line
  `text-[11px]` — the surrounding caption voice; the R124 dot itself was SNAPPED to `w-1.5 h-1.5`
  scale utilities instead) · build green (mermaid chunk ok) · e2e 12/12 · license 134 CLEAN.
- **agent-core**: tsc CLEAN · vitest **2846 passed** (was 2833: the r124-browser-capture suite's 13).
- **mobile**: tsc CLEAN · jest **46 suites / 1029 passed** (was 44/969: the updater core 31 + the
  orchestration 12, usage-format +8, chart-donut's contract pin, sheet-anatomy +9 drag-law pins, the
  R120-S close test updated honestly citing R124).
- **CI (the honest red-then-fixed story)**: main 50dea4c went green on CI + Rust Checks + Mobile CI
  immediately — but the TAG's Mobile APK run caught the round's one sandbox-blind defect at its first
  compile: `withDangerousMod`'s second argument is the `[platform, action]` TUPLE, not a bare
  function ("function is not iterable" — run 35993378103). The hotfix (e2e94ea) is the signing
  plugin's own verified spelling, validated LOCALLY: `expo prebuild -p android --clean` now runs
  clean in the sandbox and emits the plugin's whole contract (REQUEST_INSTALL_PACKAGES, the
  `com.acutecode.companion.acuteinstaller` authority matching the Kotlin, the one-cache-path
  whitelist). The stale draft + the broken tag were deleted, v0.117.0 re-tagged at the fix, and
  Mobile CI + CI re-ran green on e2e94ea before the re-tag.
- **Honest limits**: no Android device, no Windows, no real browser webview in this sandbox — the
  Kotlin module follows AcuteNetModule's verified patterns but compiles only in CI (the Mobile APK
  workflow is the gate); the staged capture's 400 ms settle + the sub-second flash are code-read +
  mock-pinned only; the sheet's gesture + coupled scrim are pure-law-tested only. The round's live
  pass on real hardware rides the owner's v0.117.0 walkthrough.

## §9 The honest deferred list

- The Android updater's REAL-DEVICE verdicts: the OS install dialog's feel, the download bar on real
  mobile data, the 24 h auto-check's silence — all need the owner's phone.
- The staged capture's brief flash (the page must be on screen ~0.5 s for a screen-region grab —
  an OS-level webview sits above all DOM): a true off-screen engine capture (CapturePreview/CDP) is
  the documented follow-up in the module header.
- The ZCode adoption queue: provider-usage anchoring + typed decision reasons is the ranked first
  pick (a round of its own — it touches the retry/compaction seam).
- The menu-timer hover ratchet (21 pairs) and the release-flow speed round stay queued (R121's list).
