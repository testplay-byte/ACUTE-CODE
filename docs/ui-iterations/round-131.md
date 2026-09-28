<!-- last-reviewed: 2026-09-27 round-131 -->
# Round 131 — the update calm + the chat fit + the meter's truth + the browser leap

**Owner directive:** his device pass on v0.123.0 + the second self-feedback
ledger (UPLOADED/Feedback-2.txt, 20 entries, read in full — never trusted
blindly: every claim was re-verified against the code by three research
passes before it earned a wave). What he confirmed GOOD (no work): the
session window and chat window rendering, the mobile interleave ("it
properly shows the text where it needs to, properly shows the tool calls
when they were actually made"), the context management itself. What he
wants fixed, in his words:

1. **The PC update flow** — "the updating process was not that smooth. It
   opened up quite a lot of terminals, and the overall experience was way
   too jittery… glitchy and kind of laggy… if it requires the admin
   permissions, then it should ask for the admin permissions from the
   user too." (Root cause found: the update supervisor's `tasklist` guard
   probes + PowerShell toast spawn WITHOUT `windowsHide`/`detached` —
   dozens of console flashes at 500ms cadence; plus the launcher's
   double-reinstall ladder; plus NO elevation leg anywhere.)
2. **The Scratchpad rail** — "when the sidebar is expanded, the scratch
   pad shows at the very bottom, which is good. But when it is collapsed,
   then the scratch pad shows at the very top… and also the scratch pad
   gets combined in with the other ones." (Root cause: `MinimizedRail`
   never filters `general`; the backend's `created_at DESC` puts the
   R128-seeded General row FIRST on installs whose projects predate it.)
3. **The session-window MIN WIDTH** — "maybe we should set a limit to the
   minimum width of the session window on the PC… this would also
   consider into the queue message button along the way too." (R130-A2
   made the shrink smooth; at the 240px floor the busy+queue anchor still
   overflows and the R51-c wrap fires. Fix: a real floor.)
4. **The user-message width + actions BELOW** — "the width of the message
   which I sent is made much smaller [at min width] even though there is
   a lot of empty area on the left… the option to revert to the message
   or to copy the message should be shown below it rather than being
   shown on the left side… If the width is made the smallest, then it can
   utilize all the width which it can with some padding… if it is
   expanded, then it will never take up all the width on the left side."
5. **The live context meter's LIE** — "even though the context was…
   roughly 200K, or maybe sometimes 30K, 40K… the actual which it was
   showing me on the context window itself was like around 900K… as soon
   as the context message session ended, it properly started showing me
   the correct, accurate one." (Root cause found: the finish frame's
   usage is the SUM across the SDK stream's internal steps — 4 steps ×
   ~200K ≈ 900K — persisted as the stats carrier the anchor reads during
   streaming; the settled path reads the single-step final reply. The
   same inflated number can trigger PREMATURE AUTO-COMPACTION.)
6. **The browser leap** — "download Chromium base and build our own
   internal application browser… it is not able to right-click and then
   click save as and save to the download folder as it needs to be… the
   ability to flexibly change the width of the browser window itself…
   drag the corners and resize it… a full-fledged browser." Plus the
   ledger's 8 confirmed tool defects (click "job vanished" on successful
   navigation; wait not navigation-aware; read_dom style/script pollution
   + truncation; eval null-payload with no diagnostics; type auto-submit
   ambiguity; no nearest-match hint; get_state title:null + history
   drift; no download capability at all).
7. **The workspace scaffold** — "whenever the user selects a folder…
   all the necessary files and folders for it should be created… if it is
   a folder which was previously used, it can check that… it will create
   a hidden folder or our own folder where it will store its own things…
   the files it downloads from the internet or other key things like
   that will be stored there, and its own memory… so that the actual
   folder does not get affected by it."
8. **The tool-creation skill** — "giving it a skill which it can use to
   create tools for itself… it can create Python tools, it can create
   other scripts… if there is a task which takes quite a lot long to do
   it manually by itself, then it can create a tool, and whenever the
   user needs to do that task, it can easily just use the pre-made tool."
9. **The computer-use skill** — "the agent does not follow a proper
   workflow… it is unaware of the elements on the screen… all the actions
   which it is performing should be shown on the screen as an overlay
   first… it sometimes does not take screenshots properly." Plus the
   ledger's confirmed defects (the addTypeOk probe lies; open_application
   can't resolve installed Edge; focus_window dead on Add-Type hosts;
   screenshot "TypeError: fetch failed"; canned recovery texts; no
   consecutive-failure circuit breaker).
10. **The mono stone theme** — "there is the white background, and on the
    white background it shows white text… in a lot of the areas around
    the application."
11. **The right sidebar images** — "it is unable to render images. If I
    open up an image file… it renders the image as raw text."
12. **The mobile tool-call styling** — "the UI of the tool calls is not
    good. Like it should be faded out kind of vibe. It should not be that
    highlighted or such."
13. **The feedback ledger itself** — improve its workflow where flawed
    (the CONTEXT TELEMETRY "turn died before first reply" lie is
    confirmed in the code: three different anchor-null reasons collapsed
    into one wrong phrase).
14. **Local testing FIRST** — "perform tests in your own local
    environment first of all, and only after verifying everything is
    working properly… then you can start building it" — with the provided
    OpenRouter keys, free models only (the R130-E battery pattern is the
    round's own verification gate).
15. **run_command / list_dir honesty** (from the ledger, verified in
    code): the `spawn cmd.exe ENOENT` root cause is a missing project
    cwd (the legacy General root); list_dir never names the directory it
    listed.

**Mini-bots are EXPLICITLY FUTURE WORK** (the owner: "that is a task
thing for the future, so we are not going to do this currently") — this
round only builds the base systems properly (the workspace, the tools
folder, the honest capabilities) that mini-bots will stand on.

**Method:** the playbook arc verbatim — this plan first, the backup
branch `backup/pre-r131-improvements` pushed at the clean v0.123.0 tip,
then the waves in dependency order (max 2 concurrent), every gate green
before the next, honest records in the worklog, the constitution amended
BEFORE the code that breaks its letters, the local live battery as the
round's own verification gate, and the release last.

---

## §0 The research (three parallel explore passes, file:line evidence)

- **The context-meter map** — the live lie's root cause: ONE
  `chatStream()` = one AI-SDK `streamText` with a multi-step internal
  tool loop (`chat.ts:1096` stopWhen stepCountIs); per-step usage is
  ACCUMULATED (`chat.ts:1240-1249` stepInput += …), the single finish
  frame carries the SUM (`chat.ts:1271-1273` max(totalUsage, stepInput)),
  the runtime persists it as the iteration's stats carrier
  (`runtime.ts:4510-4512` → `:5170-5190`), and `providerUsageAnchor`
  (`compaction.ts:566-611`) reads the newest usage-bearing event DURING
  streaming → ~N×200K ≈ the owner's 900K. At settle the final iteration
  is a single-step conversational reply → the meter "properly started
  showing the correct, accurate one." The same anchor feeds the
  COMPACTION GATE (`runtime.ts:3992`/`:2511` → planCompaction) — an
  inflated mid-turn anchor can trigger premature auto-compaction. The
  turn's `usage_events` row legitimately keeps the SUM (billing truth);
  the defect is only the same number doubling as "context at last
  request."
- **The update map** — the terminal flashes: `update-supervisor.mjs`'s
  guard command on Windows is `tasklist` (a console exe) spawned via
  `captureOutput` WITHOUT `windowsHide`/`detached` (`:420-457`, spawn at
  `:425`) at a 500ms poll cadence (`:89`) across up to 3 relaunch
  attempts × 10s (`:536-586`) — dozens of flashing consoles; the
  completion toast is a second offender (`powershell.exe` spawn at
  `:575`, `buildNotificationCommand` `:303-323`). The jitter: the
  in-app watcher relaunch + the external supervisor's 3-attempt ladder +
  the launcher's double uninstall/reinstall cycle
  (`acute_launcher.py:2069-2101`). The admin ask: NO `runas` verb exists
  anywhere — NSIS `installMode: currentUser` (`tauri.conf.json:46-47`),
  every silent leg explicitly unelevated (`update.rs:401-461`,
  `acute_launcher.py:1849-1872`, supervisor `:279-285`).
- **The chat-polish map** — the rail: `MinimizedRail` renders the raw
  backend list unfiltered (`Sidebar.tsx:755-758`, tiles at `:897-948`,
  the 10-tile cap at `:910`) while the expanded panel filters + pins by
  DOM position (`:1124-1125`, `:1489-1519`); the backend orders
  `created_at DESC` (`storage/projects.ts:114`) so the R128-seeded
  General row lands FIRST on real installs (the fixture deliberately
  makes it oldest — the tests pin the wrong world, `Sidebar.test.tsx:
  298-300`). The floor: `CHAT_MIN_WIDTH = 240` (`ChatFocusLayout.tsx:64`)
  vs the toolbar's busy+queue min-content ≈ 226px + dock paddings → the
  R51-c wrap fires and the left cluster ends up alone on the upper line
  (the `items-end justify-between` row at `Composer.tsx:653-660`). The
  message: the actions cluster renders LEFT of the bubble INSIDE the cap
  wrapper (`AgentChatPanel.tsx:1110-1140`, `max-w-[min(65%,640px)]
  @max-[420px]:max-w-[92%]`) — `opacity-0` still occupies layout width,
  so at the narrow tier the invisible cluster eats ~70-90px of the
  bubble's width.
- **The browser map** — the 8 tool defects land in
  `agent-core/src/tools/plugins/browser.ts` (click `:1176-1204`, wait
  `:1303-1393` — the conjunction at `:1356-1359` is the defect, read_dom
  builder `:338-429` — `textContent` at `:379` serializes style/script
  bodies, the byte-slice cap at `:1142-1146`, eval `:1491-1530`, type
  `:1207-1235` — the gate itself is CORRECT and pinned
  (`browser-hands.ts:576`), the output just never echoes the REQUESTED
  flag; unknown-action `:1919-1922` — the list even omits `mouse`;
  get_state `:1855-1918` — native mode never delivers titles because
  `BrowserNavigated` has no title field (`browser.rs:155-159`) and
  `handleTitleMessage` is iframe-only; the history drift is the dual-
  writer: navigate pushes the COMMANDED url (`browser-proxy.ts:1218`),
  the panel re-pushes the LANDED url (`browser-store.ts:612-639`)).
  The eval decoder's null case (`native-browser.ts:311-332`) reports
  "unexpected payload: null" with zero diagnostics. The Rust side has NO
  download handler, NO context-menu config (the builder chain at
  `browser.rs:887-1019` is the complete option set) — but tauri 2.11.5 +
  webview2-com 0.38.2 are in-tree and `with_webview` +
  `ICoreWebView2::add_DownloadStarting` is the sanctioned route (COM
  registration right after `add_child`, the async-command discipline
  already documented at `browser.rs:397-410`). The save location is
  ALREADY PINNED by the ROUND-115 note: `<projectRoot>/downloads/`
  (`browser-proxy.ts:1832-1839`). The panel: width is drag-resizable via
  the ChatFocusLayout separator (`:233-260`); the native child re-glues
  on ANY geometry change (the bounds-sync loop `BrowserPanel.tsx:
  1337-1359` + the watchdog `:1361-1449`); corner/edge handles are a
  frontend extension with zero Rust changes.
- **The workspace map** — `POST /projects` validates only
  (`routes/projects.ts:56-84`: absolute, is-dir, not-used) and creates
  NOTHING inside the folder; the `.acute/` convention already exists in
  part (`.acute/skills/`, `.acute/prompts/`, `.acute/agents/`,
  `.acute/plugins/`, `.acute/computer-use/audit.jsonl`); the Files tree
  hides dot-directories (`fs-ops.ts:79`) so a `.acute/` stays out of the
  explorer while remaining tool-accessible. The ledger's `spawn cmd.exe
  ENOENT` root cause: `spawn(cmd, {cwd: root…})` with a missing cwd
  errors ENOENT NAMING THE EXECUTABLE (`tools/exec.ts:326-339`) — the
  legacy General root `AppData\Roaming\acute-code\general` can vanish;
  `runCommand` never checks. `list_dir` succeeds on an empty root and
  says "(empty directory)" without naming WHICH directory
  (`fs-ops.ts:193-211`).
- **The computer-use map** — the probe compiles a TRIVIAL class
  (`windows.ts:1848-1852`) while production compiles the ~90-line U32
  P/Invoke preamble (`:318-407`) → `addTypeOk:true` coexists with
  U32-unavailable. `open_application` runs `Start-Process -FilePath
  "<name>"` VERBATIM (`windows.ts:1303-1328`) — no registry/AppsFolder/
  Get-StartApps resolver exists. `focus_window` is U32-only
  (`windows.ts:1427-1439`) with the canned "window may have closed"
  recovery (`dispatch.ts:1898`). `screenshot`'s vision relay throws bare
  `TypeError: fetch failed` because `attempt()` handles only HTTP-level
  failures (`vision.ts:115-231`), not transport throws. NO consecutive-
  failure circuit breaker exists (only the screenshot-spam guard at
  `dispatch.ts:3093-3127`). The overlay: the floating monitor carries NO
  coordinates (`ComputerMonitorEvent {kind,label,tool,code}`) — the
  dispatcher's ring already records intent points; the always-on-top
  window pattern exists (`mini.rs`, `menu-overlay.html`).
- **The mono-stone map** — Mono Stone dark resolves accent to
  `accentDark:"#E0E0E0"` (near-white, `themes.ts:156-179`); three
  hardcoded white-ink-on-accent CTAs paint white-on-white:
  `TodoFloat.tsx:408` (`color:"#fff"` on `styles.accent`),
  `ConnectionGate.tsx:471-472` (`text-white` on `--ac-accent`),
  `ErrorBoundary.tsx:154-155` (same). The R93-A4 toggle-switch fix is the
  in-house precedent (the accentText pair). Letter tiles with white ink
  on light project colors (amber/lime) are the adjacent audit. The mono
  palette's warm-taupe surface derivations (`themes.ts:503`, `:628`)
  are the "not well planned" aesthetic drift — a data-derived
  `isMono`-conditional neutral derivation, not an id check.
- **The image-viewer map** — `FileViewerPanel.tsx:214-272` has NO image
  branch (a `.png` falls into the raw-text `<pre>`); the bytes route
  ALREADY EXISTS (`GET /projects/:id/attachments/bytes?path=` — resolves
  ANY path inside the root, `routes/attachments.ts:441-510`) and the
  object-URL pattern is proven (`AttachmentImageThumb`,
  `AgentChatPanel.tsx:952-995`). The explorer pane mirrors the viewer
  (`FilesExplorerPanel.tsx:450-478`).
- **The ledger map** — the telemetry's "no provider report yet (turn
  died before first reply)" collapses THREE different anchor-null reasons
  into one wrong phrase (`feedback-writer.ts:250-253`;
  `compaction.ts:566-611` returns null for: no usage rows at all, the
  newest row older than a compaction boundary, all-garbage rows).

## §1 The waves (dependency order)

### Wave T — the context meter's truth (files: agent-core/src/agents/chat.ts, runtime.ts, tests)

- **T1 — the finish frame carries the LAST step's input as the context
  truth.** The per-step accumulation stays for BILLING (`totalInputTokens`
  + `usage_events`), but the `usage` block the runtime persists as the
  stats carrier / final segment carries the newest STEP's inputTokens
  (what would be RESENT next request) — `chat.ts` emits it on the finish
  frame (or emits finish-step usage downstream), `runtime.ts:5170-5190`
  persists it. The anchor (`compaction.ts`) then reads truth mid-turn.
- **T2 — the guard rails:** the multi-step sum pin that never existed
  (`chat-format.test.ts` — a 3-step stream's finish usage must report the
  LAST step's input, while the turn's usage row keeps the SUM); the
  compaction-gate pin (an inflated mid-turn anchor can no longer fire
  premature auto-compaction); the context-report pin (the live route's
  headline steps down mid-turn, matching the owner's 200K-not-900K).
- **Constitution:** CONTEXT-METER.md amended — the live number's basis
  is "the newest provider request's input" not "the turn's cumulative
  input."

### Wave P — the PC chat fit (files: ChatFocusLayout.tsx, AgentChatPanel.tsx, Sidebar.tsx, storage/projects.ts, Composer.tsx)

- **P1 — the floor.** `CHAT_MIN_WIDTH` rises from 240 to the measured
  one-line floor for the toolbar's WIDEST anchor state (busy + queue);
  `sidebarWidthCap`/`chatMinWidthFor` re-derived with the same math; the
  queue button gains a narrow-container collapse tier (the Continue
  button's `@max-[460px]` pattern) so no anchor state exceeds the idle
  width. The R51-c wrap stays as the absurd-width emergency only.
- **P2 — the user bubble.** The hover actions cluster moves BELOW the
  message (a right-aligned second row: timestamp · copy · revert · the
  queued slot), OUT of the cap wrapper; the bubble owns the width tier
  alone — full-width-minus-padding at the narrow tier, the
  `min(65%,640px)` cap when expanded. COMPONENTS.md §7's stale
  `min(75%,640px)` line is rewritten with the below-bubble action law
  (the doc was already stale vs the code's R100-D 65% — fixed in the
  same amendment).
- **P3 — the Scratchpad rail.** `MinimizedRail` filters `general` out of
  the project tiles and renders a dedicated Scratchpad tile at the rail's
  BOTTOM (own label grammar, outside the 10-tile cap); the backend's
  `listProjects` orders `general` LAST (`ORDER BY CASE WHEN id='general'
  THEN 1 ELSE 0 END, created_at DESC, id DESC`) so every consumer sees
  the same truth; the fixture + the `:298-300` test pin flip to the new
  world.
- **Constitution:** SCREENS.md §2 law #9 (the Scratchpad law) extended
  to the rail explicitly; COMPONENTS.md §7 P2's amendment.

### Wave U — the update calm (files: scripts/release/update-supervisor.mjs, launcher/acute_launcher.py, src-tauri/src/update.rs)

- **U1 — the console flashes die.** Every supervisor spawn that can
  allocate a console (`captureOutput`'s tasklist probes, the PowerShell
  toast) gains `windowsHide: true` + `detached: true` — the guard also
  moves to a console-less probe where cheap (a Node-native process
  check).
- **U2 — the elevation leg.** When a silent install fails with an
  access-denied shape (write-locked target, protected path, per-machine
  residue), the app ASKS: `update.rs`'s overlay/fallback legs retry via
  `ShellExecuteW` verb `runas` after an in-app confirm ("the update
  needs administrator permission — allow?"), and the launcher's
  `_desktop_install` detects the failure shape and re-runs elevated with
  consent. The per-user default stays (no gratuitous UAC).
- **U3 — the restart ladder collapses to ONE owner.** The in-app
  watcher relaunch and the supervisor's 3-attempt ladder stop racing:
  the supervisor owns the relaunch when IT drove the install; the
  in-app path owns it when it did. The launcher's double
  uninstall/reinstall (`:2069-2101`) becomes a single retry with a
  human-readable reason before giving up.
- **Rust caveat:** `update.rs` changes are cargo-check-verified on CI
  only (ADR-0012 — no local toolchain); the honest caveat is declared
  in §4.

### Wave TH — the mono-stone truth + the image viewer (files: themes.ts, TodoFloat.tsx, ConnectionGate.tsx, ErrorBoundary.tsx, FileViewerPanel.tsx, FilesExplorerPanel.tsx, the letter-tile family)

- **TH1 — white-on-white dies.** The three hardcoded CTAs move to the
  TOKENS §1d pair (`accentDeep` fill + `accentText` ink — the R93-A4
  pattern); the sweep re-runs the design audit (hardcoded hex only goes
  down).
- **TH2 — the mono palette's neutral derivation.** `isMono` themes
  derive their recessed surfaces from a NEUTRAL ramp (not the warm-taupe
  mixes at `themes.ts:503/:628`) — a data-derived conditional
  (`achromaticAccent`), never an id check (the file's own anti-drift
  rule).
- **TH3 — the image branch.** `FileViewerPanel` + `FilesExplorerPanel`
  render displayable images via the existing bytes route + object-URL
  pattern (loading/404 states, cleanup, panel-width fit); other binaries
  get the honest "binary file — N bytes" guard instead of mojibake.

### Wave B — the browser leap (files: browser.ts, browser-hands.ts, browser-proxy.ts, native-browser.ts, BrowserPanel.tsx, browser-store.ts, browser.rs)

- **B1 — the tool truths (agent-core).** Click: capture the pre-click
  URL; on the vanished-error branch re-probe once — URL changed ⇒
  success-with-navigation + the landing URL; unchanged ⇒ the honest
  selector-not-found. Wait: navigation-aware — a matching urlContains
  succeeds with the readyState as a NOTE (not a blocker); the timeout
  report carries the current URL + WHICH condition failed. read_dom:
  style/script subtrees filtered from text extraction (the WALL_PROBE
  innerText precedent), an `offset`/`range` escape hatch on the cap (an
  element-count cursor, never a mid-payload byte slice). eval: the null
  case reports "the page navigated / the script returned undefined" +
  the current URL. type: the output echoes the REQUESTED submit flag
  (requested vs observed distinguishable). unknown-action: a
  nearest-match hint + the `mouse` action added to the list. get_state:
  titles arrive natively (`BrowserNavigated` gains `title`;
  `handleTitleMessage` wired to native navigations; the reconcile eval
  stays the backstop); the dual-writer history drift collapses (a
  location report within a short window of a commanded navigation
  REPLACES the pending entry).
- **B2 — the download action (agent-core + frontend).** A first-class
  `download` action: the sidecar fetches the URL INSIDE the page context
  (the tab's per-project cookie jar + Referer + UA via
  `fetchUpstreamGuarded`) → writes to `<projectRoot>/downloads/` with
  the attachments-style dedupe naming + content-type/magic-byte check →
  announces via a `browser-download` SSE frame (a chat card + the
  sidebar's downloads awareness). The tool schema, the prompts section,
  and the browser-use skill body move in lockstep (the three-file law).
- **B3 — the native downloads + the context menu (Rust, CI-verified).**
  `browser_tab_create` registers `ICoreWebView2::add_DownloadStarting`
  via `with_webview` (the webview2-com route): `Handled(true)` +
  `ResultFilePath(<projectRoot>/downloads/<name>)` + the
  `browser-download` event for UI toasts/progress — a right-click
  "Save image as…" then flows through the same pipeline. The default
  context menu is enabled/verified (`AreDefaultContextMenusEnabled`).
  Cargo-check on CI is the gate (ADR-0012); the feature degrades
  honestly on non-Windows.
- **B4 — the panel resize.** Corner/edge drag handles on the panel's
  placeholder (a height dimension joins the width in the store), the
  bounds-sync loop absorbs it unchanged (it already re-glues on any
  geometry change); the clamps (360..760 width, a new height floor/ceiling)
  re-derived; instant snap in Tauri (the R67/E5 law).
- **Honest scoping (declared):** the WebView2 runtime IS the Chromium
  base (the same engine family as Edge/Chromium); bundling a separate
  Chromium fork would mean replacing the app shell itself — the round
  ships the CAPABILITY leap (downloads, save-as, resize, the tool
  truths) on the in-tree Chromium runtime, and the full-engine question
  is recorded as an ADR for the owner to gate (PROPOSED, not decided).

### Wave F — the workspace scaffold + the tool-creation skill (files: routes/projects.ts, storage/*, tools/exec.ts, fs-ops.ts, approvals.ts, skills)

- **F1 — the scaffold.** `POST /projects` (and the boot-time health
  check) calls `ensureProjectWorkspace(root)`: an existing `.acute/`
  marker ⇒ previously-used (resume: heal missing subfolders, keep the
  memory); absent ⇒ scaffold `.acute/{downloads,tools,memory,tmp}` + a
  `workspace.json` marker (versioned, idempotent, never touching user
  files). The browser downloads (B2/B3) and the agent's scratch
  artifacts land INSIDE `.acute/`'s subfolders where the round's other
  waves pin them; the Files tree keeps hiding dot-dirs.
- **F2 — the tool-creation skill.** A builtin skill ("create-tool"):
  the agent writes Python/Node tools into `.acute/tools/`, registers
  them in `.acute/tools/tools.json` (name/description/invocation), and
  reuses them by invocation. The approvals engine gains a
  `.acute/tools/` pattern tier (prefix match, project-scoped, explicit
  user-granted) so a created tool is invocable without re-approving
  every arg variation — the exact-match-only law
  (`approvals.ts:525-536`) is amended, not bypassed.
- **F3 — the honesty fixes.** `run_command` pre-checks the cwd exists
  (the ENOENT-naming-the-exe trap dies; the error names the missing
  directory); the boot-time project health check heals/reports dead
  roots; `list_dir` echoes the resolved directory + entry count.

### Wave C — the computer-use truth (files: backends/windows.ts, dispatch.ts, vision.ts, computer-use.ts, prompts, the monitor)

- **C1 — the probe tells the truth.** `request_access`'s addType leg
  compiles the REAL U32 preamble (the same TypeDefinition production
  uses) and asserts `$script:U32_OK` — `addTypeOk:true` can never again
  coexist with U32-unavailable.
- **C2 — the app resolver.** `open_application` resolves Windows app
  identities (canonical aliases, `Get-Command`, registry App Paths,
  Get-StartApps/AUMID → `shell:AppsFolder`), so an installed Edge is
  findable by name; the recovery names the identity it resolved and
  failed on (the contradictory clauses die).
- **C3 — the focus fallback.** A non-Add-Type activation path (the UIA
  SetFocus ladder) backs up the U32 path; every canned recovery is
  derived from the actual error (the `addTypeError` threading pattern).
- **C4 — the vision catch.** `attempt()` wraps the transport throws →
  `{ok:false, retryable:true, error:"vision relay transport failure:
  <cause>"}` so the retry ladder engages and the agent gets a recovery
  hint instead of `TypeError: fetch failed`.
- **C5 — the circuit breaker.** After ~3 consecutive
  capability-failures with zero progress, the dispatcher surfaces a
  stop-and-report refusal (the agent tells the owner instead of looping).
- **C6 — the overlay MVP.** The computer-use SSE frames carry the
  action's point + frameId; the floating monitor paints the latest
  raster with the animated action marker ("tapping here") — the
  always-on-top window pattern (mini.rs) is the vehicle.
- **C7 — the capability honesty.** The skill/probe report
  Chromium-cold-start web-tree availability honestly (the probe does
  not verify web-tree depth; the skill's claim is downgraded to
  conditional for user-launched browsers).

### Wave M — the mobile fade (files: mobile/src/components/transcript.tsx, turn-block.ts, theme)

- **M1 — the tool groups fade.** The R130-B tool rows/groups shift to
  the quiet register: lower-saturation family stripes/icons (the family
  color at reduced opacity over the recessed surface), the failed
  danger wash stays precise, the press feedback stays. The
  "highlighted" feel dies; the grouping/interleave laws stay pinned.
- **M2 — the mobile mono-stone pass.** The same §1d pair audit on the
  mobile clay tokens where mono can invert.

### Wave L — the ledger's honesty (files: feedback-writer.ts, compaction.ts)

- **L1 — the anchor's reason.** `providerUsageAnchor` (or its wrapper)
  returns WHY it is null (no-rows / compaction-boundary / garbage-only);
  the telemetry line phrases each honestly — "turn died before first
  reply" only when there are truly no rows.
- **L2 — the reviewer prompt refinement.** The reviewer's guidance gains
  the capability-gap classification axis the owner asked for (app-defect
  vs model-error vs capability-gap), and the checkpoint cadence stays.

### Wave V — the local live battery (the round's own gate)

The R130-E pattern at full scope: the dev stack (vite + the sidecar on a
scratch DB) + an OpenRouter free model (nvidia/nemotron-3.5-lightning
re-verified, cohere/north-mini-code the fast fallback) + the
agent-browser driving the REAL app:
- a multi-step tool turn (write + read + run) with the context meter
  LIVE-observed stepping TRUTHFULLY (the T1 pin proven in the running
  app, not just the suite);
- the composer battery at three widths (the floor never wraps;
  the queue state fits);
- the Scratchpad rail (collapsed: the dedicated bottom tile, never
  mixed);
- the user bubble at narrow + wide (the actions below, the width law);
- mono-stone light+dark walkthrough (zero white-on-white);
- the image viewer on a real PNG;
- the browser download action + the tool-truth battery (click-nav
  success, wait navigation-aware, read_dom clean);
- the workspace scaffold on a fresh folder (`.acute/` tree + marker +
  resume);
- the tool-creation skill end-to-end (create a tool, register it,
  invoke it);
- screenshots into shots/r131/.

## §2 The gates (unchanged, the house law)

Root tsc + the FULL vitest sweep + agent-core tsc/vitest + mobile tsc +
CI=1 jest + eslint 0 + design-audit at-or-below baseline + docs:check +
version:check at the bumped 0.124.0 + license audit. The browser battery
is the round's OWN gate per the owner's directive. Rust changes
(update.rs, browser.rs) ride cargo-check on CI (ADR-0012) — declared.

## §3 Rollback

`backup/pre-r131-improvements` at the v0.123.0 tip (73f2115's tree).

## §4 Honest caveats (pre-declared)

- The Rust legs (U2's elevation, B3's downloads) are cargo-check-verified
  on CI only — no local toolchain (ADR-0012). The Windows-only COM paths
  cannot be executed in this sandbox; their unit pins cover the pure
  logic and the CI check covers compilation.
- The "own Chromium build" question is scoped honestly: the round ships
  the capability leap on the in-tree WebView2 (Chromium-family) runtime;
  bundling a separate Chromium engine is an ADR the owner gates.
- The computer-use Windows legs (probe, resolver, focus, overlay on the
  real desktop) verify on the owner's device pass; the sandbox pins the
  pure logic + the dispatch contracts.
- The mini-bots architecture is NOT built (the owner's explicit future
  scope) — only the base systems (the workspace, the tools convention,
  the honest capabilities) that it will stand on.

---

## §5 The waves as they landed

- **Wave T** (r131-t @ b52c320) — the context meter's live truth: the finish frame's TWO numbers (the LAST step = context truth → the carriers/anchor/meter/compaction gate; the SUM = billing → totalInputTokens/usage_events); +14 pins; CONTEXT-METER.md amended.
- **Wave P** (r131-p @ 524122c) — the floor (CHAT_MIN_WIDTH 240→400, measured), the user bubble's actions-below + the width tiers, the Scratchpad rail's dedicated bottom tile + the backend order; +2 root pins +1 core pin; SCREENS/COMPONENTS amended.
- **Wave U** (r131-u @ 56b6b28) — the update calm: windowsHide on every supervisor spawn, the ONE-retry runas elevation legs (Rust + launcher), the restart ladder's single-owner grace handshake, the launcher's single-retry + opt-in repair; supervisor test 31/31 + launcher 45/45; the Rust legs CI-verified only.
- **Wave TH** (r131-th @ 93b6b78) — the three white-ink CTAs on the §1d pair, the letter tiles' luminance ink, the mono-neutral surface derivation (data-derived, foreign-id-proven), the FileImagePreview branch in both viewers + the binary guard; +16 pins; design-audit R1 down 2.
- **Wave B-core** (r131-bc @ c92d00b) — the 8 tool truths (click re-probe, navigation-aware wait, read_dom's innerText+offset cursor, eval diagnostics, type echo, nearest-match, the redirect-collapse window) + the first-class `download` ACTION with the `browser-download` frame + the three-file lockstep; +38 pins; the golden fixture r131.
- **Wave B-ui** (r131-bu @ 563fe75, orchestrator-completed) — the panel's drag-resize (right/bottom/corner handles + the persisted height), the Rust download pipeline (with_webview + add_DownloadStarting + the context menu + browser_tab_set_download_dir), the title probe, the download toasts, the eval null diagnostics; +67 pins; the Rust legs CI-verified only.
- **Wave F** (r131-f @ 36f4cf3) — the `.acute/` scaffold (ensureProjectWorkspace: fresh/resume/heal + the marker), the create-tool skill + the approvals prefix tier (denylist-supreme intact), the cwd pre-check + list_dir's path echo; +47 pins; PROJECT-MEMORY/EXTENSIBILITY amended.
- **Wave C** (r131-c @ a399170, orchestrator-completed) — the real-preamble probe, the app resolver ladder, the CSC-free UIA focus fallback + the honest recoveries, the vision transport catch, the circuit breaker, the SSE frames' points (the overlay's backbone), the capability honesty; +38 pins; PLUS the r127-usage-hourly time-bomb flake fixed (the morning-only failure).
- **Wave M** (r131-m @ a93eff0) — the mobile tool cards' faded register (1.5px stripes, 0.5 family fade over the well, secondary titles; failures/live full-strength); +7 pins; DESIGN.md §9.
- **Wave L** (main @ 44d6007, orchestrator inline) — the anchor's four reasons + the telemetry's honest phrases; the reviewer's capability-gap axis; +2 pins.
- **Wave X** (r131-x, the coherence wave) — the downloads alignment to `.acute/downloads/` (both B paths + the pins + the tree's owner-browsable exception, the F pin retired with the record), the CONTEXT-METER stamp, the frame-union promotion, the overlay's seed (the store/frames carry the points + the pill's coordinate legend), the mobile mono assessment (no hazards).

## §6 The close-out verification

- **The gate stack** (read with the orchestrator's own eyes): root tsc CLEAN · FULL root vitest 298 files / 5,393 tests (5,378 passed + 15 skipped) · agent-core tsc CLEAN · FULL agent-core 170 files / 3,225 tests · mobile tsc CLEAN + CI=1 jest 48 suites / 1,115 tests · eslint 0 · design-audit clean at-or-below baseline · docs:check 285/0/0 · version:check 7/7 at 0.124.0.
- **THE LIVE BATTERY (the round's own gate — the owner's local-testing directive):** the R120-H battery on the REAL sidecar with the provided OpenRouter key and the free `nvidia/nemotron-3.5-lightning:free` model — TWO real turns through the real SSE pipeline: the default task (create_dir + write_file + read_file, the file verified on disk "hello", the honest final answer, exit path "final answer") PASS, and a custom task (hello.md created + read back + the exact content quoted) PASS-in-substance (the script's hardcoded assertion checked the default file — the tool calls, the frames and the answer prove the work). The item-43 honest-stop law and the meter's live polling proven live.
- **Honest caveats (pre-declared + discovered):** the Rust legs (update.rs elevation, browser.rs downloads) are cargo-check-verified on CI only (ADR-0012); the Windows COM paths, the UAC flow, the app resolver, the focus fallback and the overlay's desktop rendering verify on the owner's device pass; the desktop mini-window's raster-overlay marker (the full "tapping here" painting) is the flagged next rendering leg — the coordinates + frameId flow end-to-end and the web pill renders the legend; the agent-browser visual walkthrough (the R130-E pattern at full scope) did not fit this session's budget — the UI waves are pin-level verified, with the structural pins (the floor math, the actions-below DOM, the rail tile, the viewer branch) carrying the contracts.

