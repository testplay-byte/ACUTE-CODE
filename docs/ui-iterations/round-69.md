<!-- last-reviewed: 2026-09-08 round-79 -->
# Round 69 — the computer-use enforcement layer: every action returns an observation receipt, clicks verify what they hit, and the re-capture loops die

**Date:** 2026-09-06 · **Branch:** `main` · **Version:** 0.69.0 ·
**Provenance:** no new owner field report this round — R69 closes the
residuals the R68 close-out itself named. R68 built the MECHANISMS (raw
SendInput input, the self-healing foreground, the poked Chromium tree,
30 s frames, the capture-excluded monitor), but the loop-level behavior
the owner actually complained about was still possible: "utilizing the
screenshot capturing way too much" survived because VERIFICATION still
required a re-capture — the receipt said `action_sent: true` and the
only way to know what happened was another screenshot; a stale frame
still hard-failed `frame_stale` and the honest recovery was ANOTHER
screenshot; the model re-observed after every action because nothing
told it what changed. R69 makes the mechanisms AUTOMATIC so the agent
stops re-capturing and starts knowing: every mutating action returns an
**observation receipt** (a fresh frame + what changed + what's focused
+ the frontmost title), coordinate clicks report whether the screen
actually changed and WHICH element the point hit, stale frames
auto-refresh with a perceptual (aHash) comparison before acting, and a
third near-identical screenshot is refused outright with the three
productive alternatives. The verification READ the model used to buy
with 5–25 s of screenshot+vision now rides the action receipt at
+600 ms.

| ID | Workstream | Files owned |
|---|---|---|
| 4-a | The Windows input engine: scroll math fixed (the quadratic over-scroll), long type rides a stdin clipboard paste, the a11y poke hardened (dual-object WM_GETOBJECT, sparse-poll, `--force-renderer-accessibility` launches) | `agent-core/src/computer/backends/windows.ts` |
| 4-b | The mini monitor stops stealing focus (tao's set_focus synthesized an ALT-key SendInput pair) — `WS_EX_NOACTIVATE` via raw FFI | `src-tauri/src/mini.rs` |
| 4-c-1 | Frame intelligence: the pngjs aHash infra, stale-frame auto-refresh (`frame_changed`), the screenshot-spam guard (`screen_unchanged`) | NEW `agent-core/src/computer/framehash.ts`, `agent-core/src/computer/dispatch.ts`, `session.ts`, `types.ts`, `errors.ts`, `package.json` |
| 4-c-2 | Observation receipts: the 11 mutating tools return post-action observations, click verification + `hitElementName`, `wait()` observable, element middle/right click, SSE inline frames, prompts | `dispatch.ts`, `types.ts`, `tools/plugins/computer-use.ts`, `agents/prompts.ts`, the golden fixture |
| 5 | Full CI-mirror verification + the skills.ts re-teach (the skill body still taught the R68 zoom-crop loop) + the license audit regen | `agent-core/src/storage/skills.ts`, `docs/compliance/dependency-licenses.md` |
| 6 | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + TESTING + indexes + status.json) + the version bump + commit/push/CI | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |

## A — the frame hash (the perceptual memory frames never had)

**Root cause (confirmed in code):** the dispatcher held rasters (the
keep-3 private cache) but NO notion of similarity — "did the screen
change?" was unanswerable without asking the vision model, so every
freshness/verification decision degraded to either a blind hard-fail
(`frame_stale`) or a full vision round (the 5–25 s loop).

**Fix — NEW `agent-core/src/computer/framehash.ts` (202 lines,
pngjs@7.0.0 MIT, the round's only new prod dependency):**
- `hashFrame(base64Png, cacheKey?)` → `{aHash: bigint, width, height}`:
  decode → Rec.601 grayscale → 8×8 average pooling → threshold each of
  the 64 cells against the cell MEAN (strictly-greater — a flat image
  hashes 0n). `hashRegion(base64Png, rect, cacheKey?)` crops FIRST, then
  the same pipeline (out-of-bounds rects clamp; a fully-outside rect is
  an honest null). `hamming(a,b)` is pure math on the two bigints.
- A 4-entry decode LRU keyed by the caller's frameId (delete-then-set
  recency; eviction re-decodes) — the registration hash and every later
  region hash of the SAME frame share ONE decode. `PNG.sync.read` is
  try/catch-wrapped: an undecodable raster hashes to null and every
  caller DEGRADES (the guards skip, the receipts omit — never a throw).
- `session.ts`: `FrameInfo` gains `aHash?: bigint` (computed AT
  registration, cacheKey = the frameId) + `provenance:
  "model" | "auto_refresh" | "observation"` (always set; the capture
  initiator — the guards below key off exactly this distinction). The
  bigint is pinned never-serialized in its docblock (map to hex first
  if a wire format ever wants it).
- Rasters now flow dispatcher rasterCache (keep-3) → plugin → route
  raster-cache (LRU-12, 10-min TTL) — unchanged pipes, but the frame
  RECORD survives raster eviction with its hash, so old-vs-new
  comparison works even when the old bytes are gone.

**Tests:** computer-framehash **13** (NEW — synthetic 32×32/64×64/
128×128 PNGs built with pngjs in-test: identical→0, different
structures >8, a shifted gradient >8, out-of-region change → region
hamming 0 while the full frame moves, region-inner change >6, OOB rects
clamped/fully-outside-null, the LRU pinned via a `PNG.sync.read` spy —
same-key shares one decode, 4-entry eviction, re-touch recency).

## B — stale frames auto-refresh (the frame_stale dead-end dies for pointer tools)

**Root cause:** R68 raised the coordinate-freshness clock to 30 s, but
the FAILURE was the same dead-end — act on an older frame and the tool
refused `frame_stale`, whose honest recovery was "fresh screenshot,
resubmit pixels": another capture, another round-trip, mid-flow.

**Fix (`dispatch.ts`, `resolveCoordinateAction`):** a coordinate
action anchored on a frame older than `MAX_FRAME_AGE_MS` (30 s) now
auto-refreshes BEFORE refusing:
1. `captureRegion` over the OLD frame's global coverage (the same
   backend primitive the zoom path calls — region-of-coverage so
   old-vs-new hashes compare apples to apples), registered with
   provenance `"auto_refresh"` + raster-cached (zoomable immediately).
2. Full-frame hamming ≤ 8 (`REFRESH_FULL_STABLE_HAMMING`) → the screen
   is static → PROCEED, the model's coordinates mapped through the NEW
   frame, receipt `{frameRefreshed: true, refreshFrameId,
   screenStable: true}`.
3. Else the TARGET REGION (the element bounds when known, else a ±48px
   box around the point, clamped; mapped per-frame) hamming ≤ 6
   (`REFRESH_REGION_STABLE_HAMMING`) → the target held still while the
   screen moved → PROCEED, receipt `{screenStable: false,
   targetRegionStable: true}`.
4. Else the screen genuinely changed → the NEW refusal
   `frame_changed` (errors.ts) carrying `{refreshFrameId}` — the fresh
   frame is ALREADY registered, so the recovery is ONE zoom round-trip
   ("zoom it, then retry with current coordinates"), not a
   screenshot+vision+replan cycle.
Capture failure or an unhashable raster (no comparison possible)
falls back to the OLD honest `frame_stale` — the failure signal is
never lost. The hard fail stays deliberately for the spec-excluded
`set_value`/`left_mouse_down` paths (they must not act on stale
anchors at all). Wired into left/right/double/triple/middle click,
scroll, `mouse_move`, and `left_click_drag`.

**Tests:** computer-dispatch (the auto-refresh describe — identical
frame proceeds with the full receipt + `auto_refresh` provenance +
latest-frame/raster service; a far change with a stable region
proceeds `screenStable:false targetRegionStable:true`; a region change
refuses `frame_changed` with the payload + recovery text + the fresh
frame registered and zoomable; a capture failure falls back
`frame_stale`; scroll/mouse_move/drag covered; `set_value` keeps the
hard fail; a fresh frame never refreshes; the legacy aged-frame pin
rewritten as the unhashable-raster fallback pin).

## C — the screenshot-spam guard (the third identical capture refuses)

**Root cause (the owner's words, R68):** "utilizing the screenshot
capturing way too much". Nothing in the engine ever said STOP — each
capture cost a vision round and the loop could run indefinitely.

**Fix (`dispatch.ts`, `guardModelCapture`):** the THREE model-initiated
capture sites (`screenshot`, `zoom`, `get_app_state
{includeScreenshot}`) run the guard AFTER the bytes arrive, BEFORE
registration — the 3rd consecutive capture whose full-frame aHash is
≤ 4 bits (`SPAM_IDENTICAL_HAMMING`) from the previous, with no
intervening mutating dispatch, refuses `screen_unchanged` (errors.ts)
with the verbatim teaching: *"Do not re-capture. Either act
(click/type/scroll — action receipts include observations), wait()
(returns what changed), or change strategy (find_elements for
element-based targeting)."* The refused capture registers/caches/
streams NOTHING. Resets: any mutating-tool dispatch attempt, a
genuinely changed capture (hamming > 4), or a foreground-pid change
(a same-pid title change is still caught when it moves pixels). Once
refused, the counter stays saturated until a real reset. The guard
counts ONLY provenance `"model"` captures BY CONSTRUCTION — it runs at
the three model sites; auto-refresh and observation captures never
seed it (pinned by test). Unhashable legacy rasters never refuse.

**Tests:** computer-dispatch (2 identical OK then the 3rd refused with
all three guidance fragments and nothing registered — latestFrame
stays, the raster stays unserved; saturation — the 4th also refuses;
reset after a mutating dispatch; reset after a changed capture; reset
after a foreground pid flip; auto-refresh + observation captures never
count; the unhashable pin; the same guard proven at the zoom and
get_app_state sites).

## D — every action returns an observation receipt (the enforcement layer's core)

**Root cause:** `action_sent: true` meant MAYBE — receipts-not-promises
was the contract, but the only verification read cost a screenshot +
a vision round. The model was TAUGHT to re-capture after acting
(R68's own chain discipline said "verify AFTER with a small zoom
crop") because the receipt itself carried nothing verifiable.

**Fix (`dispatch.ts` + `types.ts` + `computer-use.ts`):** all 11
mutating tools — `left_click`, `double_click`, `triple_click`,
`right_click`, `middle_click`, `scroll`, `type`, `key`, `set_value`,
`select_text`, `left_click_drag` — now attach an observation to the
SENT receipt, after a 600 ms settle (`OBSERVATION_SETTLE_MS`, exported;
public `observationSettleMs` so tests pin the 600 default while
running at 0):
- **The receipt's `observation`** = `{frameId, screenChanged?,
  focusedElementName?, activeApp?: {pid, title}, titleChanged?}` —
  a fresh full-display capture registered with provenance
  `"observation"` + raster-cached; `screenChanged` = full-frame
  hamming > 4 (`OBSERVATION_CHANGED_HAMMING`) vs the pre-action frame
  (the latest frame AT observation time — free, no extra capture);
  `focusedElementName` = the key tool's existing readback primitive on
  the post-action frontmost pid; `activeApp`/`titleChanged` from ONE
  `list_apps` capsule read before the action and after (the active-app
  marker every backend already derives from the real frontmost
  window). Every field whose source is honestly unknown is OMITTED,
  never fabricated (the first action has no pre-frame → no
  `screenChanged`); a failed capture yields `{captureFailed: true}` —
  the ACTION receipt never fails on its observation.
- **`returnState`** (new shared schema on all 11 tools + descriptions):
  absent / `"compact"` (the default) = the raster observation above;
  `"none"` = skip it (the opt-out for tight loops); `"full"` = the R61
  full UIA state compose, verbatim. Non-observation tools keep the
  legacy compact/full opt-in.
- The observation attaches BEFORE the audit journal append — the
  journal records the receipt the model actually got.

**The receipt IS the verification read**: the model is re-taught (K)
to read it instead of screenshotting — the loop the owner complained
about is now structurally unfed.

**Tests:** computer-dispatch 90→109 (the settle pin at 600; the full
observation shape; `titleChanged`; `captureFailed`; the
returnState full/compact/none split; the audit-journal ordering; the
refusal path attaches nothing).

## E — click verification (the coordinate click stops being blind)

**Fix (`types.ts` + `dispatch.ts`, ADDITIVE):**
- `targetVerificationStatus` gains `"changed" | "unchanged"`: a
  coordinate-click receipt whose observation knows `screenChanged`
  upgrades the old blind `"unverified"` to the truth — the pixels
  moved or they didn't. Element/a11y paths keep `"matched"`; an
  unhashable raster or a missing pre-state stays honestly
  `"unverified"`.
- `hitElementName`: the hit-test that ALREADY ran on coordinate
  clicks (its result was discarded) now rides the receipt — the model
  learns WHAT the point landed on ("Search" edit, "Sign in" button),
  on left/right coordinate clicks AND on element-routed raw clicks.
- Honesty note (documented in code): `screenChanged` is a full-frame
  ±4-bit bar — a click that flips only a small toggle may hash under
  it and read `"unchanged"`; the prompt teaches unchanged = "may not
  have registered → check focusedElementName, adjust strategy", and
  `focusedElementName`/`titleChanged` give the secondary signals. A
  region-weighted diff is the natural R70 refinement.

## F — `wait()` becomes observable

`wait(duration)` reads its own pre-title, sleeps, then builds the SAME
compact observation (no settle — the duration IS the settle):
`actionSent` stays false, and the receipt now reports WHAT CHANGED
while waiting (`screenChanged`, `focusedElementName`, `activeApp`,
`titleChanged`). Works in observe posture (wait is read-only) — the
post-navigation primitive the prompts now teach ("after Enter/links,
call wait() — its receipt reports what changed").

## G — element middle/right clicks (the open-in-new-tab flow works without coordinates)

- `middle_click {target: element}` now routes exactly like left_click's
  element path: resolve → bounds → center → raw middle click, receipt
  carrying `hitElementName` + observation — the open-in-new-tab flow
  works from a `find_elements` index, no coordinate guessing.
  double/triple click KEEP the honest raw-only refusal (no
  center-click semantics exist for them).
- `right_click {target: element}`: with a menu (a11y `has_menu`, auto/
  a11y strategies) keeps the Expand semantic path (receipt
  `"matched"`); NO menu — or strategy `"event"` — now routes a RAW
  right-click at the element's center (the old path ran Expand even
  under the event strategy; the fail-closed cell is gone). No-bounds
  elements still refuse honestly.

## H — observation frames land inline in the chat (the owner's capture-moment directive, extended)

`computer-use.ts`: after a receipt returns, the plugin emits the B
refresh frame FIRST (`{type:"screenshot", frameId, tool:
"auto_refresh"}`) then the observation's frame (`tool:` the ACTION
tool's name) — both through the R68 `emitScreenshotFrame` pipe
(dispatcher `rasterFor` → route `registerRaster` → SSE) — so the
post-action frame renders INLINE in the chat at the moment it landed,
exactly like the model's own captures since R68. A `captureFailed`
observation or an evicted raster emits nothing; the tool result is
unaffected. The stream-store handler keys on the SSE event type and
`WorkingEntry.tool` is a plain string — frontend UNTOUCHED (the four
SSE-related suites, 100 tests, pass unchanged).

## I — the Windows input engine (4-a)

### I1 — the scroll math was quadratic

**Root cause (found in code):** the R68 `rawScroll` sent `ticks`
wheel events, EACH carrying ±(ticks×WHEEL_DELTA) — the delivered
scroll was ticks²×120 (a 10-tick scroll moved 100× the intent).
Horizontal scroll was arrow-key taps, which move focus/caret, never
page content.

**Fix:** ONE wheel event carrying `delta = ticks × WHEEL_DELTA`
(clamped to the signed-int range), `SetCursorPos` FIRST + 30 ms
settle (wheel events affect the window under the cursor), and
horizontal rides `MOUSEEVENTF_HWHEEL` (0x1000, positive = right) —
the arrow-tap emulation is deleted.

### I2 — long type rides a stdin clipboard paste (the ARGV ceiling bypassed)

**Root cause:** the R68 ARGV guard honestly refused any type payload
whose composed `-EncodedCommand` would cross the 32,767-char
CreateProcess ceiling — typing a file into an editor was impossible.

**Fix:** text > 300 chars (`LONG_TYPE_THRESHOLD`) rides the NEW
`psStdinCapsule` — the SCRIPT stays in `-EncodedCommand` argv (small,
fixed) while the TEXT travels STDIN as base64(UTF-8): `[Console]::
In.ReadToEnd()` → decode → `Set-Clipboard` → 200 ms settle → a
Ctrl+V `Chord` (VK 17 + VK 86). No CreateProcess ceiling at all,
exact Unicode, and honest failure modes (an empty stdin payload or an
undecodable base64 refuses with the retry guidance — never a silent
paste of nothing). ≤ 300 chars keep the per-character SendInput path
(unchanged); the frontmost gate runs before the clipboard write so a
mismatched target never clobbers the user's clipboard.

### I3 — a11y hardening (the poke that wakes Edge's tree, made surer)

- **The Chromium poke is DUAL now:** `WM_GETOBJECT` with lParam
  OBJID_CLIENT (0xFFFFFFFC) AND UiaRootObjectId (0xFFFFFFFD) to every
  `Chrome_RenderWidgetHostHWND` child — the client path answers the
  legacy MSAA query, the UiaRoot path is the one that actually
  activates Chromium's UIA provider; both for the price of one
  SendMessage pair.
- **The sparse-retry became a POLL:** while the walk stays sparse
  (≤1 element) the snapshot re-walks at cumulative 400/800/1400/2000
  ms checkpoints (4 attempts max), returning IMMEDIATELY once the
  tree is non-sparse — a warm tree costs exactly what it did, a cold
  tree gets up to 2 s to build instead of one blind 600 ms retry.
- **`open_application` appends `--force-renderer-accessibility`** for
  msedge/chrome launches — a freshly-launched Edge has its web a11y
  tree from the first snapshot, not after the first poke.

## J — the mini monitor stops stealing focus (4-b)

**Root cause (read in tao 0.35.3's source):** the re-open path called
`existing.set_focus()` — tao's `force_window_active` falls back to
SYNTHESIZING AN ALT-KEY SendInput press/release pair to steal
foreground permission: stray synthetic keyboard input injected
mid-agent-action, exactly the corruption class the R68-C input
rebuild exists to prevent (and a visible focus yank away from the
driven app).

**Fix (`src-tauri/src/mini.rs`):** `set_focus()` deleted from
re-open (nothing ever hides the window — build-or-CLOSE lifecycle —
so there is nothing to show either; tao's post-creation `show()`
rides an ACTIVATING SW_SHOW, which is why nothing replaced the
call). `WS_EX_NOACTIVATE` (0x0800_0000) OR'd into the extended style
via raw `GetWindowLongPtrW`/`SetWindowLongPtrW` FFI (GWL_EXSTYLE
−20) at the same two sites as the R68 capture-affinity — with a
zero-read guard (this window is always-on-top, so an honest ex-style
always carries WS_EX_TOPMOST 0x8; a literal 0 is a failed read, and
writing `0 | NOACTIVATE` would wipe TOPMOST and sink the bar).
Deliberately NO `WS_EX_TRANSPARENT`: the STOP kill switch and the
drag region are interactive — click-through would neuter both.
Constants pinned by a cross-platform cargo test.

## K — the model is taught the new truth (prompts, skill, descriptions, license)

- **prompts.ts — CHAIN DISCIPLINE rewritten:** (1) every action
  receipt carries an observation — do NOT screenshot/zoom after
  acting; (2) unchanged → may not have registered → check
  `focusedElementName`, adjust strategy, element targeting
  (element-first beats coordinate guessing); (3) after navigation
  (Enter/links) call `wait()` — its receipt reports what changed;
  `screen_unchanged` = act or change strategy, never re-capture. The
  receipts-not-promises line now names the observation as the FIRST
  verification read (`get_app_state` only when it is missing or
  ambiguous). Golden fixture regenerated (+4/−2 lines).
- **skills.ts (the verifier's fix):** the built-in skill still taught
  R68's "verify AFTER the action with a small zoom region crop" —
  directly contradicting the prompt. Four guidance lines rewritten
  (core-loop items 8+9, the chain-discipline line, and the now-false
  "element targets fail closed; use coordinates" line corrected for
  the G routing); the body stays 44 lines.
- **Tool descriptions** (computer-use.ts): the shared `returnState`
  schema on all 11 mutating tools + wait; middle/right/scroll/type/
  key/wait descriptions rewritten for element-target routing and
  observation reading.
- **License:** pngjs@7.0.0 (MIT) joins the audit — 134 production
  deps, verdict CLEAN, no allowlist change needed (MIT passes
  policy outright); `@types/pngjs` is dev-only.

## The architecture (the receipt loop)

```
MUTATING ACTION (11 tools)                STALE FRAME (>30 s)          SPAM GUARD
dispatch(): route → SENT receipt          captureRegion(old cover)     screenshot/zoom/
  ├─ 600ms settle (OBSERVATION_           → register "auto_refresh"    get_app_state{shot}
  │   SETTLE_MS)                          ├ full hamming ≤8 → PROCEED   3rd consecutive
  ├─ captureDisplay → register            │   {screenStable:true}       aHash ≤4, no
  │   "observation" + rasterCache         ├ region ≤6 → PROCEED        mutation between
  ├─ screenChanged: hamming>4 vs          │   {targetRegionStable}     → screen_unchanged
  │   pre-frame (latestFrame at           └ else frame_changed         refusal (nothing
  │   observation time — free)              {refreshFrameId} — the     registered): act /
  ├─ focusedElementName (key tool's        fresh frame is already      wait() / find_elements
  │   readback, post-action pid)           registered → ONE zoom      ── resets: mutating
  └─ activeApp+titleChanged (ONE                round-trip             dispatch · changed
      list_apps capsule, pre+post)                                        capture · pid flip

THE RECEIPT: {actionSent, dispatchStatus, targetVerificationStatus:
  "matched"|"changed"|"unchanged"|"unverified" (coordinate clicks
  upgraded from blind "unverified" by the observation), hitElementName
  (the hit-test that already ran — WHAT the point landed on),
  observation:{frameId, screenChanged?, focusedElementName?,
  activeApp?{pid,title}, titleChanged?} | {captureFailed:true},
  returnState: "compact"(default)|"none"|"full"(R61 UIA compose)}

SSE (the capture-moment directive, extended): refresh frame
  {type:"screenshot", tool:"auto_refresh"} THEN the observation
  frame {tool:<action name>} → route raster-cache → INLINE chat rows.
  The model reads the receipt; the human watches the thumbs.
```

## Verification (re-run this round, fresh — the full verifier + this docs pass)

- Root `pnpm test`: **2082/2082 in 123 files** (was 2003/122) — the
  verifier's full CI-mirror run, re-confirmed by this docs pass.
- Splits: agent-core **1180/1180 in 60 files** (was 1101/59); frontend
  `src/` **890/890 in 61 files** (unchanged — R69 touched zero
  frontend files); root `tests/` e2e **12/12** (re-run).
- The R69 suites: computer-framehash **13** (NEW) ·
  computer-dispatch 72 → **109** · computer-windows-backend 68 →
  **80** · computer-use-plugin 22 → **28** · computer-session 13 →
  **15** · computer-errors-audit 20 → **24** · prompt-registry 17 →
  **21** · skills-mcp 13 → **14**. The golden fixture regenerated by
  the sanctioned procedure (+4/−2 lines).
- `pnpm lint` exit 0 · `pnpm typecheck` exit 0 (root + agent-core) ·
  `pnpm build` ✓ · `pnpm test:e2e` 12/12 · `pnpm license:audit` CLEAN
  (134 prod deps).
- `cargo check --target x86_64-pc-windows-msvc` (CI's actual
  windows-latest target, cross-checked locally) — Finished, plain AND
  `--tests`, ZERO warnings from mini.rs.
- `pnpm version:check` 0.69.0 ×4 after the bump.
- `pnpm docs:check`: **0 failures** — the R68 close-out had stamped
  eight files 2026-09-06 (its round date, "the owner-message date")
  while the sandbox UTC clock read 2026-09-05; this pass re-stamped
  those eight to the actual review date (2026-09-05) and stamped the
  R69 docs 2026-09-05 round-69, so the future-date sanity rule holds
  on the live clock everywhere.

## What this round does NOT claim (known limitations)

- **PowerShell never runs in this sandbox — ALL Windows behavior
  remains construction-pinned** (the same posture as R68: the exact
  emitted scripts, the C#-5 safety, the FFI signatures cross-checked
  1:1, none executed). The owner's next Windows field run is the live
  gate, and R69 adds its OWN live questions: does the dual-object
  poke wake Edge's UIA provider on real hardware, does the stdin
  paste channel survive the real pipe, does MOUSEEVENTF_HWHEEL feel
  right on a real Edge page, does NOACTIVATE keep the monitor
  non-activating while STOP/drag stay clickable, do the aHash
  thresholds (4/6/8 of 64) hold on real 1280×1024 frames, is the
  600 ms settle enough to catch post-click repaints.
- **Per-action cost grew**: settle 600 ms + up to 4 PowerShell
  capsules (capture + list_apps + focused readback + the action
  itself) per mutating action — the accepted trade: it REPLACES the
  5–25 s screenshot+vision verification rounds it makes unnecessary.
  Noticeable in logs; bounded; `returnState:"none"` opts out per
  call when a tight loop needs it.
- **The spam guard's foreground reset is a PID proxy** (frontmostPid
  at capture time): a same-pid title change resets only when it
  moves pixels past the hamming-4 bar; a true title read would need
  a new backend primitive.
- **`screenChanged` is a full-frame bar** (±4 bits): a small toggle
  flip can read "unchanged" — taught as "may not have registered"
  with `focusedElementName`/`titleChanged` as secondary signals; a
  region-weighted diff is the R70 refinement.
- **`setValue` and `left_mouse_down` keep the hard `frame_stale`**
  (spec-excluded paths that must not act on stale anchors at all),
  and the element-target long type still rides the UIA SetValue ARGV
  guard — `set_value`/`write_clipboard` remain the only ARGV-capped
  payload paths (an element-target long type >~4.8k chars still
  refuses with the split guidance).
- **The clipboard paste clobbers the user's clipboard content** by
  design (a paste must), gated behind the frontmost check.
- **The DASHBOARD sync is deliberately NOT this round** — the
  truth-sync to 0.69.0 is the next task's scope (this round bumps
  the code repo only: no tag, no GitHub release).
- **The debug analyst's `maxOutputTokens` cap + the browser-wall
  self-bypass stay future work** (R66/R67, carried).
