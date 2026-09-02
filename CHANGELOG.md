<!-- last-reviewed: 2026-09-02 round-63 -->
# Changelog

All notable changes to ACUTE-CODE are documented here. Entries are written for
the user of the workbench (features, fixes, behavior changes), not for the
agents that build it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); the
version number is single-sourced from the root `package.json`
(`pnpm version:get` / `version:check` / `version:set`).

## [Unreleased]

Planned next: live verification of computer use AND the agent-browser's
native paths (eval in the page, screenshot + vision) on the owner's real
machines (the checklist in `docs/runbooks/COMPUTER-USE.md`), installer
code-signing (SmartScreen), ratings-driven prompt tuning, the
deepseek-harness future candidates (compaction pressure-trigger,
continuable sub-agent children), the Files-tab polish, agent
web-app-testing tools.

## [0.63.0] - 2026-09-02

Round 63 — the desktop-update round. **The launcher now PROVES the desktop
app is the newest version instead of assuming it.** Rounds 61–62 shipped
features but never pushed their release tags, so no installer existed
beyond 0.60.0 — the site served the new code while the packaged app stayed
frozen (the root cause of "updated properly" reports). 0.63.0 is tagged and
released: the next `ACUTE.bat` run updates the desktop app 0.60.0 → 0.63.0
and verifies it. On every app launch the launcher now checks THREE
versions against the newest GitHub release — the uninstall registry's, the
installed exe's real FileVersion **on disk**, and (after launch) the
running engine's `/health` version — and a *hybrid* install (registry
bumped, exe stale — the leftover of a silent install racing a closing app)
is **deleted completely and reinstalled** from a sha256-verified download,
then verified again; a stuck engine version is flagged and self-heals on
the next run. New commands: `ACUTE.bat reinstall` (delete + fresh install
+ verify + launch) and `ACUTE.bat uninstall` (clean removal; your data in
`%APPDATA%\acute-code` is always kept), and `status` shows the full
version truth including the update-pending flag. The engine's `/health`
now reports the real app version (it had been a hardcoded 0.3.0 for 60+
rounds). The site flow's plan now says plainly that the embedded browser
and computer use are desktop-app features.

## [0.62.0] - 2026-09-02

Round 62 — the owner-feedback round. **The sidebar can now be MINIMIZED**
(a 64px icon rail with the restore button at its very top — persisted,
orthogonal to the full hide). **The session screen's gradient background
is gone** (flat theme background; the side padding + rounded corners
stay). **The embedded browser now RESPECTS the dimensions you set** —
larger presets render as a scaled-down view of the true size (the page
sees the full CSS pixels; the readout says "fits N%"), and the Chromium
footnote strip is removed. **Any open menu/dialog/popover now renders
ABOVE the browser webview** (a DOM overlay watcher hides native webviews
while overlays are open — the "menu opened under the browser" bug). **The
agent can now USE the right-sidebar browser**: `browser_control` grew
`read` (the page's text), `eval` (JavaScript in the live page — click
links, fill forms, read the DOM, native desktop mode), `screenshot`
(capture the panel + a vision-model description via Computer Use), and
`get_state` now lists every open tab; the system prompt teaches the
capability triad. **Settings → Appearance is simplified** (three
sections; the Sidebar Tint setting is removed). **Models & Providers
changes reflect on the agent session page immediately** (cross-cache
invalidation), the per-1M input/output token prices are clearly labeled
and support decimals, the model dialog gained a Supports-vision toggle,
and partially-priced models now cost what their known sides cost (the
silent $0 bug). 1542 root tests in 104 files (was 1492/103), agent-core
801/801, live-verified end-to-end including a real model turn driving
the browser tools.

## [0.61.0] - 2026-09-02

Round 61 — the computer-use + extensibility round. The agent can now
observe and actuate the real desktop GUI (30 gated tools, receipts,
fail-closed refusals, an enforced kill switch, an audit journal), with a
SEPARATELY-configurable vision model; plus the owner's extensibility asks:
user skills, MCP servers, and the settings tabs that manage them all.

### Added

- **Computer use — the agent drives your real desktop** ("give the user
  the option to turn on and off the computer use"): OFF by default; when
  you flip the master switch the agent gains 30 tools that read the
  accessibility tree (a11y-first, background-safe element actions) and
  fall back to screenshot coordinates. Three postures: **observe**
  (read-only tools only — the model never even sees a mutating schema),
  **act** (recommended — real-input actions like typing, drags, and
  coordinate clicks ask your approval first, through the same approval
  dialogs as run_command), and **auto** (no per-action prompts). Actions
  return receipts, never promises; everything the host refuses comes back
  as a NAMED refusal with the exact recovery step (22 codes, from
  `element_stale` to `frontmost_pid_mismatch` to `kill_switch_active`).
  Works on Windows (PowerShell + UI Automation, no extra deps), macOS
  (osascript + Accessibility/Screen Recording permissions), and Linux X11
  (xdotool/wmctrl/scrot/xclip + AT-SPI). Honest caveat, stated in the
  runbook: the logic is fully unit-tested but NO backend has been
  live-verified on a real display yet — follow the LIVE-VERIFICATION
  CHECKLIST in `docs/runbooks/COMPUTER-USE.md` before relying on it.
- **The separate vision model** (the owner: "for the vision we are
  utilizing a separate model… the provider completely separately"): a new
  Vision card in Settings → Computer Use with three modes — **off**
  (default), **separate** (pick any provider + model and paste that
  model's OWN API key into the dedicated key slot — masked, never shown
  in full), and **main** (use the turn's model, only when its row is
  marked supports-vision — the new eye toggle flips that flag per model
  row). The agent uses vision when you ask it to describe a screenshot
  (`describe:true`); it is never called silently.
- **The computer monitor** ("in a mini window it will show the details and
  their stats while the agent is using computers"): a new **Computer tab**
  in the right sidebar (status chip, live event feed with refusal codes,
  action/observation/vision stats, elapsed clock) plus a **floating
  draggable mini window** you can pop out anywhere — both fed live by
  per-execution stream events, and both carrying the **STOP kill switch**:
  one press and every further computer-use call is refused, with any held
  mouse button physically released.
- **The audit journal**: every computer-use call is appended to
  `<project>/.acute/computer-use/audit.jsonl` with credentials scrubbed,
  clipboard/typed text redacted to length markers, and screenshots never
  journaled (frame ids only).
- **Skills — the ability to add multiple**: Settings → Skills manages
  SKILL.md-style capability modules with progressive disclosure — each
  enabled skill's name + one-line description rides the system prompt,
  and the full body loads on demand via the new `read_skill` tool (the
  built-in `computer-use` skill ships seeded; built-ins can be edited or
  disabled but not deleted; user skills are full CRUD).
- **MCP servers — the ability to add MCP servers too**: Settings → MCP
  configures stdio Model Context Protocol servers (name/command/args/env,
  probe button, expandable live tools list). Enabled servers' tools join
  the agent's toolset as `mcp__<server>__<tool>`; child processes run with
  a sanitized environment — no ACUTE credential can ever reach an MCP
  server. One broken server never breaks a turn.
- **A new SYSTEM-PROMPT discipline** ("improve its tool calling skill
  using"): three tool-discipline rules (read tool errors fully before
  reacting; pick the most specific tool; never fabricate results), a
  faithfulness rule (report outcomes honestly — a truthful failure beats
  a confident fiction), a closing contract (state what you did, what you
  verified and how, and any follow-up), plus SKILLS / COMPUTER USE / MCP
  SERVER TOOLS sections that appear exactly when those surfaces are live.

### Changed

- **`read_skill` joins the tool vocabulary** (24 allowlisted names, was
  23): template and default agents' allowlists gain it via migration
  0023; explicitly-curated agent allowlists are untouched (their authors
  can add it in the agent form).
- The plugin registry grows to **12 built-in plugins** (computer-use,
  skills, MCP added); `GET /plugins` lists them all with the live tool
  catalog and the external `.mjs` file report.
- Test reality: **1491 tests in 102 files** (was 1348/91); agent-core
  alone 786/786 in 48 files. Migration `0023_computer_use.sql`
  (`models.supports_vision` + `skills` + `mcp_servers` tables +
  `read_skill` allowlist append) is applied on upgrade — no existing
  agent's behavior changes until you turn the new switches on.

## [0.60.0] - 2026-09-01

Round 60 — the second owner-feedback round on the design language. The
thirteenth Windows test session confirmed the rounded window PERFECT ("keep
it as a part of our design language") and the pop-out browser satisfying;
its polish list became this release.

### Added

- **The pop-out view is rounded** ("the thing which was not rounded off was
  the actual view"): the page content now sits in a rounded, bordered card
  matching the title bar and URL bar — the same design language, applied to
  the browser view itself.
- **The pop-out gutter scrollbar** ("The scroll bar should be custom themed
  on every single page. It should not show inside the section but on the
  right side outside it"): the pop-out window now paints its OWN scrollbar
  in the frame's right gutter, OUTSIDE the content card — a floating pill
  you can drag, click-to-jump, and drive from the keyboard, tracking every
  page in the window. Pages get a themed minimal scrollbar everywhere
  (injected at document start, before first paint); on strict-CSP sites
  that block the styling, the page keeps its own scrollbar and ours stays
  away — never two bars at once.
- **Real zoom in the embedded browser panel**: the zoom select now performs
  an actual DPI-level page zoom (the same engine zoom as a browser's
  Ctrl+/−) — media queries and responsive layouts re-evaluate, which is
  what display-size testing needs. Previously zoom silently did nothing
  in native mode.
- **The Add-models picker's "Free only ↔ All models" toggle** for
  OpenRouter: pick from the free catalog or the full one (persisted — the
  chat model picker honors the same choice).
- **Rating-note visibility**: a saved "what went wrong" note now shows a
  small "noted" chip on the reply; clicking it reopens the editor with the
  note pre-filled, and re-rating a saved bad reply pre-fills the editor
  too (editing context instead of losing it).

### Changed

- **Models list starts EMPTY** ("By default none of the models should be
  added there"): the Models & Providers list shows only models YOU added
  via "Add models" — no catalog listing, no pre-populated rows. Every
  added model (including free ones) is fully configurable (pricing,
  context window, output limits, thinking, visibility).
- **The API-key field is one consistent row**: the Show/Hide eye button
  sits in the exact same place in every state; Copy appears with a smooth
  fade only when the key is revealed; the "Rotate key" flow is GONE —
  click into the field, paste a new key, Save (Escape cancels back to the
  stored display).
- **The title bar's logo + app name is now the sidebar toggle**: clicking
  it hides the left sidebar entirely (the content takes the full width);
  clicking again brings it back. The sidebar's own logo and its collapse
  button are gone — the sidebar is either fully visible or fully absent,
  and it now stays visible on chat screens too until you hide it.
- **Settings lost their side padding**: the content area fills the width
  (the Models & Providers master-detail edge-to-edge) and the horizontal
  padding is minimized throughout.
- **The browser panel's viewport toolbar** was restructured: a clean
  rounded card with two labeled groups (size: preset/width×height/zoom;
  view: rotate/fit), wrapping gracefully at narrow panel widths, with the
  live size readout. "Fit" is honestly disabled in native mode (sizes are
  already clamped to the panel there) instead of silently doing nothing.

### Fixed

- **The new-tab menu no longer hides behind the browser preview**: opening
  the right-sidebar "+" menu while a browser tab is active now yields the
  page to the menu (the native webview steps aside and comes back when the
  menu closes — the browsing session is never lost).
- **Scrolling no longer shifts the providers list's width**: the scrollbar
  gutter is permanently reserved (stable), so the list (and every
  auto-scrolling panel) keeps its exact width whether or not a scrollbar
  is visible.

## [0.59.0] - 2026-09-01

Round 59 — the owner-feedback round. The twelfth Windows test session
confirmed every 0.58.0 flow working (title bar, pop-out browser, live
file-write preview, key pool, streaming stops); the session's polish list
became this release.

### Added

- **The rounded window** (the owner: "make that top navigation bar rounded
  and give it padding on all four sides"). In the desktop app the window is
  now a soft inset frame: 8px of breathing room on every side, the title
  bar and the content area as separate rounded cards, and window controls
  as inset rounded buttons. Browser mode is unchanged.
- **Minimal floating-pill scrollbars** app-wide ("go with a better scroll
  bar… minimal and good-looking"): a transparent track with a rounded thumb
  that floats inset from the edges, visible in every theme, both axes,
  with a subtle hover state.
- **Custom chrome on the pop-out browser window** ("It should be a custom
  one"): the pop-out is now a frameless window hosting a small dedicated
  app page — our own drag-region title bar with minimize/maximize/close,
  a themed editable URL bar (back/forward/reload, open-in-system-browser),
  and the page content in the same shared-profile embedded webview the
  in-app panel uses. Sizing is monitor-aware (never opens larger than 70%
  of your work area).
- **Response ratings with full context** (the owner: "add the options to
  mark the responses as good or bad… The full context will be properly
  shared"). Every assistant reply carries thumbs up/down; bad ratings
  prompt an optional note; and the rating snapshots the complete evidence
  at the moment you rate it (your message, the reply with token usage,
  every tool event, any error). `node scripts/acute.mjs ratings --full`
  dumps the evidence for analysis so the system prompts can be tuned on
  real failures.
- **The Console tab** (right sidebar) — console-like error monitoring: a
  live, newest-first view of frontend and engine errors with counts,
  expandable details, copy, and clear. Render crashes now show an honest
  recovery card instead of a blank screen.
- **Modular system prompts** (the owner: "built in multiple parts, modules,
  and such… used when necessary"): every section of the agent's system
  prompt is now a registry entry that a project can override with a file —
  `.acute/prompts/<section>.md` replaces that section wholesale, an empty
  file removes it, and `_order.txt` reorders. `node scripts/acute.mjs
  prompt:sections` lists every section and which files would override.
  Without override files the prompt is byte-identical to before.

### Changed

- **Models & Providers — honest provider list**: preset providers you
  have not configured (Anthropic / OpenAI / Google) no longer appear in
  the list at all; the Add-provider picker remains the way to set one up.
- **API key display**: a stored key now shows masked in the key field with
  one clear **Show** button (reveals the real value, with Copy and Hide),
  and a separate **Rotate key** action for entering a new one.
- **Provider disable is immediate**: no more "One agent uses this
  provider" confirmation — the switch disables outright.
- **Opening Models & Providers pre-selects the first provider** and shows
  its details; deleting a provider falls to the next one.



## [0.58.0] - 2026-08-31

Round 58 — the desktop-app-polish round. The owner's eleventh Windows test
session was the first fully-working desktop run in the product's history
(the R57 engine-bundling fix held): the app opened clean, projects created,
tasks ran, files were written. The session's report was a list of UX and
behavioral bugs, every one of which is fixed here.

### Added

- **Frameless window with an integrated title bar** (the owner: "the top
  window kind of thing, I don't want you to show that… I want it to look
  like a full-fledged application"). The native OS title bar (close /
  restore / minimize + app-name strip) is gone — replaced by a slim in-app
  bar: full-width drag region (double-click to maximize), app identity at
  left, minimize / maximize-restore / close controls at right, translucent
  backdrop-blur over the shell's ambient background. In web mode the bar is
  absent and the layout is unchanged.
- **Live file-write preview while the agent writes** (the owner: "while it
  was writing the files it did not show me anything at all. After it had
  written the whole file then it showed me"). The model's streamed tool
  arguments now arrive as live SSE frames (`tool-input-start` /
  `tool-input-delta`); the working section renders a live `writing
  <file> — N chars` box with the partial file content (tolerantly decoded
  from the growing JSON), replaced by the final diff when the write
  completes. Live-verified: the owner's exact 3-file task streams 40+ arg
  deltas during generation.
- **"Continue" after a stop.** The stop button no longer discards the
  in-flight text: the partial reply is flushed to the transcript, and the
  composer offers a Continue button that resumes from where the response
  stopped.
- **A terminal chat harness** (`docs/runbooks/CLI-HARNESS.md`): `scripts/
  acute.mjs` grew `chat:new / chat / chat:stream / chat:stop / chat:events /
  chat:ctx / approvals / approve / deny` — live-streamed agent turns with
  thinking/tool/approval rendering, Ctrl-C-to-stop, and JSONL `--raw` for
  scripting. Long-session testing no longer needs the UI.
- **Visible API keys** (the owner: "It should not be hidden. I should be
  able to… see the API key there, every single one of the API keys"). A new
  authenticated reveal route returns the stored key values; the provider
  page's primary-key field and every key-pool row gained reveal eyes with
  copy buttons. (Deliberately reverses the old R47 no-keys-in-responses
  rule — the owner's own local app, the owner's own keys.)
- **Key-reveal route**: `POST /api/v1/providers/:id/keys/reveal`.

### Fixed

- **Stop no longer reports "Generation failed / body stream buffer was
  aborted."** A deliberate stop renders a quiet "Stopped by user" card (no
  red, no error code), the server returns a `stopped` terminal frame, and
  the client no longer misclassifies its own abort as a network error.
- **The sidebar no longer spins forever after a stop** — the engine resets
  the session to its resting state on abort (previously it stayed
  "running" until the next app restart).
- **"Open the current page in your system browser" works** (was silently
  swallowed by the embedded webview): a Rust-side opener hands the URL to
  the OS default browser; the web build keeps `window.open`.
- **The pop-out browser window is no longer a white box.** The pop-out
  command was a synchronous Tauri command that deadlocked webview creation
  on Windows — it is now async (the same fix pattern the embedded tabs
  already used), and the injected nav overlay rides an initialization
  script that actually survives page loads. The pop-out shares the ONE
  browser profile with the embedded browser (the old tooltip claimed
  "isolated" — it never was).
- **The URL bar no longer resets mid-typing** (navigation polls no longer
  stomp the draft while the field is focused), and the viewport readout is
  honest when a preset is clamped to the panel size ("843×590 (clamped
  from 1920×1080 — panel too small)").
- **The end-of-task session regurgitation is capped.** History replay
  previously re-sent every tool's full output (up to 4 000 chars each) to
  the model on every loop iteration — a long task invited the model to
  echo the whole session as its reply. Only the last 8 tool results keep
  full output now; older ones collapse to stubs, blocks are bounded, and
  the completion-signal list grew the phrasings real models actually use.
- **The thinking block lost its "AI glow"** (the owner: "on the left side
  of it there is a weird AI kind of highlighting"): the accent rails are
  gone from thought rows and the working-section spine — a quiet
  self-contained notes block instead, in the main agent and sub-agents
  alike.
- **The context-window popover waits for intent** — hovering the donut no
  longer snaps open instantly; it opens after ~600 ms of pointer rest
  (focus and click still open immediately).
- **Settings → Models & Providers**: unconfigured preset providers
  (Anthropic / OpenAI / Google without keys) no longer present themselves
  as live rows — they sit in a collapsed "Not configured" group; the
  provider list sizes to its content (with a sensible minimum) instead of
  stretching the full viewport; preset providers hide the base-URL and
  API-format fields ("Preset provider — endpoint and format are fixed";
  custom providers keep them); the disable action is a proper toggle with
  an agent-impact warning; the OpenRouter model catalog no longer leaks
  into custom providers' model lists.
- **Settings → Sub-agents and Advanced are no longer the same page
  twice.** Sub-agents is now the single home for everything sub-agent
  (keys, model, parallelism limits — moved from Advanced, supervision);
  Advanced keeps the engine connection and memory. Deep links unchanged.
- **The chat model picker honors model configuration** — models marked
  hidden in Settings no longer appear (even under "All"), display names
  replace raw ids, and configured models carry a marker.

## [0.57.0] - 2026-08-31

Round 57 — the engine-bundling round. The owner's tenth Windows test
session brought the first HALF of the win: the launcher's app-or-site
question worked, the SITE launched perfectly, and the whole web flow
(dashboard included) ran clean. But the desktop app still could not reach
agent-core — and this time the engine's dying words were finally captured
on stderr: `ERR_MODULE_NOT_FOUND`, on all three startup attempts. That
error named the last packaged-only crash: the installer's bundled
`node_modules` was a pnpm LINK FARM (189 symlinks on the build runner =
189 junctions after extraction) that does not survive
tauri-bundler + NSIS packing — so the installed engine could not import
its very first package and died before its first log line, while the
Linux CI boot check passed happily (Linux preserves links; the owner's
disk does not).

### Fixed

- **The packaged engine now actually bundles** (the owner's words:
  "it needs to be bundled in properly"). The staged sidecar tree is
  installed with pnpm's **hoisted linker** — a classic npm-style
  `node_modules` of REAL directories, zero symlinks, zero junctions —
  so NSIS can pack and extract every byte as plain files. The staged
  tree also shrank from ~302 MB to ~125 MB in the process.
- **A zero-links gate in the staging script**: the build now FAILS if
  any symlink or junction appears anywhere in the tree that will be
  packed into the installer (the 0.56.0 tree carried 189 of them; this
  gate makes that number permanently zero).
- **CI reliability (test-only, same round):** a latent suite flake
  surfaced on the round's own docs commit — a transient-message
  `setTimeout` fired after the test environment tore down and failed
  the whole suite despite every test passing. A new leak-safe
  `useTimeoutClear` hook (cancel-on-unmount, replace-on-reschedule)
  now backs all 11 transient-reset sites; the shipped installer was
  never affected.
- **A Windows pre-pack boot gate in the release build**: before the
  installer is ever built, CI now boots the REAL staged engine with
  the REAL pinned node.exe on a Windows runner — same command line,
  same environment, same `ACUTE_READY` handshake the app waits for —
  and fails the release (printing the engine's stdout/stderr) if it
  does not come up. A dead engine can never be packed into an
  installer again. The R51-era check that "proven the tree bootable"
  ran on Linux only — the exact blind spot that shipped the link farm.

## [0.56.0] - 2026-08-31

Round 56 — the launch-choice round. The owner's report after 0.55.0 was
blunt and actionable: "still not working it failed and I think in the
acute.bat it should ask how to launch the app or the site." Two answers:
the launcher now ASKS (app or site, every run, one keypress), and when the
desktop engine does not come up, the launcher refuses to dead-end — it
shows the engine's own last words and offers retry / site / keep. The
launcher self-update also re-runs itself immediately, so launcher
improvements drive the session they arrive in instead of the next one.

### Added

- **The launch question (the owner's request, verbatim).** Every
  interactive run now asks how you want to use ACUTE-CODE: **[1] the
  desktop app** (the packaged window with the embedded browser) or **[2]
  the site** (local servers + your browser at http://localhost:5173).
  Enter keeps your last choice (first run defaults to the desktop app);
  the answer is remembered in `.acute-launch-pref.json` next to the
  launcher and becomes the next Enter default. Skip the question with a
  command — `ACUTE.bat app` / `ACUTE.bat site` (or `--app` / `--site` /
  `--web` / `--no-desktop`) — and non-interactive runs use the remembered
  choice silently. The plan panel shown at startup reflects the resolved
  mode (or shows both paths honestly while the question is pending).
- **Engine-failure recourse — never a dead console again.** When the
  freshly launched desktop app's engine does not report ready (startup
  failure, timeout, or the app exiting), the launcher now prints the
  engine's log tail AND asks what to do next: **[1] retry the desktop
  app** (close + relaunch, one retry round), **[2] use the SITE instead**
  (closes the app and falls through to the browser flow — the exact
  escape the owner asked for), or **[3] keep the desktop app** (its
  offline screen has Restart-engine + Copy diagnostics). A desktop-engine
  hiccup can no longer leave you with no working app and no choice.
- **`ACUTE.bat status` now reports the launch story:** your remembered
  launch preference, and the engine's last successful boot line from
  `%APPDATA%\acute-code\sidecar.log` (or "no successful boot on record") —
  the two facts that turn a vague "it failed" report into a diagnosable
  one.

### Changed

- **The launcher self-update takes effect THIS session.** The old contract
  was "copied over, runs on the NEXT double-click" — which quietly meant
  every launcher improvement (failure handling, questions, panels)
  arrived exactly one run late, on the run AFTER the one where it
  mattered. The fresh copy is now exec'd in place: the new code drives
  the current session, with the original arguments preserved and a loop
  guard (`ACUTE_LAUNCHER_REEXEC=1`) that makes re-exec failure-safe.
- **The engine watch's timeout is no longer blind.** A cold boot that
  outruns the watch used to print only "did not report ready within 45s"
  with zero diagnostics — the exact silence that hid the EISDIR crash for
  three sessions. The watch now runs 75s (matching the Rust handshake's
  3-attempt worst case more closely) and prints the engine's last output
  lines on timeout, exactly like it already did for explicit startup
  failures.
- The startup line names the version being launched ("ACUTE-CODE 0.56.0
  is running (pid …)") so any report you copy tells us exactly which
  build failed.

## [0.55.0] - 2026-08-31

Round 55 — the engine-boot round. The owner's third desktop session (0.54.0)
finally produced the crash text behind every "Can't reach agent-core" the
packaged app has ever shown: `Error: EISDIR: illegal operation on a
directory, lstat 'C:'` — node.exe dying before the first line of agent-core
code, on every handshake attempt, while the sidecar log also showed "no
provider keys found in Credential Manager" seconds after the launcher had
stored all four keys. Two root causes, both invisible in dev mode, both
fixed at the source.

### Fixed

- **The engine now actually boots in the packaged app (the EISDIR fix).**
  Tauri's `resource_dir()` on Windows returns `\\?\`-prefixed verbatim
  (extended-length) paths, and the shell passed them straight through as the
  node.exe program, the `main.js` script argument, AND the working directory.
  node starts from a verbatim program path but its module resolver
  (`fs.realpathSync` inside `resolveMainPath`) does not support verbatim
  script paths — handed `\\?\C:\…\main.js` it degenerates to `lstat 'C:'`,
  fails with EISDIR, and dies before running a single line of user code.
  Dev mode never saw this because `dev.mjs` passes plain paths. Every path
  that reaches a child process is now stripped of the verbatim prefix first
  (safe: the prefixes exist to exceed MAX_PATH and the install tree is
  nowhere near 260 chars); pinned by unit tests against the exact paths from
  the owner's log.
- **The packaged app now finds the launcher's keys (the Credential Manager
  namespace fix).** The keyring crate derives Windows credential target
  names as `{user}.{service}` — the app was reading and writing
  `api-key.ACUTE-CODE/provider/openrouter` while the launcher's cmdkey
  stores `ACUTE-CODE/provider/openrouter`. Two disjoint namespaces: every
  boot logged "no provider keys found" moments after "stored (length 73)".
  The keyring crate is gone, replaced by direct `CredReadW`/`CredWriteW`
  FFI with exact target-name control: reads and writes now use the
  launcher's canonical `ACUTE-CODE/provider/<id>` targets (byte-identical
  to cmdkey — same type, user, and persistence), the pre-R55 keyring-form
  targets are still read as a legacy fallback so keys saved through older
  app builds keep working, and saving a key in Settings retires the legacy
  entry so there is exactly one namespace from now on. The sidecar spawn
  now injects all four keys (`openrouter`, `openrouter-slot2/3/4`) and
  sidecar.log says so — keys + Restart-engine + a booting engine means the
  whole desktop session works.

### Added

- **The launcher prints what's new after an update.** A version bump used to
  be indistinguishable from "nothing happened": after installing a new
  desktop version, the ACUTE.bat console now shows that version's changelog
  summary ("What's new in 0.55.0 — …") straight from the repo.
- **The post-launch guidance is explicit about how to start the app next
  time** — desktop shortcut or ACUTE.bat (double-click = update + start),
  keys picked up automatically, and what to do if the offline screen ever
  appears.

## [0.54.0] - 2026-08-30

Round 54 — the reliability round. The owner's second desktop session reported
"can't reach agent core" on the packaged app (with Restart-engine not
recovering it), and after deleting the app folder the launcher printed
"installed desktop app 0.53.0 is current" followed by "ACUTE-CODE.exe not
found — using the dev-servers flow" instead of reinstalling. Three root
causes, three fixes, plus a big diagnosability upgrade so the NEXT failure
explains itself.

### Fixed

- **The launcher now trusts the disk, not the registry.** The NSIS uninstall
  entry survives manual deletion of the install folder, so the launcher
  believed "0.53.0 is current" while the exe was gone — and fell back to the
  browser instead of reinstalling. The install is now verified on disk
  (the app exe, the pinned `node.exe`, and the sidecar entry) before the
  "is current" decision; a broken install is repaired by reinstalling, and
  the console says exactly what was missing.
- **The packaged app's engine failures are no longer half-blind.** agent-core
  prints its real startup failure to stderr — but a GUI app has no stderr
  handle, so the old `Stdio::inherit()` sent it nowhere: the app could only
  ever say "stdout closed before the ready line". stderr is piped now and
  drained into `sidecar.log` (`sidecar:stderr] …`), and the failed-startup
  error string carries the engine's recent output.
- **A failed handshake no longer orphans its node.exe.** The old code dropped
  the child on a ready-line/health failure — on Windows the process kept
  running, holding the SQLite database while every Restart-engine attempt
  raced a zombie. Failed attempts now kill the whole child tree.
- **Running instances are closed before install and launch.** Upgrading over
  a live app can leave a hybrid install (locked files), and launching over
  one opens a second window. The launcher now closes exactly the processes
  whose executables live in the install dir (the app + its bundled node —
  never anyone else's node).

### Changed

- **The engine handshake retries (3 attempts, 25s ready budget each) before
  declaring failure.** A cold first boot — Windows Defender scanning a
  freshly installed 200+ MB tree, the first SQLite migration — is exactly the
  launch most likely to outrun a single deadline. The UI's connect deadline
  follows (90s → 150s) so the webview never gives up before the shell's own
  retry loop has had its say.

### Added

- **The offline screen shows the engine log in-app.** Instead of "check
  sidecar.log in %APPDATA%", the screen now renders the last 60 log lines in
  a scrollable box (new `sidecar_log_tail` shell command) with a **Copy
  diagnostics** button that puts the error + log on the clipboard — a
  failure now explains itself on screen.
- **The launcher window watches the engine start.** After launching the
  desktop app, ACUTE.bat polls `sidecar.log` for the "listening on
  127.0.0.1:…" line and prints "agent-core is up — port N" — or the log tail
  when the engine fails — so the console that launched the app tells the
  same story the app window does.
- **Browser-mode folder picking is bounded and honest.** The Add-project
  dialog's Browse button now shows "Opening the system folder dialog…"
  feedback, the dialog fetch is limited to 2 minutes (a hung PowerShell
  dialog used to spin the button forever), and every failure message says
  outright that pasting the folder path always works.

## [0.53.0] - 2026-08-30

Round 53 — the connection round. First run of the packaged desktop app
reported "Could not reach agent-core at http://127.0.0.1:55963 (TypeError:
Failed to fetch)", "Agent core unreachable" in Settings, and keys that looked
missing. All three shared one root cause — fixed at every layer, plus the
diagnostics and recovery the app needed to be self-healing.

### Fixed

- **The stale-port bug (the "55963" error).** The sidecar binds an ephemeral
  port on every launch, and the UI persisted that port (`baseUrl`) plus
  `demoData: false` to localStorage — so the NEXT launch rehydrated a
  previous session's dead endpoint and every request died with "Failed to
  fetch". Inside the desktop app NOTHING is persisted anymore: every boot
  starts from safe defaults and adopts the live endpoint in memory
  (pre-R53 localStorage blobs are retired on read; browser dev keeps its
  stable-port persistence).
- **The handshake race (why the port went stale in the first place).** The
  shell used to answer the UI's `sidecar_info` call exactly once — while its
  own sidecar handshake (up to 25s of blocking startup inside `setup`) was
  still running. Losing that race left the app pointed at the dead port for
  the whole session. The handshake now runs on a background thread (the
  window paints immediately) and the UI POLLS until the engine is actually
  up.
- **The invisible startup failure.** If the sidecar failed to start in the
  packaged app, the only error went to a console that doesn't exist in a GUI
  process. Every lifecycle line (spawn command, ready, health, injected
  provider keys, failures, exits) is now appended to
  `%APPDATA%\acute-code\sidecar.log`, and the failure reason surfaces IN THE
  APP.

### Added

- **Connection splash + offline screen.** The app gates its whole tree on
  the engine: a branded "Connecting to agent-core…" splash while the engine
  boots (no screen can fire requests at a dead endpoint anymore), and — if
  the engine fails — a clear screen with the REAL error, a one-click
  **Restart engine** button (the shell tears down and re-runs the full
  lifecycle; no app restart), and the sidecar.log pointer.
- **Mid-session watchdog.** The shell watches the engine process; if it dies
  while you work, the app notices within ~20s, shows the exit reason, and
  the same Restart engine button recovers it (all data is safe on disk —
  reconnecting re-fetches everything).
- **Live diagnostics for support.** `sidecar_status` (the lifecycle phase +
  error) and `restart_sidecar` are new shell commands; sidecar.log rotates
  at 1 MB; provider keys injected at spawn are logged by id + length only
  (never values).

## [0.52.0] - 2026-08-30

Round 52 — command supervision, sub-agent control, the real Usage screen,
and the plugin-based tool system. The headline fix: a background command
(`start /B node server.js > server.log 2>&1`) can never stall an agent turn
again — and the agent always knows how to check on what it started.

### Added

- **Background jobs — commands that outlive their tool call are now
  first-class citizens.** When `run_command` launches something detached
  (Windows `start /B … > log 2>&1`, Unix `… > log 2>&1 &`, `nohup`), the
  call returns IMMEDIATELY with a job id, the captured output, and exact
  polling instructions — never a silent "running…" for ten minutes. A hard
  watchdog kills any command whose shell never exits within the timeout
  (60s default) and reports the partial output. Two new tools, `job_status`
  (list/inspect, with the live output tail and the log-file tail) and
  `job_stop`, let the agent — and the main agent supervising sub-agents —
  poll and stop what it started; the prompt now teaches verify-after-start
  and poll-don't-wait as discipline. The Terminal panel gained a
  "Background jobs" section: live status, output tails on click, and a
  Stop button per running job.
- **Live terminal output in the chat.** Running commands stream their
  stdout/stderr into the working section while they execute (a compact
  live tail under the command pill, stick-to-bottom), in the sub-agent
  panel, and in the expanded command detail — the "terminal interface"
  of every command, not just its final result.
- **Sub-agents are stoppable and watchable.** The Stop control now works
  on sub-agents exactly like the main agent — a Stop button on the
  sub-agent panel header (and the API route behind it) aborts just that
  child; the parent gets an honest "sub-agent was STOPPED BY THE OWNER"
  report instead of a silent hang. While a child runs, the supervisor
  samples it every 15s and the panel shows a live watch line (last
  activity, elapsed, tool count, todo progress); a child with no activity
  for 5 minutes (configurable) is auto-stopped and reported as stalled,
  and the main agent is taught to act on those reports. The heartbeat
  cadence and the stall timeout are configurable in Settings →
  Sub-agents.
- **The real Usage screen.** The in-app Usage page (previously a
  placeholder) is now a full analytics view over the local ledger:
  overview stat cards, a token activity chart with a 7/14/30/90-day range
  selector, a tool leaderboard with failure counts, model cards with
  token/cost splits, and a projects → sessions drill-down with sub-agent
  runs nested under their parents and click-through to each chat.
- **A plugin-based tool system (DeepSeek-harness style, pragmatic).**
  Every built-in tool group (filesystem, search, git, terminal+jobs, web,
  browser, memory, todo, delegation) is now a self-contained plugin module
  behind a registry — the tool catalog is COMPUTED from the real plugin
  declarations, so the UI's tool list can never drift from the backend
  again. External plugins load from disk: drop a `.mjs` file into
  `~/.acute/plugins/` (on by default) or the project's
  `.acute/plugins/` (opt-in via settings) to add your own tools with the
  standard name/grammar/collision rules, fail-soft loading, and caps.
  See ADR-0025 for the decision record and MAINTENANCE.md for the
  add-a-tool recipe.

### Fixed

- **The ten-minute command hang (owner-reported).** Node's `close` event
  only fires when the stdio pipes close — a detached grandchild inherits
  those pipe handles and holds them for its whole lifetime, so the tool
  promise never resolved and nothing ever checked status. `exit` and
  `close` are now tracked separately; a pipe-holding grandchild becomes a
  tracked background job, a never-exiting shell is tree-killed by the
  watchdog, and a Unix `&` launch registers a detached job whose liveness
  is probed via its process group (found live in the round's battery: the
  fully-redirected Unix case closed its pipes instantly and used to
  vanish from tracking entirely).
- **The model-selector flyout no longer snaps shut on the way to it.**
  Crossing the gap between a provider row and its models flyout used to
  fire the row's mouse-leave instantly and close the menu before the
  pointer arrived; the flyout now has the same ~220ms hover-bridge the
  context donut got in R51 (leave schedules a close, entering the flyout
  cancels it).
- **The dev webapp at `http://[::1]:5173` now works.** The IPv6 loopback
  literal origin was missing from the sidecar's CORS allowlist, so every
  preflight died 401 and the app silently fell back to demo data.

### Changed

- The system prompt's terminal section now bakes in the
  background-process discipline (launch detached, verify with
  `job_status`, poll between steps, stop when done), and the supervision
  section teaches the main agent to act deliberately when a child stalls
  or is stopped by the owner.

## [0.51.0] - 2026-08-30

Round 51 — the desktop shell finally ships to the owner, plus the
fourth-test-round polish pass across the composer, the sub-agent panel,
the main agent's efficiency, and the dashboard.

### Added

- **The Windows desktop app, installable in one click.** The launcher now
  downloads the release installer and sets up the real desktop app
  silently (no admin required): the full Tauri shell with the native
  Chromium browser, the bundled agent backend (a pinned Node 24 runtime +
  the sidecar, no local Node needed), and the owner's OpenRouter keys
  seeded straight into Windows Credential Manager. Everything the browser
  rounds were building toward — the embedded browser finally activates on
  the owner's machine, and the browser panel shows which engine is live
  ("Chromium (native)" / "Proxy fallback") with an automatic fallback to
  the proxy renderer if the native engine ever fails. If anything in the
  desktop flow fails, the launcher falls back to the previous
  dev-servers-in-your-browser flow untouched. The app window can no
  longer be shrunk below a usable size (min 1000×620), and the composer's
  toolbar wraps instead of ever overlapping its controls.
- **A fast smoke suite: `pnpm smoke`.** One command runs a curated set of
  the critical-path tests (320 tests, ~17 seconds) and reports a green/red
  verdict — the quick "did I break the spine?" check between full gates.
- **The Usage page on the public dashboard** (with `pnpm usage:export` in
  the app): per-project and per-session usage statistics — tokens, cost,
  duration, model, status, every tool call broken out, sub-agent runs
  nested under their delegating session — rendered as a clean, modern
  page with overview cards, an activity chart, tool leaderboards, and
  expandable drill-downs.
- **A loop-hygiene guard in the agent runtime.** A model that re-calls
  the same tool with the same arguments now gets a corrective nudge after
  3 repeats, and an honest, retryable stop after 5 identical calls (or 6
  consecutive failures) — no more burning turns in circles.
- **Main-agent / sub-agent / combined session stats** in the context
  popover: the session's own usage, the summed usage of its sub-agents,
  and the combined total, each with requests, tokens, and cost.

### Changed

- **The main agent is now explicitly taught to work efficiently.** The
  system prompt gained an EFFICIENCY section — understand first with one
  batch of parallel reads, plan once, execute directly, verify only when
  risk exists — and lost the old mandatory re-read-after-every-write
  rule and the "use your 80-round-trip budget" step-incentive.
- **The composer's controls, per the owner's spec:** Add Context is now
  just the paperclip icon; the model button shows only the model name
  (provider on the tooltip); the provider→model flyout measures the
  viewport and can no longer be cut off at the bottom or right; the
  context donut dropped its inline percentage (details on hover) and its
  popover now stays open while you move the pointer into it, with
  amber/red warning colors as the window fills.
- **The sub-agent panel, de-sloped:** the final report no longer carries
  the accent left rail (it reads like every other message, with a quiet
  label); the todo card shows the FULL checklist with per-item status
  instead of just a progress bar; the stats footer is centered and
  visually refined.
- **Delegations and file edits stand out in the transcript:** collapsed
  tool rows for `delegate_task` and file edits now carry a tinted icon
  chip so agent calls and file changes are visible at a glance, without
  expanding anything.

## [0.50.0] - 2026-08-30

Round 50 — the owner's third test round: a real embedded browser, live
sub-agent streaming, and the fully-specified chat composer.

### Added

- **A native embedded browser.** The browser tab now renders through real
  Chromium: every tab is a WebView2 child webview hosted inside the app
  window, positioned exactly over the panel's page area — no proxy, no
  tickets, no URL rewriting, so every site loads with its real CSS/JS.
  Tabs share one persistent browser profile (logins survive app restarts
  and are isolated from the system browser); the address bar, history
  buttons, and viewport presets drive the webview while the agent's
  `browser_control` tool stays in sync with what you actually see. The
  fetch-proxy iframe remains as the fallback outside the desktop shell.
- **Sub-agents stream their raw thinking and text live.** A delegated
  sub-agent's panel now shows the actual tokens — thinking and text — as
  they are generated, exactly like the main chat, plus its tool calls as
  they happen.
- **A stats bar at the bottom of the sub-agent live view:** total time,
  tokens sent, tokens received, tokens per second, and the model in use —
  live while it works, authoritative values after it finishes.
- **Five attempts on rate limits.** Provider calls previously gave up
  after three attempts (the SDK default); they now retry five times with
  exponential backoff.
- **A redesigned chat composer** (the controls live inside the message
  box): **Add Context** — attach files via the Windows file picker, pick
  project files from a searchable list, `@`-mention files, or drag and
  drop; **permission modes** — Full Access / Ask (default) / Plan
  (read-only research) / Editor (file edits without a terminal);
  **thinking level** — Default / Low / High / Max; **a model picker** that
  opens your providers and shows each one's models on hover with a
  Manage-Models shortcut to the settings; and **a context donut** — a ring
  of the current context usage that opens a detailed breakdown (messages,
  system prompt, system tools, memory, meta), the cache hit rate, and the
  session's token and cost totals. An empty chat centers the composer in
  the lower half of the screen.
- **The Models & Providers page reworked:** the provider list and the
  detail pane scroll independently; models are added from a searchable
  catalog picker with multi-select (free/paid badges, pricing
  pre-filled); every model's advanced configuration is editable — input,
  output, and cached-input prices per million tokens, context window, max
  output tokens, thinking support, and picker visibility.

### Fixed

- Clearing a model's price never persisted (an explicit empty field was
  silently treated as "keep the old value"), and re-adding an existing
  model reset its "supports thinking" flag. Both are now field-precise.
- The context meter now reads the model's real context window from its
  configuration (previously a fixed 200k assumption for unknown models).

### Changed

- Plan mode restricts the agent to read-only tools; Editor mode removes
  the terminal; Full Access auto-approves permission asks (hard-blocked
  commands like `sudo`/`rm -rf` are still refused in every mode).
- Sub-agent sessions inherit the parent's permission mode.

## [0.49.0] - 2026-08-29

Round 49 — the file-tools repair round: every entry below fixes something
found while actually using the app on Windows (the owner's second test
session).

### Fixed

- **Agents have their file tools back.** On every install created before
  the orchestration rounds, the default "Acute" agent silently lost its
  entire project tool set (list_dir, read_file, write_file, edit_file,
  create_dir, delete_file, search, git, run_command, …) — two older
  migrations appended new tools to the agent's "all tools" allowlist and,
  in doing so, turned it into an explicit allowlist of exactly those five
  appended tools. Both the main agent and every sub-agent (children run
  the same agent row) then honestly reported "I have no write_file or
  list_dir". Migration 0019 repairs the damaged allowlist back to "all
  tools" — fingerprint-scoped so deliberate restrictions are never
  touched.
- **The embedded browser renders full pages.** Pages loaded but appeared
  as blank, unstyled HTML — every rewritten stylesheet/script/image URL
  was path-relative, and the document's injected `<base href>` (pointing
  at the upstream site) made the browser request them FROM THE UPSTREAM
  SITE, which 404'd them. Rewrites are now absolute URLs pointing at the
  sidecar proxy. Failed sub-resource fetches (404/500 CSS or JS) return an
  empty body instead of an HTML error page, so the console stays clean.
- **Saving from the browser works again.** The backend's cross-origin
  allow-list was missing the PUT method — every PUT-shaped save from the
  UI (settings toggles, API-key pool slots) failed silently at the
  browser's preflight check. Found while live-verifying the new memory
  switch.
- **A model that "announces" a tool call without making one gets one
  correction.** Free models sometimes answer a work request by writing the
  tool call as a code block in plain text; the turn used to end right
  there with nothing done. The agent now receives one in-turn nudge
  ("actually call the tool") when — and only when — the reply evidences
  tool intent; conversational replies still end immediately, and the
  nudge never appears in the chat log.

### Added

- **Nested sub-agents.** A sub-agent can itself delegate to further
  sub-agents (same tools, same workings, its own context and API key —
  the only differences), up to a fixed depth of 3 levels; beyond the cap
  the delegation tool is withheld so the fan-out stays bounded.
- **The memory master switch** (Settings → Advanced). Turn the whole
  agent-memory system off: no memory digest is injected into any system
  prompt, the memory tools are not offered, and the Memory panel says so.
  Saved memories are kept and restored when re-enabled.
- **Sub-agents run on their own context alone.** The project memory digest
  is no longer injected into sub-agent turns at all (main sessions keep it
  while the switch is on) — stale memories can no longer teach a
  sub-agent wrong facts about its own tool set.

### Changed

- **The app mark is now a cat.** The logo, favicon and Windows icon are a
  white cat-face silhouette (pointed ears, almond eyes, tiny nose) on the
  orange gradient tile.
- **The standalone Sessions screen is gone** — route, component and all.
  Sessions live on inside each project's chat, where they always actually
  belonged.

## [0.48.0] - 2026-08-29

Round 48 — the owner-test round: every entry below fixes something found while
actually using the app on Windows.

### Added

- Sub-agents can now ask for permission. A sub-agent that hits a
  needs-approval action (a non-read-only command, a web fetch or browser
  navigation outside the trusted-host list) pauses and asks you, exactly like
  the main agent: the approval card appears in the parent chat labelled with
  the sub-agent's code and role, and Allow / Always allow / Deny releases it.
  Channel-less runs (background retries) still fail fast instead of hanging.
- Sub-agents now work live in the UI. The Delegated card in the chat shows
  each running sub-agent with its code, role, progress and latest activity,
  and clicking it opens that sub-agent in the right sidebar — no more
  "Running… Running…" with nothing to click.
- The right-sidebar sub-agent view is now a real chat transcript — the task,
  the assistant's replies, every tool call with its result, todo progress and
  approval events, styled like the main chat — with a per-second clock.
- Every sub-agent now carries a short code (like `K7F2`), shown in the chat
  cards, the tab picker and the sub-agent tab title, so you can tell two
  running agents apart at a glance.
- Stopping the parent turn now also stops its sub-agents (pending approvals
  deny fail-closed; children stop cleanly between tool iterations).
- The Files action in the right sidebar now opens a real file explorer:
  the project tree on the left (folders expand, files open on click) and the
  file's contents on the right, with a Search button that still opens the
  file/command search palette.
- Projects now get distinct colors. New projects draw from an 8-color palette
  (least-used first) and existing projects are re-colored on first launch
  after this update, so the sidebar no longer shows a wall of identical
  orange. The active project highlights in its own color.
- A favicon (the new logo mark) for the browser dev setup.

### Changed

- The Sessions entry is gone from the left sidebar. Sessions live where they
  are used — under their projects — and the sessions screen remains reachable
  by its direct link only.
- New, sharper app logo: a solid "A_" prompt mark replacing the two-stroke A.
- Collapsed sidebar rail: the selected project now shows a clean inset ring
  instead of an oversized clipped outline, and the rail scrolls.

### Fixed

- The embedded browser no longer flashes and reload-loop every second, and
  no longer dies with "Browser proxy ticket missing, expired or invalid"
  after navigating or changing the viewport. Root cause: every navigate and
  viewport change silently rotated the browser-proxy ticket the panel was
  still using; tickets now stay valid (a fresh one is only minted by the
  explicit session re-mint), plus a bounded recovery loop as a safety net.
- The Browse button in the new-project dialog now opens the modern Windows
  folder picker (the File-Explorer-style one), and it appears ON TOP of your
  windows instead of hiding behind them — both in the browser/launcher setup
  and in the desktop app. The old-style tree dialog remains only as a
  fallback if the modern one cannot load.
- Sub-agents actually run their tools now: the approval gate previously
  failed every ask-tier action silently, which made browser control and most
  commands impossible for them and made delegation look stuck.
- Memory entries in the right sidebar dropped the colored left-bar accent in
  favor of clean uniform cards.

## [0.47.0] - 2026-08-29

### Added

- Provider management, cleaned up: the "Models & Providers" settings tab now
  runs on one shared API layer, its connection test can target the primary
  key or any key-pool slot and optionally a concrete model (a real one-token
  probe with measured latency instead of a bare reachability ping), and
  pasting a key in the browser-dev setup honestly warns that it lives in
  server memory only until restart.
- Model catalog from the server: the sub-agent model picker and the agent
  form now read the live model catalog (pricing, context window, tool and
  vision support) from the backend instead of each carrying their own
  hand-maintained copy, so newly shipped models appear everywhere at once.
  The agent form's provider dropdown also lists custom providers you added
  in Settings, and model fields suggest known ids while still accepting
  free text.
- Disabling a provider now actually stops it: turns against a disabled
  provider fail fast with a clear "enable it in Settings" message instead
  of quietly proceeding.

### Fixed

- Security: the launcher template and launcher no longer ship any real API
  keys (the round-44 baked-in sub-agent defaults were removed) — every
  credential value now comes from you and only you, and the launcher never
  writes key values into your credentials file.
- Security: an API route that returned a provider key in plain text (unused
  by the app) was removed.
- The launcher could never actually read the optional sub-agent pool keys
  from credentials.txt (names containing digits were skipped by the
  credentials parser), so your own pool-key values were silently ignored.
- Adding a key-pool slot in Settings could silently overwrite an existing
  slot's key when earlier slots had gaps (e.g. slots 2 and 4 occupied → the
  next add targeted 4 again); the next free slot is now computed correctly.

## [0.46.0] - 2026-08-28

### Added

- Context compaction: when a long session would overflow the model's context
  window, the over-budget history is now summarized by the model itself into a
  dense briefing (task, decisions, files touched, errors fixed, open steps)
  instead of being silently dropped. The summary persists as part of the
  session (fork and revert keep working), it is reused until the window
  overflows again, and a summarizer failure safely falls back to the old
  trim behavior.
- Relevance-ranked agent memory: `memory_recall` now scores results by
  multi-token relevance (content match strength, kind, importance and
  recency) instead of plain substring matching, the auto-injected memory
  digest ranks durable decisions above casual notes, and saving the same
  fact twice refreshes the existing memory instead of duplicating it.
- File restore from checkpoints: the diff view for agent file edits gained a
  "Restore" action (with confirmation) that reverts the file on disk to its
  pre-edit content — the round-25 checkpoint backend is finally reachable
  from the UI. The diff view also no longer misses the recorded snapshot
  while session events are still loading.
- Browser cookie persistence: the embedded in-app browser now keeps cookies
  in the project database, so logged-in sessions survive a restart. Cookies
  never appear in logs or agent-visible output.

### Fixed

- The first file-diff card in a session could permanently show "no snapshot
  recorded" because it rendered before the checkpoint list finished loading.

### Changed

- Terminal session behavior is now covered by black-box end-to-end tests
  (create → input → streamed output → exit → cleanup), in addition to the
  existing unit suite.

## [0.45.0] - 2026-08-28

### Added

- Persistent interactive terminal sessions per project: a real PTY shell when
  `node-pty` is available, a pure-Node fallback otherwise, exposed as a
  "Shell" mode in the Terminal panel that keeps its state between commands
  (idle shells are reaped, and each project gets a session cap).
- Packaging v1: version numbers are now single-sourced across the root
  package, agent-core, shared and the Tauri config (`pnpm version:set`
  writes all four, `pnpm version:check` gates CI), this changelog exists, and
  a release workflow assembles a downloadable launcher kit (CRLF-safe
  `ACUTE.bat` + launcher scripts + credentials template + changelog) with a
  draft GitHub release for every `v*` tag.
- A drift-guard test keeps the agent-form tool catalog in lockstep with the
  backend tool list — the silent "15 checkboxes vs 21 tools" gap found in
  round 44 cannot happen again.

### Security

- Provider API keys are no longer passed to child processes spawned by agent
  tools; children get an allowlisted environment only.
- The automatic read-only command tier is now contained to the project
  folder: absolute paths outside the project, `~`-relative paths and `..`
  escapes demote the command to interactive approval.
- Web tools now go through the approval engine: `web_fetch` and browser
  navigation are host-gated against an editable allowlist (with
  "always allow" per host), and web-search queries are scrubbed of secrets
  before leaving the machine.

### Fixed

- The Sessions screen search is usable on phones: a full-width search row
  under the header and a vertical results list while searching (was a cramped
  170px input plus horizontal scrolling through filtered results).

## [0.44.0] - 2026-08-27

### Added

- Persistent agent memory: agents save facts, decisions and preferences per
  project and get them injected into every later turn; a Memory panel in the
  right sidebar shows and prunes what was learned.
- Real web search: `web_search` queries the general web (DuckDuckGo) with an
  honest fallback chain, instead of returning encyclopedia-only results.
- Session intelligence: search across titles and message text, fork (copy a
  whole conversation under a new session) and revert-to-message (rewind the
  chat to any earlier user message).
- Streaming terminal: live command output with exit codes and a Stop button.
- Sub-agent API keys are auto-provisioned from `credentials.txt` — the
  sub-agent key pool fills itself, no manual entry in Settings.

### Fixed

- Sessions no longer stay "running" forever after a finished turn; revert and
  stop behave correctly on finished conversations.
- Recent-activity cards open the actual conversation instead of an
  unreachable screen; the Sub-agents settings tab is reachable from the
  sidebar navigation.
- The agent form's tool checkboxes were missing delegation, browser control
  and the memory tools (a stale frontend catalog).

## [0.43.0] - 2026-08-26

### Added

- Embedded browser panel plus a `browser_control` agent tool (navigate,
  history, viewport presets) so the agent can drive the user's browser panel.
- Free-model catalog: curated free OpenRouter models with an automatic
  fallback chain when a model is unavailable.
- Turn error cards in the chat with one-click retry.
- Sub-agent provider settings (per-sub-agent model overrides).

### Changed

- Chat geometry: messages use the intended reading width and center correctly
  at every window size.

### Fixed

- `delegate_task` was missing from every existing database's tool allowlist —
  delegation was silently unreachable for all seeded agents; a migration
  repairs old databases.
- CI repaired and green again.

## [0.42.0] - 2026-08-26

### Added

- Desktop notifications that fire even with the window closed (Web Push +
  service worker); turns complete in the background after you disconnect, and
  an explicit Stop button ends them.
- The launcher opens the browser automatically once the app is up; the
  embedded browser panel works in launcher/web mode, not just the desktop
  shell.

### Fixed

- The notification menu no longer cuts off at the screen edge; the chat keeps
  a minimum width while the right sidebar shrinks smoothly; sessions
  auto-name after the first reply and survive sidecar restarts.

## [0.41.0] - 2026-08-26

### Added

- Per-session sidebar state: expanded folders and the selected file/agent
  snap back per session instead of leaking across sessions.
- Desktop notifications while the app window is open, and automatic session
  naming from the first message.
- Embedded browser panel in the Tauri desktop app.

### Fixed

- Command-palette auto-open glitch on session/project switch; the
  notification menu is positioned fully on-screen at every window size.

## [0.40.0] - 2026-08-26

### Fixed

- Sub-agents had every tool silently stripped by an empty-allowlist sentinel —
  delegated children could not actually work; the system prompt no longer
  misreports the tools a child can reach.

### Added

- Notification center (bell menu) surfacing task events; click-to-open for
  files referenced in chat; chat width and sidebar dropdown bounds tuned.

## [0.39.0] - 2026-08-25

### Added

- Browser-style tabs in the right sidebar (Files, Browser, Terminal,
  Sub-agents) — each tab keeps its own state and new ones open from a menu.
- Background sessions: streams keep running while you navigate elsewhere, with
  a live running animation in the sidebar.
- Sub-agent multi-turn conversations.

### Fixed

- Short conversations sit against the composer instead of floating in the
  middle of a large empty pane.

## [0.38.0] - 2026-08-25

### Added

- Right sidebar with Files, Terminal, Browser and Sub-agents panels — the
  previously empty right side of the chat is now usable.

### Changed

- User messages restyled (soft accent-tinted bubble) and smooth
  collapse/expand animations for the working section and thoughts.

### Fixed

- Sessions no longer mix state across projects; sessions auto-title after the
  first reply; a newline-encoding bug garbled sub-agent prompts.

## [0.37.0] and earlier - 2026-08-25

Rounds 1–37 built the foundation: the spec and architecture skeleton, the
first live agent conversation, the setup wizard, the one-double-click Windows
launcher, the agentic MVP (projects, sandboxed tools, live-proven file
writes), the demo-parity chat UI with streaming replies and per-reply
telemetry, project indexing and code search, multi-turn agentic continuation,
sub-agent orchestration, the approval engine and structured logging. The full
history lives in `docs/agent/ORCHESTRATION-WORKLOG.md`; round reports in
`docs/ui-iterations/`.
