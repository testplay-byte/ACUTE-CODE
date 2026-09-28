<!-- last-reviewed: 2026-09-28 round-132 -->
# Round 132 — the mini agent partner + the download truth + the quiet mobile

**Owner directive:** his device pass on v0.124.0 (the sixth feedback
conversation) + THE MINI AGENT feature (now explicitly in-scope — R131's
"future work" gate is lifted by his own words: *"what I want you to do is
that I want you to implement a new functionality… the functionality of a
mini agent"*). What he confirmed GOOD (no work): the mobile update flow's
happy path (check → bottom-sheet → download → ready-to-install), the
mobile thinking display ("properly shown, just like how it was meant to
be"), the context window at the bottom ("perfect. Good improvement
there"), the workspace scaffold (he verified `.acute/` with five entries
on a fresh project), and the agent-driven browser download task
("acceptable… good work with all of that"). What he wants, in his words:

1. **The mobile update MENU can desync** — "sometimes the downloading
   options would disappear and would not be shown even though the
   download was happening, and if I click check for updates and click
   download again, it would say download already happening, which was
   not a good experience."
2. **The mobile tool cards are STILL too loud** — "the toolbars were
   most definitely highlighted way too much too. Like they can show the
   SVG icon alongside with them, but getting a dedicated section is most
   definitely not good."
3. **The chat minimum width is too much** — "The minimum chat area width
   was in place, but I feel like that it was a little bit too much. It
   could be made a bit more smaller, like a bit more flexible."
4. **The native Save-image-as is broken** — the Windows Save-As dialog
   "had selected the actual download folder of the device, not the
   proper folder which it was supposed to be"; and saving — even into
   the correct project folder — "still it says images.jpg, the download
   was interrupted, and the image was actually not being saved."
5. **The browser should feel like a real, well-managed native browser**
   — "I don't feel like that the browser is a full native experience…
   I don't think like we have a proper base of our own browser."
6. **The computer-use skill underperforms** — Edge "opened up in the
   background" (not foregrounded); the agent "eventually ended the
   session… it said that it was a host issue"; after continue it
   "was not capable of performing the actions that well."
7. **The agent deserves its own environment** — "give the agent a custom
   environment of itself, like how Z code gives a custom environment of
   itself, like a browser of itself and such. Like the user can keep on
   using his computer as he wishes, but the agent will be given a custom
   computer kind of vibe, like a section in the computer or a screen to
   itself."
8. **THE MINI AGENT SYSTEM (the centerpiece)** — the main agent
   dispatches a quick natural-language task to a mini agent (a PARTNER,
   not a sub-agent); the mini agent is specialized in ONE skill
   (browser use, computer use, file search — pre-given the skill's
   details); it runs its own small model loop (its own model per
   settings, or the main one); it performs quick smart actions and
   returns the result + the current state; a dedicated section appears
   in the chat while it works (the prompt the main agent gave it + its
   actions, rendered like a tool call); the main agent can create mini
   agents itself (a custom specialization); up to 3 run concurrently
   (capped for now); they are DISPOSABLE — one-time, scrapped after, no
   resume, no long conversations, never long-horizon. Settings: a few
   customizations — which model/provider the mini agents use, or "use
   the main one." And: *"test these mini agents out in your own
   environment too, first of all… keep on improving it until we have a
   fully functional, highly capable, highly reliable system."*
9. **Space Bunny Alpha** — the owner's named free stealth model
   (verified live this session: 1M context, native tool support, $0) is
   the round's test model.
10. **The PC update calm rides the NEXT cycle** — the v0.123.0→v0.124.0
    update flashed terminals (expected: the old binary was still on the
    old update path); *"the changes were supposed to be applied from the
    next version moving forward. So we can test it in the next one"* —
    the v0.124.0→v0.125.0 update on the owner's device is the U-wave's
    real gate.

**Method:** the playbook arc verbatim — this plan first, the backup
branch `backup/pre-r132-improvements` pushed at the clean v0.124.0 tip,
then the waves in dependency order (max 2 concurrent), every gate green
before the next, honest records in the worklog, the local live battery
(Space Bunny Alpha) as the round's own verification gate, the release
last.

---

## §0 The research (three parallel explore passes, file:line evidence)

- **The mobile-update map** — ALL download state is component-local in
  the route `mobile/app/settings/update.tsx:102-118` (useState:
  downloading/received/total/downloaded); the route unmounts on back/tab
  navigation while the native OkHttp transfer keeps running in the
  module's process-lifetime scope (`activeCall`,
  AcuteInstallerModule.kt:79); the native module exposes NO
  status-query function (only downloadApk/cancel/install/
  canRequestInstalls/delete/openInstallPermissionSettings + the
  throttled progress event at :356-368); on re-mount the progress card's
  gate `(downloading || downloaded !== null)` (:325) renders NOTHING and
  the sheet's Download button shows again (:414); tapping it → the
  native single-flight rejection `promise.reject("busy", "a download is
  already running")` (Kotlin :114-117) → the screen's catch
  (:187-199) classifies only "canceled" → the raw message as an ERROR
  TOAST while `finally` flips `downloading` back false. Sibling defect:
  if the first download COMPLETED while away, `activeCall` is null →
  tapping Download silently DELETES the cached APK (Kotlin :127-128) and
  re-downloads ~57MB. No screen-level tests exist at all.
- **The mobile tool-card map** — the R131-M register still ships a
  bordered/tinted GROUP CARD (`styles.toolCallCard`, transcript.tsx:
  :3543-3548 + inline tints :1976-1986), a multi-call HEADER that reads
  as a section title (`ToolGroupHeader` :2029-2077), 12px card padding +
  8 inter-group gaps, and a 1.5px left family stripe per row
  (:3576-3580) — the four contributors of the "dedicated section" feel.
  The 13px family icon (:2132-2142) IS the "SVG icon alongside" the
  owner wants, already in the faded family color. The structural laws to
  preserve byte-untouched: emission-order interleave (:1276-1291),
  collapsed-default/live-open/failed-stays-open (:1925-1966, hold 2500),
  tap-anywhere (:2218-2230), the toolActivity matrix (:1320-1346),
  failures full-strength (:326-331).
- **The chat-fit map** — `CHAT_MIN_WIDTH = 400` (ChatFocusLayout.tsx:80)
  was measured for the model pill's 80px label tier; the toolbar's true
  one-line floor with EVERY tier fired (model logo-only ≤350 container —
  the R89-D2 owner-sanctioned tier) is **242px of toolbar inner width =
  F − 44**, so a floor of **360** leaves 74px daylight and **340**
  leaves 54px — the floor can drop to 360 with ZERO new collapse tiers.
  The queue button is already icon-only (28px, pinned Composer.tsx:
  :777-784 + test :2660-2667). The five soften-band literals + the
  413/414 zero-boundary pins move 1:1 with F (ChatFocusLayout.test.tsx:
  :86-87, :112-125).
- **The native-downloads map** — the decisive symptom: **the Save-As
  DIALOG appeared at all.** With `Handled(true)` set (browser.rs:1326)
  WebView2 never shows a dialog — so the handler did not intercept THAT
  event. External evidence verified live (Microsoft's feature map +
  StackOverflow 73464438): WebView2 has TWO separate API families — the
  **Download APIs** (DownloadStarting — what we registered, browser.rs:
  :1279) and the **Save-as APIs** (`ICoreWebView2_26::add_SaveAsUIShowing`,
  `SaveAsUIShowingEventArgs{FilePath, Cancel, …}` — "these APIs pertain
  only to the Save as dialog, not the Download dialog"); on the owner's
  runtime "Save image as…" rides the save-as family, which we never
  touch → the dialog defaults to the profile's DefaultDownloadFolderPath
  (the device Downloads — symptom 2) and the interrupted leg follows
  (the toast at BrowserPanel.tsx:1796-1797 matches his phrasing at least
  as well as Chromium's own bubble). Concrete API gaps to close (all in
  the in-tree webview2-com 0.39.1, zero new deps):
  `ICoreWebView2Profile::SetDefaultDownloadFolderPath` (fixes the dialog
  default outright), `add_SaveAsUIShowing` (the designated interception
  surface), `op.InterruptReason()` (today discarded — the toast cannot
  name WHY), and the pop-out gap (popout.html never calls
  `nativeTabSetDownloadDir` nor subscribes `onBrowserDownload` — saves
  there silently land in the device Downloads). Registration itself is
  sound: `browser_tab_create` registers at CREATE time on exactly the
  webview right-clicked (:1144), wry adds no competing handler, the dir
  fallback resolves on Windows. Shared profile:
  `<app_local_data>/browser-profile` for ALL tabs (:368-377) — the
  in-tree Chromium-family runtime (the honest scoping stays: bundling a
  separate Chromium engine remains an owner-gated ADR).
- **The mini-agent map** — PARALLEL TOOL EXECUTION IS CONFIRMED
  CONCURRENT: the AI SDK (`ai@7.0.73`) executes all tool calls of one
  assistant message via `Promise.all` (node_modules/ai/dist/index.js:
  :6087-6101) — three `mini_agent` calls in ONE message run natively in
  parallel, so the 3-cap is enforced INSIDE the tool (module-level
  reservation, the honest-refusal shape of the r79 cap), and every frame
  needs a stable `miniId` (the R128-W5 out-of-order lesson). The tool
  registry: a new plugin `tools/plugins/mini-agent.ts` (the delegation
  template — never-throw, `toolDeps`-gated, honest `{ok:false}` outputs)
  joins `BUILT_IN_PLUGINS` (registry.ts:112-141). The loop: a FRESH
  light partner loop `agents/mini-agent.ts` calling `streamAiSdkChat`
  directly (chat.ts:1162) — NOT `runStreamedAgentTurn` (it writes
  `message.user` + flips session status — pointing it at the parent
  session would corrupt the parent log) and NOT the delegation runner
  (children get full child sessions + 25K prompts + resume semantics —
  everything the owner explicitly does NOT want). The debug analyst is
  the side-loop precedent (routes/sse.ts:449-530). The skill bodies:
  `BROWSER_USE_SKILL_BODY` (storage/skills.ts:370-395) and
  `COMPUTER_USE_SKILL_BODY` (:133-228) seed the specializations; the
  search skill is a new small body. Frames: new
  `mini-agent.started/action/done` members of the PC union (api.ts:3728+)
  + a branch in `handleStreamEvent` BEFORE the liveTurn guard
  (stream-store.ts:1742+, the subagent-status precedent) + the fold in
  `toProjectChatItems` (api.ts:1600) for reload. Persistence: parent
  `session_events` rows (zero migrations; 0044 stays reserved). Settings:
  `orchestration.miniagentModel` `{providerId, modelId} | null` in the
  orchestration domain (settings.ts:209-252 is the validation template;
  the SubAgentsTab "Inherits main model" pattern is the UI precedent).
  Approvals: the mini's tools flow through the SAME pipeline
  (buildApprovalDeps + interactiveApprovals) — a mini's consent-gated
  action must attribute by miniId (3 concurrent minis can stack cards).
  **The prompt budget constraint:** the R113-f pin is 25,200 chars and
  the measured composition is 25,069 — only 131 chars of headroom for
  the mini_agent line in the system prompt's tool list + core-vocabulary
  block (prompts.ts:484/:527-565); it must be PAID FOR (a trim or a
  re-pinned ceiling with the measurement recorded — the R131-B
  precedent). The tool's own description rides the tools param (outside
  the law).

## §1 The waves (dependency order)

### Wave CF — the chat fit, one notch smaller (files: ChatFocusLayout.tsx, ChatFocusLayout.test.tsx, Composer.test.tsx comments)

- **CF1 — the floor drops 400 → 360.** At 360 the @container is ~332:
  every collapse tier has fired (model logo-only ≤350 — the R89-D2
  owner-sanctioned tier; mode @max-[560px]; thinking @max-[500px];
  Continue @max-[460px]; dock @max-[420px]) and the one-line floor is
  242px of toolbar inner width vs ~316 available — **74px of daylight,
  zero new tiers, the R51-c wrap stays the absurd-width emergency
  only.** The measurement comment is rewritten with the new math; the
  five soften-band literals + the 413/414 zero-boundary pins re-pin 1:1
  (the band boundaries move −40); the queue-icon pin's comment re-words
  its floor reference.

### Wave MU — the mobile update menu never lies (files: mobile/src/update/*, the Kotlin module, app/settings/update.tsx, tests)

- **MU1 — the state outlives the route.** A module-scope download
  manager singleton in `mobile/src/update/` (the native floor is
  process-lifetime; the JS state must match it): owns the live handle,
  the received/total/startedAt state, the completion result, and the
  subscriber set; the route subscribes on mount and renders from the
  singleton — a back-navigation mid-download changes nothing.
- **MU2 — the native status probe.** `getDownloadState()` on the Kotlin
  module (url/bytes received/total/active — reads `activeCall` + the
  throttled progress plumbing): on re-mount the screen re-attaches to
  an in-flight download (progress bar, cancel, the sheet's live state)
  instead of a blank menu.
- **MU3 — "busy" classifies to re-attach.** The catch's taxonomy gains
  the `busy` code → the UI reflects the LIVE singleton state (never an
  error toast when the download is genuinely running). The completed
  state is never silently destroyed: tapping Download with a completed
  result present confirms/installs instead of re-downloading.
- **MU4 — screen-level tests** (none exist today): the state-machine
  suite (mount-mid-download re-attach; busy → live state; completed →
  no silent re-download; cancel; error).

### Wave MT — the mobile tool calls lose the section (files: transcript.tsx, turn-block.ts if needed, DESIGN.md §9, tests)

- **MT1 — the card dies.** The group card (border + tint + 12px padding
  + the multi-call header line + the inter-group boxed gaps) is retired:
  tool runs render as PLAIN inline rows — the 13px family SVG icon
  alongside the TypeMono title in the faded family color, rows separated
  by whitespace alone, no container. The 1.5px stripe dies with the card
  (the icon carries the family identity now).
- **MT2 — the register goes quieter still.** The remaining row grammar:
  transparent background, secondary ink, the compact press feedback, the
  failed wash and live tails stay full-strength (the honesty laws), the
  collapsed-default/live-open/failed-stays-open laws + hold 2500 +
  tap-anywhere + the toolActivity matrix ride byte-untouched.
- **MT3 — the pins.** The R131-M visual pins re-pin to the no-section
  law (`transcript-turn.test.ts:537-603` + the card-geometry subset of
  `:336-345`, holding 2500); DESIGN.md §9 rewritten.

### Wave BD — the save-as truth (files: src-tauri/src/browser.rs, src/lib/native-browser.ts, BrowserPanel.tsx, popout wiring, tests)

- **BD1 — the profile default download folder.** `browser_tab_set_download_dir`
  (and the register pass) sets `ICoreWebView2Profile::
  SetDefaultDownloadFolderPath(<root>/.acute/downloads)` on the shared
  profile — the Save-As DIALOG then defaults to the right folder even
  when the save-as family bypasses DownloadStarting (symptom 2 dead
  outright).
- **BD2 — the save-as interception.** `ICoreWebView2_26::
  add_SaveAsUIShowing` registered beside DownloadStarting: steer the
  event args' default FilePath to `<root>/.acute/downloads/<suggested>`
  (never Cancel — the native save-as experience stays; the owner picks
  the final name), so the chosen pipeline lands in the project by
  default.
- **BD3 — the interrupt truth.** The StateChanged follower reads
  `op.InterruptReason()` and puts it on the wire (`interrupt_reason` on
  the BrowserDownload payload, snake_case) — the toast names WHY
  ("interrupted: file failed / access denied / …") instead of the bare
  phrase; every download event logs a `browser:` line to sidecar.log
  (the owner's device pass yields diagnostics, not ambiguity).
- **BD4 — the pop-out parity.** popout.html (the pop-out chrome) calls
  `nativeTabSetDownloadDir` for its content tab + subscribes
  `onBrowserDownload` for its own toast — saves from the pop-out land in
  the project folder with feedback, not silently in the device
  Downloads.
- **BD5 — the stale comments sync** (`<root>/downloads` →
  `<root>/.acute/downloads` at browser.rs:217, lib.rs:125,
  EMBEDDED-BROWSER.md:369).
- **Rust caveat:** the exact webview2-com 0.39.1 surface (ICoreWebView2_6
  Profile cast, ICoreWebView2_26 cast, SaveAsUIShowingEventArgs members,
  InterruptReason enum) is verified against the in-tree crate source at
  implementation time; compilation gates on the re-installed LOCAL
  windows-target cargo check (the R131 recipe) + CI's
  `cargo check --locked` (ci.yml:84-94). The COM behavior itself
  verifies on the owner's device pass — declared.

### Wave CU — the agent's own screen + the honest computer use (files: windows.ts backends, dispatch.ts, computer-use skill body, popout/desk machinery, prompts)

- **CU1 — open_application FOREGROUNDS.** After a successful
  Start-Process, the backend polls for the new process's main window
  (bounded ~3s) and activates it (the U32 SetForegroundWindow path with
  the UIA SetFocus fallback — the C3 ladder reuse) — "it opened up in
  the background" dies.
- **CU2 — the Agent Desk v1.** The agent's own screen, on the pop-out
  machinery: a browser command `open_desk` (agent-triggered) opens the
  pop-out browser window in DESK mode — always-on-top, a sensible
  default position/size (restored per project), a distinct title — and
  its content webview is a NORMAL TAB (popout-tab.ts already creates it
  via `browser_tab_create`), so the agent drives it with the EXISTING
  browser tools, and the screen-screenshot sees it. The user's desktop
  stays theirs; the agent's web work happens on its own visible screen.
- **CU3 — the skill teaches the desk.** The computer-use skill body (and
  the mini agent's computer specialization) learns the boundary: web
  work belongs on the desk (browser tools); real-desktop computer use is
  for what the user explicitly wants on THEIR desktop; the honest
  capability claims stay.
- **CU4 — the resilience.** The "host issue → ended the session" shape:
  the dispatcher's consecutive-failure circuit breaker (R131-C5) gains
  the stop-and-report refusal on the HOST-error class too (a dead host
  capability reports + yields to the user instead of ending the turn),
  and the session never auto-ends on a tooling failure — the model gets
  the honest error + recovery guidance. (The owner's exact symptom:
  "it eventually ended the session, and it said that it was a host
  issue.")

### Wave MA — THE MINI AGENT SYSTEM (the centerpiece; two sub-waves)

**MA-core (agent-core):**

- **MA1 — the plugin.** `tools/plugins/mini-agent.ts`: the `mini_agent`
  tool — schema `{skill: "browser"|"computer"|"search"|"custom", task:
  string, instructions?: string (custom only)}`, never-throw execute,
  `toolDeps`-gated, the 3-cap enforced inside (module-level atomic
  reservation; the honest `{ok:false}` "3 mini agents already running"
  refusal — never a queue), abort-aware (the parent turn's signal).
  Registered in BUILT_IN_PLUGINS. The specialization gates: browser/
  computer skills refuse honestly when their master switches are off
  (the read_skill refusal precedent).
- **MA2 — the light partner loop.** `agents/mini-agent.ts`: resolve the
  model (the `orchestration.miniagentModel` setting ?? the parent's
  provider/model/key), build the system prompt (a SHORT wrapper —
  identity, the disposable one-task law, the report format: what was
  done + the current state + artifacts — plus the SKILL BODY), build the
  tool subset (`buildProjectTools(root, allowlist, toolDeps)` with the
  mini-tagging wrapped emit + the SAME approval pipeline), and run
  `streamAiSdkChat` directly with a small budget (maxTurns ~8,
  timeout ~180s, an output cap). The result returns to the MAIN model
  as the tool result (the mini's tool chatter NEVER enters the main
  context — the efficiency is the point); the actions surface only as
  frames + events.
- **MA3 — the frames + the events.** `mini-agent.started {miniId, skill,
  task, model}` → `mini-agent.action {miniId, seq, tool, summary, ok}`
  → `mini-agent.done {miniId, ok, result, steps, usage}` on the parent's
  SSE (mirrored to the events bus by the existing send() wrapper);
  persisted as parent `session_events` rows (fold on reload); usage
  recorded with origin "mini-agent" (the meter's attribution truth).
- **MA4 — the settings.** `orchestration.miniagentModel` in the
  orchestration domain: `{providerId, modelId} | null` (null = "use the
  main one"), validated against the catalog + tool-capability (the
  subagentModel template), broadcast on change; the routes + validation
  + tests.
- **MA5 — the prompt budget paid for.** The mini_agent line lands in
  the system prompt's tool list + core-vocabulary block PAID FOR by a
  trim (or a re-pinned ceiling with the Windows-platform measurement
  recorded — the R131-B precedent); the golden fixture regenerates in
  the same commit.
- **MA6 — the prompts teach the partner.** The main agent's prompt
  gains the mini-agent guidance: WHEN (small, quick, specialized,
  parallelizable — up to 3 at once), WHAT (a clear natural-language
  goal with the why, not step-by-step), WHEN NOT (long-horizon work,
  anything the main tools do trivially), and the report shape it gets
  back.

**MA-ui (frontend):**

- **MA7 — the dedicated chat section.** The MiniAgentSection card
  (live + folded): the skill badge + status; THE PROMPT the main agent
  gave (the owner's explicit ask); the compact action rows (live-
  updating, the quiet register); the final result + steps + usage; the
  attribution by miniId (concurrent minis stack as sibling sections).
  The `mini_agent` tool pill itself renders like a tool call (it IS
  one). The fold in `toProjectChatItems`.
- **MA8 — the settings surface.** The SubAgentsTab pattern: a small
  "Mini agents" card — the model override picker + "Inherits main
  model" (null) default; the tool-capability validation surfaces
  honestly.
- **MA9 — mobile minimal treatment.** The mobile union gains the
  frames + a single quiet inline row per mini run (skill + task
  headline → result), riding the new MT register — full sections are a
  future round (declared, not silently skipped).

### Wave V — the live battery (the round's own gate)

The R130-E/R131 pattern at full scope with
`stealth/space-bunny-alpha`: the real sidecar (scratch DB + the real
SSE pipeline) + the real vite app —
- a real turn dispatching a SEARCH mini agent end-to-end (the frames,
  the section, the honest result, the events persisted);
- a parallel dispatch (TWO mini agents in ONE message → the concurrency
  proof: both run, both return, the cap honest);
- the cap refusal at 3 (a scripted 3rd+4th);
- the custom skill (the main agent supplies the specialization);
- the settings override live (a different model for the mini);
- the update-menu state machine (mount-mid-download via the singleton
  — headless at pin level, the device pass completes it);
- the chat floor at 360 (the composer battery at three widths — no
  wrap, the queue fits);
- the mobile tool rows (the no-section register, pinned + a visual
  pass if the emulator path is unavailable: pin-level declared);
- screenshots into shots/r132/.

## §2 The gates (unchanged, the house law)

Root tsc + the FULL vitest sweep + agent-core tsc/vitest + mobile tsc +
CI=1 jest + eslint 0 + design-audit at-or-below baseline + docs:check +
version:check at the bumped 0.125.0 + license audit. The Rust legs gate
on the re-installed LOCAL windows-target cargo check + CI's
`cargo check --locked`. The live battery is the round's OWN gate per the
owner's directive.

## §3 Rollback

`backup/pre-r132-improvements` at the v0.124.0 tip (4001f3e's tree).

## §4 Honest caveats (pre-declared)

- The Rust legs (BD's save-as/profile COM paths, CU1's foreground) are
  compile-verified locally (windows-target cargo check) + CI; the
  runtime COM behavior verifies on the owner's device pass — the
  InterruptReason + the `browser:` log lines are designed to make that
  pass diagnostic, not ambiguous.
- The computer-use Windows legs (the app resolver, focus, the desk on
  the real desktop) verify on the owner's device; the sandbox pins the
  pure logic + the dispatch contracts.
- The mini agent's browser/computer specializations can only be
  exercised live at the logic level in the sandbox (no Tauri shell
  here): the SEARCH specialization runs fully live; the browser/
  computer specializations are pin-level + battery-level (the loop, the
  frames, the cap, the disposal) with the tool-facing legs declared.
- The PC update calm (R131-U) rides the v0.124.0→v0.125.0 update on the
  owner's device — this round's release IS its test.
- Mobile mini-agent rendering is the minimal row (MA9); full mobile
  sections are a future round, declared.
- The "own Chromium build" question stays scoped honestly: the in-tree
  WebView2 IS the Chromium-family base; bundling a separate engine
  remains an owner-gated ADR (R131's record stands).

## §5 The waves as they landed

(filled as the waves land)

## §6 The close-out verification

(filled at close)

## §7 The release end-state

(filled at close)
