<!-- last-reviewed: 2026-09-11 round-90 -->
# COMPUTER USE — the desktop-control system (owner's guide)

**Status:** normative · **Established:** round-61 (owner directive: computer
use + a separately-configurable vision model; R66 moved the vision model to
its own section and made the Windows walk big-app-capable; R67 hardened the
Windows transport, taught the key tool to press keys, and stabilized the
monitor across thinking gaps; R68 overhauled the Windows input path to raw
SendInput, made the foreground gate self-heal, poked Chromium's web tree
into existence, and made the monitor invisible to captures; R69 made
verification AUTOMATIC — every action returns an observation receipt,
coordinate clicks verify what they hit, stale frames auto-refresh, and the
re-capture loops refuse; R70 did not touch the engine — it changed what
the MODEL brings to it: the prompt's computer-use section kept only its
always-on discipline and points at the skill body for the deep contract
(skill bodies no longer evaporate mid-task now), the agent knows its
real OS/shell/date/git state, and the verify-before-claiming-done
contract + line-numbered read_file joined the general discipline) ·
**Audience:** the owner (anyone flipping the
switches and watching the monitor) and any agent maintaining the system

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
   only while that raster is fresh (30 s — R68), converted to global screen
   points by the engine (the agent never scales) — and R69 auto-refreshes a
   stale frame perceptually instead of dead-ending (see the R69 section).
2. **Receipts, not promises — and since R69, receipts that OBSERVE.** Every
   action returns an action receipt (`action_sent`, `dispatchStatus:
   accepted|refused|possibly_sent`, `retryAction`). `action_sent=true`
   means it MAY have happened — and R69 attached the verification read to
   the receipt itself: the 11 mutating tools carry a post-action
   `observation` (fresh frame, `screenChanged`, `focusedElementName`, the
   frontmost app's title) after a 600 ms settle, so the model reads the
   receipt instead of re-capturing (see the R69 section below).
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
  tasklist worked fine. **R68 re-measured:** the preamble is now 6,682
  chars and the biggest FIXED capsule (preamble + buildSnapshot)
  composes ~30,985 of the 32,767-character CreateProcess command-line
  ceiling — under it with ~1.8K headroom (past comfort; the model-payload
  capsules are runtime-guarded, see the ARGV ceiling guard in the key
  section below).
- **R67: the Add-Type compile is guarded.** The one U32 helper class is
  wrapped in try/catch setting `$script:U32_OK`; when the (flaky, cold-csc)
  compile fails, `list_apps` falls back to Get-Process MainWindowTitle
  (entries tagged `source:"get-process-fallback"`) instead of the whole
  script dying before ANY output — the fallback was previously dead code.
  The readiness probe now also exercises the compile itself (`addTypeOk`
  in the probe report; a third probe next to the permission checks).
- Activation is the `SetForegroundWindow` + `AttachThreadInput` sequence
  with a ≤1.5 s **postcondition check** — the receipt's `active` field
  reports the truth, not the API's return value. **R68: the ladder
  escalates** — see the activate section below.
- Raw input is `SetCursorPos` + `mouse_event` + **SendInput** (user32
  P/Invoke — R68-C: keyboard input is SendInput ONLY, never Windows.Forms);
  typing rides `SendText` (KEYEVENTF_UNICODE per character — see the key
  section below). **R68: the raw-input tools now ACTIVATE their target
  automatically and retry once** — a `frontmost_pid_mismatch` refusal
  means the auto-activation itself failed (see the foreground self-heal
  section below).
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
  its header. **R69: the bar really never steals focus now** — the re-open
  path no longer activates it (tao's `set_focus` secretly SYNTHESIZED an
  ALT-key keystroke pair to grab the foreground — stray synthetic input
  while the agent is mid-action, exactly the corruption class the R68
  SendInput rebuild exists to prevent), and the window carries
  `WS_EX_NOACTIVATE` so even clicking the bar never yanks the foreground
  from the app being driven; the STOP button and the drag region stay
  fully interactive (deliberately NO click-through style).
  **R68: the bar is INVISIBLE TO CAPTURES** —
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on the window: fully
  rendered on YOUR physical display, dropped from every screen-capture
  API (the agent's own GDI captures — it was being "detected" and
  occluding the UI it drove — plus Windows.Graphics.Capture, OBS, screen
  share). Corollary (the semantics, intended): your own recordings and
  screen-shares of a session will NOT show the bar either — the exclusion
  is global, not agent-specific. Pre-Windows-10-2004 hosts fall back
  honestly (the call fails non-fatally; the bar appears in captures
  there exactly as before). Re-asserted on every re-open (idempotent,
  self-healing).
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

## The key tool presses keys (R67 named them, R68 drives them through SendInput)

The owner's R66 live failure: `key "tab"` typed the literal letters t-a-b
— the backend special-cased only `{ENTER}` and sent every other key token
as TEXT. R67 fixed the SEMANTICS with a SendKeys chord table; the owner's
0.67.0 run then killed the ENGINE itself: every input call died
`capability_fail_closed` because `[System.Windows.Forms.SendKeys]` was
TypeNotFound — the preamble loaded Windows.Forms via the DEPRECATED
`[System.Reflection.Assembly]::LoadWithPartialName`, which silently fails
on modern .NET (while the captures' own `Add-Type -AssemblyName
System.Windows.Forms` worked live — screenshots succeeded all round; the
live trace proved LoadWithPartialName dead where Add-Type works).

R68's fix is structural — **Windows.Forms is a dead dependency for input**:
the `LoadWithPartialName` line is REMOVED, and every input path rides raw
**SendInput** P/Invoke in the SAME single-Add-Type U32 class:

- **Typing** (`typeText`): `SendText` — one KEYEVENTF_UNICODE down+up pair
  per character. THE PROPERTY THE OWNER CARES ABOUT: text is NEVER
  escaped — '+', '%', '~', '{', '}' are just characters. SendKeys needed
  a brace-escape set and an ENTER special case; KEYEVENTF_UNICODE has no
  syntax at all, so the whole escaping class of bugs is dead. Newlines map
  to real VK_RETURN presses (`\r` is skipped so a CRLF pair types ONE
  Enter).
- **Keys/chords** (`rawKey`): `composeVkChord` maps the key tokens to
  real Virtual-Key codes — the full R67 vocabulary (enter/return, tab,
  esc/escape, backspace, delete/del, insert, help, space, arrows + the
  arrow* aliases, home, end, pageup/pgup, pagedown/pgdn, f1..f12), single
  letters a-z, digits 0-9, and the OEM punctuation (+ - , . / ; ') —
  `[U32]::Chord` sends mods down → key → key up → mods up REVERSED in one
  SendInput batch. `key "tab"` is VK 0x09; `ctrl+a` is VK_CONTROL + 'A'.
- **THE WINDOWS/META KEY WORKS NOW** (win/meta/super/cmd/command → LWIN
  0x5B) — SendInput synthesizes it where SendKeys had no such modifier
  (R67 refused it honestly; R68 plays it), including as a click/drag
  modifier via `ModsDown`/`ModsUp`.
- **Everything else rides the same machinery**: the select gestures
  (`TapKey(HOME)` + shift+END for whole-text selection), horizontal
  scroll (arrow-key taps), and the click/drag modifier holds.
- **Honest refusals**: an unknown key name or an unmappable single
  character refuses with the full supported list + the "type it with the
  type tool instead" redirect BEFORE any capsule is spawned — nothing is
  typed on a guess.
- **The ARGV ceiling guard (R68, new)**: the three capsules that embed
  MODEL-SUPPLIED text (`type` app-scoped, `set_value`,
  `write_clipboard`) are measured before spawning — a payload whose
  composed `-EncodedCommand` would cross 31,875 base64 chars (the
  32,767-char CreateProcess command-line ceiling minus the fixed argv
  minus slack) refuses with a self-teaching error ("split it across
  multiple type calls") instead of dying at spawn. The old sizing comment
  claimed the typing path "stays far below" the ceiling because its
  timeout math caps text at ~1,400 chars — that was FALSE (the timeout
  clamp never capped the text); the guard is the fix. Measured honesty:
  the preamble is 6,682 chars and the biggest FIXED capsule (preamble +
  buildSnapshot) composes ~30,985 of the 32,767 ceiling — ~1.8K
  headroom, past comfort; further C# growth must re-measure, and the
  documented next step is a temp .ps1 file.
- **The focused readback** (R67, unchanged): every successful `key`
  receipt carries `focused: "<element name>"` — best-effort (a
  null/empty/throwing readback omits the field, never fails the key).
- **The Tab-walk loop** (taught in the prompt + the skill): when
  `find_elements` comes back empty or screenshots cannot identify the
  control, press `key "tab"` repeatedly — each receipt names the FOCUSED
  element. Combine with `find_elements` (search by name) in big apps.

On Linux nothing changed semantically: the same tokens join into one
  xdotool chord string as before (ordinary chords are byte-identical; a
  literal `'++'` reaches the backend as the plus key, mapped to
  VK_OEM_PLUS on Windows).

## The foreground gate self-heals (R68 — what the model sees now)

The owner's 0.67.0 trace: `open_application(activate=true)` verified
INACTIVE (Edge steals/holds the foreground through its own focus churn),
and every raw-input tool then REFUSED `frontmost_pid_mismatch` — the
recovery the refusal text preached ("activate, then retry once") was left
to the model to do by hand, mid-flow, repeatedly.

**The R68 contract:** every raw-input call (type, key per repeat,
left/right/double/triple/middle click, scroll, drag, mouse-down,
mouse-move, hold-key down) rides `withForegroundRetry` —

1. The foreground rule runs FIRST: if the target is not frontmost, the
   engine ACTIVATES it (the escalated ladder below) and re-reads the
   frontmost pid itself — the activation is trusted only when the OS
   confirms it (activate's own `{active}` receipt AND the independent
   frontmost read).
2. The action runs; if the backend's own script-level check raced the
   focus churn (FRONTMOST_MISMATCH mid-script), the engine activates and
   retries ONCE.
3. Only when the ACTIVATION ITSELF fails does the honest refusal remain —
   and its text now says so: "the automatic re-activation of pid N was
   already attempted and failed" + "check the app is still running
   (list_apps) and still owns the window (list_windows), re-observe with
   get_app_state, then retry ONCE — or report the focus conflict to the
   user."

Non-mismatch errors NEVER retry (one retry, mismatch-class only — no
retry storms). Consent note (documented in dispatch.ts): the model
already declared intent on THIS app and the tool-level consent gate
already ran on exactly that action — the auto-activation completes the
SAME consented intent; the only visible difference is the window coming
forward, which the open_application(activate:true) the old refusal text
told the model to call would have done anyway.

**The activate escalation ladder (R68):** the AttachThreadInput sequence
+ 1.5 s verify (R67) now ESCALATES when it fails — the classic
bulletproof foreground steal: `SW_MINIMIZE` → 150 ms → `SW_RESTORE` → a
second 1.5 s re-verify → the honest ACTIVE/INACTIVE receipt. The restore
path re-enters through the foreground grant the shell gives a restoring
window, which SetForegroundWindow alone cannot take from a process the OS
considers "not foreground eligible". TRADEOFF (accepted, documented at
source): the target window VISIBLY FLICKERS (one-frame minimize +
restore) — only when the polite sequence failed, and only once.

## Edge/Chromium pages are searchable now (R68 — the Chromium poke)

Why the owner's Edge trees came back SPARSE (only the window element):
Chromium builds its web accessibility tree ONLY after an assistive
technology pokes the render widget — `WM_GETOBJECT` to the
`Chrome_RenderWidgetHostHWND` child, exactly what a screen reader does on
connect. The tree EXISTS; the walk never asked for it.

Every Windows snapshot now pokes BEFORE the UIA walk: `[U32]::
PokeChromium` enumerates the target window's children, sends
`WM_GETOBJECT` (OBJID_CLIENT) to every render-widget child, waits 400 ms
for the tree to start building, then walks — and if the poke fired but
the walk still produced only the root window, a sparse-retry re-walks
ONCE (600 ms later, the first walk's output discarded). `find_elements`
routes through the same buildSnapshot, so ONE poke site covers
`get_app_state` AND `find_elements`.

**What this changes for Edge workflows**: `find_elements {appRef,
query:"Wikipedia", kind:"link"}` now returns REAL web elements (links,
buttons, inputs BY NAME) with directly actionable indexes — element
targets become the PRIMARY path for browser content and the screenshot
loop the fallback (the owner: a "coordinate-based system is not proper").
The prompts, the skill and the tool descriptions teach exactly this.

## Frames stay valid 30 s + the vision relay retries (R68)

- **MAX_FRAME_AGE_MS 10 s → 30 s**: the vision roundtrip (describeRaster
  through the separate model) takes 10–25 s BY ITSELF — a 10 s max-age
  expired the frame BETWEEN observing and acting, so every
  zoom-then-click pair died `frame_stale` (the frame was already dead the
  moment the observation finished; the debug report's own recommendation
  #1). 30 s covers the roundtrip with margin; the keep-cleanup still
  rides ×3 = 90 s (frames refuse as stale at 30 s but stay resolvable
  for 90 s). TWO DIFFERENT CLOCKS: the 30 s is coordinate freshness; the
  chat's inline screenshot tiles still expire at the server's 10-minute
  raster lifetime.
- **The vision relay retries 429/5xx**: one "Vision rate-limited (429)"
  used to kill the observation MID-FLOW (the owner's Edge flow stalled on
  exactly this). describeRaster now shares ONE attempt body across both
  wire formats (chat-completions + anthropic-messages), retries **429
  and ≥500 twice** with a 1.5 s + 3 s backoff, and fails fast on every
  other 4xx (auth/shape errors are terminal — retrying them is
  pointless).

## Every action returns an observation receipt (R69 — the enforcement layer)

R68 built the mechanisms (raw SendInput, the self-healing foreground,
the poked tree, 30 s frames) but VERIFICATION still cost a re-capture:
the receipt said `action_sent` and the only way to KNOW what happened
was another screenshot — the "utilizing the screenshot capturing way
too much" loop survived its own fixes. R69 makes the verification ride
the action itself:

- **The receipt's `observation`** — all 11 mutating tools (the clicks,
  `scroll`, `type`, `key`, `set_value`, `select_text`,
  `left_click_drag`), after a 600 ms settle:
  `{frameId, screenChanged?, focusedElementName?, activeApp?:
  {pid, title}, titleChanged?}` — a FRESH registered frame
  (raster-cached, zoomable), whether the screen CHANGED (a perceptual
  64-bit frame hash vs the pre-action frame — no vision round), which
  element holds the focus NOW (the key tool's readback), and the
  frontmost app + whether its title changed. Every field is omitted
  when its source is honestly unknown, never guessed; a failed capture
  yields `{captureFailed: true}` — the action receipt itself never
  fails on its observation.
- **`returnState`** (all 11 tools, in the tool schemas): `"compact"`
  (the DEFAULT) = the raster observation; `"none"` = skip it (tight
  loops); `"full"` = the complete accessibility compose (the R61
  shape).
- **The post-action frame renders INLINE in the chat** at the moment
  it was captured — `{type:"screenshot", tool: <the action's name>}`
  through the same R68 pipeline the model's own captures ride; a
  stale-frame auto-refresh frame emits first (`tool:
  "auto_refresh"`).
- **The model is taught to READ the receipt** (prompt + skill): never
  screenshot or zoom after acting; `screen_unchanged` (below) = act or
  change strategy; after navigation (Enter, links) call `wait()` —
  its receipt reports what changed. `wait()` is observable now: the
  post-sleep receipt carries the same observation (no action sent —
  `actionSent` stays false).
- **Per-action cost, honestly**: settle 600 ms + up to 4 PowerShell
  capsules (capture + list_apps + focused readback + the action) on
  Windows — the accepted trade: it REPLACES the 5–25 s
  screenshot+vision verification rounds it makes unnecessary.

### Click verification (coordinate clicks stop being blind)

- A coordinate-click receipt's `targetVerificationStatus` now reads
  `"changed"` / `"unchanged"` (upgraded from the blind `"unverified"`
  by the observation's `screenChanged`), and `hitElementName` names
  the element the point actually LANDED on — the hit-test the engine
  already ran, no longer discarded ("Search" edit, "Sign in" button).
- Honest bar: `screenChanged` is a full-frame diff — a click that
  flips only a small toggle can read `"unchanged"`. Treat unchanged as
  MAY-NOT-HAVE-REGISTERED: check `focusedElementName`, adjust the
  strategy, switch to element targeting (the prompt teaches exactly
  this).

### Element middle/right clicks (R69)

- `middle_click {target: element}` routes to the element's CENTER —
  open-in-new-tab flows work straight from a `find_elements` index, no
  coordinate guessing. double/triple click keep the honest
  raw-only contract (no center-click semantics exist for them).
- `right_click {target: element}`: keeps the semantic menu-open path
  when the element has a menu (auto/a11y strategy, receipt
  `"matched"`); otherwise it now routes a RAW right-click at the
  element's center (the old no-menu cell refused outright).

### The frame memory (aHash — new in R69)

Every registered frame now carries a perceptual 8×8 average hash
(Rec.601 grayscale, 64 bits — `agent-core/src/computer/framehash.ts`,
the round's only new dependency: pngjs, MIT) plus its PROVENANCE
(`model` | `auto_refresh` | `observation` — WHO captured it). "Did the
screen change?" becomes a ≤4-bit Hamming question instead of a
vision-model round; that hash powers the observation, the
auto-refresh, and the spam guard below.

### Stale frames auto-refresh (R69 — the frame_stale dead-end dies)

A coordinate action on a frame older than 30 s no longer dead-ends.
The engine re-captures the SAME coverage, registers the fresh frame
(`provenance: auto_refresh`, raster-cached, zoomable), and compares:

1. full-frame Hamming ≤ 8 → the screen is STATIC → the action
   PROCEEDS on the fresh frame (receipt: `frameRefreshed`,
   `refreshFrameId`, `screenStable: true`);
2. else target-region Hamming ≤ 6 (the element's bounds, or a ±48px
   box around the point) → the target held still while the screen
   moved → PROCEEDS (`screenStable: false`, `targetRegionStable:
   true`);
3. else the screen genuinely changed → the NEW `frame_changed`
   refusal carrying `refreshFrameId` — the fresh frame is ALREADY
   registered, so the recovery is ONE zoom round-trip (see the
   catalog below).

`set_value` and `left_mouse_down` keep the honest hard `frame_stale`
(they must not act on a stale anchor at all), and a failed/unhashable
refresh falls back to `frame_stale` with the honest why — the failure
signal is never lost.

### The screenshot-spam guard (R69 — `screen_unchanged`)

The THIRD consecutive model capture whose frame hash is ≤4 bits from
the previous (with no mutating action in between) refuses
`screen_unchanged` BEFORE anything registers — with the three
productive alternatives (act / `wait()` / `find_elements`). Resets on
any mutating action, a genuinely changed capture, or a frontmost-app
(pid) change; the engine's OWN captures (auto-refresh, observation)
never count — only the model's `screenshot`/`zoom`/`get_app_state
{includeScreenshot}` captures do.

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

## R70 — what changed AROUND the engine (the agent-brain round touched zero computer-use code)

The R70 prompt round reshaped what the model knows and does around
every tool surface, computer use included:

- **The prompt's COMPUTER USE section is the always-on DISCIPLINE now;
  the deep contract lives in the skill body.** The section kept its
  safety/posture/chain-discipline lines and ends pointing at
  `read_skill "computer-use"` for the full contract (app resolution,
  exact-spelling launches, recovery catalogs, modifiers, occlusion, the
  write discipline). That pointer now actually WORKS end-to-end: skill
  bodies are STICKY since R70 (`read_skill` + `memory_recall` results
  persist with a 60K budget and skip the 200-char replay stub — the
  6,440-char computer-use body no longer loses its middle in the event
  log or its whole self on replay; the last-resort context cap degrades
  to 8K with an honest "call read_skill again" marker, and the prompt
  teaches the reload).
- **The skill is gated on the master switch now.** While computer use
  is OFF, the `computer-use` skill is absent from the prompt's SKILLS
  index and `read_skill` refuses it ("computer use is disabled in
  settings — its tools are dark") — a dark surface is no longer
  advertised.
- **The agent knows its machine.** Every turn states the real OS +
  release, the real shell (`run_command` spawns cmd.exe on Windows /
  /bin/sh on POSIX — the TERMINAL section teaches only the real
  platform's syntax now), the current date, and the git branch + dirty
  state — no more guessing the platform before composing a command, and
  a dirty tree is named the USER's work the agent must never revert.
- **Line-numbered read_file.** The read_file tool returns `cat -n`
  output with optional `offset`/`limit` pagination (and both ends kept
  for oversized files) — path:line citations and exact edit anchors
  ride on it; the prompt's FILE EDITING section teaches that the
  number prefix is NOT content.
- **Verify-before-claiming-done.** The prompt's AGENTIC LOOP VERIFY
  phase + FILE EDITING rules now require running the touched
  tests/typecheck/lint before claiming done (commands discovered from
  the project's AGENTS.md / package.json; ask the owner once +
  `memory_save` the answer) — the same receipts-not-promises posture
  this runbook teaches, applied to the agent's own edits. For 3+ file
  edits the loop also suggests a `delegate_task` adversarial review.

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
| `left_click` | Click — element target = a11y press (preferred); coordinate = hit-test then raw — R69: every mutating tool's receipt carries a post-action OBSERVATION (see the R69 section) |
| `double_click` | Raw only (coordinate) — no a11y equivalent |
| `triple_click` | Raw only (coordinate) — same contract as double_click |
| `right_click` | Element with a menu → a11y menu-open; no-menu element → R69: raw click at its center; else coordinate/raw |
| `middle_click` | Coordinate, or ELEMENT target → R69: raw click at the element's center (open-in-new-tab) |
| `scroll` | Coordinate-only (no a11y path); direction + amount 0–100 |
| `left_click_drag` | Drag from → to (same app); the gesture is raw |
| `mouse_move` | Hover — raw, coordinate only |
| `left_mouse_down` | Press-and-hold (pairs with left_mouse_up) |
| `left_mouse_up` | Release the button held by THIS session (cleanup-release only) |
| `type` | Type text — element = a11y value write (REPLACES contents); appRef = app-scoped (R68: the app is auto-activated + frontmost verified on Win/Linux) |
| `set_value` | Set a settable element's value directly (the preferred text write) |
| `select_text` | Select [start, length] or place the caret |
| `key` | Non-text keys and chords ('return', 'ctrl+a', 'win+l'); repeat 1–100 — R68: real SendInput VK keys/chords on Windows (the win key works now), the receipt names the FOCUSED element (the Tab-walk loop) |
| `hold_key` | Hold a key/chord 0–30 s (never targetless) |
| `perform_action` | Invoke a NAMED a11y action from the element's advertised list |
| `request_access` | Read-only readiness probe (permissions + capabilities; never pops dialogs) |
| `stop_computer_control` | The kill switch — all further computer-use calls refuse |
| `wait` | Pause 0–30 s for animations — R69: the receipt reports what CHANGED (screenChanged, focused, title); the post-navigation read |
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
| `frontmost_pid_mismatch` | Raw input but app not frontmost — R68: the engine already auto-activated + retried once; this refusal means the ACTIVATION failed (list_apps/list_windows → re-observe → retry once, or report the conflict) |
| `foreground_required` | Event path needs focus — repeat activation + fresh observation |
| `uipi_blocked` | Elevated target (Windows UIPI) — human step; retrying is pointless |
| `targetless_input_refused` | No target on type/key — scope with element target or appRef |
| `capability_fail_closed` | Element can't do that action — re-observe detail:full, pick an advertised action |
| `element_stale` | State token superseded/changed/scope-drifted — fresh `get_app_state` |
| `frame_stale` | Coordinate raster is stale (>30 s — R68, was 10 s — or superseded) — R69: pointer tools AUTO-REFRESH first (see the R69 section; `frame_changed` appears only when the screen really changed); `set_value`/`left_mouse_down` keep this honest hard fail — fresh screenshot, resubmit pixels |
| `frame_changed` | R69: the screen changed since the observation — a FRESH frame was auto-captured and registered (`refreshFrameId`) — zoom it, retry with current coordinates (ONE round-trip) |
| `screen_unchanged` | R69: the 3rd consecutive near-identical capture refused — act (action receipts carry observations), `wait()`, or change strategy (`find_elements`); never re-capture |
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
(-EncodedCommand argv, the guarded compile, the chord table); the 0.67.0
run surfaced the R68 set (the SendKeys engine itself dead on modern .NET,
the frontmost refusals, the sparse Edge trees, the 10 s frames, the
vision 429 stalls, the monitor burned into captures) — fixed by
construction (raw SendInput, the self-healing foreground, the Chromium
poke, 30 s frames, the vision retry, WDA_EXCLUDEFROMCAPTURE). R69 is the
first round with NO new field report — its Windows behavior is
construction-pinned from the start (the dual-object poke, the stdin paste
channel, the HWHEEL math, the non-activating monitor, the aHash thresholds
on real 1280×1024 frames, the 600 ms settle) and gates on this same
checklist.** The checklist below is how the 0.64.0+R67+R68+R69 fixes get
verified. **The owner
must live-verify on the real machine before relying
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
4. **The key tool (R67 named them, R68 SendInput)**: ask it to press *"press
tab in the X app three times and tell me what gets focused"* — expect the
   receipt's `focused:` field to name a different control after each press
   (the Tab-walk), and REAL key presses (a text field's caret moves; `key
   "tab"` never types t-a-b — and with R68 no Windows.Forms dependency can
   kill the input path). A chord (`ctrl+a`) selects; `key "enter"` activates;
   `key "win"` now works too (LWIN).
5. One small **act-mode** action with the approval dialog (e.g. *"click the
   X app's About button"*) — expect the approval prompt, then a receipt and
   a visible click. R68 changed the old refusal path: a coordinate click
   with the app in the background now SELF-HEALS (the engine activates the
   target — you will SEE the window come forward — and retries once); the
   `frontmost_pid_mismatch` refusal appears only when the activation
   itself fails (e.g. the app is gone).
6. Watch the **floating monitor** appear automatically at the top of your
   screen when the agent starts using the computer (above other apps) —
   and STAY UP while the agent thinks between tool calls (the R67 turn
   hold), disappearing only after the turn ends (the 6-second decay) or
   STOP. **R68: take a screenshot (Win+PrintScreen or the Snipping Tool)
   while the monitor is up — the bar must NOT appear in your capture**
   (fully visible on the physical display, invisible to every capture
   API — your own OBS recordings won't show it either, by design). Press
   **STOP** mid-task — expect every further computer-use call
   to refuse `kill_switch_active`, any held button released, and the
   monitor to disappear a few seconds after the session ends.
7. **The Edge flow (R68's acceptance test)**: ask the agent to do a real
   7-step Edge task (search a page for a link by name, click it, type in
   a field) — expect `find_elements` to return REAL web elements by name
   (the Chromium poke), element-target clicks, typing that lands
   (SendInput), and each screenshot the agent takes to appear INLINE in
   the chat at the moment it was captured (not pooled at the bottom).
8. **The R69 enforcement layer**: watch any action the agent takes —
   its receipt should carry the observation (a `frameId`, whether the
   screen CHANGED, the focused element, the app title) and the
   post-action frame should appear INLINE in the chat seconds after
   the click, WITHOUT the agent taking another screenshot to verify
   (the loop the owner complained about is dead); a link click via
   `middle_click {target: element}` should open a new tab; `wait()`
   after a navigation should report what changed; the monitor bar
   must NOT yank focus when it (re)appears and the driven app must
   stay foreground while you click STOP or drag the bar; a long paste
   (ask it to type >300 characters into Notepad) must land complete
   (the stdin clipboard channel); horizontal scroll on an Edge page
   must move PAGE CONTENT (HWHEEL, not the caret); wait >30 s on a
   static screen then ask for a click on the old frame — it must
   PROCEED via the auto-refresh, not refuse.
9. If a list comes back EMPTY, read the result's `diagnostics` block
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
- [ATTACHMENTS](ATTACHMENTS.md) — the live screenshot RASTERS the captures
  publish (the ephemeral registry + route that the chat's INLINE capture
  rows fetch — R68)
- [EXTENSIBILITY](EXTENSIBILITY.md) — the sibling runbook (plugins, skills,
  MCP servers, the plugins listing route)
- [TESTING](TESTING.md) — the R61+R66+R67+R68+R69 suites and the verification
  ladder
- [MAINTENANCE](MAINTENANCE.md) — where things live in the tree
- Code map: engine in `agent-core/src/computer/` (types, errors, session,
  audit, dispatch, vision, framehash — R69: the pngjs aHash + region
  crops, backends/{interface,linux,windows,macos,index}),
  tools in `agent-core/src/tools/plugins/computer-use.ts`, settings in
  `agent-core/src/storage/computer-use.ts` (vision settings now in
  `agent-core/src/storage/vision.ts` — migration
  `agent-core/src/storage/migrations/0025_vision_settings.sql`), migration
  `agent-core/src/storage/migrations/0023_computer_use.sql`, routes in
  `agent-core/src/server.ts` (ROUND-61 section; R67: the frames raster
  route), monitor UI in
  `src/components/ComputerMiniWindow.tsx` + the mini window page
  `src/mini/MiniApp.tsx` + the OS window `src-tauri/src/mini.rs` (R68: the
  WDA_EXCLUDEFROMCAPTURE capture exclusion; R69: WS_EX_NOACTIVATE —
  the re-open no longer steals focus), the live
  signal `src/lib/computer-monitor-store.ts`, settings UI in
  `src/components/settings/ComputerUseTab.tsx` (vision:
  `src/components/settings/ImageAnalysisTab.tsx`).
