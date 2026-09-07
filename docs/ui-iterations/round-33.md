<!-- last-reviewed: 2026-09-07 round-75 -->

# Round 33 — Behavioral Fixes + Sidebar System + Settings Design Prompt

**Status:** DELIVERED — the infinite-continuation bug fixed and live-proven,
the sidebar/logo system built per owner directives, the chat panel is fully
headerless, 215 tests green, pushed.

**Owner directive (R33):** mixed verdict on R32 ("much better… still not that
good… decent enough") with a long fix list + a request for the settings
design prompt FIRST, then the fixes.

---

## The critical behavioral fix — "hello, how are you" no longer loops

**Root cause:** the outer loop's inverted continuation heuristic continued
UNLESS (completion-signal AND todos-done). A conversational reply has neither
→ the loop re-invoked the model up to 5 times, each iteration inventing work
(explored the codebase, ran commands), which the owner watched in horror.

**Fix (two layers):**
1. `runtime.ts`: an iteration with **ZERO tool calls is a conversational
   reply — break immediately.** Tool-using iterations keep the old
   completion-signal logic.
2. `prompts.ts` AGENTIC LOOP: a new CONVERSATIONAL REQUESTS paragraph —
   greetings/small talk/factual questions get a direct reply with NO tools.

**Live-proven (battery, real OpenRouter):** "hello, how are you" → event log
is exactly `message.user | message.assistant` — 0 tool calls, 1 reply, no
continuation, and the UI shows a clean text reply with NO activity card and
NO rounds. A real work task ("create notes.txt") → `write_file + read_file →
Done.` with the activity card correctly interleaved between the user bubble
and the reply.

## The activity display — exactly where the work happened

- `toProjectChatItems` now emits ONE activity block per MAXIMAL run of
  consecutive tool.use events, positioned chronologically — interim assistant
  replies interleave between blocks (owner: "it should show within the chat at
  the point of the tools are being called").
- **No ROUND pills, no "planning next round…" dividers** (owner: "it was
  supposed to be a continuous session") — one continuous timeline.
- **Stats chips only on the FINAL assistant message of each turn** (owner:
  "shown at the very bottom… not on each and every single one of them").
- **Live file-population view** (owner: "live file creation and live file
  populating… in a minimized view inside the chat"): during a live turn, a
  write's file-change card AUTO-EXPANDS when the write lands and its diff
  lines reveal with a staggered animation (`ac-line-reveal`, reduced-motion
  safe).

## The sidebar system (owner directives, all implemented)

- **Custom SVG logo** (`AcuteLogo`): rounded-square orange tile with a
  geometric white "A" (peak + crossbar strokes). At the sidebar's TOP-LEFT.
  **Hover morphs the "A" into a panel-toggle icon** (cross-fade); click
  toggles — hides the sidebar on chat routes, collapses the rail elsewhere.
- **Collapse button moved to the top-right of the sidebar**, beside the logo
  (was at the footer).
- **Generous spacing** between NAVIGATION and PROJECTS (my-4 divider band).
- **Project rows**: chevron REMOVED, session-count chip REMOVED; the
  **"+ new session" button lives ON the project row** (hover-revealed,
  accent-colored).
- **Sessions are renameable** (owner: "the user will be given the ability to
  edit the names of the sessions"): hover pencil → inline input (Enter saves,
  Escape cancels) → `PATCH /sessions/:id` (full stack: storage +
  `updateSessionTitle` + route + api + `useRenameSession` + tests).
- **Prominent Settings button** at the footer: card-style row with an
  accent-tinted icon tile + bold label + border + hover lift (collapsed rail:
  a large accent gear tile).
- **Instant session-list updates** (owner: "I have to refresh the whole
  page"): session creation now goes through the `useCreateSession` hook
  (invalidates the sessions query immediately) instead of a raw fetch.
- **Project name = the folder's name** (owner: "rather than the user picking
  the name manually"): the Add dialog lost its name field; the name derives
  from the picked path's basename (Windows + POSIX separators).

## The chat window

- **The top bar is GONE ENTIRELY** (owner: "All of that is unnecessary… just
  outright not implement it") — no agent chip, no model chip, no search
  button, no theme toggle. ⌘K/Ctrl+K palette remains keyboard-only.
- **Platform-aware shortcut labels** (owner: "I am on Windows and it should
  not show me these kinds of things"): "Ctrl K search" on Windows, "⌘K" on
  Mac.
- **Explicit 4-corner rounding** on the chat panel + **wider reading column
  with comfortable side padding** (px-5→px-7, max-w-4xl) — the owner's
  "somewhat more padding" instead of side voids.
- **Floating show-sidebar = the app LOGO** (owner: "make it the logo of our
  application"), pinned to the chat window's top-left when the rail is hidden
  (replaces the old hamburger).

## Design Prompt 3 (delivered FIRST, per the owner's instruction)

`docs/design/AI-DESIGN-PROMPT-3.md` — the settings restructure: the sidebar
TRANSFORMS into the settings sidebar (Appearance / Agents / Models &
Providers / Advanced + a "more coming" slot), plus full page specs for each
section including the Add Custom Provider dialog (name, id, base URL, masked
key with show/hide, kind selector, in-dialog connection test), the agents
editor (provider/model pickers, temperature, max-turns, allowed-tools chip
grid, memory policy), provider cards (connected/empty states, test
connection with latency), and the advanced page (data, diagnostics, danger
zone with confirm dialogs).

## Verification evidence

- `pnpm lint` 0 errors · `pnpm typecheck` 0 (frontend + agent-core) ·
  `pnpm test` **215 passed** (was 213; +3 rename tests, +1 hello-stops test
  restructured, chat-header tests rewritten) · `pnpm build` GREEN.
- **Live battery (real OpenRouter)**: the hello test (event log proves 0
  tools + 1 reply), session rename via the sidebar pencil ("Chat" →
  "Greetings test" verified over the API), the work task (interleaved
  activity: user → Completed 2 actions + notes.txt +24 Open card → Done.),
  sidebar visuals, hide-sidebar floating logo, **0 fetch/CORS console
  errors**.
- VLM cross-checks: no top bar ✓ · logo tile at sidebar top-left ✓ ·
  prominent Settings card ✓ · section spacing ✓ · clean hello reply with no
  activity card and no ROUND labels ✓ · activity interleaved between user
  bubble and Done. ✓ · floating logo at chat top-left with all-corners
  rounding ✓.

**Screenshots (7, published to DASHBOARD `screenshots/round-33.zip`):**
`01-empty-state` · `02-hello-reply` (the fix, live) · `03-sidebar-renamed` ·
`04-sidebar-logo` · `05-live-activity` · `06-activity-interleaved` ·
`07-sidebar-hidden-logo`

## Known scope notes

- The composer/model-picker/context redesign awaits the owner's demos from
  AI-DESIGN-PROMPT-2 (round 32).
- The settings page restructure awaits the owner's demos from
  AI-DESIGN-PROMPT-3 (this round).
