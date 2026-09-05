<!-- last-reviewed: 2026-09-05 round-67 -->
# COMPUTER USE — the desktop-control system (owner's guide)

**Status:** normative · **Established:** round-61 (owner directive: computer
use + a separately-configurable vision model; R66 moved the vision model to
its own section and made the Windows walk big-app-capable; R67 hardened the
Windows transport, taught the key tool to press keys, and stabilized the
monitor across thinking gaps) · **Audience:**
the owner (anyone flipping the switches and watching the monitor) and any
agent maintaining the system

Computer use lets the agent **observe and actuate your real desktop GUI** —
read an app's accessibility tree, click its buttons, type into its fields,
take and reason about screenshots. It is OFF by default, gated at three
levels, receipt-based (the agent never claims success — it reports what the
OS actually acknowledged), fail-closed (missing capability = a named
refusal, never a half-work), and stoppable at any instant by an enforced
kill switch. This runbook is the condensed REAL system; the uploaded spec
(`computer-use-docs/01..12`) it was built from stays the deep reference.

## What it is (the five design promises)

1. **A11y-tree-first, screenshot-coordinate fallback.** The agent's primary
   observation is `get_app_state` — the accessibility tree (element index +
   kind + name + flags), text-only, no pixels. Element actions
   (`{type:"element", stateId, index}`) are semantic, background-safe, and
   never steal your focus. Coordinates (`{type:"coordinate", x, y}`) are the
   FALLBACK: pixels copied UNCHANGED from the latest returned raster, valid
   only while that raster is fresh (10 s), converted to global screen points
   by the engine (the agent never scales).
2. **Receipts, not promises.** Every action returns an action receipt
   (`action_sent`, `dispatchStatus: accepted|refused|possibly_sent`,
   `retryAction`). `action_sent=true` means it MAY have happened — the
   system prompt and the built-in skill both teach verify-after-act.
3. **Fail-closed refusals.** A missing tool, a denied permission, a stale
   element, an out-of-frame coordinate — every one is a NAMED refusal code
   with a one-line explanation and the exact recovery step (see the table
   below). Nothing half-works; the backends "REFUSE (never degrade)".
4. **Enforced kill switch.** STOP (monitor panel, mini window, or the agent's
   own `stop_computer_control`) makes every further computer-use call refuse
   with `kill_switch_active` and releases any mouse button the session was
   holding (a real mouse-up at the recorded point). The kill switch ends
   THAT session — the next agent turn (new message → new toolset build)
   re-arms a fresh session automatically; the stopped turn itself keeps
   refusing to its end.
5. **One control session per engine.** The session (snapshots, frames, stats,
   the monitor ring) is a process singleton; snapshots are keep-last-8 with
   a 120 s TTL and are CONSUMED by any element write (supersession — the
   agent must re-observe before its next element action).

## Setup per platform

### Windows (the owner's platform)

No extra dependencies: PowerShell (always present) + UI Automation
(`System.Windows.Automation`). Every native call is a fixed PowerShell
script (JSON on stdout, DPI-awareness set first so Windows doesn't lie with
virtualized coordinates). Notes:

- **R67: capsules ride `-EncodedCommand` ARGV** — the script is the base64
  of its UTF-16LE text, passed as a command-line argument. The old
  transport piped the script through STDIN under `-Command -`, which has
  two live failure modes: PowerShell 5.1 can exit 0-with-no-output on an
  aborted run, and a child that exits early EPIPE-swallows the stdin write
  (an EMPTY script ran → exit 0, no stdout) — together those were the
  owner's "the PowerShell session died before emitting JSON" while
  tasklist worked fine. The biggest capsule (~8 K chars → ~22 K base64)
  stays under the 32 767-character CreateProcess ceiling.
- **R67: the Add-Type compile is guarded.** The one U32 helper class is
  wrapped in try/catch setting `$script:U32_OK`; when the (flaky, cold-csc)
  compile fails, `list_apps` falls back to Get-Process MainWindowTitle
  (entries tagged `source:"get-process-fallback"`) instead of the whole
  script dying before ANY output — the fallback was previously dead code.
  The readiness probe now also exercises the compile itself (`addTypeOk`
  in the probe report; a third probe next to the permission checks).
- Activation is the `SetForegroundWindow` + `AttachThreadInput` sequence
  with a ≤1.5 s **postcondition check** — the receipt's `active` field
  reports the truth, not the API's return value.
- Raw input is `SetCursorPos` + `mouse_event` (user32); typing is `SendKeys`
  after focus verification (see the key table below — R67 made it press
  real keys, not spell their names). Raw input on Windows requires the
  target app frontmost — the engine refuses with `frontmost_pid_mismatch`
  otherwise.
- **R67: a helper-process pid answers honestly.** A pid that is running
  but owns no accessible top-level window (e.g. a WebView2 renderer such
  as `msedgewebview2`) refuses with "target the HOST application instead
  (see list_apps)" — not the old misleading "no running application
  matches". A confirmed-dead pid keeps the plain not-running shape. An
  app list that comes back EMPTY-with-a-failure-note is retried once, and
  the refusal carries the note as `probeNote` so the agent sees WHY.
- Elevated targets (admin apps) refuse with `uipi_blocked` — Windows
  silently discards the input; retrying is pointless (a human step is
  needed).

### macOS

- Deps: `osascript` (System Events = the AX bridge — built in) and
  `screencapture` (built in). Raw mouse/keyboard synthesis is best with
  **cliclick** (install via Homebrew: `brew install cliclick`); without it
  the macOS backend approximates raw input foreground-style and reports its
  capability honestly.
- Permissions (System Settings → Privacy & Security): grant ACUTE-CODE
  (or the terminal running it) **Accessibility** (gates every AX call) and
  **Screen Recording** (gates captures + window titles). The readiness probe
  READS these states — it never pops the OS dialogs from tool code.
- `bundle_id` is the preferred app reference on macOS.

### Linux (X11)

Deps (each probed once; a missing tool fails closed with
`unsupported_on_backend`, never half-works):

```bash
# Debian/Ubuntu:
sudo apt install xdotool wmctrl scrot imagemagick xclip x11-utils \
  at-spi2-core libglib2.0-bin
# Fedora:
sudo dnf install xdotool wmctrl scrot ImageMagick xclip x11-utils \
  at-spi2-core glib2
```

(On Fedora, `xrandr` ships in `x11-utils`/`xorg-x11-utils`.) What each tool
does:

- `wmctrl -lGp` — app + window enumeration (fallback: GNOME Shell via
  `gdbus`, then a ps approximation without geometry).
- `xrandr --current` — displays + bounds.
- AT-SPI over DBus via `gdbus` — the accessibility tree (needs the session
  bus + a running at-spi registry; Chromium apps need
  `--force-renderer-accessibility`).
- `xdotool` — raw input + foreground checks. **X11 only**: Wayland has NO
  generic input injection (doc 04 §5) — the backend reports it honestly.
- `import` (ImageMagick) or `scrot` — capture, PNG to stdout.
- `xclip` (or `xsel`) — clipboard.

## Settings → Computer Use (the two gates + readiness)

The whole surface is dark until YOU turn it on
(`computerUse.enabled`, default **OFF** — the owner's on/off directive).
R66 note: this tab is now PURELY the desktop-control surface — the vision
model that used to live here moved to its own section (see below):

1. **Master switch** — OFF by default. While off, the plugin contributes
   zero tools and the agent cannot control the desktop at all.
2. **Posture** (visible only while ON):
   - **observe** — only the 12 read-only tools are even registered (the
     model never sees a mutating schema): `list_apps`, `list_windows`,
     `list_displays`, `switch_display`, `get_app_state`, `find_elements`,
     `screenshot`, `zoom`, `cursor_position`, `request_access`,
     `read_clipboard`, `wait`.
   - **act** (recommended) — all 31 tools; in ask permission-mode the
     real-input risk classes (typing, keys, clipboard writes, drags,
     coordinate/raw clicks, activations) ride the SAME approval flow as
     `run_command` — you see a dialog before the agent moves your real
     mouse. Element presses (background-safe) and observations never prompt.
     `find_elements` is observe-only — it never prompts in any posture.
   - **auto** — all 31 tools with no per-action approval prompts.
3. **Test readiness** — runs the engine's readiness probe (permissions +
   backend capabilities; never pops OS dialogs) and shows the result:
   green "Ready" or amber "Issues" with the report's lines. The probe's
   route composes the UI verdict server-side: `ok` = both core
   capabilities granted, `issues` = the report's notes (+ explicit
   denied-permission lines).

A small pointer card at the bottom of the tab notes where the vision model
went ("Image analysis (the vision model) now lives in its own section —
open Settings → Image Analysis").

## The vision model (moved to its own section in R66)

The vision subsystem describes screenshots in text when the agent asks for
it (`screenshot`/`zoom` with `describe:true`) — and, since R66, also powers
the general `analyze_image` tool and the embedded browser's screenshot
descriptions. Its configuration is GLOBAL and lives in
**Settings → Image Analysis** (`vision.mode`/`vision.provider`/
`vision.modelId` — migration 0025 seeds them from the old
`computerUse.vision.*` rows, so an existing setup moves losslessly):

- **off** (default) — screenshots still return raster METADATA (frame id,
  size, scale) and coordinates still work; the a11y tree remains the
  observation channel. Nothing breaks.
- **separate** — pick any provider + a model id, and paste that model's OWN
  API key into the dedicated vision-key slot (the key row rides the SAVED
  provider in the Image Analysis tab). The key rides the keyring
  pseudo-provider `<providerId>-vision` (credential target
  `ACUTE-CODE/provider/<providerId>-vision`, env
  `ACUTE_PROVIDER_<ID>_VISION`) — the same store/handoff pattern as every
  other key, never shown in full (masked `Key saved` + Replace/Clear). If
  no dedicated key is pasted, the provider's PRIMARY key is used (one
  provider, one key — a valid configuration, reported honestly).
- **main** — use the turn's main model, allowed ONLY when that model's row
  is marked **supports vision**. Flip the eye toggle on the model rows in
  the Image Analysis tab (or set the flag in Models & Providers); the flag
  is prefilled from the catalog for known vision models.

See the [EXTENSIBILITY](EXTENSIBILITY.md) R66 addendum for the
`analyze_image` tool this configuration also powers.

The relay speaks `chat-completions` (OpenAI/OpenRouter/Google-compat) and
`anthropic-messages` formats, direct fetch, one image + one instruction,
terse text back. It is called ONLY for describe requests — never
automatically.

## The monitor (watching the agent work)

ROUND-64: **the surface is the ALWAYS-ON-TOP floating monitor** — the
right-sidebar "Computer" tab is REMOVED (one surface, and it must be
reachable while the agent drives OTHER apps). ROUND-66 (R66, the owner's
A1/B1 report) reshaped it:

- **Desktop app**: a **460×56 single-row** frameless OS window
  (`acute-computer-mini`) that floats ABOVE EVERYTHING (always-on-top,
  never in the taskbar, never steals focus), parked **top-center** of the
  monitor you're looking at (was top-right + taller — the owner: "make it
  less tall and make it centered at the top, not on the top right"). The
  one compact row: pulsing status dot + "Agent is using your computer" +
  elapsed timer + the latest activity + the STOP kill switch. Drag it by
  its header.
- **Web mode**: the same minimal bar as an in-app pill at the top-center
  of the window (auto-shown/hidden the same way).
- **THE LIVE SIGNAL (R66 rework): real control events only, with a 6-second
  decay.** The monitor shows "live" while — and only while — real
  computer-use frames keep arriving; 6 s of silence = the agent stopped
  driving your desktop = hide. A merely-ENABLED session (the long-lived
  singleton stays active while Computer Use is on) no longer pins it on
  forever, and **browser turns never trip it**: the embedded browser's
  `screenshot` action no longer records into this ring at all (browser
  work is not computer use — that was the owner's A1 report). The web pill
  and the OS window both key off the same decayed signal. **R67 adds the
  TURN HOLD** (see below): while a computer-use turn is open, a stable
  latch keeps the monitor up through thinking gaps — the decay still hides
  it after the turn ends or the stop signal fires.
- **Data path**: every tool execution emits one `{type:"computer-use"}` SSE
  frame at dispatch time (live, zero polling latency) — the main app's
  controller watches these to open/close the OS window; the mini window
  itself polls `GET /computer-use/session` every second (its own bearer
  token via the shell) so it stays honest even if the main window is
  backgrounded.
- **STOP** = `POST /computer-use/stop`: the kill switch engages, a held
  button (if any) is released with a real mouse-up at its recorded point,
  and every further computer-use call refuses with `kill_switch_active`
  ("Stopped — the kill switch is active" locks in for the REST OF THE
  TURN; the next turn's toolset build re-arms a fresh session — the
  long-lived engine is never bricked by a stop).

## The safety contract

- **Approvals in act mode**: the consent gate covers exactly the real-input
  risk classes (typing, key chords, clipboard writes, drags, press-and-hold,
  coordinate clicks, app activation). Declining returns a
  `host_policy_denied` refusal; the agent is told not to retry the same
  action.
- **NEVER types credentials** — passwords, API keys, OTPs: hard rule in the
  system prompt AND the built-in computer-use skill. Destructive or
  hard-to-reverse actions need your explicit go-ahead; outward-facing sends
  are treated as publishing.
- **Audit journal** — one append-only JSONL line per tool call at
  `<project>/.acute/computer-use/audit.jsonl` (ts, tool, args, receipt or
  refusal). Redaction on write: credential-shaped strings (sk-/ghp_/AKIA/
  Bearer/api_key=…) are scrubbed; `text`/`clipboard`/`value` payloads are
  replaced by `{redacted, len}`; every string capped at 2000 chars;
  screenshots never enter the journal (frame ids only). A broken journal
  fails soft — it never takes a turn down.
- **Only the owner configures** — no computer-use setting is model-writable;
  all writes go through the authenticated settings routes.

## The key tool presses keys (R67 — the SendKeys table + the Tab-walk)

The owner's live failure: `key "tab"` typed the literal letters t-a-b —
the Windows backend special-cased only `{ENTER}` and sent every other key
token as TEXT; chords were never composed. R67 fixes the whole surface:

- **The key-name table** (`composeSendKeysChord` in
  `agent-core/src/computer/backends/windows.ts`): enter/return, tab,
  esc/escape, backspace, delete/del, space, up/down/left/right (+ the
  arrow* aliases), home, end, pageup/pgup, pagedown/pgdn, insert, help,
  and f1..f12 — each maps to its SendKeys literal (`{TAB}`, `{ENTER}`…).
- **Chords**: LEADING modifier tokens compose the SendKeys prefixes —
  ctrl/control → `^`, shift → `+`, alt/option → `%` — with exactly one key
  token left. `key "tab"` sends `{TAB}`; `ctrl+a` sends `^a`;
  `ctrl+shift+t` sends `^+t`. A single printable character is
  brace-escaped (`{+}` `{%}` `{^}` `{~}` `{(` `{{}`) and passes through;
  `'++'` is the plus key.
- **Honest refusals**: the Windows/Meta key (SendKeys has no such
  modifier) and unknown key names refuse with the full supported list
  BEFORE any capsule is spawned — nothing is typed on a guess.
- **The focused readback**: every successful `key` receipt carries
  `focused: "<element name>"` — the FOREGROUND app's focused control,
  best-effort (a null/empty/throwing readback omits the field, never
  fails the key).
- **The Tab-walk loop** (taught in the system prompt AND the built-in
  skill): when `find_elements` comes back empty or screenshots cannot
  identify the control, press `key "tab"` repeatedly — each receipt
  names the FOCUSED element, and Tab walks the focusable controls one by
  one. Combine with `find_elements` (search by name) in big apps.

On Linux nothing changed semantically: the same tokens join into one
  xdotool chord string as before (ordinary chords are byte-identical; a
  literal `'++'` now reaches the backend as the plus key instead of a
  degenerate empty chord).

## The monitor holds for the whole turn (R67)

The owner's report: the mini window disappeared while the agent THOUGHT
between tool calls — the 6-second liveActivity decay (correctly) treated
  silence as "stopped driving". R67 adds the **turn hold**: the
  stream-store calls `holdForTurn(sessionId)` when a computer-use frame
  arrives during an open turn and `releaseTurnHold` at turn end (every
  terminal path, including errors); the monitor's live signal is
  `(liveActivity || any turn hold) && !killSwitch`. The hold is a stable
  latch — it never decays and never bumps the activity ring — so the pill
  survives thinking gaps, and it is released (or rested by the
  `stop_computer_control` frame's `noteStopSignal`) the moment the turn
  ends. **Browser-only turns never hold** (only computer-use frames arm
  it) — the R66 "no pill on browser turns" guarantee is structural.

## Big apps (browsers, Edge, VS Code) — find_elements (R66)

The owner's live Edge report: the agent was "not able to detect where it
needs to tap, stuck taking screenshots" — a Chromium-sized window exposes
THOUSANDS of a11y elements, and reading the whole tree (or looping
screenshots) is exactly the wrong move. R66 adds the search:

- `find_elements {appRef, query, kind?, limit?}` — a SERVER-side filtered
  walk of the same snapshot `get_app_state` builds: name-substring match
  (case-insensitive), optional kind filter (button, textfield, checkbox,
  combobox, slider, tab, menuitem, row, text, image, pane, window,
  scrollbar), small capped result (default 20, hard max 40) whose entries
  carry `index` + `kind` + `name` + `flags` + `bounds` — and the `stateId`
  rides every result, so the indexes are DIRECTLY actionable element
  targets: `find_elements {appRef, query:"Sign in", kind:"button"}` →
  `left_click {target:{type:"element", stateId, index}}`. Cheaper than
  `get_app_state detail:"full"` on Chromium-sized windows.
- **No matches** is an honest refusal that names the query, the kind
  filter, and how many elements were walked (retry with a shorter/looser
  substring, drop the kind filter, or read the tree).
- The discipline (taught in the prompt section AND the built-in skill):
  in big apps, SEARCH first (`find_elements` + element clicks), NEVER loop
  screenshots when the tree can answer.

## The Windows walk (R66: fast + deep enough for Edge)

The Windows UIA walk was rebuilt for Chromium-sized trees:

- **Pattern probes only on potentially-interactive ControlTypes** (17 of
  them: Button, Hyperlink, Edit, ComboBox, CheckBox, RadioButton, Slider,
  TabItem, MenuItem, ListItem, DataItem, TreeItem, Spinner, Thumb,
  ScrollBar, Document, Custom). Every other kind (Window, Pane, Text,
  Image, Group, Table, … — the majority of Chromium's nodes) records
  kind+name+bounds with ZERO `GetCurrentPattern` calls.
- **ONE 4-probe pass per probed node** (Invoke/Toggle/ExpandCollapse/
  Value) whose handles are reused for flags + value capture + action
  advertisement — was up to 8 probes per node at `detail:"full"`.
- **maxEl 800 → 2400** (maxDepth stays 25): the walk reaches page content
  in Edge-sized trees, and the element-action re-walk moved with it
  (otherwise indexes 800+ would be findable-but-never-actionable).
- Non-probed kinds never carry pressable/editable/has-menu flags, a value,
  or advertised actions — fail-closed downstream, documented in the script.

**Honest note: the Windows backend remains construction-tested only** —
this sandbox is a headless Linux host (the walk's PowerShell script is
pinned by construction tests: the exact probe list, the 4-probe count, the
2400/25 caps, the cached-handle reuse). The owner's next live Windows run
is the real proof; if Edge walks time out in the field, the 25 s capsule
timeout is the first knob to raise.

## The 31 tools (quick reference)

| Tool | Purpose |
|---|---|
| `list_apps` | List RUNNING apps (name/pid/active) — absent means not running, not not installed |
| `open_application` | Launch by EXACT user-provided name (character-for-character) or activate a running one (`activate:true`) |
| `list_windows` | An app's windows (id, title, bounds, main, focused) |
| `get_app_state` | THE core observation: the window's a11y tree (detail:full adds bounds + actions; includeScreenshot adds a raster) |
| `find_elements` | SEARCH the tree by name substring (+ optional kind) — the big-app locator; returns small match lists whose indexes are directly actionable (R66) |
| `screenshot` | Full-display capture (the fallback observation); `describe:true` runs the vision model over it |
| `zoom` | Close-up region of the latest raster — a NEW raster to pick pixels from |
| `list_displays` | Displays (1-based index, bounds, main) |
| `switch_display` | Choose which display the next screenshot captures |
| `cursor_position` | Current pointer position + the display being captured |
| `left_click` | Click — element target = a11y press (preferred); coordinate = hit-test then raw |
| `double_click` | Raw only (coordinate) — no a11y equivalent |
| `triple_click` | Raw only (coordinate) — same contract as double_click |
| `right_click` | Element with a menu → a11y menu-open; else coordinate/raw |
| `middle_click` | Raw only (coordinate) |
| `scroll` | Coordinate-only (no a11y path); direction + amount 0–100 |
| `left_click_drag` | Drag from → to (same app); the gesture is raw |
| `mouse_move` | Hover — raw, coordinate only |
| `left_mouse_down` | Press-and-hold (pairs with left_mouse_up) |
| `left_mouse_up` | Release the button held by THIS session (cleanup-release only) |
| `type` | Type text — element = a11y value write (REPLACES contents); appRef = app-scoped (frontmost on Win/Linux) |
| `set_value` | Set a settable element's value directly (the preferred text write) |
| `select_text` | Select [start, length] or place the caret |
| `key` | Non-text keys and chords ('return', 'ctrl+a'); repeat 1–100 — R67: real SendKeys keys/chords on Windows, the receipt names the FOCUSED element (the Tab-walk loop) |
| `hold_key` | Hold a key/chord 0–30 s (never targetless) |
| `perform_action` | Invoke a NAMED a11y action from the element's advertised list |
| `request_access` | Read-only readiness probe (permissions + capabilities; never pops dialogs) |
| `stop_computer_control` | The kill switch — all further computer-use calls refuse |
| `wait` | Pause 0–30 s for animations, then re-observe |
| `read_clipboard` | Read the system clipboard text (observation) |
| `write_clipboard` | Write clipboard text (paste with `key 'ctrl+v'` into apps that fight synthetic typing) |

## Refusals → recovery (the catalog, condensed)

Every refusal is `{error, message, recovery}` — the codes:

| Code | Meaning / recovery |
|---|---|
| `kill_switch_active` | Session stopped — end the turn, report honestly |
| `computer_use_disabled` | Master switch off — tell the user, do not retry |
| `host_policy_denied` | Posture or the owner refused — background-safe path or ask |
| `accessibility_denied` | macOS Accessibility not granted — user step, END the turn |
| `screen_recording_denied` | macOS Screen Recording not granted — a11y-only if the task allows |
| `permission_denied` | OS/policy layer — read the message; don't infer macOS TCC from it |
| `request_access_refused` | The probe itself failed — report, don't loop-probe |
| `app_not_found` | No running match — `list_apps`, re-resolve; never guess pids |
| `ambiguous_app_ref` | Name matches several apps — scope with pid/bundle_id |
| `could_not_launch` | Launch failed — verify the EXACT name once; never substitute |
| `invalid_window_id` | Invented/stale window id — use a real one from list_windows |
| `frontmost_pid_mismatch` | Raw input but app not frontmost — activate → re-observe → retry ONCE |
| `foreground_required` | Event path needs focus — repeat activation + fresh observation |
| `uipi_blocked` | Elevated target (Windows UIPI) — human step; retrying is pointless |
| `targetless_input_refused` | No target on type/key — scope with element target or appRef |
| `capability_fail_closed` | Element can't do that action — re-observe detail:full, pick an advertised action |
| `element_stale` | State token superseded/changed/scope-drifted — fresh `get_app_state` |
| `frame_stale` | Coordinate raster is stale (>10 s or superseded) — fresh screenshot, resubmit pixels |
| `occlusion_owner_mismatch` | Another window covers the point — re-activate the intended app; NEVER touch the covering window |
| `raster_out_of_bounds` | Pixel outside the latest raster — re-look, never scale |
| `vision_disabled` | Vision off/unconfigured — configure it or proceed a11y-only |
| `unsupported_on_backend` | Not supported on this platform/backend — report honestly |

## LIVE-VERIFICATION CHECKLIST (honesty — read before trusting it)

The engine's logic is test-covered (gates, matrix, receipts, refusals,
audit, consent, vision relay, the 31-tool surface — see
[TESTING](TESTING.md)), **but this sandbox has no display**: the dispatcher
is tested against an injected fake backend, and the plugin tests run the
real Linux backend on a headless host where GUI probes fail closed (the
shape contracts are pinned, the live GUI paths are NOT). The Windows and
macOS backends are code-complete per the spec but have NEVER run on live
hardware — **the owner's 0.63.0 run was the FIRST live Windows exercise
and surfaced the R64 bug set (empty app lists, exact-title resolution) —
now fixed by construction with diagnostics on every empty result; the
0.66.0 run surfaced the R67 set (the stdin capsule deaths, the dead
fallback, the key tool typing t-a-b) — also fixed by construction
(-EncodedCommand argv, the guarded compile, the SendKeys table).** The
checklist below is how the 0.64.0+R67 fixes get verified. **The owner must
live-verify on the real machine before relying
on computer use.** Per platform, in order:

1. Flip the master switch ON (Settings → Computer Use) and press
   **Test readiness** — expect "Ready" (or read the issue lines; the
   report now also carries `addTypeOk` — the Add-Type compile probe — on
   Windows).
2. Ask the agent: *"list the running apps"* — expect a real app list via
   `list_apps` (a FIRST empty with the "session died" note should
   self-heal via the built-in retry; a second empty carries `probeNote`).
3. Ask it to **observe** one app (*"look at the X window and tell me what
   controls it has"*) — expect `get_app_state` output and a tree. Try a
   WebView2 renderer pid if you can find one in a task list (e.g.
   `msedgewebview2`) — expect the honest
   "target the HOST application instead" refusal, not "no running
   application matches".
4. **The key tool (R67)**: ask it to press *"press tab in the X app three
times and tell me what gets focused"* — expect the receipt's `focused:`
   field to name a different control after each press (the Tab-walk),
   and REAL key presses (a text field's caret moves; `key "tab"` never
   types t-a-b). A chord (`ctrl+a`) selects; `key "enter"` activates.
5. One small **act-mode** action with the approval dialog (e.g. *"click the
   X app's About button"*) — expect the approval prompt, then a receipt and
   a visible click. Try a refusal path too: a coordinate click with the app
   in the background should refuse `frontmost_pid_mismatch` (Win/Linux).
6. Watch the **floating monitor** appear automatically at the top of your
   screen when the agent starts using the computer (above other apps) —
   and STAY UP while the agent thinks between tool calls (the R67 turn
   hold), disappearing only after the turn ends (the 6-second decay) or
   STOP. Press **STOP** mid-task — expect every further computer-use call
   to refuse `kill_switch_active`, any held button released, and the
   monitor to disappear a few seconds after the session ends.
7. If a list comes back EMPTY, read the result's `diagnostics` block
   (processCount / foregroundPid / enumWindowsCount) — it exists precisely
   so a failure is debuggable from the transcript; an `app_not_found`
   refusal lists the running apps as candidates (and carries `probeNote`
   when the list itself failed).

If any step refuses unexpectedly, the refusal's message + recovery line is
the diagnosis; the engine log (sidecar log; `sidecar_log_tail` in the
offline screen) carries the capsule errors.

## Troubleshooting

- **"Issues" on Test readiness** — the report lists the exact missing
  grants/tools (Linux: which of xdotool/wmctrl/scrot/xclip/AT-SPI is absent;
  macOS: which TCC permission). Install/grant, re-test.
- **Nothing streams into the monitor** — the tab polls
  `GET /computer-use/session` (2 s while active); check the sidecar is
  reachable and the master switch is on (the OFF notice renders in the
  panel).
- **Vision describes nothing** — mode off, or separate without provider/
  model/key, or main without `supportsVision` on the row. The refusal/
  error names which one.
- **Wayland session (Linux)** — raw input is not supported (X11 only);
  observation + a11y still work if AT-SPI is reachable.

## See also

- [EMBEDDED-BROWSER](EMBEDDED-BROWSER.md) — the sibling surface (the app's
  in-app browser panel; the R65 boundary lines name each other)
- [ATTACHMENTS](ATTACHMENTS.md) — the live screenshot THUMBNAILS the
  captures now publish (the ephemeral raster registry + route)
- [EXTENSIBILITY](EXTENSIBILITY.md) — the sibling runbook (plugins, skills,
  MCP servers, the plugins listing route)
- [TESTING](TESTING.md) — the R61+R66+R67 suites and the verification ladder
- [MAINTENANCE](MAINTENANCE.md) — where things live in the tree
- Code map: engine in `agent-core/src/computer/` (types, errors, session,
  audit, dispatch, vision, backends/{interface,linux,windows,macos,index}),
  tools in `agent-core/src/tools/plugins/computer-use.ts`, settings in
  `agent-core/src/storage/computer-use.ts` (vision settings now in
  `agent-core/src/storage/vision.ts` — migration
  `agent-core/src/storage/migrations/0025_vision_settings.sql`), migration
  `agent-core/src/storage/migrations/0023_computer_use.sql`, routes in
  `agent-core/src/server.ts` (ROUND-61 section; R67: the frames raster
  route), monitor UI in
  `src/components/ComputerMiniWindow.tsx` + the mini window page
  `src/mini/MiniApp.tsx` + the OS window `src-tauri/src/mini.rs`, the live
  signal `src/lib/computer-monitor-store.ts`, settings UI in
  `src/components/settings/ComputerUseTab.tsx` (vision:
  `src/components/settings/ImageAnalysisTab.tsx`).
