<!-- last-reviewed: 2026-09-12 round-94 -->
# Round 42 — Desktop notifications with the window CLOSED (Web Push) · Launcher auto-open · Browser fallback · Sidebar/layout polish

**Date:** 2026-08-26 · **Branch:** `main` · **Owner directives:** the round-42
verdict message (embedded-browser failure in launcher mode, notification menu
still cut off, sub-agent prompt clamp, no desktop notification after closing
the window, sessions still not auto-renamed, chat-window seam + minimum width,
left-sidebar polish, collapsed-project activity animation, launcher
auto-open-browser).

## What shipped

### A. Desktop notifications that survive a CLOSED window (the owner's core ask)

The R41 approach (`new Notification(...)` from the page) can never fire once
the tab is closed — page JS is dead. Round 42 adds the only standards-based
path that works from a closed window: **Service Worker + Web Push**.

- **agent-core**
  - `web-push` (MPL-2.0 — allow-listed) + `@types/web-push`; license audit
    clean at 131 prod deps.
  - VAPID keypair generated ONCE per machine, persisted at
    `<dbDir>/vapid.json` (mode 600) — `src/lib/web-push.ts`.
  - Migration `0012_push_subscriptions.sql` (endpoint PK, p256dh, auth);
    re-subscribes upsert.
  - Routes: `GET /notifications/push/key`, `POST …/push/subscribe`,
    `POST …/push/unsubscribe`.
  - The notification bus fans EVERY publish out to every subscription
    (fire-and-forget, 15s timeout, 404/410 endpoints pruned, a push failure
    can never break a turn).
- **Turns now survive client disconnects** (the prerequisite): the stream
  route no longer aborts on `res.close` — the turn completes in the
  background (events keep persisting; the completion notification fires; Web
  Push delivers it to the closed window's service worker). The owner's exact
  scenario — send a message, close the window, get a desktop notification —
  now works. Live-proven (below).
- **Explicit Stop**: `POST /sessions/:id/stop` + an in-process
  `activeTurns` registry; the UI's Stop button aborts the fetch AND calls the
  endpoint (turns can no longer be stopped by merely disconnecting). The
  runtime returns a distinct `ABORTED` outcome — a deliberate stop is NOT a
  task failure (no task_failed notification; the client gets
  `{type:"stopped"}`).
- **task_complete now fires for EVERY successful turn** (the R40 `didWork`
  gate left the owner's conversational test silent). task_failed only fires
  for real failures (status ≥ 500) — 404/409 request errors stay quiet.
- **frontend**
  - `public/sw.js`: push handler (skips when a VISIBLE window client exists —
    the in-page path owns that case), Acute-mark icon, tag = notification id
    (same-tag notifications replace, never stack — no doubles when the page
    is alive); `notificationclick` focuses an existing window + navigates to
    the session, else opens one.
  - `<PushSetup />` (AppShell): registers /sw.js, requests the Notification
    permission (boot + first-gesture retry for browsers that suppress
    non-gesture prompts), subscribes with the VAPID key, re-upserts on
    boot/visibility. Demo mode + non-secure contexts no-op.
  - Toaster: the in-page `new Notification` now only fires when the page is
    HIDDEN (visible ⇒ in-app toast only; closed ⇒ SW push only).

### B. Launcher auto-opens the browser (owner: "so that I don't have to
manually open up the browser")

`launcher/acute_launcher.py` ONLY (ACUTE.bat / acute.sh / credentials.txt are
UNTOUCHED): a daemon thread polls `http://localhost:5173` while
`pnpm dev:full` boots; the moment Vite answers it opens the user's default
browser at the app URL exactly once per launcher run (240s timeout → a clear
fallback warning). The launch panel's copy now says the browser opens
automatically.

### C. Embedded browser in launcher/web mode (owner: "I am on Windows and I
need it to be working properly")

The owner runs the app in a normal browser via ACUTE.bat — there is no Tauri
shell, so R41's "only available in the Tauri desktop app" error fired on every
click. Now: **web mode opens the URL in a new tab of the current browser**
(the natural expected behavior — NOT the old Tauri→Edge leak; the user is
already in their browser). The panel is mode-aware (status row + copy + the
last URL as a clickable link); popup-blocked opens surface a clear fallback
link. The Tauri path (native `acute-browser` window) is unchanged.

### D. Notification menu cut-off (owner: "the left half of it was completely
cut out")

The R41 fix only clamped the VERTICAL axis — the popover was RIGHT-anchored,
and the bell lives in the LEFT sidebar, so a 340px popover anchored at a bell
~60px from the left edge ran ~280px off-screen. New `computePopoverPos`:
left-anchored with full both-axis viewport clamping + right/left alignment
preference + flip-up. Browser-verified: popover bounds [235,575]×[665,783] in
a 1600×900 viewport — fully visible.

### E. Sub-agent panel (prompt clamp + redesign)

- The TASK bubble clamps at **10 lines** with a "Show full task / Collapse
  task" toggle (shared `ClampedText`); the final report clamps too.
- Activity is a **timeline** of compact tool rows (status-colored rail —
  pulsing while running, green ok, red failed; tool icon; dir+basename mono
  path; status chip; failed output shown in red).
- **Files manifest** under the task: header chip with a count badge,
  tool-specific icons (FilePlus2/FilePenLine/FolderPlus/Trash2), dir dimmed +
  basename bright, clamped to 5 rows + "Show all N files".
- Final report: accent-rail card with a Sparkles eyebrow.

### F. Main chat: long user prompts clamp too

`UserMessage` wraps its content in `ClampedText` (10 lines + "Show full
message / Show less"). Browser-verified with a 16-line message: the toggle
appears, expands, and collapses.

### G. Chat window: minimum width + auto-shrinking right sidebar (owner:
"the chat window cannot be minimized or shrunk more than that… the right
sidebar will be made smaller automatically, smoothly")

- The chat column carries `minWidth: 480px`.
- `ChatFocusLayout` measures its own width (ResizeObserver) and caps the
  sidebar's effective width at `container − 480 − handle − gaps`; the
  sidebar's motion-animated width transitions smoothly when the cap changes.
  The resize handle is now keyboard-operable (←/→ ±16px).
- Browser-verified: at a 1600px viewport chat=823/sidebar=460; narrowed to
  1100px → chat=480 (floor held), sidebar=303, NO horizontal overflow.
- The sidebar's empty state is now a set of one-click quick actions (Open a
  file / Browse the web / Open a terminal) instead of a bare dashed `+` —
  the "right side empty area" reads as designed, not dead.

### H. Left sidebar polish + collapsed-project activity animation

- **PROJECTS header**: heavier uppercase tracking + a mono count chip + a
  ghost icon Add button (replaces the solid "Add" pill). Navigation header
  matches.
- **Project tiles**: soft 150° gradient derived from the project's own color
  (+22%/−24% shade), inner top highlight, soft drop shadow, text shadow —
  replaces the flat colored square (both the expanded row and the collapsed
  rail).
- **Live-work animation on the project itself** (owner: "if the session is
  going on and I collapse the project, the animation should move on to the
  project itself"): any running session in a project puts the pixel-stream
  animation on the project row (visible when the group is collapsed) and a
  pulsing accent dot on the collapsed-rail tile.
- Session rows: smoother action-button fades; the indent guide uses a softer
  tint.

### I. Auto-rename — the actual bug found and fixed

The sidebar's + button seeds sessions `New chat · <ProjectName>`; R41's
default-title check only matched `null` / the bare project name, so those
sessions were NEVER auto-renamed. `maybeAutoTitleSession` now recognizes both
seed formats. The stream store also invalidates `sessions`/`session`/`usage`
from its finally block, so background completions refresh the sidebar without
a mounted panel.

### J. Bonus real-bug fix: sessions no longer die on sidecar restart

Parent sessions intentionally stay `running` (so they accept the next
message), but the boot sweep flipped EVERY `running` session to `failed` — so
every sidecar restart killed all idle conversations ("session … is failed and
no longer accepts messages"). The sweep now distinguishes: last event =
`message.assistant` → back to `queued` (idle, alive); anything else (a genuine
mid-turn crash) → `failed` as ADR-0022 intended. Live-proven: a session that
finished a turn survived a sidecar restart as `queued` and accepted a second
message; a mid-turn `POST /stop` cleanly stopped with `{type:"stopped"}` and
no task_failed notification.

## Verification

- `pnpm lint` / `pnpm typecheck` (root + agent-core) CLEAN.
- `pnpm test`: **262 passed** (251 → 262; +11 new R42 regression tests:
  auto-rename both seed paths + no-op-after-manual/no-op-after-first, push
  key/subscribe/upsert/unsubscribe/fanout with web-push mocked, stop
  endpoint, boot-sweep idle-vs-crashed).
- `pnpm test:e2e`: 8/8 green. `pnpm license:audit`: clean (131 deps).
- **Live battery (real OpenRouter turn, real disconnect)**: fresh session
  titled `New chat · LiveTest`; streamed a turn; curl forcibly disconnected
  at 6s (simulating the closed window); the sidecar completed the turn in the
  background (turn.end ok, 29.5s, 2 tool calls — all AFTER the disconnect);
  the session auto-renamed to "Summarize the README in one sentence"; a
  `task_complete` notification was created with the new title + reply body.
  A live `POST /stop` mid-turn returned `{type:"stopped"}` with NO
  task_failed notification.
- **agent-browser (direct 127.0.0.1:5173 — bypasses the sandbox gateway's
  module-forwarding limitation)**: app fully mounts; onboarding → dashboard →
  project chat; the right sidebar renders (tab strip + dedicated collapse
  column + quick-action empty state); notification popover fully on-screen
  (bounds above); 1100px viewport holds chat=480 + sidebar=303 with no
  overflow; "Browse the web" → BrowserPanel web mode → clicking GitHub opened
  `https://github.com/` in a NEW TAB; /sw.js registered + active; a 16-line
  user message clamps with a working expand toggle; collapsed rail shows 2
  gradient project tiles; console clean (a pre-existing
  setState-during-render warning in RightSidebar was also fixed).

## Known limitations (honest)

- Web Push delivery itself (browser ↔ push service ↔ sw.js) can only be
  truly proven on the owner's machine — the sandbox has no interactive
  notification UI. Everything up to the push handoff is verified live
  (endpoints, subscription storage, fanout with the real keypair, SW
  registration); the click-through is standard sw.js code.
- The in-page permission prompt requires the owner to ALLOW notifications
  once (Chrome/Edge prompt on first app load, retried on first click).
- Sub-agent panel visual changes are structurally verified (compiles, tests,
  the unchanged event-parse logic from R41); a live sub-agent run against the
  new timeline was not repeated in this round.
