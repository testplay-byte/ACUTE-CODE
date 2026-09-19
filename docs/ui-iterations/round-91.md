<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 91 — the third-walkthrough answer round (v0.89.0)

The owner's third end-to-end walkthrough of v0.88.0 confirmed the R90 wins
(the update check works, the wizard persists, the model card icons, the chat
picker's memory) and filed this round's list. Every item below is the direct
answer to a filed verdict, in the owner's order.

## 1. The verdicts this round answers

| Verdict (the owner's words, compressed) | Where it landed |
|---|---|
| "deleting an OpenRouter provider, it apparently was not getting deleted" (NVIDIA/custom deleted fine) | §2 |
| "the option to add the input capabilities was not highlighted properly" | §4 |
| "the inputs which the model supports should be shown on the right side of the model name" | §3 |
| "if nothing is added … it would not show the whole complete section at all" / "only the context is added → on the right side of the model ID" | §3 |
| "there was no inbuilt update system … update the application from within the app itself" | §5 |
| "the browser was not working at all … nothing was being shown" + pop-out + open-externally dead | §1 |
| "That send message button should only appear when I have typed some message" | §6 |
| "the to-do list will get cut off so the text inside does not adapt properly" | §7 |
| "The continue button could be minimized too" | §8 |
| "the total amount of tokens used can be shown in millions too … 300m" | §9 |

## 2. The OpenRouter delete refusal (the root cause found)

The owner's report was precise: custom and NVIDIA providers deleted; the
OpenRouter one did not. The root cause is the DELETE route's honesty — it
**409s while any agent still references the provider**, and the seeded
default agent ("Acute") references `openrouter` by factory default. NVIDIA
and custom gateways never accumulate agent references, so they deleted
cleanly; every OpenRouter attempt bounced with the 409 the settings pane
rendered as "not getting deleted".

**The R91 contract**: `DELETE /providers/:id?force=1` deletes anyway and
**resets every referencing agent** to the no-provider state (`providerId =
NULL, model = NULL` — the composer's model picker then asks for a model on
the next send, exactly like a fresh agent). The unforced 409 stays as the
API's honest default for other callers, with the force hint added to the
message. The settings confirm flow now tells the owner exactly what will
happen BEFORE the click ("In use by N agents … confirming the delete resets
them to pick a new model") and sends `force=1`; the confirm button itself
carries the reset count ("Confirm delete (reset 2)"). The agents + session
caches are invalidated after the delete so the chat sees the reset
immediately. New server suite in `agent-core/tests/providers.test.ts`
(3 tests: the hinted 409, the force+reset+re-add path, the unchanged
unreferenced contract).

## 3. The model card's right-side identity (the owner's layout)

- **The capability icons moved UP**: the input→output icon row now rides
  INLINE on the model NAME's right (one glance row: name · badges ·
  [in] → [out]); at tight widths flex-wrap takes them to their own line
  automatically.
- **The details band is now CONDITIONAL**: `statFacts` counts only the
  CONFIGURED values (null = unknown = absent). **0 → no section at all**
  (the owner: "it would not show the whole complete section"); **1–2 →
  compact mono chips on the model ID's right** (e.g. `128K ctx`, `$0.15
  in`) instead of the full band; **3+ → the full fused band** with only
  the configured cells (no more "—" placeholders — what is set is what
  you see).

## 4. The capability chips' states (the dialog)

The add/configure dialog's capability pills now read at a glance: **ON =
a filled, saturated pill in the modality's color with a check badge**;
**OFF = a neutral interactive pill** (theme border + text — the old
faded-tint off-state read as a DISABLED ghost), with the modality's color
arriving on hover as the promise of the click, an explicit pointer cursor,
and the icon keeping its modality tint in both states.

## 5. THE IN-APP UPDATER (the headline)

The owner: "I would like you to add an inbuilt update system to it, like I
can update the application from within the app itself rather than going
anywhere."

The three halves:
- **The sidecar** (the PAT lives here — the repo is private): `GET
  /system/updates` now also returns the release's `ACUTE-CODE_*_x64-setup.exe`
  asset URL + GitHub's server-side sha256 digest; `POST
  /system/updates/download` streams the asset to the OS temp dir through a
  counting+hashing pipeline (single-flight; the URL is hard-gated to THIS
  repo's release-asset hosts so the PAT-bearing fetch can never become an
  open proxy); `GET /system/updates/download/progress` carries the live
  byte count. A truncated or digest-mismatched download lands `status:
  error` honestly and the file is removed; a `< 10 MB` result is refused as
  "not a real installer".
- **The shell** (`src-tauri/src/update.rs`, new module): `run_update_installer
  (path)` validates the path (absolute, `.exe`, > 10 MB), hands it to the
  OS open verb, and schedules the app's own exit 1.5s later (Windows locks
  a running exe's file — the NSIS installer needs the app closed).
- **The About tab**: "Update now" (offered when a newer release is found,
  desktop shell only) → a live MB progress bar → "Verifying the installer's
  checksum…" → "Installer launched — the setup wizard will close this app
  and install v<x>. Your data is kept." Web dev keeps the Releases pointer
  (a browser has no installer to run). New suite in
  `agent-core/tests/r89-updates.test.ts` (4 tests: the no-token 409, the
  URL gate, the streaming+verifying+ready path, the digest mismatch).

## 6. The browser's blank render (the deep fix)

The owner's v0.88.0 field report: the agent's browser actions executed but
the page area showed nothing; the pop-out and open-in-system-browser
affordances did nothing either. Root-cause analysis of the v0.88.0 delta
(the menu-overlay round) found the likely wedge: **`menu_overlay_prewarm`
and `menu_overlay_show` were SYNC commands that built windows — tauri's
own docs name this exact pattern the Windows deadlock** ("On Windows, this
function deadlocks when used in a synchronous command… You should use
async commands and separate threads when creating windows") — the same
lesson `open_browser_window` (R58-b) and `browser_tab_create` (R50-a)
already carried in this file. CI's cargo check cannot catch it and the
sandbox cannot run Windows, which is how v0.88.0 shipped it.

The fix is defense-in-depth (four layers, each independently sufficient):
1. **B1 (Rust)**: `menu_overlay_prewarm`/`menu_overlay_show` are `async`
   now — window creation never runs inside a sync command again.
2. **B2 (Rust)**: `browser_tab_set_visible(true)` **re-asserts the tab's
   last commanded bounds in the same breath as the show** (a new
   `TAB_LAST_BOUNDS` map fed by `browser_tab_set_bounds`, cleared on
   close) — a webview can never again be "shown" at its degenerate 1×1
   birth geometry.
3. **B3 (frontend)**: the **visibility watchdog** — every 2s, for the
   active, unguarded tab, the BrowserPanel checks `browser_tab_exists`
   (a new in-memory Rust probe, no dispatcher round-trip) and (a)
   **recreates the webview** at the live URL when it vanished, (b)
   re-asserts show + bounds when it exists. A missed show can never
   persist past one period. The watchdog is paused exactly when the
   panel's own states want the webview hidden (keep-alive inactive,
   popover suppression, a covering overlay).
4. **B3 (frontend, honesty)**: the pop-out and open-externally invokes now
   carry a 6s timeout — a wedged shell's silence becomes the visible
   error card ("the desktop shell may be busy; try again") instead of a
   dead button.

The v0.87.0 and earlier browsers worked on the owner's machine, so the
watchdog's steady-state cost is one boolean probe per 2s — nothing
measurable — and every layer degrades independently (the watchdog cannot
fight the popover guard; it reads the guard's live state each tick).

## 7. The composer's affordances

- **The queue-send button appears only with text** (the owner: "That send
  message button should only appear when I have typed some message in the
  search bar"): while a turn streams, Stop is joined by the queue affordance
  the moment text lands — and not a frame before. (Enter still routes to the
  queue with text; the keyboard path never depended on the button.)
- **The Continue button minimizes**: below a 460px composer the label
  collapses (animated max-width, like the model pill's tiers) and the
  padding shrinks a notch — icon-only, tooltip intact.

## 8. The floating to-do list under squeeze

The float's width cap now measures the **chat column** (`calc(100% -
padding)`, 380px ceiling) instead of the viewport — the old `min(92vw,
380px)` let a squeezed chat column clip the card at its overflow-hidden
edge. On narrow columns (< 520px) the pill's task text **wraps to two
lines** (line-clamp with ellipsis) instead of truncating to a couple of
characters, and the pill softens to a 16px radius to carry the taller
shape.

## 9. Token counts in millions

`formatTokenCount` (dashboard + usage stat cards) and `fmtTokens` (the
composer's donut/breakdown) grew the million tier: 300,000,000 renders as
**300M** (the owner's exact example), 1.5M keeps its decimal, the
sub-million tiers are byte-identical (test-pinned). New suite
`src/lib/format.test.ts` (5 tests).

## 10. Verification (the full pipeline, green)

| Gate | Result |
|---|---|
| lint (eslint, root + agent-core) | clean |
| typecheck ×2 (root + agent-core) | clean |
| root suite (vitest) | **2,899 / 2,899** in 162 files (was 2,888 — +11 new tests) |
| e2e (sidecar, built dist) | 12 / 12 |
| license audit | 134 deps CLEAN |
| windows-target cargo check (rustup + llvm-rc shim) | clean — the R90 method, now covering the `update.rs` module + the async menu-overlay signatures |
| docs check | 192/0/0 |

## 11. Files this round touched (the load-bearing list)

- `src-tauri/src/browser.rs` — async menu-overlay commands; TAB_LAST_BOUNDS
  + the show re-assert; `browser_tab_exists`.
- `src-tauri/src/update.rs` (NEW) — `run_update_installer`.
- `src-tauri/src/lib.rs` — module + command registration.
- `agent-core/src/routes/providers.ts` — the force-delete + agent reset.
- `agent-core/src/storage/agents.ts` — `resetAgentsProvider`.
- `agent-core/src/routes/system.ts` — the asset/digest in the check; the
  download + progress routes.
- `src/lib/api.ts` — `deleteProvider(force)`, the updater wire types.
- `src/lib/native-browser.ts` — `nativeTabExists`.
- `src/lib/format.ts` — the million tier (both formatters).
- `src/components/right-sidebar/BrowserPanel.tsx` — the watchdog, the
  affordance timeouts.
- `src/components/settings/ModelsProvidersTab.tsx` — the model card layout,
  CapChip states, the force-delete confirm flow.
- `src/components/settings/AboutTab.tsx` — the in-app update UI.
- `src/components/project-chat/composer/Composer.tsx` — the queue gating +
  the continue minimize.
- `src/components/project-chat/TodoFloat.tsx` — the column-relative cap +
  the two-line wrap.
- Tests: `agent-core/tests/providers.test.ts` (+3), `agent-core/tests/
  r89-updates.test.ts` (+4), `src/lib/format.test.ts` (NEW, 5), plus the
  re-pinned expectations in Composer/AgentChatPanel/ModelsProvidersTab/
  BrowserPanel test files for the new affordance contracts.

## 12. The CI verdict (the close-out)

R91 push b0ca2b6 → **CI run 34646260159 SUCCESS on the first try** (lint,
typechecks, the 2,899-test root suite, the 4-page build, e2e 12/12, license
audit, cargo check, docs check) + **Release run 34646261861 SUCCESS**.
**v0.89.0 PUBLISHED** (release 387334140, marked latest, zero drafts):
`ACUTE-CODE_0.89.0_x64-setup.exe` 37,544,084 B (sha256
631df87c…) + `acute-launcher-kit-v0.89.0.zip` 104,977 B (sha256
c66ac302…) — the same digests the new in-app updater verifies against.
The DASHBOARD was truth-synced the same hour (30a9c39).

## 13. The owner's TEST CHECKLIST for v0.89.0

**A. The in-app update system (the headline)**
1. Update to v0.89.0 however you did before (ACUTE.bat update — the
   launcher still works exactly as before). Open Settings → About → Check
   for updates: expect "Up to date — v0.89.0 is the latest".
2. THE REAL TEST comes next round: when v0.90.0 ships, Check for updates
   → "Update available" → the **Update now** button → a progress bar
   (MB counting up) → "Verifying the installer's checksum…" → "Installer
   launched — the setup wizard will close this app and install v0.90.0.
   Your data is kept." The NSIS wizard takes over; let it finish; reopen
   the app — expect the new version in About. No browser, no ACUTE.bat.
3. If the download ever fails, expect an honest red reason (the checksum
   line, the truncation line) — never a silent dead button.

**B. The provider delete (the OpenRouter one)**
4. Settings → Models & Providers → OpenRouter → Danger zone: expect the
   "In use by 1 agent: Acute — confirming the delete resets it to pick a
   new model" note ABOVE the button.
5. Click Delete provider → the button flips to "Confirm delete (reset 1)"
   in red → click it → the provider is GONE. Verify: the left list no
   longer has OpenRouter; re-add it if you want it back (Add Provider →
   OpenRouter — the key is stored again cleanly).
6. In the chat: send a message → the composer's model picker now asks
   for a model (the reset agent has none) → pick one → the send works.

**C. The browser (the blank-render fixes)**
7. Give the agent a browsing task ("open github.com and find the Rust
   book"). Expect: the browser tab opens, the page RENDERS in the right
   sidebar, the agent's cursor moves naturally, the address bar tracks.
8. Resize the window, change resolutions/zoom/mobile presets — the page
   follows live (as before).
9. The pop-out button (top-right of the browser bar): expect the Acute
   Browser window to open (shared profile). Close it → the panel is
   untouched.
10. The open-externally button: expect your system browser at the current
    page. If the shell is ever wedged, expect an honest error card within
    6 seconds — never a dead click.
11. The + menu over a LIVE page: the menu floats on top of the browser
    (the v0.88.0 feature, now built on the fixed async path).

**D. The model card**
12. Models list: the capability icons ride on the model NAME's right;
    the details band below shows ONLY what you configured — add a model
    with NOTHING set → no details section at all; with only the context
    set → a compact "128K ctx" chip beside the model ID; with 3+ values
    → the full band.
13. The add-model dialog: the Input/Output capability pills — ON is a
    filled colored pill with a check; OFF is a clean neutral outline
    (clickable-looking, hover colors it).

**E. The composer + the to-do float**
14. While the agent works: type nothing → only the Stop button. Type text
    → the queue-send button appears next to Stop. Enter still queues.
15. Narrow the chat way down: the to-do pill's text wraps to two lines
    (never cut off), the float never spills past the chat column, and the
    Continue button collapses to its icon.
16. The dashboard + usage pages: token totals in the millions render as
    "12.4M" / "300M" (not thousands of K).
