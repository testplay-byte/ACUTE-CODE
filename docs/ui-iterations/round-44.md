<!-- last-reviewed: 2026-08-30 round-53 -->
# Round 44 — Completing the agentic coding environment: agent memory · REAL web search · session search/fork/revert · sub-agent keys from credentials.txt · streaming terminal · VLM-verified UI · MAINTENANCE.md

**Date:** 2026-08-27 · **Branch:** `main` · **Owner directives:** "continue
make it capable make it better and proper in various ways and test using VLM
tools… complete the whole agentic coding environment completely now… quality
over speed." Explicit asks: (1) sub-agent API keys pre-loaded via
credentials.txt ("save them inside credentials.txt so i dont have to manually
enter them"), (2) the missing agentic-environment functionality, (3) UI
verified with VLM tools, (4) documentation + maintainability. Security holes
remain **deferred by the owner** ("after this").

**Commits (in order):** `8156bde` (wave 1: memory + web search + sessions +
keys) · `4d5f920` (wave 2: streaming terminal) · `29eec05` (VLM pass +
live battery).

## What shipped

### A. Agent memory system (the headline — R44-a)

Agents now persist durable per-project knowledge and get it back in every
later turn. Migration `0015_memory.sql` creates the `memory` table
(kind `fact|decision|preference|note`, 4000-char cap, audit-logged) and
appends the three tools to seeded template allowlists (the 0014 pattern).
Tools 20–22: `memory_save` (validated, capped), `memory_recall` (ranked LIKE
search), `memory_list` — all registered in `buildProjectTools`, in `TOOL_NAMES`
(21 tools now), and failing gracefully outside project sessions.
`prepareTurn` injects the newest slice as a `## Project memory (persisted
across sessions)` system-prompt section — **~1500 chars, whole-line
granularity, only when non-empty**. REST: `GET /projects/:id/memory` +
`DELETE /projects/:id/memory/:memoryId` (read + prune only — memory is the
agent's channel, no REST create). Right sidebar gains the **Memory tab**
(Brain icon; `MemoryPanel.tsx`: kind-grouped cards, hover delete, 5s polling).
Full reference: `docs/runbooks/PROJECT-MEMORY.md`.

### B. REAL web search (R44-b — the weak-tool fix the audit flagged)

`web_search` was MediaWiki-only (encyclopedia results for every query). Now a
3-tier chain, zero new deps, no key: (1) `html.duckduckgo.com/html/` (parsed
from `result__a`/`result__snippet` anchors, `uddg=` redirect unwrap,
ad/self-link stripping, entity decode), (2) `lite.duckduckgo.com/lite/`
fallback, (3) MediaWiki last resort, honestly labeled ("general web search
unavailable — showing encyclopedia results"). **8 results** (was 6);
`parseDdgHtml`/`parseDdgLite` exported + unit-tested (web-tools suite 14→23).
Live-verified from the sandbox: 8 real results on a real query.

### C. Session intelligence — search / fork / revert (R44-c)

- `GET /sessions?q=` — LIKE over title + event payload JSON (messages AND
  tool calls are searchable); same response shape, `total` = result count.
- `POST /sessions/:id/fork` — copies the session + its full event log under a
  new top-level session ("Fork · <title>"); usage not carried.
- `POST /sessions/:id/revert` `{keepThroughSeq}` — truncates the event log to
  a chosen user message (its reply + later turns deleted), appends a
  `session.reverted` marker; 409 while a turn is running (no racing a live
  stream).
- UI: Sessions screen debounced (300 ms) search + result count + hover Fork;
  chat user-message hover "Revert to this message" with a ConfirmDialog.
  Hooks `useSessionSearch`/`useForkSession`/`useRevertSession`.

### D. Sub-agent API keys from credentials.txt (R44-d — owner's explicit ask)

The launcher (self-updating; `ACUTE.bat` untouched) parses optional
`OPENROUTER_SUB1..3_KEY` lines, **auto-appends them with the baked-in
defaults when missing** (a pre-R44 credentials.txt upgrades itself), and
distributes the keys to keyring pool slots 2/3/4 (Windows Credential Manager
`openrouter-slotN` / `~/.acute/openrouter-slotN.key` fallback) +
`ACUTE_PROVIDER_OPENROUTER_SLOT{2,3,4}` env at sidecar spawn. `scripts/dev.mjs`
mirrors the lookup per slot (`readSlotKey`), so Settings → Sub-agents shows
slots 2/3/4 with **zero manual entry** — sub-agent traffic prefers the pool,
the main key stays free for main chats.

### E. Streaming terminal (R44-e — wave 2)

The right-sidebar Terminal tab no longer freezes on long commands:
`POST /projects/:id/terminal/stream` is SSE — `stdout`/`stderr` frames as
chunks arrive, `exit {code, ms}` frames (real exit codes; null = killed by
signal), `error` frames (timeout / output cap / spawn failure — no exit frame
after an error we caused), `: ping` heartbeats every 10 s plus a leading ping
(header flush). Same containment as the sync route; **client disconnect kills
the child** (deliberate divergence from chat turns, which complete in the
background — an interactive command has no reader to return to). Body
overrides `{timeoutMs, maxBytes}` can only SHRINK the 60 s / 64 KB budgets
(250–60000 ms / 256–65536 B, else 400). TerminalPanel: live chunk rendering,
running spinner, **Stop** button (server-side kill; renders "stopped"),
exit-code footer (green/red), and a pre-first-frame fallback to the sync
route so the panel can never regress against an older sidecar (the ROUND-43
silent-death lesson applied).

### F. VLM UI verification pass (the owner's "test using VLM tools")

agent-browser screenshots of every key screen — dashboard, sessions, chat,
all settings tabs, all right-sidebar tabs, light/dark, a viewport sweep —
analyzed with the vision model. **Two real bugs found + fixed**
(`29eec05`):

1. **Dashboard recent-activity cards linked to the dead `/sessions` route**
   ("Not found" on every card) — now deep-link to
   `/project/:id/chat?session=:id`.
2. **The R43 Sub-agents settings tab was unreachable** — it existed in
   SettingsPage `TABS` but not in the sidebar's `SETTINGS_SECTIONS` (and
   since R34 the sidebar IS the settings nav), so the key pool was invisible
   except by hand-typed `?tab=subagents`. Sidebar entry added (lesson #63 in
   AGENT-MEMORY.md; MAINTENANCE.md recipe c).

Plus polish the VLM pass surfaced: the phantom slot-1 row dropped from the
Sub-agents key list (was rendering 2,3,4,1,5), terminal command lines get a
hanging indent so wrapped text aligns under the command, provider rows show
the full endpoint on hover.

### G. Documentation + maintainability (R44-f — this wave)

`docs/runbooks/MAINTENANCE.md` (NEW: architecture map + six how-to-add
recipes pointing at real example files + the golden rules);
`docs/runbooks/PROJECT-MEMORY.md` (NEW: the memory system reference +
live-battery verification pattern); IMPLEMENTED-API ROUND-44 additions;
TESTING/SETUP/WORKFLOW/AGENT-MEMORY refreshed (471-test reality,
credentials.txt v2, the VLM pass as a round step, lesson #63).

## Verification

- `pnpm lint` / `pnpm typecheck` (root + agent-core) CLEAN.
- **Tests: 471 in 44 files** (`pnpm test` — agent-core 297 + frontend 162 +
  shared 4 + the 8 sidecar e2e, which the root run also picks up; i.e. 463
  pure unit/integration + 8 e2e). Trajectory 262 (R42) → 397 (R43) → 471
  (R44), same counting basis. New suites: memory-tools (16), sessions-manage
  (23), terminal-stream backend (7) + client (10) + panel (6), MemoryPanel
  (4); extended: web-tools 14→23, SessionsScreen, AgentChatPanel,
  projects-tools, storage, models-catalog.
- **CI: green on wave 1 — run `33038236165` @ `8156bde` success. The wave-2
  and VLM-pass runs are RED** (`33040195313` @ `4d5f920`,
  `33040846059` @ `29eec05`): the new
  `agent-core/tests/terminal-stream.test.ts` asserts `echo hello` emits
  exactly `"hello\n"` — on windows-latest it emits `"hello\r\n"`. A
  Windows-only CRLF assertion; the suite is green on Linux. **Open item for
  the next session** (fix the assertion to accept/strip `\r`; do not delete
  the test). The docs:check step also logs a Windows-only latent failure
  (`docs\compliance\dependency-licenses.md` missing stamp — the check's
  compliance-skip uses a forward-slash `includes()`, which never matches
  Windows backslash paths; `continue-on-error` keeps it non-blocking).
- **Live battery (dev stack, owner's keys):** memory — saved a fact via
  `memory_save` in one turn, then confirmed recall in a later NO-TOOLS turn
  (proves the digest injection path end-to-end); web_search returned **8 real
  DuckDuckGo results in-turn**; streaming terminal — chunked output visible
  as it arrived + exit codes 0 and 3 rendered; slots 2/3/4 visible in
  Settings with zero manual entry.
- VLM pass screenshots live under the sandbox `tool-results/` paths
  (ephemeral sandbox artifacts — not repo assets; the verified state is the
  code + this report).

## Known limitations (honest)

- **CI red on the tip** (the CRLF assertion above) — first breach of golden
  rule 3 since R43 fixed the R39–R42 red streak; must be the next session's
  first commit.
- **`TOOL_CATALOG` in `src/lib/api.ts` is stale** (15 entries; missing
  `index_project`, `delegate_task`, `browser_control`, and the three memory
  tools) — the agent-create/edit dialog's tool checkboxes lag the real
  21-tool server list. Flagged since R43; a code change (next session).
- Security holes (child-process key scrubbing, contained auto tier, gated web
  tools — audit P0-3..P0-5) remain OPEN, deferred by the owner ("after
  this").
- Memory v1: digest is newest-first only (no relevance ranking in the
  injection), 4000-char per-item cap, no user-facing edit (delete only).
- Streaming terminal kills the child on client disconnect (by design);
  interactive stdin is still not supported (no PTY — deferred with the
  PTY-terminal work).
- Sub-agent keys live in the owner's local credentials.txt + the launcher's
  baked-in defaults in `credentials.example.txt` (private repo, owner
  directive); rotating them means editing the file — the launcher re-reads
  it every start.
- The public DASHBOARD has NOT yet been truth-synced to R44 (test count,
  features, CI status) — dashboard duty rides with the round close-out.
