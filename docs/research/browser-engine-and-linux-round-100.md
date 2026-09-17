<!-- last-reviewed: 2026-09-17 round-100 -->
# Browser engine + Linux release — the R100 research memo

**Why this exists (owner directives, round-100):** the owner's verdict on the
round-99 embedded browser: (1) *"You did try to implement the browser
functionality properly by implementing a native inbuilt browser but I don't
feel like you have implemented the correct version… I feel like it is still
utilizing the Microsoft Edge browser under the hood."* (2) *"I also feel like
the size is way too much, more than it should have been… The size is 4x what
the previous one was."* Plus the standing round-100 ask: **a proper Linux
release**. This memo is the research pass for all three; it makes no code
changes.

**Method.** ~28 web searches plus live primary-source reads on 2026-09-17
(Tauri v2 official docs, servo.org blog + book + the live WPT scores JSON,
Ultralight's pricing/blog/GitHub, the CEF automated-builds index JSON,
Chromium-for-Testing's version JSON with HEAD-verified artifact sizes,
Microsoft Learn, VS Code release notes, the OpenHuman production wiki, GitHub
repo APIs). Our own tree was re-verified today at `src-tauri/tauri.conf.json`,
`.github/workflows/release.yml`, `src-tauri/src/{browser,sidecar,keys,wincred,
update,mini,lib}.rs`, `src/lib/native-browser.ts`,
`scripts/release/stage-sidecar.mjs`, and `agent-core/package.json`. Anything
not verified from a primary source is marked **[UNVERIFIED]**. Live artifact
sizes were measured today with HTTP HEAD / fresh fetches, not quoted from
memory.

**The two hard numbers this round turns on** (both verified today):

- GitHub release assets: `ACUTE-CODE_0.96.0_x64-setup.exe` = **36.9 MB**
  (pre-fixedRuntime) → `ACUTE-CODE_0.97.0_x64-setup.exe` = **258 MB**
  (with the bundled WebView2 Fixed Version Runtime). The owner's "4x"
  perception is directionally right; the measured ratio is ~7x.
- The WebView2 fixed-runtime cab the CI pins is 308,367,262 bytes
  (`release.yml` + EMBEDDED-BROWSER.md), and Tauri's own docs price the
  `fixedRuntime` mode at **~180 MB of installer growth** — that is the entire
  delta.

---

## §A Windows browser engine options (the core question)

### A.0 What the owner is actually seeing — why it "feels like Edge"

The round-99 build genuinely IS Microsoft Edge's engine, in three
user-visible ways (verified in our tree + WebView2's documented contracts):

1. **The user agent.** `src-tauri/src/browser.rs`'s `WebviewBuilder` chain
   (line ~926) sets no custom UA, so every browser-panel page reports
   WebView2's default UA, which carries the **`Edg/153.0.…` token** — any
   "what is my browser" page, any site with browser detection, and any agent
   demo that asks the page what it is answers **"Microsoft Edge."** This is
   almost certainly the trigger: the panel was built to be driven by the
   agent, and the agent's own `eval`/`read_dom` on a detection page returns
   "Edge" verbatim.
2. **The process.** Task Manager shows `msedgewebview2.exe` children (the
   fixed runtime we now bundle is literally that exe tree), and the installer
   visibly installs a `webview2-runtime` folder with Microsoft's binaries.
3. **The lineage.** WebView2 is documented by Microsoft as the Edge
   runtime ("WebView2 Runtime" = Edge's evergreen binaries in embeddable
   form) — see https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
   ("The WebView2 Runtime is… the same binaries that power Microsoft Edge").

So the owner's read is *correct*: round-99 shipped a self-contained
**Microsoft Edge engine**, branded as "the browser ships with the app." Any
round-100 answer must either de-Edge what is visible, or change the engine
underneath — §A.1–§A.7 price every option, §B picks.

### A.1 WebView2 install modes (the size lever we already hold)

The authoritative table (Tauri v2 "Windows Installer" guide, live today —
https://v2.tauri.app/distribute/windows-installer/):

| `webviewInstallMode` | Internet at install? | Installer size | Notes |
|---|---|---|---|
| `downloadBootstrapper` (default) | Yes | **0 MB** | NSIS runs the tiny bootstrapper only if the runtime is absent |
| `embedBootstrapper` | Yes | **~1.8 MB** | Better Windows 7 / `.msi` behavior |
| `offlineInstaller` | No | **~127 MB** | Embeds the full evergreen installer |
| `fixedRuntime` ← we ship this | No | **~180 MB** | Pins one version; never auto-updates; adds a ~300 MB tree to disk |
| `skip` | No | 0 MB | App breaks where the runtime is absent — not recommended |

Two load-bearing facts from the same page and Microsoft's distribution doc
(https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution):

- **"On Windows 10 (April 2018 release or later) and Windows 11, the WebView2
  runtime is distributed as part of the operating system."** The bootstrapper
  itself is "a tiny (approximately 2 MB) installer" that only evergreen-
  downloads when the machine genuinely lacks the runtime (pre-2018 Win10,
  stripped LTSC images, some VMs).
- What the production Tauri ecosystem actually ships: the default
  (`downloadBootstrapper`). No mainstream Tauri app ships `fixedRuntime` —
  Tauri's own guide positions fixed runtimes for offline/air-gapped or
  patch-control niches, and flags the ~180 MB cost as the price.

**Implication:** round-99's "zero reliance on the device" goal was bought at
~221 MB of installer (measured 36.9 → 258 MB) to defend against a failure
mode (no WebView2 runtime) that the supported-Windows baseline (Win10
2018-04+, Win11) does not have. The honest nuance to tell the owner: the
WebView2 evergreen runtime is an **OS component** on supported Windows, not
"the device's Edge browser app" — the app never depends on Edge-the-browser
being installed or being the user's default. Offline/locked-down machines are
the residual risk class (§B.1 covers the honest framing).

### A.2 Servo / Verso — the genuinely-not-Edge engine (2026 state)

Servo is the only actively-developed, non-Chromium, non-WebKit-corporate
engine that is consciously building an embedding story for Rust apps. Facts
verified today:

- **It became a library in 2026.** v0.1.0 of the `servo` crate hit crates.io
  on 2026-04-13 ("Servo is now available on crates.io" —
  https://servo.org/blog/2026/04/13/servo-0.1.0-release/), with a stated
  embedding API (`ServoBuilder`), an LTS train for embedders, and the caveat
  *"this release is not a 1.0 release… we still haven't finished discussing
  what 1.0 means for Servo."* The Servo Book's embedding chapter
  (https://book.servo.org, print edition read today) says embedding docs are
  "sparse… an active work in progress" and recommends, for embedding today:
  **`tauri-runtime-verso`** (a custom Tauri runtime), `servo-gtk`, or
  `servo-qt` / Slint bindings.
- **Web compatibility is the blocker, measured.** The live WPT dashboard data
  (https://wpt.servo.org/scores.json, run dated 2026-09-16 — I fetched and
  computed the rates rather than quoting a blog): **66.4% of ALL WPT tests**
  (2,021,576 / 2,163,695 subtests); CSS 68.6%; **CSS Grid 39.1%**; editing
  49.5%; **IndexedDB 43.8%**; streams 91.9%; WebCrypto 97.0%. For scale,
  shipping browsers score in the 90s. The July 2026 report
  (https://servo.org/blog/2026/08/31/july-in-servo/) still headlines
  real-world wins of the shape *"Gumroad did not render at all in v0.4.0, now
  renders almost perfectly"* and *"the DuckDuckGo duck now renders"* — i.e.
  mainstream-site breakage is current news, not history. DOM text selections
  only became *visible* in July 2026.
- **Size is NOT small.** The official Windows nightly archive
  (https://download.servo.org/nightly/windows-msvc/servo-x86_64-windows-msvc.zip,
  HEAD today) is **103,058,283 bytes ≈ 98 MiB compressed** — roughly half of
  the WebView2 fixed runtime, but nowhere near "0 MB."
- **Tauri integration exists and is alive but explicitly experimental.**
  `tauri-runtime-verso` (https://github.com/versotile-org/tauri-runtime-verso
  — 134 stars, last push 2026-09-10, not published to crates.io) is the
  Tauri-blessed path: the whole app swaps `tauri-runtime-wry` for Verso's
  Servo-based runtime, driving a separate `versoview` executable. Tauri's own
  blog post announcing it
  (https://v2.tauri.app/blog/tauri-verso-integration/, Mar 2025) says it is
  *"not as feature rich and powerful as the current backends used by Tauri
  in production yet"* and lists planned basics (window decorations,
  transparency); the long-term goal is an evergreen shared Verso runtime
  precisely *"so you don't have to ship the browser inside your app."* A wry
  Servo backend also exists as an experiment (servo.org, Jan 2024,
  "Tauri update: embedding prototype, offscreen rendering").
- **Automation:** Servo speaks **WebDriver** (classic conformance work is in
  the monthly reports) and has a Firefox-DevTools console with *basic*
  autocomplete (July 2026). It has **no CDP**. Our 15 `browser_control`
  actions ride wry's `eval_with_callback` — a Servo panel would need a new
  bridge against the servo crate's embedding API (a rewrite of
  `src-tauri/src/browser.rs`'s data-returning channel, plus the panel's
  double-parse decoder becomes moot).
- **Is anyone shipping it embedded in production?** No. The "Made with
  Servo" page (https://servo.org/made-with/) lists hobby browsers (Beaver,
  Cuervo, Hermes, Kumo, Moto, retsurf), framework bindings (Servo GTK/Qt,
  Slint, a wry backend), and Verso itself — no mainstream production desktop
  app embeds Servo for general web content today. **Search results on
  production Servo embedding are thin; this is the honest state.**

**Verdict:** Servo is the only true "not Edge, not Chromium" option, and it
is a 2026 research bet, not a product engine: 66.4% WPT means real sites
break, and the Tauri integration is a runtime swap marked experimental by
its own authors.

### A.3 Ultralight (ultralig.ht) — WebKit-based, licensed, C++-only

- **Engine identity:** a fork of WebKit (WebKitGTK-lineage WebCore), NOT
  Chromium/Edge. v1.4 (Apr 2025) brought the core to **WebKit 615.1.18.100.1**
  (Safari-17-era WebCore) with ARM64 and console platforms
  (https://ultralig.ht/blog/ultralight-1-4-out-now/). Single-process
  ("low-latency, no multi-process"), JavaScriptCore for JS.
- **License — the blocker.** Free tier: *non-commercial*, or commercial for
  indie companies **< $100K annual revenue**, **PC platforms only,
  application use only, LIMITED performance + LIMITED feature-set,
  community support**; Pro is **$3,000 per year per application**; Enterprise
  is custom (https://ultralig.ht/pricing/ and the GitHub README
  https://github.com/ultralight-ux/ultralight). ACUTE-CODE is a distributed
  commercial product — the free tier's revenue ceiling and locked features
  are a real legal risk, and $3K/yr/app is a business decision, not an
  engineering one.
- **Embedding:** C/C++ SDK; a Rust panel would be a custom FFI layer we own
  forever. It is a **UI renderer for games/apps**, not a browser: no
  navigation history, downloads, profiles, or DevTools surface; our
  `navigate/back/forward/read_dom/click/type/eval` bridge would all have to
  be hand-built against its C API.
- **Size:** not verifiable without the license-gated download
  (**[UNVERIFIED]** — the SDK download sits behind a form); the project
  markets a "small footprint" but no public number could be pinned today.
  GPU renderer requires a competent GPU (their positioning; **[UNVERIFIED]**
  for minimum specs).

**Verdict:** eliminates the size question only if its footprint claims hold,
but it fails on license (paid/locked for a commercial app), on integration
cost (C++ FFI + re-implementing every browser_control action), and on
browser-shaped features. Not product-sound for ACUTE-CODE.

### A.4 CEF (Chromium Embedded Framework) — Chromium, but not Microsoft's

- **Engine identity:** Chromium, repackaged. It is *not Microsoft Edge's*
  build/distribution, but it IS Chromium-lineage — if the owner's objection
  is "Chromium monopoly" rather than "Microsoft," CEF does not answer it.
- **Size (measured today from the official build index,
  https://cef-builds.spotifycdn.com/index.json):** latest stable
  152.0.7977.83 win64 — **minimal 163.7 MiB**, standard **343.0 MiB**,
  signed **129.9 MiB** *compressed*. A CEF-bundled installer is therefore
  **bigger than our current 258 MB**, not smaller.
- **Rust story is real and current:** `tauri-apps/cef-rs`
  (https://github.com/tauri-apps/cef-rs — created Jan 2025, **465 stars,
  last push 2026-09-14**, maintained under the official Tauri organization;
  dual MIT/Apache-2.0; x86_64+ARM64 across Windows/Linux/macOS). This is not
  a hobby binding.
- **Production precedent with our exact shape:** OpenHuman (a Tauri-based AI
  desktop product) documents shipping "its own CEF runtime via a fork of
  tauri-runtime" — they chose CEF over stock webviews **for CDP**
  (`Target.getTargets`, `DOMSnapshot.captureSnapshot`,
  `Runtime.evaluate`, per-provider scanners over a debugging WebSocket), and
  document a Linux shell fallback for NVIDIA setups
  (https://openhumanwiki.com/docs/developing/cef). Their reasoning maps 1:1
  onto what a CEF port would buy us: native CDP automation replacing the
  SSE→UI→Rust eval bridge — at the cost of bundling ~130–165 MB of
  compressed Chromium and owning the runtime's security-update cadence.

**Verdict:** the most production-proven "not Microsoft's distribution"
option, with the best automation story (CDP), but it makes the size problem
WORSE, not better, and it is still Chromium under the hood.

### A.5 chrome-headless-shell / Chromium-for-Testing + CDP screencast

The "embedded browser as remote view" pattern (headless Chromium renders,
`Page.startScreencast` streams frames into the app, input events forwarded
over CDP) — how remote debugging views and several tools do it.

- **Size (measured today):** Chromium-for-Testing stable 153.0.8010.47 —
  `chrome-win64.zip` **195 MiB**, `chrome-headless-shell-win64.zip`
  **114 MiB** compressed (URLs from
  https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
  sizes via HEAD on storage.googleapis.com). So even the "lightweight"
  headless shell costs more installer bytes than the whole previous
  ACUTE-CODE installer (~37 MB) — and ~2.5x a 65 MB target.
- **Latency:** screencast is not a native view. A long-standing puppeteer
  issue reports **~5 fps in headed mode, ~1 fps headless**
  (https://github.com/puppeteer/puppeteer/issues/478), and Chromium's tracker
  documents heavy CPU on animation-heavy pages
  (Page.screencastFrame storms). Our current child-webview panel is a real
  OS-level surface at full framerate — a screencast port would be a visual
  downgrade for the "watch the agent browse" experience that round-43..99
  built.
- **Where it shines:** when the engine is ALREADY bundled (VS Code — §A.6)
  or when the engine is a service (Playwright/browserless). We have neither
  precondition.

**Verdict:** solves nothing we have: same Chromium identity as WebView2,
bigger than the fixed runtime we're trying to shed, and worse interactivity.
Only interesting later if we ever want CDP automation without CEF — and even
then "download on first use" (§B.2) is the only size-viable shape.

### A.6 What Cursor / Windsurf / Zed / VS Code / JetBrains actually ship

- **VS Code (Microsoft's own answer, Feb–Mar 2026):** the new **integrated
  browser** in 1.109 replaces the iframe-based Simple Browser precisely
  because iframes could not do auth / Google / GitHub / Stack Overflow; it
  adds persistent profile storage, full DevTools, find-in-page
  (https://code.visualstudio.com/updates/v1_109). 1.110 then ships **agent
  browser tools** that are a near-exact mirror of our `browser_control`:
  `openBrowserPage, navigatePage, readPage, screenshotPage, clickElement,
  hoverElement, dragElement, typeInPage, handleDialog, runPlaywrightCode` —
  "work out of the box without the need to install any extra dependencies"
  (https://code.visualstudio.com/updates/v1_110). The engine costs VS Code
  **zero installer bytes** because VS Code is Electron: Chromium is already
  the app shell. That is the structural difference between their situation
  and ours — they bundle Chromium once for everything; Tauri apps don't.
- **JetBrains:** the built-in browser/preview surfaces ride **JCEF** (Java
  Chromium Embedded Framework), distributed as part of JetBrainsRuntime
  (https://plugins.jetbrains.com/docs/intellij/jcef.html,
  https://github.com/JetBrains/jcef). Same trade as A.4, hidden inside the
  IDE's runtime.
- **Cursor / Windsurf:** Electron forks of VS Code — their in-app browser
  and agent-browser surfaces are Electron's Chromium (Cursor's docs market
  browser automation: https://cursor.com/docs — engine questions don't even
  arise because the shell IS Chromium).
- **Zed:** ships **no general embedded browser** — the honest data point.
  The community thread "Simple Browser" (Mar 2026,
  https://github.com/zed-industries/zed/discussions/51251) is still debating
  whether to have one; the older feature request #10533 suggests wry/native
  webview as the approach; "Webview via Extensions" (#21208) remains an open
  design. Zed's shipped adjacent feature is HTML *preview* (local files),
  not a web browser. **[Search results on Zed's engine choice are thin
  precisely because they haven't shipped one.]**

**The pattern in one line:** every production IDE that has a real in-app
browser either already bundles Chromium (Electron/JCEF/CEF) or uses the
platform webview (us, today). Nobody ships a non-Chromium engine in a
production IDE browser panel in 2026.

### A.7 Other genuinely-not-Edge options, checked and closed

- **WebKitGTK on Windows:** not a thing — WebKitGTK is Linux/BSD-only; the
  WebKit "Windows port" is WinCairo, a testing/build port with no stable
  embedding story for third-party apps
  (https://docs.webkit.org/WindowsPort.html; iangrunert.com's Nov 2025
  WebKit Windows port update describes it as a contributor concern, not a
  product SDK).
- **Firefox/Gecko embedding:** GeckoView is Android-only and Mozilla has no
  maintained desktop embedding path ("Embedding Gecko Into Other Apps Isn't
  Pretty" — Phoronix/Chris Lord; the 2022 Mozilla connect request for a
  desktop CEF-style embedding was never realized). Closed.
- **Ladybird:** not 1.0, no embedding API surface aimed at apps, and its own
  team's WPT-score discussions show the same maturity gap as Servo. Not
  embeddable today. **[Thin search results; stated honestly.]**

### A.8 The comparison table

| Option | Engine identity | Installer size impact | Web compatibility | Our 15 browser_control actions | Embedding in Tauri 2 + Rust | License | Risk |
|---|---|---|---|---|---|---|---|
| **WebView2 fixedRuntime** (today, R99) | Edge (Chromium, Microsoft build) | **+~180 MB** (measured: 36.9→258 MB) | Full (Chromium 153) | ✅ all 15 work today (eval bridge) | none — shipped | proprietary but free to redistribute | LOW (works, just heavy + Edge-branded) |
| **WebView2 downloadBootstrapper** (default) | Edge-lineage runtime as an OS component; panel de-brandable via UA | **0 MB** | Full | ✅ all 15 unchanged | none — config revert | same | LOW (needs honest "OS component" framing; offline/locked-down residual) |
| **WebView2 offlineInstaller** | Edge (same) | +~127 MB | Full | ✅ | config change | same | LOW (only for an offline variant) |
| **Servo via tauri-runtime-verso** | **Servo (Rust) — genuinely not Edge/Chromium** | +~98 MiB (nightly zip measured) or 0 MB if downloaded on first use | **66.4% WPT** — real sites break (Gumroad/DDG news in Aug 2026) | ⚠️ needs a new eval bridge (embedding API/WebDriver); no CDP | runtime swap, experimental, versoview binary + resources to bundle | MPL-2.0 etc. (open) | **HIGH** — product-breaking compat; API churn (v0.1.0, no 1.0) |
| **Ultralight 1.4** | WebKit fork — not Chromium | small **[UNVERIFIED]** (login-gated download) | WebKit 615.1 core; renderer, not browser (no history/profiles) | ⚠️ every action re-built over C FFI | custom Rust FFI we own | **free tier capped at <$100K revenue + locked features; $3K/yr/app** | HIGH (license + engineering) |
| **CEF via tauri-apps/cef-rs** | Chromium (not Microsoft's build) | +130–164 MB compressed (measured: minimal 163.7 MiB) | Full | ✅ + native CDP could replace the eval bridge | active Rust crate (Tauri org), but runtime fork + helper processes | BSD (Chromium's) | MEDIUM (weight + maintenance; still "Chromium under the hood") |
| **chrome-headless-shell + CDP screencast** | Chromium | +114 MB compressed (measured) | Full | ⚠️ CDP-native but the PANEL becomes a ~5 fps video | sidecar process + WS + input forwarding | BSD | MEDIUM-HIGH (latency regression vs our live webview) |
| **WebKitGTK-on-Windows / Gecko / Ladybird** | not Edge | n/a | n/a | n/a | no viable path in 2026 | — | CLOSED (not embeddable) |

---

## §B The recommendation

### B.0 The trilemma, stated honestly

On Windows in 2026 you may pick **two** of:

1. **Not Edge/Chromium under the hood** (a different engine lineage),
2. **Production web compatibility** (real sites: Google, GitHub, banks,
   SPAs — the agent's whole point),
3. **Installer ≤ ~100 MB.**

No option in §A.8 delivers all three. Servo delivers 1+3 (barely) and breaks
2. CEF/headless-shell deliver 2 (+CDP) and abandon 1 and 3. Ultralight fails
on license. The round-99 build delivered 2 and abandoned 1 and 3. The
engineering-sound move is to keep 2+3 and eliminate every *user-visible*
Edge signal — then give the owner a real, honest path toward 1 (§B.2
fallbacks) without betting the product's core browser feature on a 66%-WPT
engine.

### B.1 PRIMARY — R100-A "Evergreen shell + de-Edged panel" (recommendation)

**App UI + browser panel stay on WebView2's evergreen runtime (the OS
component), the installer drops the bundled engine, and every visible Edge
surface in the panel is re-branded honestly.** Expected installer:
**~37–40 MB** (v0.96.0 measured 36.9 MB) — inside the owner's 65–100 MB ask
with room for round-100's other features.

Exact changes (referencing the real files):

1. `src-tauri/tauri.conf.json` — revert the install mode and drop the
   resource row:

   ```jsonc
   "resources": {
     "staging/sidecar/": "sidecar/"
   },                       // ← DELETE the "webview2-runtime/": "webview2-runtime/" row
   "windows": {
     "webviewInstallMode": {
       "type": "downloadBootstrapper"     // ← was { "type": "fixedRuntime", "path": "webview2-runtime" }
     },
   ```

   (The serde tag field is `type`, the R99 lesson stands; `downloadBootstrapper`
   is the documented default so the block may also be deleted outright.)

2. `.github/workflows/release.yml` — **delete the whole "Fetch the WebView2
   Fixed Version runtime (ship the browser with the app)" step** and restore
   `timeout-minutes: 45 → 30` (the LZMA pass no longer carries ~300 MB).

3. `src-tauri/src/browser.rs` — set a custom user agent on the panel's child
   `WebviewBuilder` chain (~line 926) and on the pop-out window's content
   webview: `.user_agent(PANEL_UA)` where `PANEL_UA` keeps the honest engine
   tokens but drops the Edge brand and carries ours, e.g.
   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
   Chrome/153.0.0.0 Safari/537.36 AcuteBrowser/1.0`.
   Verified today: `tauri::WebviewBuilder::user_agent` exists in tauri 2.11.5
   (docs.rs), and wry's `with_user_agent` is supported on Windows from
   **WebView2 Runtime ≥ 86.0.616.0** (docs.rs/wry) — trivially satisfied by
   the evergreen floor. The same call is a no-op-safe addition on the Linux
   (WebKitGTK) transport. Note the wry warning: overriding UA does not affect
   the default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
   args (we are not overriding `additional_browser_args`, so those defaults
   stay).
   This single change kills the "agent asks the page what browser it is →
   'Microsoft Edge'" demo — the most plausible thing the owner saw.

4. **Honesty surfaces (no lying):** Settings → Browser + the About tab gain
   an "Engine" line, stated plainly: *Windows: WebView2 (Chromium-based,
   provided by the Windows runtime — re-branded ACUTE UA) · Linux: WebKitGTK*.
   EMBEDDED-BROWSER.md's "engine SHIPS with the app" section gets rewritten
   to the new contract (the runbook is normative — this is part of the
   workstream, not optional docs polish).

5. **Linux release lands this round (§C)** — which converts "it's Edge under
   the hood" from a universal truth into a Windows-platform fact, with the
   Linux panel on WebKitGTK (genuinely not Edge/Chromium), driven by the
   SAME panel code, the same 15 actions, and the already-built dual-transport
   decoder (`native-browser.ts`: WebKit single-parse, WebView2 double-parse —
   verified in-tree today).

**What we tell the owner, honestly:** on Windows the panel's engine is
Chromium-lineage (WebView2 — the same class of engine VS Code, JetBrains,
Cursor and Windsurf use for their in-app browsers), it is provided by the
Windows OS runtime rather than bundled, and every Microsoft/Edge brand the
page can see is gone from the panel. A genuinely non-Chromium engine today
(Servo) renders ~66% of the web platform — we ship it as an opt-in
experimental path rather than the product default (§B.2), and we say so.

### B.2 Ranked fallbacks (if the owner rejects any-Chromium on Windows)

1. **Servo/Verso as an opt-in, on-first-use panel engine** ("ACUTE Browser —
   Experimental engine" toggle in Settings → Browser; default OFF).
   The engine (versoview + resources, ~98 MiB compressed measured for the
   nightly) downloads into app-data on first enable — installer stays
   ~37 MB, the app stays self-contained after. Panel actions run through a
   Servo-side bridge (WebDriver/`Runtime.evaluate`-equivalent against the
   servo crate's embedding API) — a new `browser.rs` transport behind the
   same Rust command surface. Honest warning in the UI: *"experimental
   engine — some sites will not render correctly (66% web-platform
   compatibility)."* This is the only shape in which "genuinely not Edge"
   is compatible with "small installer": pay in compat risk, clearly
   labeled. Re-evaluate at Servo 1.0.
2. **CEF via `tauri-apps/cef-rs`** — if the objection is specifically
   *Microsoft* rather than Chromium: our own Chromium build, native CDP
   (retire the SSE→UI→Rust eval bridge for the panel), JetBrains/OpenHuman
   precedent. But the installer grows ~130–165 MB compressed (measured) —
   i.e., WORSE than today's 258 MB problem — so it is only viable in the
   same on-first-use download shape as fallback 1. Rank it below Servo
   because it fails both "not Chromium" and "small."
3. **An "offline/full" Windows installer variant** (separate artifact with
   `offlineInstaller`, +~127 MB) for air-gapped users, keeping the default
   installer small. Only if the owner reports real offline installs —
   otherwise it is artifact sprawl.

### B.3 What we deliberately will NOT do

- No silent `fixedRuntime`-to-`skip` swap (breaks runtime-less machines).
- No shipping Servo as the DEFAULT engine — a product whose headline feature
  is "the agent drives a real browser" cannot ride a 66%-WPT engine.
- No Ultralight (license ceiling for a commercial product + C++ FFI +
  non-browser feature set).
- No screencast re-architecture of a working live-webview panel (latency
  regression, no size win).

---

## §C Linux release plan (round-100's second deliverable)

### C.1 Targets + updater

- **Ship `deb` + `AppImage` (+ `rpm` if cheap).** The deb is the installable
  for Debian/Ubuntu; AppImage is the distro-agnostic portable + the only
  artifact with a mature self-update story. Tauri's docs note AppImage
  building is *"currently only fully supported on Ubuntu build systems"*
  (https://v2.tauri.app/distribute/appimage) — ubuntu-latest CI qualifies.
- **Updater:** our custom one-click updater (`src-tauri/src/update.rs`) is
  Windows/NSIS-only (ShellExecuteW `/S /R` — verified in-tree). On Linux:
  - tauri-plugin-updater now covers **deb, rpm AND AppImage** (release
    notes: *"Updater plugin now supports all bundle types: Deb, Rpm and
    AppImage for Linux; NSIS, MSI for Windows"*, PR
    tauri-apps/plugins-workspace#2624 — https://v2.tauri.app/release/updater/),
    though deb updates still have open bug reports (issue #3108, Nov 2025).
  - Recommendation for round-100: **AppImage = the auto-updating artifact**
    (self-contained, in-place replace), deb/rpm = "check for updates, open
    the releases page" honesty (the same fallback UX the wizard already
    has). Wiring tauri-plugin-updater for Linux is a round-101 follow-up,
    not a blocker for shipping.

### C.2 The CI matrix change (release.yml)

Current state (verified): `desktop-installer` is the only bundle job,
`runs-on: windows-latest`, fetches the 308 MB cab (deleted by §B.1). Add a
sibling job rather than a matrix (the two jobs share nothing but checkout):

```yaml
  linux-bundles:
    runs-on: ubuntu-latest          # 24.04 — has webkit2gtk-4.1 in apt
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4    # node 24.20.0 pinned, cache: pnpm
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - name: Install WebKitGTK + bundle deps        # per v2.tauri.app/start/prerequisites
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential \
            curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev \
            librsvg2-dev
      - run: pnpm install --frozen-lockfile
      - run: pnpm version:check
      - run: pnpm build                               # shared + agent-core + vite
      - run: node scripts/release/stage-sidecar.mjs --platform linux-x64
      - name: Stage the pinned Linux Node runtime     # mirror of the Windows step
        run: |                                        # node-v24.20.0-linux-x64.tar.xz
          ...extract into src-tauri/staging/sidecar/node + LICENSES/...
      - name: Boot the staged engine on Linux (pre-pack gate)   # the R57 gate, bash port
        run: ...poll for ACUTE_READY with the same env (ACUTE_TOKEN/ACUTE_DB_PATH)...
      - run: pnpm tauri build --bundles deb,appimage,rpm
      - uses: actions/upload-artifact@v4  (acute-bundles-linux)
```

`github-release` then downloads the Linux artifacts and adds them to the
draft release's `files:` (name-glob `*.deb`, `*.AppImage`, `*.rpm`). The
Windows job keeps `targets: ["nsis"]` in `tauri.conf.json`; the Linux job's
`--bundles` flag overrides per-invocation (no conf-file split needed).

**Gotchas verified from primary sources:**

- `libwebkit2gtk-4.1-dev` is the Tauri v2 line; the 4.0 series is gone from
  Ubuntu 24.04's repos (tauri issue #9662) — build on ubuntu-latest (24.04).
- **WebKitGTK graphics bugs are the #1 Linux support burden**: blank/flicker
  windows and resize crashes on NVIDIA, `AcceleratedSurfaceDMABuf` errors,
  Wayland `Error 71` — the official workaround ladder is
  `__NV_DISABLE_EXPLICIT_SYNC=1` → `WEBKIT_DISABLE_DMABUF_RENDERER=1` →
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`, and WebGL can silently fall to a
  software rasterizer while reporting "Apple GPU"
  (https://v2.tauri.app/develop/debug/linux-graphics/). Our app has no
  WebGL-critical paths (the UI is DOM/CSS), so the recommended posture is:
  ship nothing unconditional, but surface an easily-editable env hint in the
  Linux README/troubleshooting section, and watch crash reports.
- AppImage needs the runtime libs present; building on Ubuntu CI is the
  documented-supported path.

### C.3 The Node sidecar on Linux — verified small delta

- `agent-core` builds with plain `tsc` to `dist/` (agent-core/package.json —
  no bundler). ADR-0009's architecture (pinned Node binary + pruned
  node_modules tree) ports unchanged: `stage-sidecar.mjs --platform
  linux-x64` already prunes to the target platform's prebuilds (the script's
  platform arg is generic — verified today), and the Linux Node runtime is
  `node-v24.20.0-linux-x64.tar.xz` = **31.8 MB** (HEAD-verified today on
  nodejs.org/dist — same pinned version as Windows).
- `src-tauri/src/sidecar.rs` already resolves **both `node.exe` and `node`**
  (line ~915, verified today) — the staged `sidecar/node` just works.
- Native modules: `better-sqlite3@13` ships all-platform prebuilds in its
  tarball and `node-pty` loads bundled `prebuilds/<platform>/<arch>/`
  (stage-sidecar.mjs's own verified notes) — linux-x64 prebuilds exist for
  both, so no compiler toolchain lands in the installer. The boot gate
  (C.2) proves it on CI before packing, exactly like R57's Windows gate.
- **Do NOT** switch to bun-compile/Node-SEA/pkg for this: `vercel/pkg` is
  dormant (last publish 2023), Node SEA is still experimental (now with
  `--build-sea` landing in core, Jan 2026 — joyeecheung's writeup), and a
  runtime swap would re-verify node-pty/better-sqlite3 for zero size gain.

### C.4 Shell code inventory for the Linux build (verified in-tree today)

| File | Status on Linux |
|---|---|
| `src-tauri/src/browser.rs` | ✅ ready — `#[cfg(all(unix, not(macos)))] transient_for` branches exist; the eval bridge rides wry, which is WebKitGTK there; `native-browser.ts`'s decoder already handles WebKit's single-encoded eval |
| `src-tauri/src/mini.rs`, `dialogs.rs` (rfd) | ✅ cross-platform by design |
| `src-tauri/src/sidecar.rs` | ✅ ready — `node`/`node.exe` dual lookup; the Win32 job-object leash is `#[cfg(windows)]` and the graceful kill paths run without it |
| `tauri-plugin-shell`, `tauri-plugin-notification` | ✅ both list Linux as supported (v2.tauri.app plugin pages — notification read today) |
| `src-tauri/src/update.rs` | ⚠️ Windows-only by design (NSIS `/S /R`) — needs a `#[cfg]` gate + the C.1 plan |
| `src-tauri/src/keys.rs` + `wincred.rs` | ⛔ **compilation blocker**: `keys.rs` calls `crate::wincred::{read,write}` unconditionally while wincred's items are `#[cfg(windows)]` — a Linux `cargo check` fails today. Needs a Linux key store (secret-service via the `keyring` crate — the R55 TargetName complaint was Windows-specific — or an encrypted-file fallback + honest docs). This is the one genuinely new subsystem. |
| `installer-hooks.nsh`, `mainBinaryName`, NSIS bits | Windows-only, gated by bundle target |
| `capabilities/default.json`, `withGlobalTauri` IPC | ✅ platform-neutral |

### C.5 Sequencing + risks (for the orchestrator's workstream split)

1. R100-A (Windows revert + UA + docs) and R100-B (Linux bundle) are
   separable; A is a config/lint-sized change with a huge size win, B needs
   the keys.rs Linux store + CI job + boot gate.
2. Biggest Linux risks, ranked: (a) keys.rs port (new code + security
   review — SPEC's "keys never on disk" rule needs a Linux-equivalent
   decision, i.e. an ADR); (b) WebKitGTK panel parity for the 15 actions —
   the transport is built, but live verification on a real Linux desktop is
   the only proof (the R67 lesson: mocks stay green while the real
   transport fails); (c) NVIDIA/blank-window support tickets (prepare the
   troubleshooting doc from day one); (d) deb/rpm dependency metadata
   (libwebkit2gtk-4.1-0 etc. — tauri-bundler generates most of it).
3. The release-notes/CHANGELOG should state the Linux feature surface
   honestly: panel + agent browser = yes; computer-use (PowerShell/
   win32 backends) stays Windows-only; keys move to the Linux secret store.

---

## §D Sources (every load-bearing claim's primary URL)

**Tauri / WebView2 (sizes + modes):**
- https://v2.tauri.app/distribute/windows-installer/ — the install-mode table (0 / 1.8 / 127 / ~180 MB), config syntax, "runtime distributed as part of the OS" note
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution — bootstrapper ≈2 MB; evergreen model
- https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewBuilder.html — `user_agent` exists
- https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html — `with_user_agent` requires WebView2 ≥ 86.0.616.0; default browser-args warning
- https://github.com/testplay-byte/ACUTE-CODE/releases (expanded assets v0.96.0 / v0.97.0) — 36.9 MB → 258 MB (fetched today)

**Servo / Verso:**
- https://servo.org/blog/2026/04/13/servo-0.1.0-release/ — first crates.io release, LTS, "not a 1.0"
- https://wpt.servo.org/scores.json (fetched + computed 2026-09-17) — 66.4% all-WPT; per-area rates
- https://servo.org/blog/2026/08/31/july-in-servo/ — real-world compat items, DevTools console, Windows console fix, embedding-API changes
- https://book.servo.org (print.html) — embedding chapter: tauri-runtime-verso / servo-gtk recommended; supported platforms
- https://v2.tauri.app/blog/tauri-verso-integration/ — runtime swap, "not as feature rich… as the backends used in production", evergreen goal
- https://github.com/versotile-org/tauri-runtime-verso (API, fetched today) — 134 stars, push 2026-09-10; crates.io: crate does not exist (checked)
- https://download.servo.org/nightly/windows-msvc/servo-x86_64-windows-msvc.zip (HEAD) — 103,058,283 bytes
- https://servo.org/made-with/ — embedder roster (no production desktop apps)

**Ultralight:**
- https://ultralig.ht/pricing/ — free tier limits, $3,000/yr/app
- https://github.com/ultralight-ux/ultralight (README) — <$100K revenue free-commercial line, WebKit basis
- https://ultralig.ht/blog/ultralight-1-4-out-now/ — WebKit 615.1.18.100.1, ARM64, single-process positioning

**CEF / Chromium-for-Testing / screencast:**
- https://cef-builds.spotifycdn.com/index.json (fetched today) — 152.0.7977.83 win64: minimal 163.7 MiB / standard 343.0 MiB / signed 129.9 MiB
- https://github.com/tauri-apps/cef-rs (API + README) — 465 stars, push 2026-09-14, all desktop targets
- https://openhumanwiki.com/docs/developing/cef — production Tauri+CEF case (CDP rationale; Linux NVIDIA fallback)
- https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json + storage.googleapis.com HEADs — chrome-win64 195 MiB / chrome-headless-shell-win64 114 MiB (153.0.8010.47)
- https://github.com/puppeteer/puppeteer/issues/478 — startScreencast ~5 fps headed / 1 fps headless

**IDE precedents:**
- https://code.visualstudio.com/updates/v1_109 — integrated browser (auth, DevTools, storage)
- https://code.visualstudio.com/updates/v1_110 — agentic browser tools (openBrowserPage…runPlaywrightCode), "no extra dependencies"
- https://plugins.jetbrains.com/docs/intellij/jcef.html + https://github.com/JetBrains/jcef — JCEF in JetBrainsRuntime
- https://github.com/zed-industries/zed/discussions/51251 (+ issues #10533, #21208) — Zed has no shipped general browser
- https://cursor.com/docs (Browser) — Cursor agent browser (Electron/Chromium shell)

**Linux release:**
- https://v2.tauri.app/start/prerequisites/ — Ubuntu dep list (libwebkit2gtk-4.1-dev, libayatana-appindicator3-dev, librsvg2-dev, libxdo-dev, libssl-dev)
- https://v2.tauri.app/develop/debug/linux-graphics/ — NVIDIA/DMABUF/Wayland workarounds + WebGL silent software raster
- https://v2.tauri.app/distribute/appimage/ — "only fully supported on Ubuntu build systems"
- https://v2.tauri.app/release/updater/ (+ plugin/updater) — updater supports deb/rpm/AppImage since PR #2624; issue #3108 deb caveat
- https://v2.tauri.app/plugin/notification/ — Linux supported
- https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz (HEAD) — 31,838,904 bytes
- https://github.com/tauri-apps/tauri/issues/9662 — webkit2gtk-4.0 gone from Ubuntu 24.04 (build on 24.04)
- Joyee Cheung, "Improving Single Executable Application Building for Node.js" (joyeecheung.github.io, Jan 2026) + npm `pkg` (dormant since 2023) — why not SEA/pkg

**In-tree verification (read today, no changes):** `src-tauri/tauri.conf.json`,
`.github/workflows/release.yml`, `src-tauri/src/browser.rs` (UA absent;
transient_for cfg), `src-tauri/src/sidecar.rs` (node/node.exe dual lookup),
`src-tauri/src/keys.rs` + `wincred.rs` (Linux compile blocker),
`src-tauri/src/update.rs` (NSIS-only), `src/lib/native-browser.ts`
(dual-transport decode), `scripts/release/stage-sidecar.mjs`
(generic --platform), `agent-core/package.json` (tsc build),
`docs/runbooks/EMBEDDED-BROWSER.md`, `docs/ui-iterations/round-99.md`.
