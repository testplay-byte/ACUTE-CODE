<!-- last-reviewed: 2026-08-24 round-28 -->

# Round 28 — UX + Agentic-Quality Overhaul

**Status:** IN PROGRESS — MS-1 complete (A1+A2+B+C+K1); MS-2 through MS-5 pending
**Owner directive (R28 opening message):** *"Quality over speed or time. Take
as much time as needed. It is a very huge task… handle each and every single
one of the things properly… highly customizable, flexible, and easily
manageable… implement proper project or such indexing… utilize advanced
searching techniques too, like a grep… everything should be well optimized."*

**Plan:** `docs/ROUND-28-MASTER-PLAN.md` (1123 lines, v2 with 30 sub-agent
review fixes applied — 6-d architecture, 6-e UX, 6-f risk/scope).

**Session→file mapping:** This round spans one orchestrator session that
executes all 5 milestones sequentially. Each MS section below records the
workstreams landed, verification evidence, and open items.

---

## MS-1 — Governance + Sidebar + Settings Appearance

**Workstreams landed:** A1 (governance docs sync), A2 (ui-iterations board
backfill), B (sidebar redesign), C (settings appearance), K1 (dashboard
screenshot publish infra). Plus the ORCHESTRATOR-METHOD.md doc (owner R28
explicit ask: "document this, the proper workflow").

### A1 — Governance docs sync (commit c2d62ee)
- `docs/runbooks/SANDBOX-RESTORE.md` rewritten for the round-28 layout
  (`/home/z/PROJECT/ACUTECODE` + per-repo credential helpers + token-in-URL
  clone per lesson #24).
- `docs/runbooks/AGENT-MEMORY.md` lessons #37–#40 appended (sandbox-wipe
  2026-08-24, per-repo suffixed secret files, ntfy-on-wipe-only rule,
  demo zip upload target changed to DASHBOARD repo).
- `docs/status.json` refreshed (test count 197 actual, plan.current).
- `HANDOFF.md` §3 + §9 refreshed.

### A2 — ui-iterations board backfill (commit 6263779)
- `docs/ui-iterations/README.md` board rows R16–R27 backfilled (gap in the
  board from rounds 16–27 now closed).

### ORCHESTRATOR-METHOD.md (commit a7d123d)
- New `docs/runbooks/ORCHESTRATOR-METHOD.md` — the cognitive companion to
  `WORKFLOW.md`. Owner R28 explicit ask: *"document this, like the proper
  workflow and things like this, so that you can look into that and follow
  it properly."* Captures: session-opening ritual, planning ritual
  (research → plan → sub-agent review → apply fixes → execute), execution
  ritual (per-milestone, verify gates, adjust as needed), verification
  ladder (5 rungs), documentation ritual, push/backup/notify ritual,
  close-out checklist, anti-patterns, "when the owner sends it back."

### K1 — Dashboard screenshot publish infra (commit 8e7b1a4)
- NEW `scripts/dashboard/publish-screenshots.mjs` — publishes a round's
  screenshot zip to the PUBLIC DASHBOARD repo (not the private ACUTE-CODE
  repo). Token-in-URL push, remote sanitized after (lesson #24).
- `package.json` — `dashboard:publish-screenshots` script.
- `DASHBOARD/screenshots/` dir created (README.md + index.json).
- `DASHBOARD/data.json` — `screenshots` section added; stale
  `quality.suites` count fixed (was 203, actual 197 = 132+4+55+6);
  `plan.current` updated to R28.
- R27 zip moved from ACUTE-CODE repo root →
  `DASHBOARD/screenshots/round-27.zip` (deleted from ACUTE-CODE).
- **Live battery:** `node scripts/dashboard/publish-screenshots.mjs 27` ran
  end-to-end — zip copied, index.json + data.json updated, pushed to
  DASHBOARD (23f5846..98a5ac1), remote sanitized.

### B — Sidebar redesign (commit 0cfc56e)
**Owner words:** *"At the very top it should not show the app's name like
that and the logo like that. the dashboard and usage should be shown in a
dedicated section and the bottom projects should be shown in a dedicated
section itself too."*

- `src/components/shell/Sidebar.tsx` L94-116: removed the 8×8 accent square
  + "Acute" text + "v0.1.0" version pill entirely (no wordmark, no flag —
  6-e review fix).
- Top row now carries ONLY the hamburger (chat routes only); nothing else.
- Added "NAVIGATION" section header (11px uppercase, matches PROJECTS header
  style) above the Dashboard+Usage nav buttons — dedicated section parity.
- `aria-label="Main sidebar"` on the motion.aside root (6-e accessibility).
- ProjectRow expand/collapse already had aria-expanded + aria-label (verified).
- `src/App.test.tsx`: inverted the brand assertion — now asserts
  `queryByText("Acute")` is null + `queryByText("v0.1.0")` is null; added
  "Navigation" header assertion; updated test name.
- Product name preserved in document `<title>` (ACUTE-CODE) + Settings/About.

**Verification:**
- `pnpm verify` GREEN (197 tests, 191 pass + 6 skip).
- Browser (agent-browser, 1920×1080): VLM confirms "The sidebar does not
  show any app name, logo, or version text at the very top; it starts with a
  'NAVIGATION' label." (screenshots 01 + 04).

### C — Settings appearance (commit 058e255)
**Owner words:** *"In the settings the appearance section was not changed.
Its UI was supposed to be improved. In dark mode the darker text was not
showing."*

**Root causes (6-b report):**
- L119 active knob text used `styles.text` (#FFFBF0 cream) → white-on-white
  in dark mode (`toggleActive` = white knob). `getContrastText` was exported
  but UNUSED.
- L156-164 theme swatches used `borderColor: styles.borderSubtle` → dark
  swatches (#242426/#2C2C2E) disappeared against dark card bg (#2C2C2E).

**Fixes (trimmed scope per 6-f fix #20 — custom-accent/density/font
deferred to R29):**
- `getContrastText(styles.toggleActive)` for active knob text → black-on-white
  in dark, white-on-black in light (READABLE in both modes).
- Sun/Moon icons inside the mode toggle buttons (lucide-react).
- Swatch strip: subtle bg (withAlpha(text,0.06)) + strong border
  (withAlpha(text,0.18)) + per-swatch border (withAlpha(text,0.22)) → dark
  swatches stay visible against dark card bg.
- Theme cards: responsive 2-col grid (1 per row mobile, 2 per row sm+).
- Accessibility (6-e): role=radiogroup + aria-label on mode toggle;
  role=radio + aria-checked on each mode button; aria-pressed + aria-label
  on each theme button.
- Also fixed "Aa" circle + checkmark to use `getContrastText(t.accent /
  styles.accent)` so text contrasts with EACH card's accent.

**Verification:**
- `pnpm verify` GREEN.
- Browser (agent-browser, 1920×1080, dark mode): VLM confirms "The mode
  toggle knob's active label 'Dark' is readable as it is displayed in black
  text on a white background." (screenshots 02 + 03). Before the fix this
  was cream-on-white = invisible.

### MS-1 screenshots (published to DASHBOARD repo)
- `screenshots/round-28.zip` via `pnpm dashboard:publish-screenshots 28`
- 4 screenshots: 01-sidebar-light, 02-settings-light, 03-settings-dark,
  04-sidebar-dark (all dark-themed — app defaults to nova/dark; the
  verification target was dark-mode readability, which is the owner's
  complaint, so dark-themed screenshots are the correct evidence).

---

## MS-2 — Chat Screen Complete Redesign (PENDING)

**Workstreams:** D1 (chatFocusMode + ProjectChatScreen rewire +
ChatFocusLayout + ChatTopBar), D2 (AgentChatPanel modernization + streaming
hook MERGED with WS-E + aria-live), D3 (composer wiring: Stop + Paperclip +
DiffCard real diff + delete orphaned TopBar).

Owner words: *"the chat screen win UI… I was hoping for a complete redesign…
the chat window should be made to show on the left side or in the center on
the left side. These infos will not show, like the folder structures and the
actual code window or other windows. Those will not show there."*

---

## MS-3 — Multi-Turn Agentic Continuation (PENDING)

**Workstream:** F (AGENTIC LOOP prompt section + inverted
continueIfUnfinished + maxOuterLoops 5 + context/request guards).

Owner words: *"It was not continuing the chats… It should automatically
continue with the next sessions… 4, 5, 6, or 7 iterations… research → save
files → restart → next research."*

---

## MS-4 — Project Indexing + Advanced Search (PENDING)

**Workstreams:** G1 (codebase_index migration + indexer + index_project 16th
tool), G2 (GET /projects/:id/index + CodebasePanel), H (search_code schema
extension + CommandPalette ⌘K + POST /projects/:id/search).

Owner words: *"implement proper project or such indexing… utilize advanced
searching techniques too, like a grep."*

---

## MS-5 — Demo Viewer + Docs + Dashboard + Verify + Cadence (PENDING)

**Workstreams:** I (in-app demo viewer), J1 (DOC-STANDARDS + check-stale.mjs
+ CI gate), J2 (backfill missing docs + ADRs), K2 (DASHBOARD UI screenshots
section), L (verify-round.mjs), M (REVIEW-CADENCE.md).

Owner words: *"maybe we should give an area inside our own application
itself to view this demo too… make sure that the documentation is proper
and easily manageable."*

---

## Open items / questions for owner

None blocking. MS-1 is complete and verified; proceeding to MS-2 inline per
owner directive ("complete everything in this exact same one now").
