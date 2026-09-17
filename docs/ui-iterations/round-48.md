<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 48 — The owner-test round: sub-agents at near-main-agent parity (ask-tier approvals, live chat UI, codes) · the browser flash-loop + ticket fix · a real files explorer · sidebar polish (project colors, logo, Sessions nav) · the modern always-on-top folder picker

**Date:** 2026-08-29 · **Branch:** `main` · **Owner directives:** every fix in
this round traces to the owner's own Windows test session after R47. In his
words: *"sub-agents did not have tool access and could not ask for
permission… they should be an almost exact copy of the main agent — same
functioning, same workings, only different context"* — plus *"no option in
the main chat to click it and see that agent on the right side; just Running
Running Running"*, the sub-agent view *"should look like the main chat, show
tools live, timer every second"*, and a short code so he can *"easily
identify which sub-agent is which"*; the embedded browser *"flashes every
one or two seconds and refreshes; changing resolution/size triggers repeated
refreshes; eventually 'Browser proxy ticket missing, expired or invalid…'"*;
*"clicking Files opens the file system on the right sidebar: left half =
file tree with folder navigation; right half = the file's content"*;
*"projects should be given different colors; currently all get the exact
same color"*; the logo *"is just an A"*; the collapsed selected project
*"becomes a little bit bigger and gets cut off"*; *"remove the sessions
section completely as it is not needed"*; the memory left accent bar
*"looks way too bad"*; and Browse opens the old-style tree picker stuck
behind every window. Chat bottom-bar/model-switcher improvements were
**EXPLICITLY DEFERRED** by the owner ("let's talk about it later") — not
done. Plan: `agent-ctx/R48-plan.md` (sandbox); recon via 3 parallel explore
agents (R48-E1/E2/E3) that mapped every report to exact file:line root
causes before a line was changed.

**Commits (in order):** `df8ffd3` (sidebar polish: project colors +
migration 0018, logo + favicon, collapsed-rail fix, Sessions nav removal,
memory de-accent) · `1884eb9` (browser proxy: tickets no longer rotate
under the panel — the flash-loop fix) · `05616de` (sub-agent backend
parity: approvals through the parent's SSE + abort propagation + codes +
live per-step events) · `40ba7de` (frontend: the real files explorer tab +
the sub-agent live UI) · `3336283` (modern Windows folder picker + Tauri
dialog parenting + version 0.48.0). Tip = `3336283`.

## What shipped

### A. Sub-agent parity — children can ask, stream, stop, and be identified (`05616de` + `40ba7de`)

The owner's core complaint ("no tool access, could not ask for permission")
was a single compounding root cause, verified line-for-line: children DID
get all 21 tools (since the R40 allowlist fix), but `runSingleAgentTurn`
called `prepareTurn` WITHOUT the emit channel and abort signal, and the
interactivity gate was `emitForTools !== undefined &&
session.parentSessionId === null` — always false for a child — so every
ask-tier approval (non-read-only commands, `web_fetch`/`browser_control`
to non-allowlisted hosts) failed FAST with a deny note instead of asking.

- **The gate is now `interactiveApprovals: emitForTools !== undefined`** —
  a child delegated from a live streamed parent turn IS interactive: its
  `approval.requested`/`approval.resolved` events ride the parent's SSE as
  `subagent-event` envelopes (`{type:"subagent-event", sessionId:<child>,
  parentSessionId, inner:{…}}`), the approval card appears in the PARENT
  chat attributed "Sub-agent CODE · role", and the decision travels the
  existing `POST /approvals/:id/decision` route to wake the child's waiter.
  Channel-less runs (the plain sync route, `retryChild`) STILL fail fast —
  no UI channel to ask on; ask-tier RULES unchanged, nobody bypasses
  allowlists, children can now ASK and the owner decides.
- **Abort propagation:** `delegate_task` forwards the parent turn's
  `AbortSignal` into the child (`delegateTask(…, emit?, signal?)`); the
  child checks between outer-loop iterations, finishes the in-flight
  iteration (work persists), and returns the honest 499 ABORTED outcome —
  mirroring the streamed path's stop semantics exactly (a stop is not an
  error: no `turn.error`). Pending approvals deny fail-closed on stop.
- **Sub-agent codes (owner-requested):** `subAgentCode(sessionId)` in
  `storage/sessions.ts` — FNV-1a 32-bit hash → base36 → last 4 chars
  uppercased (padded `X` if short) = a deterministic 4-char `[A-Z0-9]`
  code, pure so SSE envelopes, `GET /sessions/:id/subagents` rows, approval
  attribution and the tab picker all agree with zero stored state. `code`
  was added to `SubAgentStatus` (rows) and to EVERY `subagent-status`
  envelope from BOTH status emitters (delegate + retry paths).
- **Live per-step child events (the e1 stretch — done):** `chat.ts` gained
  `ChatStepSnapshot` + optional `onStepFinish` (passed through to
  generateText, normalized through the SAME extractToolCalls conversion the
  post-call audit uses), and the child runtime emits wrapped
  tool-call/tool-result/text-delta events LIVE per step; the ROUND-40
  post-call batch is skipped when steps were reported live (no duplicates).
- **Prompt honesty:** the `## SUB-AGENTS (delegate_task)` prompt section is
  now gated on the tool actually being present — children (who never get
  `delegate_task`) are no longer prompted to delegate.
- **Frontend (`40ba7de`):** `stream-store` handles `subagent-status`
  (upserts a live map childId → {code, role, task, status, lastActivity}
  + invalidates the `["subagents", parent]` query) and `subagent-event`
  (inner `approval.requested`/`approval.resolved` → the parent's live
  approvals queue WITH `subAgentId`; tool-call/tool-result → lastActivity;
  text-delta/finish and the child's forwarded `meta.*` frames ignored — the
  panel polls its own transcript). The **Delegated card** now shows live
  clickable per-child rows (code chip + role + title + status + todo
  progress + tokens + latest activity; the single-live-child tool row opens
  the child directly), the completed card shows the code chip, and
  **ApprovalCard** renders "Sub-agent CODE · role" attribution (live map
  first, polled `/subagents` row fallback — works after a mid-ask reload).
  The **SubAgentPanel was rewritten** from the R43 phase-card stack into a
  chat transcript in the main chat's visual language: task bubble, markdown
  assistant bubbles (final report accented), tool rows with the same
  icons/expand affordances, todo progress, informational approval cards
  ("Decide in the main chat"), error banner, kept Retry/failure banner,
  header = code chip + role + title + StatusChip + a **1-second** clock
  (was 5s), stick-to-bottom scroll. The New-Tab **SubAgentPicker** rows and
  every sub-agent tab title lead with the monospace code badge.

### B. The embedded browser no longer flash-loops (`1884eb9`)

Root cause (verified first-hand): `SessionStore.create()` ROTATES the
ticket on every call, and it was called by `browserNavigateCore`
(POST /browser/navigate), `browserViewportCore` (PUT /browser/viewport)
AND a third site the recon had missed — the proxy handler's header-authed
adopt path — while none of their responses return the new ticket. So the
panel kept embedding a dead `bt` → 401 error page → the 900 ms recovery
probe re-mints → `go("reload")` POSTs navigate → rotates the just-minted
ticket again → iframe remount with the just-killed ticket → repeat every
0.9–2 s (the owner's "flashes every one or two seconds"); the panel's
`attempts > 1` guard was defeated because every recovery bumped `navSeq`
and the reset effect zeroed the counter.

- **Backend fix:** NEW `SessionStore.getOrCreate(sessionId)` — returns the
  EXISTING still-valid ticket (TTL + LRU refreshed on use) and mints only
  when the session is unknown or its ticket already expired (nobody holds
  a usable credential then, so minting cannot strand a live iframe).
  navigate + viewport + the adopt path all switched to it. **Rotation now
  happens ONLY in `POST /browser/session`** (the explicit re-mint whose
  response carries the fresh ticket, which the panel adopts). Zero
  route/response-shape changes.
- **Panel hardening (defense-in-depth):** the per-navSeq attempts counter
  is replaced by a rolling time cap — max 3 recoveries per 60 s, then the
  panel PARKS on an honest error card with a working manual Retry (bounded
  mints, bounded reloads, zero flashing even against a crash-looping
  sidecar); `onIframeLoad` captures the seq the load belongs to and skips
  stale probes mid-navigation.
- **Test honesty (the fix the mock needed):** the BrowserPanel fetch mock
  now mirrors the REAL backend — `/browser/session` rotates (fresh 48-hex
  ticket per mint, previous dead), navigate/viewport never change ticket
  validity, the probe 401s iff `bt` ≠ the session's current server ticket.
  The old mock never rotated, which is exactly why 14 passing tests could
  not see the bug (lesson #67).

### C. A real files explorer in the right sidebar (`40ba7de`)

The Files quick-menu action no longer opens the search palette — it opens a
two-pane explorer tab (singleton, like terminal/memory): tree ≈40 % left
(expand/collapse chevrons, per-extension icons/colors, depth indentation,
own custom-scrollbar scroll, first-load seeds top-level folders open) |
content ≈60 % right (FileViewerPanel's shared Markdown renderer for
`.md`, line-numbered tokenized code otherwise, breadcrumb + project color
chip). A Search button keeps the old palette affordance reachable; a
tree-collapse toggle handles narrow widths; loading skeletons + honest
error cards with Retry on both panes; explorer navigation state survives
tab switches via an in-file per-project store (deliberately not persisted).
Alongside: `right-sidebar-store.addTab` now returns the ACTIVATED tab's id
on the dedupe path (the old leaked fresh id — harmless to every prior
caller, but the `openFiles` singleton contract needs the honest value).

### D. Sidebar polish (`df8ffd3`)

- **Per-project colors:** `storage/projects.ts` exports `PROJECT_PALETTE`
  (8 hex colors, the old orange `#FF6B2C` first so nothing looks alien);
  `createProject` defaults to the least-used palette color (ties → palette
  order); explicit `input.color` still wins. **Migration
  `0018_project_colors.sql`** backfills legacy all-orange rows round-robin
  by `(created_at, id)` (custom colors untouched; `ROW_NUMBER` materialized
  before the UPDATE so the ordering can't corrupt itself; audit-logged;
  idempotent — the SQL was empirically verified against a scratch DB with
  out-of-order created_at + >8 wrap + custom-color rows before being
  committed to a file). The sidebar's active row highlight uses
  `project.color` (border + background tint) instead of the theme accent.
- **Logo:** the two-stroke "A" is now a solid angular A with a squared
  terminal-cursor underscore ("A_" prompt heritage) on the upgraded orange
  gradient tile — VLM-reviewed twice (first pass "production-ready" with 2
  nits → underscore squared → verdict "Ship it"); same size prop +
  hoverToggle behavior, all 4 usage sites untouched. NEW
  `public/favicon.svg` + `<link rel="icon">` in `index.html` (none
  existed).
- **Collapsed rail:** the selected project's outside outline (visually
  44 px, clipped by the overflow-hidden wrapper, unscrollable rail) is
  replaced by a 2 px INSET ring on the tile itself — selected stays exactly
  36 px like its siblings; the rail gained padding + `overflow-y-auto`
  (first tile never clipped, long lists scroll, running-dot badge safe).
  Documented deviation: the ring is WHITE, not project.color — a
  same-color ring is invisible against the tile's own gradient of that
  color; project.color still marks selection via the composed glow.
- **Sessions nav REMOVED** (owner: "not needed"): the sidebar nav entry is
  gone; the `/sessions` route + SessionsScreen are KEPT for deep links
  (verified: session resolution never routes through the nav). Dashboard's
  primary quick action became "Continue in <newest project>".
- **Memory panel:** the colored left-accent bar is gone — uniform cards
  (kind chips in group headers untouched; no test asserted the border).

### E. The modern always-on-top Windows folder picker (`3336283`)

The owner's Browse path (launcher → browser → `POST /internal/dialog/folder`)
spawned a hidden PowerShell `FolderBrowserDialog` — the pre-Vista tree
picker, behind every window. `agent-core/src/dialogs.ts` was rebuilt:

- **PRIMARY: the modern `IFileOpenDialog` COM picker**
  (`FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST` — the
  File-Explorer-style dialog) via an inline C# interop snippet
  (C#-5-compatible for the PS 5.1 csc), shown OWNED by a topmost invisible
  form so it lands ON TOP; the classic `FolderBrowserDialog` remains ONLY
  as the catch-fallback (still topmost-owned); every picker is owned —
  z-order is inherited. The result contract is unchanged plus an explicit
  `ERROR:` line when both pickers fail; the process plumbing (temp .ps1,
  -STA, windowsHide, timeout, stdout contract) is preserved. NEW
  `dialogs-script.test.ts` (8) covers the script structure + fully-mocked
  win32 routing.
- **Tauri path:** `src-tauri/src/dialogs.rs` `pick_folder` now takes the
  `AppHandle` and parents rfd to the main webview window. **No cargo in
  the sandbox** — the change is compile-verified only by CI's
  `cargo check` (green on `3336283`); the runtime behavior reaches the
  owner with his next desktop build.

### F. Version 0.48.0 + CHANGELOG (`3336283`)

Version single-sourced at **0.48.0** across all four manifests
(`version:check` gates CI); the `CHANGELOG.md` `[0.48.0]` section is the
user-facing summary of every owner report above.

## Verification

- `pnpm lint` / `pnpm typecheck` clean (root + agent-core; both re-run for
  the docs commit and green on CI's verify step).
- **Tests: 752 in 61 files** (`pnpm test`, re-run at the tip by this docs
  agent: 752/752 green, 56.5 s). Split: **740 unit + 12 e2e** (8 sidecar +
  4 terminal-session — statically countable in `tests/e2e/` and confirmed
  in the CI log, where the root run skips them pre-build and the dedicated
  e2e step runs them: `11 passed | 1 skipped (12)` on windows-latest, all
  green in the sandbox). Trajectory: 622 (R46) → 683 (R47) → 752 (R48).
  The changed suites, before → after (every FINAL number re-verified via
  `vitest list` at the tip): `browser-proxy` 33→38 · `BrowserPanel` 9→10 ·
  `approval-flow` 9→11 · `orchestrator` 8→16 · `projects-tools` 21→27 ·
  `storage` 6→6 (0018 registration + tests live in projects-tools) ·
  `Sidebar` 8→9 · `App` 2→3 · `DashboardScreen` 5→5 (1 test rewritten to
  the new quick action) · `WorkingSection` 9→17 · `SubAgentPanel` 6→9 ·
  NEW `RightSidebar` 4 · NEW `FilesExplorerPanel` 8 · NEW
  `right-sidebar-store` 5 · NEW `stream-store` 9 · NEW `dialogs-script` 8.
  Per-suite deltas sum to exactly **+69 = 752 − 683** (no baseline drift
  this round). agent-core total: **460 tests across 27 files** (452/26 at
  the e1 wave-close + 8 dialogs-script). 4 of the 5 new backend
  browser-regression tests were stash-verified to FAIL against the pre-fix
  backend before being accepted.
- **CI (GitHub Actions API, not hand-claimed):** run `33257534609` @
  `3336283` (the tip, push event) **completed/success** — polled to
  completion by this docs agent BEFORE any doc claim; the docs-push run
  `33258603674` @ `90e5cf0` (push event) is likewise **completed/success**
  (API-verified by the continuation pass — a docs push's own run id can
  only exist after the push, so it is recorded here rather than pre-baked;
  the original text claimed HANDOFF carried it, which it never did).
  One honesty note: CI's `docs:check` step is `continue-on-error`
  (warn-only) and logged 1 failure on that run — the CHANGELOG
  `last-reviewed` stamp was dated 2026-08-30, a future date at push time;
  the docs commit fixes the stamp to 2026-08-29 and `pnpm docs:check` is
  0-failure again — **135 docs scanned** at the docs tip (the code tip's
  134 + this round report itself).
- **Live battery (real keys, real disk, dev sidecar):**
  - **Browser (the bug's exact sequence):** mint → `POST /browser/navigate`
    200 → `PUT /browser/viewport` 200 → proxy GET with the ORIGINAL
    pre-navigate ticket → **200** (this exact sequence was the 401 loop);
    three UI screenshots taken 8 s apart are BYTE-IDENTICAL (same md5), no
    error page, no remount.
  - **Sub-agent end-to-end approval round-trip:** battery #1 proved
    children ask for EVERY tool class incl. `browser_control` (its
    decisions were eaten by a tool timeout — evidence preserved, honestly
    not counted); battery #2 FULL PASS: child spawned with code **S23I**
    on the status frame → asked `run_command echo R48_BATTERY_OK` →
    decision route approved → `approval.resolved` envelope observed on the
    parent stream → command ran `ok:true` (`R48_BATTERY_OK`) → child
    reported → parent replied "DONE" (`/home/z/tmp/r48-battery2.verdict`:
    all flags true).
  - **Project colors live:** first create → `#14B8A6` (least-used palette,
    NOT the old orange); second → `#8B5CF6`.
  - Memory has no REST create (tool-only by design) — the panel was
    verified visually against the R46 project's two memories instead.
- **VLM/UI pass (agent-browser + glm-5v-turbo, 13 screenshots):** dashboard
  shows 4 distinct project colors + NO Sessions nav + the clean new logo;
  the Delegated card shows S23I with a clickable open affordance; the
  sub-agent panel reads as a chat transcript with the permission card; the
  files explorer's tree/content split is correct (markdown + syntax-
  highlighted code with line numbers); memory entries are clean uniform
  cards WITHOUT the left accent bar; the collapsed rail shows all tiles
  the same size with the selected one neatly inset-highlighted, nothing
  clipped; no glitches anywhere.

## Known limitations (honest)

- **The src-tauri dialog change is compile-verified only by CI** (no cargo
  in the sandbox): `cargo check` is green on `3336283`, but the runtime
  parenting behavior needs the owner's re-test with the next desktop
  build. The PowerShell path (launcher/browser setups) IS fully covered by
  the new script tests + live-verified patterns.
- **`retryChild` remains channel-less by design** — a retried child has no
  SSE channel, so its ask-tier approvals still fail fast (the same
  security posture as the plain sync route).
- **`subagent-status` frames carry `code`/`task`/`role`/`todos*` only** —
  `inputTokens`/`outputTokens`/`error` stay poll-only via
  `GET /sessions/:id/subagents` (the live map refreshes lastActivity from
  tool events; the panel polls its own transcript).
- **Aborted children currently end status `"failed"`** (+ a
  `subagent_failed` notification and an honest "turn aborted" note in the
  delegate result) — correct but noisy on deliberate stops; a dedicated
  `"stopped"` child status is a later-round candidate.
- **SessionsScreen is kept** (deep links still work) — only the sidebar
  nav entry went; the screen itself is now reachable by URL only.
- **Chat bottom-bar / model-switcher UI: owner explicitly deferred**
  ("let's talk about it later") — untouched this round by directive.
- The collapsed-rail selected ring is WHITE, not project.color (a
  same-color ring is invisible against the tile's own gradient —
  documented in code); the "Final report" accent wears the last assistant
  bubble on FAILED runs too (exact R43-panel parity).
- Sub-agents still run `generateText` (no token streaming for children);
  the live UI is per-STEP events, which is the panel's poll cadence —
  full token streaming for children remains future work.
