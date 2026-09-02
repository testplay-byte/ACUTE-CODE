<!-- last-reviewed: 2026-09-02 round-61 -->
# COMPUTER USE — the desktop-control system (owner's guide)

**Status:** normative · **Established:** round-61 (owner directive: computer
use + a separately-configurable vision model) · **Audience:** the owner
(anyone flipping the switches and watching the monitor) and any agent
maintaining the system

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
   holding (a real mouse-up at the recorded point).
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

- Activation is the `SetForegroundWindow` + `AttachThreadInput` sequence
  with a ≤1.5 s **postcondition check** — the receipt's `active` field
  reports the truth, not the API's return value.
- Raw input is `SetCursorPos` + `mouse_event` (user32); typing is `SendKeys`
  after focus verification. Raw input on Windows requires the target app
  frontmost — the engine refuses with `frontmost_pid_mismatch` otherwise.
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

## Settings → Computer Use (the three gates)

The whole surface is dark until YOU turn it on
(`computerUse.enabled`, default **OFF** — the owner's on/off directive):

1. **Master switch** — OFF by default. While off, the plugin contributes
   zero tools and the agent cannot control the desktop at all.
2. **Posture** (visible only while ON):
   - **observe** — only the 11 read-only tools are even registered (the
     model never sees a mutating schema): `list_apps`, `list_windows`,
     `list_displays`, `switch_display`, `get_app_state`, `screenshot`,
     `zoom`, `cursor_position`, `request_access`, `read_clipboard`, `wait`.
   - **act** (recommended) — all 30 tools; in ask permission-mode the
     real-input risk classes (typing, keys, clipboard writes, drags,
     coordinate/raw clicks, activations) ride the SAME approval flow as
     `run_command` — you see a dialog before the agent moves your real
     mouse. Element presses (background-safe) and observations never prompt.
   - **auto** — all 30 tools with no per-action approval prompts.
3. **Test readiness** — runs the engine's readiness probe (permissions +
   backend capabilities; never pops OS dialogs) and shows the result:
   green "Ready" or amber "Issues" with the report's lines. The probe's
   route composes the UI verdict server-side: `ok` = both core
   capabilities granted, `issues` = the report's notes (+ explicit
   denied-permission lines).

## The vision model (completely separate, by directive)

The vision subsystem describes screenshots in text when the agent asks for
it (`screenshot`/`zoom` with `describe:true`). Configure in
Settings → Computer Use:

- **off** (default) — screenshots still return raster METADATA (frame id,
  size, scale) and coordinates still work; the a11y tree remains the
  observation channel. Nothing breaks.
- **separate** — pick any provider + a model id, and paste that model's OWN
  API key into the dedicated vision-key slot. The key rides the keyring
  pseudo-provider `<providerId>-vision` (credential target
  `ACUTE-CODE/provider/<providerId>-vision`, env
  `ACUTE_PROVIDER_<ID>_VISION`) — the same store/handoff pattern as every
  other key, never shown in full (masked `Key saved` + Replace/Clear). If
  no dedicated key is pasted, the provider's PRIMARY key is used (one
  provider, one key — a valid configuration, reported honestly).
- **main** — use the turn's main model, allowed ONLY when that model's row
  is marked **supports vision**. Flip the eye toggle on model rows in the
  Computer Use tab (or set the flag in Models & Providers); the flag is
  prefilled from the catalog for known vision models.

The relay speaks `chat-completions` (OpenAI/OpenRouter/Google-compat) and
`anthropic-messages` formats, direct fetch, one image + one instruction,
terse text back. It is called ONLY for describe requests — never
automatically.

## The monitor (watching the agent work)

- **Right-sidebar "Computer" tab** — the full feed: status chip
  (OFF/STOPPED/LIVE/Idle), four stat cells (actions sent / refused /
  observations / vision calls), the elapsed clock + backend, the
  newest-first event ring (kind icon, label, tool chip, refusal-code chip),
  and the STOP kill switch.
- **The floating mini window** (pop-out button in the panel footer; app-wide,
  draggable, 340 px card) — the same feed condensed: what it's doing now,
  how it's going (stats + refusal/vision spotlights), and a full-width STOP.
- **Data path**: every tool execution emits one `{type:"computer-use"}` SSE
  frame at dispatch time (live, zero polling latency, works even for
  background turns) + the panel polls `GET /computer-use/session`
  (2 s while active, 10 s idle) for the authoritative ring + stats.
- **STOP** = `POST /computer-use/stop`: the kill switch engages, a held
  button (if any) is released with a real mouse-up at its recorded point,
  and every further computer-use call refuses with `kill_switch_active`
  ("Stopped — the kill switch is active" locks in until a new session).

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

## The 30 tools (quick reference)

| Tool | Purpose |
|---|---|
| `list_apps` | List RUNNING apps (name/pid/active) — absent means not running, not not installed |
| `open_application` | Launch by EXACT user-provided name (character-for-character) or activate a running one (`activate:true`) |
| `list_windows` | An app's windows (id, title, bounds, main, focused) |
| `get_app_state` | THE core observation: the window's a11y tree (detail:full adds bounds + actions; includeScreenshot adds a raster) |
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
| `key` | Non-text keys and chords ('return', 'ctrl+a'); repeat 1–100 |
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
audit, consent, vision relay, the 30-tool surface — see
[TESTING](TESTING.md)), **but this sandbox has no display**: the dispatcher
is tested against an injected fake backend, and the plugin tests run the
real Linux backend on a headless host where GUI probes fail closed (the
shape contracts are pinned, the live GUI paths are NOT). The Windows and
macOS backends are code-complete per the spec but have NEVER run on live
hardware. **The owner must live-verify on the real machine before relying
on computer use.** Per platform, in order:

1. Flip the master switch ON (Settings → Computer Use) and press
   **Test readiness** — expect "Ready" (or read the issue lines).
2. Ask the agent: *"list the running apps"* — expect a real app list via
   `list_apps`.
3. Ask it to **observe** one app (*"look at the X window and tell me what
   controls it has"*) — expect `get_app_state` output and a tree.
4. One small **act-mode** action with the approval dialog (e.g. *"click the
   X app's About button"*) — expect the approval prompt, then a receipt and
   a visible click. Try a refusal path too: a coordinate click with the app
   in the background should refuse `frontmost_pid_mismatch` (Win/Linux).
5. Open the **mini window** and press **STOP** mid-task — expect every
   further computer-use call to refuse `kill_switch_active` and any held
   button released.

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

- [EXTENSIBILITY](EXTENSIBILITY.md) — the sibling runbook (plugins, skills,
  MCP servers, the plugins listing route)
- [TESTING](TESTING.md) — the R61 suites and the verification ladder
- [MAINTENANCE](MAINTENANCE.md) — where things live in the tree
- Code map: engine in `agent-core/src/computer/` (types, errors, session,
  audit, dispatch, vision, backends/{interface,linux,windows,macos,index}),
  tools in `agent-core/src/tools/plugins/computer-use.ts`, settings in
  `agent-core/src/storage/computer-use.ts`, migration
  `agent-core/src/storage/migrations/0023_computer_use.sql`, routes in
  `agent-core/src/server.ts` (ROUND-61 section), monitor UI in
  `src/components/right-sidebar/ComputerPanel.tsx` +
  `src/components/ComputerMiniWindow.tsx`, settings UI in
  `src/components/settings/ComputerUseTab.tsx`.
