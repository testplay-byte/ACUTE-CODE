<!-- last-reviewed: 2026-08-30 round-54 -->
# Round 11 — Owner Windows-test verdicts fixed: working folder dialog, fullscreen chat, plug-and-play default agent, centered dialogs, HTML-build proof (2026-08-23)

**Owner direction (after testing round-14 on Windows):** four failures +
one capability ask: (1) Browse showed NO dialog at all; (2) the app sidebar
must vanish on the chat screen — hamburger (three lines) toggles it, and the
hamburger's dropdown options "should not be shown at all" for now; (3) chat
was unusable — "Create an agent in settings"/"No model", and the Settings
agent dialog glitched ("centered for a moment then goes outside the view";
create/edit did nothing visible); (4) no manual agent setup should be needed
by default; (5) full agentic capability — "build me an HTML file with a
beautiful demo UI" must land in the project folder.

## 1. Folder dialog — silent failure eliminated (root cause + fix)

Root cause: the round-14 Windows picker mapped ANY failed PowerShell run to
"user cancelled" — a WinForms dialog that failed to appear looked exactly
like a cancel, so the UI silently did nothing. Fixes:

- **Marker protocol** (`ACUTE_PICK:<path>` / `ACUTE_CANCEL`): a real cancel
  is now distinguishable from a failed dialog run.
- **Two Windows methods with fallback**: WinForms
  `FolderBrowserDialog` (`-STA`) first, then the Shell.Application COM
  `BrowseForFolder` (historically reliable from background console
  processes where WinForms can refuse to pump).
- **Errors are surfaced end-to-end**: sidecar returns `{path, error?}`;
  the UI shows "Folder dialog failed: <cause>" inline under the path field
  (and stays quiet only for a genuine cancel). Verified live: this sandbox
  (no zenity) now answers with the informative
  `no folder dialog available (zenity: spawn ENOENT; kdialog: …)` instead
  of silence.

## 2. Fullscreen chat + hamburger = sidebar toggle (owner spec)

- `AppShell` hides the app sidebar on `/project/:id/chat` (route-aware);
  **the TopBar hamburger now toggles it** — click shows the Dashboard/
  Projects sidebar, click again hides it. (The owner's "later we will change
  the three lines to the actions" is noted for a future round.)
- The hamburger **dropdown menu is removed entirely** (owner: those options
  "should not be shown at all" for now). Agent selection moved to the
  **chat header**: the agent name is now a small popover (live agents with
  provider · model, persisted choice applies to new sessions; the bound
  session agent keeps priority). Theme switching remains in Settings; file
  search remains the TopBar's centered ⌘K bar.
- Verified: DOM check on the chat route finds **0** nav/sidebar elements;
  screenshots `chat-fullscreen.png` (no rail) vs `chat-sidebar-shown.png`
  (rail present after hamburger), machine-inspected.

## 3. Plug-and-play default agent (no setup required)

`ensureDefaultAgent` seeds **Nova** (`openrouter` · `stealth/ox-alpha` — the
owner's single allowed key model, maxTurns 40, coding system prompt) at
database open when no non-template agent exists. Fixed id
(`agt_default_nova`) + guard: a user's own agents are never crowded.
Verified on a FRESH database: `GET /agents?includeTemplates=false` → Nova,
ready to chat with zero setup. Tests updated to the new contract (6 agents
on a fresh DB; Nova first by id sort).

## 4. Agent dialog glitch — fixed and numerically proven

Root cause: `.dialog-content` animates FROM/TO
`translate(-50%,-50%)` but the base style had **no transform** — the moment
the 0.25s animation ended, the dialog reverted to `top-1/2 left-1/2`
untransformed = half off-screen (the owner's exact symptom, and why
"nothing happened" on open: it opened off-view). Fix: base
`transform: translate(-50%, -50%)` on `.dialog-content`. **Numerically
verified in-browser**: dialog box center X=960/1920 ✓, Y=540/1080 ✓
(`centeredX:true, centeredY:true`) — screenshot
`agent-dialog-centered.png`.

## 5. Agentic capability — the owner's HTML scenario, live

Fresh DB → project P1 → session on the SEEDED Nova agent → prompt: *"Build
me an HTML file called demo/index.html … beautiful, simple demo UI —
centered card, gradient background, ACUTE-CODE title, subtitle, one button,
self-contained CSS."* Result (57 s): `list_dir → create_dir → write_file`,
assistant described the glassmorphism card it built, and **on disk**
`demo/index.html` exists containing the title, a gradient, and a button
(all four assertions PASS; file preview in the session log). No manual
agent/model setup anywhere in the chain.

## Verification summary

- `pnpm verify` green (113 agent-core incl. 3 updated seed-contract tests +
  frontend suites; build; license audit clean).
- Live: fresh-DB seed ✓ · dialog error-surfacing ✓ · owner HTML scenario ✓
  (disk assertions) · fullscreen chat DOM check (0 nav elements) ✓ ·
  hamburger toggle screenshots ✓ · agent popover ✓ · dialog centering
  numeric proof ✓ · zero console errors.
- New screenshots: `assets/round-11/{chat-fullscreen, chat-sidebar-shown,
  chat-agent-popover, agent-dialog-centered}.png`.

## Open items

1. Owner re-test on Windows: Browse must now either open the dialog (two
   methods) or SHOW the exact failure text — never silence.
2. Hamburger → "actions" transformation (owner's planned future change).
3. Sessions-per-project list/switcher (still latest-session resume).
4. Dashboard redo remains queued (owner-gated).

**Status: delivered (all four owner verdicts + HTML capability proven);
awaiting owner's Windows re-test.**
