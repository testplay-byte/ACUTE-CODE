<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 90 — The owner's second walkthrough: the delete dead-click, the wizard's memory, and the browser's NATIVE feel

Date: 2026-09-11 · Version: 0.87.0 → 0.88.0 · Scope: UX + capability + a
browser-architecture round (the owner's post-v0.87.0 test verdicts)

## 0. The owner's directive (verbatim → implementation map)

The owner ran v0.87.0 end-to-end and reported, in order:

| # | Verdict (condensed, faithful) | Fix |
|---|---|---|
| 1 | "Check for updates" STILL says the launcher's token is not saved — even after running acute.bat | PATH MISMATCH: the launcher saved the PAT at `<kit>/.acute/github.pat`, the sidecar read `~/.acute/github.pat`. The launcher now saves in the USER HOME + one-time migration of the old kit file + the token is passed to the app via the `ACUTE_GITHUB_PAT` env var (the sidecar honors it first) |
| 2 | Reset → setup wizard: works properly now | ✔ no change needed (confirmed good) |
| 3 | Setup wizard: provider selected, key stored, connection tested — all good | ✔ confirmed good |
| 4 | After the wizard, Settings showed the provider but the MODEL was not selected (manual fix needed) | The wizard persisted ONLY the key + the done-flag. `Save & Continue` now ALSO writes the model row (context/max-output/pricing), the global last-used model, and re-points the default agent at the choice |
| 5 | The model card's capabilities showed as TEXT descriptions — "I was hoping for only the SVG logos" | Icon-only colored SVG badges (the label lives in the tooltip + aria-label) |
| 6 | "The separation between inputs and outputs was only a single line — I wanted an ARROW going from the inputs to the outputs" | A themed arrow flows between the input badges and the output badges |
| 7 | "The bottom [context/input/output/cache read] should be a part of the model section itself… a single highlighted section" | The identity row + the details band are ONE merged card (single border, hairline separator) |
| 8 | Test model works exactly as wanted | ✔ confirmed good (the R89-C6 expansion) |
| 9 | Adding models: no issues this time | ✔ confirmed good (the R89 provider/model flows) |
| 10 | Deleting a provider: confirm delete clicked, NOTHING happens, no error shown | The backend 409s (the default agent still references it) and the error rendered ~1500px ABOVE the click in the accent color. Now: the error renders INLINE in the Danger zone (role=alert) + a pre-armed "In use by N agents" listing + the OS-stored key is purged too (the R82 TODO closed) |
| 11 | Layout shrinking with the left sidebar there AND hidden: both smooth now | ✔ confirmed good (the R89-D tiers) |
| 12 | The browser dims: appropriate; search flow works | ✔ confirmed good |
| 13 | "The mouse pointer should ALWAYS be visible. It should not go away" | The webview's INITIALIZATION SCRIPT paints the cursor at document creation on EVERY page (a resting spot between actions); the runtime adopts it |
| 14 | "The mouse movement was not natural… precise, straight lines… there should be a little bit of fallback behavior — go a little further away and then return back" | The HUMAN PATH PLANNER: overshoot-and-return (~45% of long moves), mid-flight hesitation (~22%), curved bezier legs, arrival settle |
| 15 | "It did not tap there, but when it typed, it typed in perfectly" / "it taps on the input bars and then types" — the type tool never CLICKED | The type driver now TAPS the field first (the visible press), then types |
| 16 | "It should click, then after 1 second, it should start typing" | A 0.7–1.3s beat between the tap and the first character |
| 17 | "The Enter button should be clicked after the typing has finished and after 1 second has passed" | A 0.8–1.4s beat, then the full synthetic Enter sequence + requestSubmit |
| 18 | "The mouse pointer was not apparently clicking anything at all… did not look natural" | The VISIBLE CLICK: a settle micro-move, a press PULSE (the cursor squashes to 0.82 + springs back), a genuine 60–140ms held duration |
| 19 | Drop-down menus: "it clicked there, but the drop-down menu did not appear. When I clicked it manually, it showed" | The REAL EVENT TRAIL: every travel frame fires pointermove/mousemove + hover over/out — hover-driven menus actually open |
| 20 | "The browser itself was not looking like a full-fledged browser… like an overlay… clicking the new tab button closed it and showed 'Browser paused while the menu is open'. The menu was supposed to be shown ON TOP of the browser window" | THE MENU OVERLAY WINDOW: the sidebar's quick menu + sub-agent picker render in an OWNED transparent borderless OS window that rides ABOVE the live browser webview (Win32 owned windows stay above their owner, child webviews included). The browser NEVER pauses for these menus |
| 21 | "The old browser window was floating in the new chat" (the debug-mode switch) | The create-after-unmount RACE: a create resolving after the panel unmounted re-SHOWED the webview over the new chat. A mountedRef latch hides instead |
| 22 | "The provider was OpenRouter even though I did not have OpenRouter added, and the model was not the previous one" | Two roots: the wizard never wrote the last-used model (#4) + the session-switch effect dropped the global last-model fallback the initial state had. Both fixed |
| 23 | "Make sure the project is finalized, well documented, and cleaned — a stable state" | The close-out: docs (this file + CHANGELOG + status.json + HANDOFF), every phase verified, dead code retired where touched |

## 1. Plan (phases, each ends in a commit + push)

- **A. The settings cluster** — the delete-provider honesty (inline 409 +
  pre-armed warning + the OS-key purge), the model card (icon badges, the
  arrow, the merged section), the wizard's persistence, the session-switch
  fallback.
- **B. The launcher PAT** — the home-path fix + migration + the env handoff.
- **C. The browser's native feel** — the floating-webview race fix + the
  MENU OVERLAY WINDOW (the owner's headline ask).
- **D. The agent hands v2** — the always-visible cursor, the path planner,
  the trail, the pulse, the human-paced type.
- **E. Close-out** — verify pipeline, docs, v0.88.0, the test checklist (§6).

## 2. What shipped (the commit map)

| Phase | Commit | The verdicts answered |
|---|---|---|
| A — the settings cluster | `1148a55` | #4 #5 #6 #7 #10 #22 |
| B — the launcher PAT | `d7150a3` | #1 |
| C — the menu overlay + the race | `605028e` | #20 #21 |
| D — the agent hands v2 | `04a386d` | #13–#19 |

## 3. The architecture note — why menus could never paint above the browser

The embedded browser's page is an OS-level CHILD WEBVIEW of the main
window; the app's HTML lives in the MAIN webview. Child webviews float
above ALL app HTML — no DOM popover, dialog, or menu can ever paint over
them. That is why R62/R89 HID the webview while a popover covered it (the
"browser paused" the owner rejected).

R90's answer moves the MENU into the OS layer too: a second window —
transparent, borderless, shadowless, never in the taskbar, not focusable,
and **OWNED by the main window**. Win32 owned windows always ride above
their owner (and everything inside it, the browser child webviews
included), so the menu genuinely floats ON TOP of the LIVE browser. The
window hosts `menu-overlay.html` (the 4th vite entry — the popout
pattern), renders the visual twin of the DOM menu from a JSON payload
(kind/title/items/theme), and reports picks through Tauri events. The
R60-D webview-hiding fallback survives ONLY for the degraded path (web
dev mode / a refused command), where the "paused" caption is honest.

The same round kills the other big "overlay feel" leak: the
create-after-unmount race that floated the previous chat's webview over
the new one.

## 4. Verification

| Gate | Result |
|---|---|
| eslint | clean |
| tsc (root) | clean |
| tsc (agent-core) | clean |
| Frontend suite | 2,888 / 2,888 (+3 vs R89) |
| agent-core suite | 1,894 / 1,894 (+2 vs R89) |
| Build (4 pages incl. menu-overlay.html) | green |
| e2e (Playwright smoke) | 12 / 12 |
| License audit | clean (134 deps) |
| Launcher python tests | 16 / 16 (10 R74 + 6 new) |
| **CI (windows-latest)** | **run 34634030474 SUCCESS** (push 5e4c21a — the full verify pipeline) |
| **Release** | **run 34634033426 SUCCESS → v0.88.0 PUBLISHED (both assets, latest, zero drafts)** |

The honest failure record: the first tagging (912e0b4) ran CI RED twice and
Release RED once before 5e4c21a ran green. (1) The launcher's `panel()`
crashed on the runner's cp1252 console — a real legacy-codepage Windows bug
(box-drawing characters at the very first print), fixed by reconfiguring
stdout/stderr to UTF-8 with replacement (eafd91b). (2) Two Rust compile
slips in the menu-overlay code (a doc comment on a fn parameter — illegal
Rust; and the `WebviewWindowBuilder` generics/arity) — the sandbox had no
Rust toolchain, so CI was the first compiler that saw them (fixed in
5e4c21a). That gap is now closed permanently: the sandbox runs a
**windows-target cargo check** (rustup + an llvm-rc shim — the .res embed
is link-time only) that reproduces the CI's exact typecheck before any
push.

## 5. What did NOT change (the owner confirmed it good)

The reset→setup flow, the wizard's key store + connection test, the
test-model expansion, the model-adding flow, the layout-shrink tiers, the
browser viewport dims, and the search-first agent flow — all confirmed
working by the owner's own walkthrough; untouched this round.

## 6. The owner's TEST CHECKLIST for v0.88.0

**A. Check for Updates (the token fix)**
1. Take the CURRENT kit (the one you ran acute.bat with — the old token is
   saved in the KIT's `.acute/` folder) and run the NEW acute.bat. The
   launcher migrates the saved token to `C:\Users\<you>\.acute\github.pat`
   on startup (watch the launcher console line).
2. In the app: Settings → About → Check for Updates. Expect the live
   version check against the private repo — either "you are up to date"
   (on the newest release) or the newer-release card, NEVER the
   "launcher's token is not saved" message again.

**B. The setup wizard's persistence**
3. Reset the app (Settings → the reset flow you already tested). Run the
   wizard: provider, key, model, context/max-out/prices → Save & Continue.
4. Open Settings → Models & Providers. Expect: the provider row AND the
   model you picked — listed and SELECTED (the tuning values you set in
   the wizard are on the model's detail).
5. Open a NEW chat. Expect: the composer pill shows the WIZARD's model
   (not OpenRouter/GLM, not empty) — and the provider behind it is the one
   you configured.

**C. The model card**
6. In the model list: expect the capability ICONS ONLY (no text labels;
   hover an icon for its tooltip), an ARROW between the input icons and
   the output icons, and the stats (context/input/output/cache read) as
   ONE merged highlighted card under the name — no separate floating
   strip.

**D. Delete provider (the dead click)**
7. Pick a provider that an agent uses (the seeded "Acute" agent points
   at OpenRouter unless your wizard re-pointed it). Click Delete →
   Confirm delete. Expect the RED inline message IN the Danger zone:
   "1 agent still use '…' (Acute) — reassign or delete them first", plus
   the "In use by …" warning that was there BEFORE you clicked.
8. Delete a provider no agent uses: expect it to actually disappear (and
   — delete + re-add it: the key should read empty, not "stored" on the
   old value).

**E. The menu on top of the live browser (the headline test)**
9. Open a browser tab, load any page. Click the "+" (new tab) button in
   the right sidebar. Expect: the menu floats ON TOP of the LIVE page —
   the page never disappears, never says "paused", and KEEPS PLAYING/
   RENDERING while the menu is open. Click away / Escape / pick — the
   menu closes, the browser never blinked.
10. Same with the sub-agent picker (if a session has sub-agents).
11. Open a NEW chat while a browser tab exists — expect NO floating
    browser window over the chat area (the race fix).

**F. The agent hands (give it a browsing task and WATCH)**
12. The cursor is visible from the FIRST frame of every page load —
    parked low-right, never disappearing between actions.
13. Moves overshoot slightly and return (or hesitate mid-flight) — no
    straight-line precision.
14. A field tap is VISIBLE: the cursor squashes + springs back at the
    field, and the first character lands ~1s LATER.
15. Typing is word-by-word at ~150 WPM; Enter lands ~1s after the last
    character (for submit:true actions).
16. Hover menus/dropdowns OPEN when the agent's cursor passes over them
    (the real event trail) — try a site with a hover-nav.
17. A full 600-char type completes without a timeout (the budgets rose).

## 7. Standing notes

- The z-order deep-dive (a DOM-paintable main webview above child webviews)
  was investigated and rejected for this round: it would require
  transparent-window surgery on the main webview + CSS mask plumbing
  across every ancestor of the panel — the owned-menu-window answers the
  actual complaint with a documented, robust Win32 primitive instead.
- Next queue (unchanged): Wave 2-b (the turn-loop harness), the remaining
  server.ts split, Wave 3 (the frontend seams), the standing items.
