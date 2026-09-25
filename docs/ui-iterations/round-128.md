<!-- last-reviewed: 2026-09-25 round-128 -->
# Round 128 — the reliability & trust pass on v0.120.0

**Owner directive:** his device pass on v0.120.0 — the updater that "updated
successfully, downloaded, it updated, and then it closed properly without
any problem. But then it did not auto-start at all. It did not show me any
system or anything" (the ask: a separate updating system that survives the
app closing); the dashboard tooltip "showing the details exactly on the
top, centered on it" (the ask: right side or left side); the usage bars
that "could be made wider to fit the things in"; the 90-day/24-month views
that "would not scroll to the latest ones… would start from the oldest
month"; the project rows that stutter on first click, navigate when they
should only expand/collapse, ellipsize their names "way too early while
the right side is empty", and delete sessions/projects "without asking for
any session or confirmation"; the missing no-folder "general conversation"
("it will select an internal folder and it will use that"); the
Models-and-Providers ask for a one-click "try the second API key in the
list" after a 429; the chat's icon-littered file rows ("first a file icon,
then the action, then the colored image, then the filename, then the
simple white image again"); the batch commands that should show "one by
one, in order"; the feedback ledger that "did not show me any processing
for that — it only sends me the message after it has done it"; the mobile
tool cards "still not being shown properly… a very huge issue"; the
context that "does not have any capabilities of shrinking it or managing
it better" — plus the 85KB self-feedback ledger he uploaded to
UPLOADED/Feedback.txt with the standing instruction to validate it, never
trust it blindly. Workflow: the R126/R127 wave method verbatim, per the
AI-AGENT-PLAYBOOK.

**Method:** the playbook's arc — the sandbox checked (dev server live,
repo clean at b4eb932, the upload commit pulled), the 18-entry ledger read
end-to-end and every claim cross-validated against the code by SIX parallel
research agents before any code was written (two follow-ups: the Models &
Providers test flow + the mobile bug hunt; the acute-relay Worker cloned
and audited — its SSE guest leg forwards chunks verbatim, NOT the drop
point). Backup branch FIRST (`backup/pre-r128-improvements`, pushed at
b4eb932). The constitution amended BEFORE any wave (COMPONENTS §6: the
side-placement tooltip law RETIRING the R127 center-on-bar law, the fill
law, the reinforced newest-end law, the ToolLine single-icon anatomy;
SCREENS §2: law #2 REVERSED — the project row toggles only; laws #8-9 —
deletes confirm + the General conversation; MOTION §4: the ledger
processing row). NINE waves in three review-gated batches — with the
sandbox's sub-agent transport dropping responses three times (the
interrupted-run successor pattern handled each: the work had landed; the
successor audited every item against the letter, tightened the gaps,
re-ran the gates independently, and wrote the missing records).

## 1. The wave ledger

| Wave | Surface | The owner's complaint it killed |
|---|---|---|
| F (inline) | The constitution amendments + the events-bus "deleted" vocabulary + the mobile events-test re-pin | the spec every wave implements |
| W2 | The chart laws | tooltip centered on top of the bar; bars too narrow for 14-day; 90d/24mo not scrolling to latest |
| W3 | The projects sidebar | first-click stutter (row navigates); expand/collapse button + wrong row behavior; early ellipsis; no delete confirmations; no folder-less general chat |
| W5 | The chat tool cards | the five-mark file rows; batch commands not shown one-by-one in order; the silent feedback ledger |
| W6 | The mobile trap | "tool cards still not being shown properly on the mobile side" — the phone-only `hidden` pref + the silent hello-revert |
| W1 | The updater | "it did not auto-start at all. It did not show me any system or anything" |
| W7b | The agent tools | ten validated ledger fixes (path rebase, no-matches, blocklist naming, temp-files, edit diagnostics, log redirect, memory dedup, search hints, stderr warnings) |
| W8 | The context compaction | "our context does not have any capabilities of shrinking it or managing it better" — the ZCode D3+D5 adoption |
| W4 | The Models & Providers | "an option that I can click that immediately there, and it would try the second API key" |
| W7a | The browser tools | the ledger's most-repeated failure (5 entries): every `browser_control click` dead on every page |

## 2. The two headline finds (both live-verified or pin-proven)

**The evalJob script-shape mismatch (W7a).** The ledger's most-repeated
tool failure — `click failed — evalJob: unexpected start payload (no job
started) — got: {}` — was a two-character class of bug that survived
thirty-plus rounds because every test mocked PAST it: the hands action
builders emitted IIFE *expressions* while the Rust eval wrapper captures
only inner-function *return* values, so every click/type/press_key answered
`{ok:true, value:null}` and the panel's `start.value ?? {}` read `{}`. The
fix is the `return` prefix on both builders + a panel belt that re-probes
on null + Rust-wrap-faithful test mocks (the mechanism bit the mocks' own
first draft twice — now it cannot regress).

**The phone-only `hidden` trap (W6).** The mobile tool-card mystery's
remaining root cause: the DESKTOP Appearance picker still offered
toolActivity:"Hidden" while the desktop render tree never reads it — but
the phone syncs it server-side on every connect/hello and renders
text-only forever. R127's phone-side recovery was necessary but the trap
itself stood. Now the desktop picker retires the rung too (mirror of the
mobile de-risking: the legacy row + the one-tap "Show tool activity"
riding the same server-PUT path), and `pushAppearancePatch` is hardened
(a failed/disconnected PUT records PENDING; the next hello flushes it
BEFORE applying the server value — flush wins, ≤3 attempts, then the
honest surfaced error row). The relay Worker itself was audited clean.

## 3. Live verification (agent-browser 1600×1000, a real sidecar on a seeded temp DB)

- **The dashboard tooltip renders BESIDE the hovered bar** — measured:
  bar 4 at 455-487, tooltip at 495-671 (**8px gap, side RIGHT**, zero
  overlap); the last bar at 864-895, tooltip at 680-856 (**side LEFT**,
  9px gap). The VLM's first read ("overlapping") contradicts the measured
  DOM geometry and is recorded as advisory-only — the ledger's own lesson.
- **The fill law**: the dashboard's 14 bars stretch 20→31px in-card; the
  usage 14-day view reaches the 42px CAP and the chart FITS (no scroller).
- **The newest-end law exact**: 90-day — scrollLeft 1565 + clientWidth
  769 = scrollWidth 2334; 7-day hourly — 565+769=1334 with `HH:00` ticks.
- **The stagger cap**: the Model Mix's last bar delays 0.348s (≤0.4s cap;
  was an uncapped 4.38s old→new sweep).
- **The sidebar**: General PINNED first (live-seeded at sidecar boot — the
  row appeared from the real DB, not fixtures); the project row click
  toggles the session well with the URL UNCHANGED, both directions; the
  delete confirm dialog carries the exact enumeration ("Delete
  \"Demo Workspace\" and its 1 session? Their messages and tool history
  will be permanently removed.") and CANCEL preserves; General renders no
  delete affordance; the "Start a general conversation" button is present.
- **The chat**: file rows carry exactly 3 svgs (status → colored ext icon
  → chevron; was 5 marks); run_command keeps its family glyph; the batch
  command renders "1. node-v / 2. npm-v" numbered in order above the
  "combined output" label.
- **Zero console errors** across every phase. Screenshots: `shots/r128/`.

## 4. Honest caveats

- **cargo check is NOT runnable in this sandbox** (no Rust toolchain) —
  update.rs's supervisor mod and browser.rs's `window_unminimize` were
  written against the files' own live patterns (the overlay's proven
  CreateProcessW mechanics; the set_focus patterns) and **the Rust Checks
  workflow on CI is their verification gate** (watched before the tag).
- **The update flow end-to-end needs the owner's device pass**: the
  supervisor's restart guarantee, the Windows toast (an unregistered AUMID
  may not display on some Win11 builds — the outcome is logged; the app's
  own "Setting up v…" splash is the primary UX), and `update-supervisor.log`
  beside sidecar.log. The fallback `/S /R` leg's NSIS-hook dependency is
  retired — the supervisor owns that flow now.
- **The mobile toolActivity trap is closed at the source**, but the
  owner's phone still carries a server-synced `hidden` until his one tap
  (either surface — both now render the legacy row + the recovery chip;
  a relay blip can no longer silently revert it).
- **Verified-at-pin-level-only**: the ledger live row (the turn-end
  feedback processing renders only during a live turn — jest pins prove
  the store + render contract); the toolCallId threading (pin-proven
  end-to-end in stream-store; live confirmation rides the owner's next
  real session); the compaction D3/D5 decisions (pure-function pins + the
  full agent-core suite; the model's actual compaction behavior is the
  device pass); the try-next-key flow (pinned against the route contract
  — no real 429 was spent in the sandbox).
- **The docs:check transient**: three runs disagreed (4 unreachable →
  clean → 2 WARN) on servo.org/openrouter/openhands URLs — the same
  sandbox-egress class R127 documented (CI's docs:check runs green from
  GitHub's network); the final run is 275/0/0.
- **Kept-by-design**: `runRows` on the dashboard keep their family glyph
  (non-file tools); the side tooltip necessarily floats over the chart
  content BESIDE the hovered bar (the hovered column itself stays fully
  visible — the constitution's law); the loopback curl carve-out demotes
  to ASK, never auto-run.
- **The interrupted-run pattern hit three times** (W1/W7b/W8 dispatches
  + the first four-wave batch): the sandbox's sub-agent transport dropped
  responses AFTER the work landed. Each successor auditor verified every
  item against the letter before the record was written — one real defect
  was caught this way (W7b's full-suite run found a stale cross-suite pin
  the targeted gates had missed).

## 5. The gate stack

Root `tsc` CLEAN · FULL vitest **292 files / 5,145 tests** GREEN (baseline
288/4,961) · agent-core tsc CLEAN + **164 files / 3,035 tests** (baseline
162/2,952 at wave time — every delta a new pin suite) · mobile tsc CLEAN +
jest **1,082 tests** (baseline 1,066) · eslint CLEAN · design-audit CLEAN
(R1 100/101, R2 1536/1635, R3 0/0, R4 15/16, R5 13/21 — at/below baseline)
· pnpm build SUCCESS (mermaid chunk ok) · e2e 12/12 · license CLEAN (299
deps) · docs:check 275/0/0 (final run; the egress transients documented
above) · version:check 7/7 at 0.121.0.

## 6. Release end-state

v0.121.0 — the round committed in two review-gated batches, all five
workflows watched green on the commit (the Rust Checks gate covers the
sandbox-uncompilable supervisor + unminimize code), the tag at the green
commit, the release published with the CHANGELOG section, 7/7 assets.
The rollback door: `backup/pre-r128-improvements` (pushed at b4eb932).
