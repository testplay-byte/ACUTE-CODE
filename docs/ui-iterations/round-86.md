<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 86 — the verification + SSE-extraction round (the owner's task-list session)

## 1. Owner direction (verbatim intent)

"i need you to work on a project for me… a full-fledged, highly modular, highly
customizable, mostly extension-based agentic coding IDE… analyze it properly,
understand it properly, and get a proper understanding of it by reading the
documents and such, and then give me a complete overview of how the current
structure looks… You need to properly do the documentation too. You need to
update the current documentation and our current standing… push all of it to
github as there is a flaw of your sandbox environment… we are treating the
github repo as a backup too… Do the branch cleanup. There are a lot of branches
which are currently not in use… only keeping the branch which is needed, like
only the main branch… Make sure to publish the version properly so that I can
use the acute.bat file to easily download it, run it, test things out… The SSE
route extraction needs to be handled properly for the dashboard. Truth sync
needs to be handled properly too. The final worklog appending, the final
notification sending, and summary… Every 15 minutes, or roughly around that, I
want you to send me a notification giving me a summary of your progress…
If I told you to make changes and the changes are not needed, then do not make
changes. Those changes might have already been made."

Extracted task list: (1) deep analysis + a complete overview of the current
structure (honest: proper? issues? improvements?); (2) documentation updates +
current standing; (3) branch cleanup (keep only main); (4) publish the version
so acute.bat works; (5) the SSE route extraction; (6) DASHBOARD truth-sync;
(7) worklog appending + ntfy notifications (15-min progress + final, topic
`NTFY-TOPIC-REDACTED`); (8) push everything to GitHub (the backup); (9) verify
before changing — do not redo what is already done.

## 2. Method

- Fresh clone at HEAD `2ff8b88` (R85 docs close-out, v0.83.0) on `main`
  (WORKFLOW §2 — this round began as analysis; the code change is ONE
  behavior-identical move of ONE route).
- Read-first per HANDOFF §1: HANDOFF, AGENTS, WORKFLOW, MODULE-BOUNDARIES,
  MODULARITY-ASSESSMENT (R85), status.json, LOCAL-PC-RUNNER, release.yml,
  launcher/acute_launcher.py, the DASHBOARD repo (README + data.json).
- **Three parallel verification sweeps** (sub-agents — the sanctioned pattern
  for parallel research): backend structure (Task 2-a), frontend anatomy
  (2-b), documentation truth + DASHBOARD gaps (2-c). Every R85 claim
  re-verified with file:line evidence; the corrections are in §3 below.
- The 15-minute ntfy progress notifier (a background loop reading a progress
  file — topic `NTFY-TOPIC-REDACTED`) ran for the whole session; the owner also
  got event-driven pings at each milestone.

## 3. The verification results (R85 re-audit at HEAD 2ff8b88)

**Backend (2-a) — 7 of 8 claims exact:**
- 52 routes in server.ts: **VERIFIED** with the full inventory (terminal 8,
  MCP 6, computer-use 9, diagnostics 2, approvals 2, vision 3, SSE 1 + the
  21-route tail: notifications ×7, jobs ×4, checkpoints/snapshots ×4 incl.
  browser-checkpoints, dialogs ×2, plugins, index, keys, health). Extracted
  side: 71 routes in **12 domain modules** + context.ts + helpers.ts = 14
  files (the "14 domain modules" phrasing counts the two shared files).
- The SSE route: **VERIFIED EXACT** — `server.ts:1348-1823` = 476 lines, with
  the internal map (validation :1348-1392 · SSE plumbing :1394-1436 · the
  debug-analyst closure :1438-1591 · the queue-continuation loop :1593-1760 ·
  crash recovery :1761-1812 · finally :1813-1822).
- SQL leaks: **VERIFIED EXACT** — 22 statements at every cited line.
- The registry↔mcp value 2-cycle: **VERIFIED** (`registry.ts:53` ↔
  `plugins/mcp.ts:20`, the TOOL_NAME_RE edge).
- The 378 byte-identical sync/streamed lines (78% of the sync runner):
  **REPRODUCED digit-for-digit** (with a methodology note: line-membership
  after normalization; a strict LCS gives 271/56% — Wave 2-b planning should
  state which metric). `prepareTurn` is 446 lines (not 447) with the 10
  positional args confirmed.
- ToolDeps: verified at `index.ts:63-130`, built at `runtime.ts:1203-1259`
  (the audit's ranges were shifted); **no `runId`** — confirmed.
- Test suite: 92 agent-core files confirmed statically; 1,867-agent-core
  count re-verified live this round (the suite ran green twice — baseline
  and post-extraction).

**Frontend (2-b) — ~95% exact, four numbers corrected:**
- api.ts 3,959 lines with **85 importing files** (58 non-test; not 72) ·
  ModelsProvidersTab **60 hook call-sites** (the "40" counts only
  non-react-query hooks) and **3** named dialogs (not 4) · **14** Zustand
  stores (not 13) · `StreamTurnEvent` at `api.ts:2944` with **37** member
  types (34 handled; 3 meta types typed-but-unhandled, documented in the
  function's own note).
- The dead `src/components/sessions/` dir: **VERIFIED** — 559 lines, zero
  live importers — **but it received an R83 edit** (dead code being
  maintained; the deletion Wave-1 item is now more justified).
- The "zero extension seams" claim is **overstated**: three narrow seams DO
  exist (`lib/error-bus.ts` pubsub ring, `lib/agent-browser-bridge.ts`'s
  per-tab handler registry, `lib/right-sidebar-events.ts`'s tiny bus) — no
  GENERAL plugin/registry pattern, but the audit's "zero" should read
  "no domain extension surface".
- NEW drift finds: `src/README.md` lists `/agents` and `/sessions/:id`
  routes that do not exist in App.tsx (stale rows).

**Docs + DASHBOARD (2-c):**
- `docs/status.json` carried ONE stale live figure ("the 392-line streamed
  SSE route" in plan.upcoming — R85's correction to 476 never landed in
  that field). Everything else in status.json was R85-current.
- **The DASHBOARD's `plan` section was two rounds stale and LIVE on the
  public Pages site**: `plan.current` still told the R83 story, and
  `plan.upcoming[0]` still listed the R84 work (split server.ts "now 5,719
  lines", break the 25-file cycle) as NEXT — all shipped in R84. The
  R84+R85 sync updated version/milestones/quality but missed the plan
  section. `usage.json` is 10 days stale (generatedAt 2026-08-31) —
  refreshing it requires the owner's real DB (not regenerable in the
  sandbox clone; left as-is, flagged).
- CHANGELOG verified correct (0.83.1-docs documents R85); DeepSeek round-2
  study verified present with the C1-C5 candidates (C2 per-tool timeoutMs
  remains the top pick).

## 4. The deliverables (this round)

### 4a. The SSE route extraction (the final-phase domain of the R84 split)

`agent-core/src/routes/sse.ts` (NEW, 562 lines incl. the provenance header +
imports): `registerSseRoutes(scope, ctx)` carrying the streamed turn route
(POST `/sessions/:id/messages/stream`) — the hardest concurrency logic in
the HTTP layer (the R42 client-gone semantics, the R78 queue-continuation
loop capped at 25 with R82 override adoption, the R66-2-c debug-analyst
phase with R83 usage metering, the R43+R80 crash recovery).

- **Verbatim move, zero transcription risk**: the 491-line block (the
  15-line provenance comment + the 476-line route) was extracted with sed,
  dedented by the uniform 4 spaces, and **round-trip verified byte-identical**
  against `git show HEAD` before any gate ran.
- server.ts: **2,439 → 1,913 lines** (−526: the route block + the
  now-single-consumer imports pruned — persistTurnError/
  runStreamedAgentTurn/TurnModelOverride, runDebugAnalyst, streamAiSdkChat,
  MessageAttachment, resolveProvider, 6 of 7 storage/sessions symbols, the
  whole storage/settings + storage/models + storage/agents + lib/retry +
  lib/turn-registry imports, readComposerSendFields/readOverrideProviderId).
- Registration order preserved: `registerSseRoutes(scope, ctx)` sits exactly
  where the route lived (between `registerSettingsRoutes` and the
  computer-use routes); Fastify wildcard precedence untouched.
- One recovery during the edit (recorded as AGENT-MEMORY lesson #86): the
  first import-prune pass deleted the approvals.js import from server.ts on
  the false memory that it belonged to the moved block — caught by READING
  the diff before any gate, restored before anything ran.
- **Verified**: lint clean · typechecks clean ×2 · root suite 2,825 GREEN
  (2,813 passed + 12 env-skipped e2e — byte-identical to the pre-move
  baseline) · build green · **e2e 12/12 green against the built dist** (the
  suite drives buildServer through the real registration path) · license
  audit 134 CLEAN · **live boot smoke**: the built sidecar reports
  ACUTE_READY and the extracted route answers through the full
  hijack→writeHead→SSE-frame path (honest 404 for an unknown session).
- Version 0.83.0 → **0.84.0** (version:set ×4 + version:check green).

### 4b. Branch cleanup (owner-directed)

Deleted from origin (tips recorded here for recoverability — this file is
pushed to GitHub as the backup):

| Branch | Tip | State before deletion |
|---|---|---|
| `backup/pre-r79` | `ff65a5f` | 0 commits outside main (fully merged) |
| `backup/pre-r80` | `ede3455` | 0 commits outside main |
| `backup/pre-r81-session` | `6e9e3d7` | 0 commits outside main |
| `work/r82-models-providers` | `1932a9e` | 0 commits outside main (tip IS in main's history) |
| `work/r84-modularity` | `497a3ff` | 0 commits outside main (tip IS in main's history) |
| `work/round-61-computer-use` | `d16640e` | 7 commits outside main — **superseded, not merged**: main's R61 (9c1b794…) shipped the PowerShell-backend approach (computer/backends/windows.ts, R64-a-hardened); the branch holds the abandoned cua-helper Rust crate line (d4ab464 M1-M4, 7bf2e0c packaging, 2c72ae0 M5, 059a081 M6, a89ad8b M7, d16640e verify pass). Owner verdict: "not in use anymore" |

`main` is the only remaining branch. No tags were touched.

### 4c. Version publishing (the acute.bat path)

- **v0.83.0 was a never-published DRAFT** (the R84 close-out left it; the
  exact R63-R67 failure class the R74 lesson describes — except the max-version
  picker masked it for the owner's PAT). **PUBLISHED** via the API
  (release 386366651 → draft:false, make_latest): both assets verified
  (ACUTE-CODE_0.83.0_x64-setup.exe 37.4 MB + acute-launcher-kit-v0.83.0.zip
  97.5 KB). Zero drafts remain repo-wide.
- This round tags **v0.84.0** on push; the release workflow builds the
  installer + kit as a draft, and the close-out publishes it (MAINTENANCE
  recipe g: publish-at-close-out is a required step).

### 4d. DASHBOARD truth-sync

The R86 sync (in the DASHBOARD repo, this session): `plan.current` → the R86
story, `plan.upcoming` → the post-extraction queue (Wave 2-b first; 51 routes
remain), the R83-era leftover upcoming entry removed, version + lastUpdated +
milestones/quality synced to the R86 truth, rebuilt with build.mjs
(denylist clean). The `plan` section is the part the previous sync missed.

## 5. Verification summary

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `pnpm typecheck` (root + agent-core) | clean ×2 |
| `pnpm test` (root suite) | 153 files passed + 2 skipped / **2,813 passed + 12 skipped** — identical to the pre-move baseline |
| `pnpm build` | green |
| `pnpm test:e2e` (vs built dist) | **12/12** |
| `pnpm license:audit` | 134 deps CLEAN |
| Live boot smoke | ACUTE_READY + the extracted route answering (honest 404 frame) |
| CI (windows-latest) | run 34515808594 SUCCESS — the full verify pipeline on the pushed commit |
| Release workflow | run 34515811591 SUCCESS — v0.84.0 installer + kit built, PUBLISHED at close-out (both assets verified, zero drafts remain) |
| Round-trip verifier | the moved block byte-identical to `git show HEAD` (dedent-only diff) |

## 6. What's next (the R87 scoping input)

- **Wave 2-b — the turn-loop harness extraction** (still risk #1): the 378
  byte-identical lines between the sync/streamed runners; `prepareTurn`'s 10
  positional args → an options object.
- **The remaining server.ts split**: **51 routes** (terminal 8, MCP 6,
  computer-use 9, diagnostics 2, approvals 2, vision 3 + the 21-route
  unnamed tail: notifications/jobs/checkpoints/dialogs/plugins/index/keys/
  health). The SSE domain (the hardest) is now done — the rest is
  mechanical on the proven pattern.
- **Wave 3 — the frontend seams**: api.ts split (85 importers), the
  stream-event handler registry (the 687-line handleStreamEvent), the
  AgentChatPanel/ModelsProvidersTab decompositions, deleting the 559-line
  dead sessions/ dir (now provably maintained-while-dead — see §3).
- **Wave 1 leftovers**: the 22 SQL leaks → storage/ (approvals ×11), the
  registry↔mcp TOOL_NAME_RE 2-cycle leaf, the 3 unsanctioned
  tools→agents leaf edges, src/README.md's stale route rows.
- **DeepSeek round-2**: C2 per-tool declared timeoutMs (top pick).
- **The standing queue**: external plugin ctx enrichment, ratings-driven
  prompt tuning, edit-linting, installer code-signing, Files-tab polish,
  agent web-app-testing tools.
