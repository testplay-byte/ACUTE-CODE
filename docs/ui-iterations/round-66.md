<!-- last-reviewed: 2026-09-05 round-66 -->
# Round 66 — The live-fire patch: browser page actions, owner-solvable bot walls, the vision split, the post-turn debug analyst, and Windows element search

**Date:** 2026-09-04 · **Branch:** `main` · **Version:** 0.66.0 · **Owner
directive (verbatim, the 0.65.0 field report — via
`agent-ctx/R66-plan.md`):** the A1 "agent is using your computer" indicator
showed during BROWSER turns ("wrong — browser is inbuilt, not computer use")
and was "too tall + top-RIGHT → top-CENTER, minimal height"; A3 "Google
search: agent typed but never submitted"; A4 "If it detects that there is
some bot blocking going on, like captcha or Cloudflare verification, then it
will wait for it. It will wait for about 15 seconds and allow the user to
bypass it by himself… While it is waiting for it, it will show in the chat
window itself in a beautiful format that captcha verification is needed,
Cloudflare verification is needed, or age captcha verification is needed… It
will show me the timer below that it is waiting for me… I will be given
other options there too, like manually marking it as done… and being given
the option to stop the automatic one, stop it manually, and mark it as
done."; A5 the agent's viewport change "was not APPLIED until the owner
nudged a number"; A6 "full page-content access WITHOUT screenshots"; B1 the
floating monitor must SHOW during computer use, top-center, minimal; B2
Windows: "not able to detect where it needs to tap, stuck taking
screenshots" — element-aware interaction, not screenshot loops; B3+B5
"remove the vision model from [computer use] and create a DEDICATED
section… allow the user to select it much more properly… provider and
model… paste in the API key" + "without using the computer use skill, the
agent can just generally use [image analysis]"; B4 the minimized settings
sidebar showed the WRONG rail ("normal projects nav"); C1 no agent
self-report — "a COMPLETELY NEW context-free analyst" receives "the WHOLE
conversation history + FULL tool call responses" and streams its report
live at the bottom of the turn.

R65 shipped the honesty patch; the owner then ran 0.65.0 LIVE on Windows
and this round is that field report's patch set — every directive below has
a confirmed root cause in the code, not a guess.

| ID | Workstream | Files owned |
|---|---|---|
| R66-0 | The contract layer: `api.ts` types/fns + `StreamTurnEvent` frames, stream-store frame handlers, monitor-store decay, plan/worklog | `src/lib/api.ts`, `src/lib/stream-store.ts`, `src/lib/computer-monitor-store.ts` |
| R66-2-a | Browser backend: 15-action `browser_control` + bot-wall detector + the checkpoint registry + the resolve route + the instant viewport frame + the screenshot record removal | `agent-core/src/tools/plugins/browser.ts`, NEW `agent-core/src/browser-checkpoint.ts`, `agent-core/src/server.ts` |
| R66-2-b | Vision split: global settings storage + migration 0025 + `/vision` routes + `ImageAnalysisTab` + ComputerUseTab surgery + the `core-vision` plugin (`analyze_image`) | NEW `agent-core/src/storage/vision.ts`, `agent-core/src/tools/plugins/vision.ts`, `src/components/settings/ImageAnalysisTab.tsx` |
| R66-2-c | Debug agent: the context-free analyst + the route-side phase + `DebugReportCard` + the `debug.report` folding + the R65 prompt-section removal | NEW `agent-core/src/agents/debug-analyst.ts`, `agent-core/src/server.ts` (stream route), `src/components/project-chat/DebugReportCard.tsx` |
| R66-2-d | Windows element-awareness: the walk speedup + scale + `find_elements` + the skill's big-apps paragraph | `agent-core/src/computer/backends/windows.ts`, `agent-core/src/computer/dispatch.ts`, `agent-core/src/storage/skills.ts` |
| main | Integration: BrowserPanel viewport fix + the checkpoint card mount + the mini window rework (Rust + MiniApp + ComputerMiniWindow) + the Sidebar settings rail + the prompts browser section + verification + ship | `src/components/right-sidebar/BrowserPanel.tsx`, `src-tauri/src/mini.rs`, `src/mini/MiniApp.tsx`, `src/components/shell/Sidebar.tsx`, `agent-core/src/agents/prompts.ts` |
| R66-2-e | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + indexes) | `docs/**`, `CHANGELOG.md`, `HANDOFF.md` |

## A1 — the monitor's live signal (browser turns never show it)

**Root cause (confirmed in code):** the monitor keyed `live` off the
long-lived session state — a stale `sessionActive` (the singleton session
stays active while Computer Use is merely ENABLED) pinned it true forever,
so the edge-triggered `open_computer_mini` never re-fired after the MiniApp
self-closed; and the browser `screenshot` action RECORDED into the
computer-use session ring, so a browser-only turn tripped "Agent is using
your computer" too.

**Fix:** `live` = **decayed real-control activity** — every
`{type:"computer-use"}` SSE frame that is a real control event bumps
`liveActivity` and re-arms a **6 s decay**; 6 s of silence = the agent
stopped driving the desktop = hide. `session_start` is bookkeeping (never
marks live); `session_stop` rests the signal immediately. The browser
screenshot action's `relay.session.record` call is DELETED (the capture +
vision description stand alone).

**Tests:** ComputerMiniWindow 7 → **10** (the decay: bump-arms-6s,
silence-hides, session_stop rests, browser frames never trip it), the
monitor store's decay hooks, browser-tool's screenshot case now asserts
`relay.session.record` is NOT called.

## A2/B1 — the mini window is top-center 460×56

**Root cause:** top-RIGHT placement + a 96px-tall two-row bar (the owner:
"make it less tall and make it centered at the top, not on the top right").

**Fix:** `src-tauri/src/mini.rs` — `MINI_DEFAULT_W/H` 460×56, anchored
**top-center** of the active monitor's work area (clamped for small
displays); the Rust tests pin the top-center anchor on a normal and a
small work area. `MiniApp.tsx` reworked to a **single compact row**
(status dot, label, elapsed, latest activity, STOP) that fits 56px; the
web-mode `ComputerMiniWindow` pill follows the same shape.

**Tests:** ComputerMiniWindow **10**, MiniApp **10**, mini.rs's
`mini_position_anchors_top_center_of_a_normal_work_area` +
`mini_position_small_work_area_still_top_center` (Rust).

## A3 — form submission (click / type / press_key)

**Root cause:** the R62 surface had no element-level actions — `eval`
scripts were the only path, and models typed via `el.value = x` (invisible
to React/Vue) and never submitted.

**Fix:** three high-level actions, each ONE eval script over the existing
browser-command bridge (user input embedded via `JSON.stringify` only —
a compile-validity test proves it):
- `click {selector?|text?, nth?}` — CSS match, ELSE a label scan over
  a/button/input[submit|button]/[role=button]/[onclick] (text/aria-label/
  name/value/title, case-insensitive); scrollIntoView + `.click()`.
- `type {selector, text, submit?}` — the NATIVE value setter (prototype
  descriptor) + input/change events so React/Vue register it;
  `submit:true` → `form.requestSubmit()` (native, handlers included) or
  the honest `submitHow` note when there is no form.
- `press_key {key, selector?}` — the key trio (keydown/keypress/keyup)
  with the key map; **Enter inside a form ALSO calls
  `form.requestSubmit()`** — synthetic events never trigger native
  submission — and reports `submitted:true`.

The tool description teaches the exact forms line; the prompt section adds
"FORMS & SEARCH BOXES (R66): to SUBMIT a search or form, do NOT just type
and hope".

**Tests:** browser-tool 17 → **43** (happy paths asserting the
single eval frame + the JSON.stringify-escaped payloads + the descriptor/
requestSubmit/input-change events + the key trio; no-target and page-level
misses; compile tests over every generated script).

## A4 — the bot-wall protocol (detect → checkpoint → honest re-probe)

**Fix (three parts):**
1. `detectVerificationWall` (pure, `browser-checkpoint.ts`) — title first
   then text/html, word-boundary case-insensitive markers, priority
   **cloudflare > captcha > age > "verification"**, evidence = a ≤120-char
   window around the match. `navigate` runs ONE bridge-only 5 s probe
   after the command returns (failures swallowed); `read` detects over the
   fetched text + state title. Both append:
   `⚠ A verification wall (<kind>) is showing on this page — call
   browser_control with action wait_for_verification so the owner can
   solve it while the agent waits.`
2. The checkpoint registry — `openBrowserCheckpoint` mints `bchk_<base36>`
   ids, emits the `browser-checkpoint` frame (the chat card mounts), pends
   with a countdown, settles on REST resolve OR timeout (emits
   `browser-checkpoint.resolved` on EVERY settle), **60 000 ms hard cap**
   (an owner cannot be asked to wait longer than a minute).
3. `wait_for_verification` — probes (bridge script: title + 4 000 chars of
   text + the recaptcha/turnstile/hcaptcha/challenge-platform widget
   markers; server-side fetch fallback), clamps the wait 3 000–60 000
   (default 15 000), opens the checkpoint, then RE-PROBES and reports
   honestly: cleared / still-present warning / owner-stopped / timed-out.
   `POST /api/v1/browser-checkpoints/:id/resolve {action:"done"|"stop"}`
   (in server.ts's /api/v1 scope, same bearer wall) answers the exact
   api.ts client contract.

`BrowserCheckpointCard.tsx` is the owner-facing card: the kind's title
("CAPTCHA verification needed"…), the URL + evidence, a live countdown +
progress bar, **Mark as done** / **Stop waiting** (the resolve POST lives
in the card, like the approval cards' decision POSTs).

**Tests:** browser-checkpoint **16** (detector cases incl. word-boundary
negatives + priority; registry open→resolve/settle/frames/timeout/
resolve-after-timeout/60s-cap/reset; the REST route over a real
buildServer: 401 wall, 400 validation, unknown-id contract, live-id
resolve), browser-tool's wait_for_verification cases (clean → no
checkpoint; wall → exact frame → done + clean re-probe → "verification
cleared"; stop; fake-clock timeout; web-mode honest refusal), and
`BrowserCheckpointCard` **8** (waiting state incl. BOTH controls + live
countdown, resolve POSTs, resolved states).

## A5 — the instant viewport apply

**Root cause (confirmed in code):** the BrowserPanel's panel-local
`naturalSize` gate — agent presets landed in the tab store via the server
state, but the mounted panel kept sizing itself to its container
(`effectiveViewport` null) until a manual number edit flipped the mode.
The 4 s poll updated the store, never the mode.

**Fix (three legs):**
- `set_viewport` now ALSO emits the **`browser-viewport`** SSE frame
  `{tabId, viewport{width,height,preset,zoom,rotate}}` (sessionId ""
  — the frontend takes its own stream session id);
- the stream-store intercepts the frame BEFORE the liveTurn guard
  (turn-independent) → `applyAgentViewport(tabId, viewport)` patches the
  store AND bumps `agentViewportSeq`;
- the mounted panel's effect watches the seq — any bump > 0 exits natural
  mode. The 4 s poll stays as the BACKFALL: it now diffs the server
  viewport on width/height/preset/rotate (zoom-only never forces the
  switch) and adopts + bumps the same seq.

**Tests:** browser-tool's set_viewport frame emission + emit-throws-never-
breaks; BrowserPanel 36 (the natural-mode exit on seq bump + the poll
adoption); stream-store's `browser-viewport` intercept
(turn-independent — a background turn's change applies).

## A6 — read_dom / source (know the page without screenshots)

**Fix:** `read_dom {include:"interactive"|"all", maxChars}` — a structured
outline JSON built in-page: title/url/headings (≤40)/interactive (≤120,
visible-rect-only, each with tag/type/text/ariaLabel/value/placeholder +
a SHORT tag:nth-of-type selector anchored at the closest id ancestor +
rect w/h)/forms (action, method, fields); "all" adds the first 80 text
paragraphs; serialized capped at maxChars (default 12 000, max 20 000).
`source {part:"html"|"css"|"scripts", selector?, maxChars}` — outerHTML /
stylesheets (cross-origin skipped + counted honestly, computed style when
a selector is given) / scripts (src list + inline bodies). Both ride the
eval bridge; both refuse honestly in web dev mode. The prompt section
teaches "USE THE BROWSER LIKE A USER WOULD: read_dom first".

**Tests:** browser-tool's read_dom outline pass + source html/css/scripts
cases + the in-script maxChars truncation + bad-part refusal + the
fail-closed-no-emit refusals.

## B1 — see A1/A2 (the decayed signal + the top-center 460×56 window)

## B2 — Windows element-awareness (walk speedup + find_elements)

**Root cause:** `buildSnapshot`'s PowerShell walk made up to 8
cross-process COM pattern probes per node at `detail:"full"` (4 for flags +
1 value + 3 actions, duplicated) and capped at `maxEl` 800 — Chromium's
tree truncated before page content, and there was NO way to SEARCH the
tree (the model read the whole snapshot or looped screenshots).

**Fix:**
- **Speed:** pattern probes only on 17 potentially-interactive
  ControlTypes (Button/Hyperlink/Edit/ComboBox/CheckBox/RadioButton/
  Slider/TabItem/MenuItem/ListItem/DataItem/TreeItem/Spinner/Thumb/
  ScrollBar/Document/Custom); every other kind records kind+name+bounds
  with ZERO `GetCurrentPattern` calls; probed nodes make ONE 4-probe pass
  (Invoke/Toggle/ExpandCollapse/Value) whose handles are reused for flags
  + value + action advertisement.
- **Scale:** `maxEl` 800 → 2400 (maxDepth 25 unchanged); the
  element-action re-walk moved with it (one token, walk logic untouched —
  otherwise indexes 800+ would be findable-but-never-actionable).
- **`find_elements {appRef, query, kind?, limit?}`** (dispatch.ts + the
  plugin): the app_ref → window resolution extracted into
  `resolveAppWindow()` shared with `get_app_state`; a full-detail snapshot
  + registerSnapshot (the `stateId` rides the result); filter by name
  substring AND kind; `matches` capped at `limit` (default 20, hard 40)
  with `total` uncapped; EMPTY = the honest refusal naming the query +
  kind + elementsWalked. Observe-posture read-only, kill-switch gated,
  never consents; deliberately NOT `TOOL_NAMES` vocabulary (computer use
  stays settings-gated).
- **Skill:** the built-in computer-use skill gained the "Big apps
  (browsers, Edge, VS Code)" paragraph — SEARCH with find_elements,
  element clicks over screenshots, NEVER loop screenshots when the tree
  can answer.

**Tests:** computer-dispatch 44 → **52** (happy path with registered
stateId + indexes/bounds/total, kind filter AND-rule, limit semantics +
clamp, empty-match refusal, find→click end-to-end with the returned
stateId+index, observe-posture runs it, kill-switch refuses, resolution
parity), computer-windows-backend 24 → **30** (the $maxEl 2400 pin + the
construction pins: the exact $probe list, non-interactive kinds not
probed, EXACTLY 4 GetCurrentPattern occurrences inside the interactive
branch, cached-handle reuse, detail-conditional bounds, the unchanged
parse path), computer-use-plugin 14 → **15** (the 31-tool list × both
postures + the registration/schema pin), skills-mcp **11** (the big-apps
body pin).

## B3+B5 — the vision split (Settings → Image Analysis + analyze_image)

**Fix:**
- **Storage:** `vision.mode`/`vision.provider`/`vision.modelId` settings
  rows (NEW `storage/vision.ts` — validated writes, safe reads); migration
  `0025_vision_settings.sql` seeds them from the legacy
  `computerUse.vision.*` rows (INSERT…SELECT + OR IGNORE — absent sources
  insert nothing, existing vision.* rows never clobbered) + a LAZY read
  for databases the migration has not touched; the legacy rows stay
  (read-only compatibility). `ComputerUseSettings` drops the vision block.
- **Routes:** `GET /vision/settings` (the bare object), `PUT
  /vision/settings` (validated patch → the new settings bare), `POST
  /vision/test` (a 1×1 transparent PNG through the CURRENT settings —
  off/main/unconfigured answer honest errors; there is deliberately no
  api.ts client for the test — the tab's settings + key presence are the
  truth). `PUT /computer-use/config` with a `vision` field → the honest
  `400 "vision settings moved to PUT /vision/settings"`. The vision KEY
  keeps the R61 `/computer-use/vision-key` routes + the
  `"<providerId>-vision"` keyring slot + the Tauri `store_vision_key`
  command (unchanged — the slot is THE slot).
- **UI:** NEW `ImageAnalysisTab.tsx` (mode radios — off / separate
  [recommended] / main; separate: provider select + model input with the
  supportsVision-filtered datalist + the masked key row with the
  Tauri-first durable store; main: the amber hint + per-provider eye
  toggles; one honest readiness line). ComputerUseTab's vision card
  REMOVED, replaced by the pointer card (data-testid
  `image-analysis-pointer`). Sidebar/SettingsPage register the section
  (`?tab=vision`, "Image Analysis", ScanEye).
- **Relay:** `relayVision` + `computer/vision.ts` + every error string now
  read the GLOBAL settings and point at Settings → Image Analysis; the
  computer-use and browser screenshot descriptions share the ONE
  configuration.
- **`analyze_image`** (NEW `tools/plugins/vision.ts`, plugin `core-vision`):
  `{path?|url?, instruction?}` — local file (png/jpg/jpeg/webp/gif/bmp,
  ≤8 MB, relative→root-resolved) or http(s) URL (≤8 MB, 20 s timeout),
  described through the same relay; honest ok:false on every failure,
  never throws; ALWAYS registered for every turn with a db (the OFF
  refusal IS the switch) → `TOOL_NAMES` **25** + api.ts `TOOL_CATALOG`
  grew it together (the drift guard); migration
  `0026_analyze_image_tool.sql` appends it to template + default-agent
  allowlists that carry `web_fetch` (curation-respect; `[]` = ALL already
  covers it).

**Tests:** vision-plugin **13** (fail-closed gates, registration with CU
OFF + vision OFF, every honest refusal, the end-to-end separate-mode path
+ URL download with UA, fetch stubbed), migration-0025 **5**,
migration-0026 **1**, ImageAnalysisTab **11**, ComputerUseTab 12 → **8**
(vision tests removed, the pointer test added); collateral updates in
permission-modes/r52-plugin-registry (13 plugins)/storage (migration
inventory)/computer-use-plugin fixtures.

## B4 — the settings rail when minimized

**Root cause:** the minimized 64px rail rendered the NORMAL projects nav
on `/settings` — the owner reported seeing the projects rail while in
settings.

**Fix:** `Sidebar.tsx`'s collapsed rail is MODE-AWARE — on `/settings` it
renders the SETTINGS rail (the section icons: Appearance, Agents, Models &
Providers, Sub-agents, Skills, MCP Servers, Computer Use, Image Analysis,
Advanced — same ids/order as the expanded settings list) with the gear +
back affordance; the projects nav is deliberately absent there.

**Tests:** Sidebar **15** (the settings-variant rail renders the section
icons + navigates `?tab=`, the normal variant keeps the projects rail).

## C1 — the post-turn context-free debug analyst

**Root cause (by directive):** the R65 debug mode made the agent grade its
own homework — the self-report prompt section had every incentive to
polish.

**Fix:**
- The R65 `## DEBUG MODE` prompt section + its registry entry + the golden
  lines are REMOVED (the fixture regenerated by the test file's own
  sanctioned procedure; `debugMode` stays declared as a no-op so callers
  keep type-checking — the live gate is the route-side phase).
- NEW `agents/debug-analyst.ts`: `buildDebugTranscript` renders the
  session's whole event log as USER/ASSISTANT/TOOL (FULL output — the
  4 000-char per-call cap already happened at persist time)/ERROR/
  APPROVAL lines; `debug.report` + unknown types skipped; a **60 000-char
  hard cap** with head 24 k + tail, whole middle blocks dropped behind
  `…[N events omitted]…`, degenerate single-block slice, budget math that
  holds the cap exactly. `runDebugAnalyst` = a FRESH call (the analyst's
  ~15-line system prompt, the keyring-scrubbed transcript as ONE user
  message, NO tools, maxTurns 1, temperature 0.2) streaming every
  text-delta as a `debug-delta` frame; provider failures → scrubbed
  `{ok:false}`; never throws.
- The stream route's `runDebugAnalystPhase` (after the outcome
  notification, BEFORE the terminal frame): the debug setting gate
  (default OFF), minimal session→agent→provider→key resolution, then
  `debug-start` → the analyst → persist `debug.report` `{content, model,
  ts}` UNCONDITIONALLY (a closed window still folds on reload) →
  `debug-done` (or `debug-error`). The gate fires on `outcome.ok` OR
  `status >= 500` — ABORTED (499) and 404/409 are never analyzed. The
  phase is double-wrapped: a debug failure can NEVER break the turn's
  terminal frame.
- **Isolation:** `assembleHistory` has no `debug.report` branch — follow-up
  turns NEVER see the report; the analyst's own transcript builder skips
  it too (an earlier analysis never leaks into a later one).
- **Frontend:** `DebugReportCard` (live: spinner + live partial markdown
  under the answer; done: full markdown + model chip + "context-free
  analyst" subtitle; error: the amber line) mounted in AgentChatPanel's
  live turn + the folded `AssistantTurnItem.debugReport`
  (`toProjectChatItems`: the report attaches to the open turn in its gap —
  endTs stretched — or the last-closed turn in the SAME user gap, never
  the next turn; strays drop honestly).

**Tests:** debug-analyst **10** (transcript rendering, the 60 k cap, the
degenerate slice, skip rules, the streamed path — deltas accumulate, NO
tools, ONE user message with the WHOLE transcript, the sync fallback,
provider-throw scrub, empty reply, keyring scrubbing); r58-stop-and-
replay +4 (the stream-route SSE order debug-start → 2×delta → debug-done
→ done, the persisted payload, the analyst-provider-dying → debug-error
with the turn's done still terminal, the 502-turn gate with the transcript
carrying `ERROR PROVIDER_ERROR:`); DebugReportCard **8**; api.test.ts's
debug.report folding cases (+6, now 90 total).

## The architecture (the three new round trips)

```
CHECKPOINT (A4)                          DEBUG ANALYST (C1)
tool: wait_for_verification              turn completes (ok | >=500)
  │ probe → wall detected                  │
  ▼                                        ▼
browser-checkpoint.ts registry           server.ts runDebugAnalystPhase
  ├─SSE─▶ browser-checkpoint frame        ├─SSE─▶ debug-start
  │        stream-store → liveTurn        │        (frontend opens the
  │        → BrowserCheckpointCard        │         live section)
  │        (countdown + done/stop)        ├─SSE─▶ debug-delta* ←─ chatStream
  ◀─REST─ POST /api/v1/browser-           │        (fresh model, no tools,
           checkpoints/:id/resolve        │         60k transcript)
  ├─SSE─▶ browser-checkpoint.resolved     ├─ persist debug.report (skipped
  ▼                                        │   by assembleHistory → never
re-probe → honest report                   │   in model-facing history)
                                           ├─SSE─▶ debug-done
VIEWPORT (A5)                             ▼ then done|error (terminal)
tool: set_viewport
  ├─SSE─▶ browser-viewport frame ──▶ stream-store (BEFORE the liveTurn guard)
  │                                     └▶ browser-store.applyAgentViewport
  │                                        (patch + agentViewportSeq++)
  │                                        └▶ BrowserPanel exits natural mode
  └─ 4s poll backfill (server viewport diff → same seq bump)
```

## Verification (re-run this round, fresh)

- Root `npx vitest run`: **1807/1807 in 118 files** (was 1686/110).
- agent-core: **980/980 in 58 files**; frontend `src/`: **815/815 in
  58 files** (root total = 815 + 980 + 12 root e2e).
- The R66 suites, each re-run scoped this round (counts as measured):
  browser-checkpoint **16** · browser-tool **43** (was 17) ·
  vision-plugin **13** · migration-0025 **5** · migration-0026 **1** ·
  debug-analyst **10** · r58-stop-and-replay **10** (was 6) ·
  computer-dispatch **52** (was 44) · computer-windows-backend **30**
  (was 24) · computer-use-plugin **15** (was 14) · skills-mcp **11** ·
  DebugReportCard **8** · BrowserCheckpointCard **8** ·
  ImageAnalysisTab **11** · ComputerUseTab **8** (was 12) ·
  ComputerMiniWindow **10** (was 7) · MiniApp **10** · Sidebar **15** ·
  BrowserPanel **36** · api.test **90**.
- `pnpm lint` CLEAN · `pnpm typecheck` CLEAN (repo-wide) ·
  `pnpm version:check` 0.66.0 ×4 · `pnpm docs:check` 0/0.
- The round's live check on the dev stack: onboarding → the new
  Settings → Image Analysis tab (mode radios, provider/model cards —
  machine-verified screenshot `assets/round-66/r66-vision-tab.png`) → the
  Computer Use pointer card → the minimized settings rail → a live session
  on `z-ai/glm-5.2:free` for the debug-analyst turn (screenshot
  `assets/round-66/r66-debug-analyst.png` — the archived shot captures the
  session before the turn; the analyst pipeline itself is pinned by the
  stream-route tests above). The native-bridge page actions (read_dom/click/type/
  press_key/eval) cannot run in the sandbox's web mode — they answer the
  honest refusal there; the owner's next live Windows run is their proof.

## What this round does NOT claim (known limitations)

- **Windows backends remain construction-tested only** — the headless
  Linux sandbox pins the walk's script by construction (the probe list,
  the 4-probe count, the 2400/25 caps); the owner's next live Windows run
  (Edge + find_elements + the mini window + a real bot wall) is the real
  verification, and the 25 s capsule timeout may want a bump if Edge
  walks time out in the field.
- **The checkpoint card is turn-bound** — it renders during a LIVE turn
  (tools only run inside turns, so this is the normal case); a wall hit
  during a background turn with no mounted chat panel shows no card (the
  tool still times out honestly and says so).
- **`analyze_image`'s relay labels every image media_type `image/png`** —
  jpg/webp/gif/bmp bytes ride the png label (pre-existing
  `describeRaster` behavior, flagged in the R66 worklog; the providers
  accept the bytes).
- **The debug analyst has no `maxOutputTokens` hard cap** — the
  ChatFn/StreamChatFn contracts expose no such parameter; the analyst is
  bounded by prompt discipline + `maxTurns: 1` (a follow-up chat.ts param
  is the noted fix).
- **navigate's wall probe can race a still-loading page** (single try,
  5 s, failures swallowed — the read action's detector over the fetched
  text is the second chance).
- **Wall self-bypass is future work** — the agent never attempts to solve
  a wall itself; it waits for the owner.

## Addendum (2026-09-05, the close-out session)

The round's original push (`47a2da3`) shipped with RED CI — the session
ended before anyone watched the run (golden rule 3). Two Windows-runner
flakes, both invisible in the headless Linux sandbox:

1. **BrowserCheckpointCard's countdown-tick test** waited on a REAL
   1-second boundary flip inside `waitFor`'s default 1000 ms budget — the
   display can only change after a full wall second, so a loaded runner
   loses the race (`expected '0:15' not to be '0:15'`). Fix (commit
   `96cf8f6`): `vi.useFakeTimers()` + `advanceTimersByTime(1100)` drives
   the flip deterministically (asserting the exact `0:14`), real timers
   restored in a `finally`.
2. **computer-use-plugin's `list_apps` execute test** crossed vitest's
   default 5000 ms — on the Windows runner it dispatches a REAL OS probe
   (the shared Add-Type/csc preamble compiles cold in seconds, plus the
   EnumWindows walk); the R65 green run's whole file took 8.7 s, the R66
   red run 12.7 s. Fix: explicit 30 s timeouts on the four real-probe
   execute tests (list_apps, screenshot ×2, the auto-posture resolver),
   with the rationale pinned in a comment. Counts unchanged.

No production code touched. CI run 33952264863 green on `96cf8f6`; tag
**v0.66.0** cut on it → Release run 33952608589 green (launcher kit +
NSIS installer + the draft release with both assets, verified via the
API); the public DASHBOARD truth-synced to 0.66.0 the same day.

### Addendum 2 (2026-09-05, later the same close-out session)

The DOCS commit (`e9848a6`) then flaked CI with a THIRD failure mode —
all 1771 in-run tests passed, but vitest caught an **unhandled error**:
`ReferenceError: document is not defined` inside
`popover-webview-guard.ts`'s debounce (`overlayPresent` at :88, the
80 ms `check` at :113). Root cause: `AppShell` installs the overlay
watcher on mount (module-global, once); any AppShell-rendering test file
that finishes with a DOM mutation in flight leaves the pending 80 ms
debounce ALIVE — the timer fires after the file's happy-dom environment
tore down, and the `document` global is gone. A pure teardown race,
surfaced by runner timing (the docs commit changed no code).

Fix: the `check` callback now guards `typeof document === "undefined"`
(the watched world is gone — skip the probe; inert in the real app where
`document` always exists), and `resetOverlayWatcherForTests()` now also
DISCONNECTS the observer (module-scoped) instead of only clearing the
timer. Verified: the guard's own suite + AppShell's suite + the full
root run 1807/1807 (with the e2e suite live against the built dist),
lint/typecheck clean.
