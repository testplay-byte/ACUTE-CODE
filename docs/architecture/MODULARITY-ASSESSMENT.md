<!-- last-reviewed: 2026-09-10 round-85 -->
# MODULARITY ASSESSMENT — the structure audit for the extension-based vision

**Status:** reference · **Established:** round-80 (docs-only analysis round, owner-directed) · **Updated:** round-85 (the post-R84 re-assessment — see below) · **Audience:** the owner deciding the R86+ direction; any agent planning structural work
**Method (R85):** three parallel analysis sweeps (backend import-graph + sizes · frontend anatomy + coupling · docs-truth audit), every claim re-verified at HEAD `c38bc8b` with file:line evidence; spot-checked by the orchestrator before writing. Full evidence + method: [round-85](../ui-iterations/round-85.md). Companion rules doc:
[MODULE-BOUNDARIES](../runbooks/MODULE-BOUNDARIES.md).

## R85 re-assessment (the post-R84 state, 2026-09-10)

**Verdict in one paragraph:** R84's two structural wins are REAL and verified
(server.ts 5,719→2,439 lines across 14 `routes/<domain>.ts` modules; the
25-file agents↔tools SCC dead — the delegation plugin imports only the
`agents/sub-roles.ts` leaf). But the re-assessment found: (1) R84's "zero
cyclic SCCs" is overstated — one benign value-import 2-cycle remains
(`tools/registry.ts:53` ↔ `tools/plugins/mcp.ts:20`, the TOOL_NAME_RE edge
since R61); (2) the remaining server.ts work is undercounted — **52 routes**
remain (not ~31; 21 routes in ~9 groups were never on the plan: notifications
×7, jobs ×4, checkpoints/snapshots ×3, internal dialogs ×2, plus
browser-checkpoints, projects/:id/index, GET /plugins, internal/providers/keys,
/health); (3) the SSE route is 476 lines (the 392 figure is the stale R80.5
measure); (4) the turn-loop debt GREW — runtime.ts 3,192→3,369 with the
sync/streamed runners sharing 378 byte-identical lines (78% of the sync
runner); (5) the frontend god files grew (api.ts 3,821→3,959,
stream-store.ts 1,891→1,936, ModelsProvidersTab 3,006→3,304) — Wave 3 is
untouched and the trend is negative; (6) SQL confinement regressed in
visibility terms (22 statements outside storage/ vs the documented ~12 —
approvals.ts alone holds 11 that were never counted, and the R84 split
RELOCATED the usage SUMs to routes/sessions.ts instead of fixing them);
(7) the normative docs drifted hardest where agents trust them most —
MODULE-BOUNDARIES still described the dead cycle as current and the
route-add recipe pointed at server.ts ("do not preemptively create routes/")
— **all fixed this round** (see §13).

**Scores (R80.5 → R85):** built-properly 7→7.5 (SCC dead + split real, but
turn-loop debt grew and `computer/dispatch.ts` 2,447 is a never-flagged
largest-file) · backend agent-editability 6.5→7 (routes now a proven 5-step
pattern; turn behavior still 3/10 until Wave 2-b) · frontend
agent-editability 4→3.5 (god files grew, 559 lines of dead code,
zero seams — unchanged D) · doc-truth 7→6 at audit time (the R84
stamp-cohort refresh was stamp-only on ~12 docs, over-claiming freshness) →
~8 after this round's fixes.

## R84 progress (Wave 2, shipped behavior-identical + test-guarded)

- **Wave 2-c (the SCC break): DONE.** The 25-file cycle is dead — the
  delegation plugin's static orchestrator import (the audit's root cause)
  replaced by the `agents/sub-roles.ts` leaf + the `ToolDeps.orchestrator`
  seam + a lazy dynamic-import fallback. A Tarjan check over the runtime
  value-import graph reports zero cyclic SCCs **at the >2-file threshold —
  R85 correction: one benign 2-cycle remains (registry ↔ plugins/mcp,
  TOOL_NAME_RE, present since R61; see R85 section above)**.
- **Wave 2-a (the server.ts split): 57% done.** 71 routes moved verbatim
  into 14 `agent-core/src/routes/<domain>.ts` modules on the
  `registerBrowserRoutes` pattern; `buildServer` is the assembler;
  **server.ts: 5,719 → 2,439 lines**. Remaining: **52 routes** (R85 count —
  terminal, MCP, computer-use, diagnostics, approvals, vision, the
  notifications/jobs/checkpoints/dialogs/plugins groups, and the 476-line
  streamed SSE route marked final-phase) — the pattern is established.
- **Wave 2-b (the turn-loop harness): NOT STARTED** — the ~1,700-line
  sync/streamed duplication is the next structural round (R85 measured it
  precisely: 378 byte-identical lines, 78% of the sync runner).

---

## 1. The verdict in one paragraph

ACUTE-CODE's **part-level modularity is exemplary** — the extension surfaces the owner
asked for (tools, skills, modes, prompt modules, MCP) are real, tested, fail-soft, and
mostly addable with one file and zero core edits. But the **product core is not yet
extension-based**: six god files concentrate every cross-cutting change
(`server.ts` 5,086 lines, `runtime.ts` 3,192, `api.ts` 3,821, `stream-store.ts` 1,891,
`AgentChatPanel.tsx` 2,932, `ModelsProvidersTab.tsx` 3,006), one 25-file import cycle
tangles runtime ↔ orchestrator ↔ tools, and the frontend has no extension seams at
all. A low-context agent can add a tool or skill confidently today (9/10); it cannot
safely touch the turn loop, the stream pipeline, or the chat UI without whole-system
context (3/10). The fix patterns already exist inside the repo itself
(`registerBrowserRoutes`, `ToolDeps` injection, the settings-tab switch) — the gap is
execution, not invention.

## 2. What the system is today (the numbers — R85 re-measure)

| Layer | Size (R80.5 → R85) | Shape |
|---|---|---|
| `agent-core/` (Node sidecar) | 88→**104 TS files, ~44.6K LOC** | Fastify server (routes/ split 57%) + agents runtime + 14 internal tool plugins (26-tool base vocabulary) + storage (31 migrations) + computer-use + browser proxy + MCP |
| `src/` (React frontend) | 156→**217 files, ~76K LOC** | Shell + project-chat + 8 settings tabs + right-sidebar panels + 13 Zustand stores + popout/mini apps; 60 test files (946 tests) |
| `src-tauri/` (Rust shell) | small | sidecar lifecycle, key injection, dialogs, wincred, browser |
| `shared/` | 1 file, 123 lines | canonical domain types (honored; new cross-process contracts should start here) |
| Tests | 149→**155 files, 2,825 tests** | agent-core 92/1,867 · frontend 60/946 · e2e 12 · shared 1/4 · launcher 10 |
| Docs | 181→**188 docs, 29 ADRs, 83 round files** | stamped, path-checked, CI-advisory (R85: still `continue-on-error` — see §10) |

Top backend files (R85): runtime.ts **3,369** · computer/dispatch.ts **2,447** ·
server.ts **2,439** · windows.ts 1,855 · browser-proxy.ts 1,738 · orchestrator.ts
1,436 · routes/sessions.ts 1,243 · prompts.ts 1,243. Top frontend files (R85):
api.ts **3,959** · ModelsProvidersTab.tsx **3,304** · AgentChatPanel.tsx **2,757** ·
stream-store.ts **1,936** · WorkingSection.tsx 1,888 (the unnamed fifth god
component — the shared turn renderer, cross-imported by SubAgentPanel).

Process discipline is the strongest asset: 80 owner-gated rounds, ADR trail, honest
error surfacing, fail-soft loading everywhere, drift tests (tool catalog, prompt
registry), and verification culture. The round system itself is a working template for
how low-context agents already operate on this repo.

## 3. The dependency map and its cycles (R85 re-measure)

Clean one-way flow overall: `server.ts` is the outermost layer (only `main.ts` +
tests import it); subsystem fences HOLD — `browser-proxy` never imports `computer`,
`computer` never imports `tools/agents/server`, `approvals`/`mcp`/`terminal-sessions`/
`providers` are tightly fenced, `shared` is honored. Cycle status (Tarjan, R85):

1. **SCC(25) — the big one: DEAD (R84).** The delegation plugin's static
   orchestrator import was replaced by the `agents/sub-roles.ts` leaf + the
   `ToolDeps.orchestrator` seam + a lazy dynamic-import fallback
   (delegation.ts:101-102). agents→tools is now exactly ONE value edge
   (runtime.ts:20 → tools/index.js); the all-import SCC is now 22 files,
   entirely inside tools/.
2. **SCC(2) — R85 find:** `tools/registry.ts:53` ↔ `tools/plugins/mcp.ts:20`
   (mcpPlugin and TOOL_NAME_RE, both used at call time — benign, present since
   R61, missed by the R84 "zero cycles" check's 90-file scope). Fix when
   convenient: move TOOL_NAME_RE to a `tools/names.ts` leaf.
3. SCC(4): `storage/db` ↔ `storage/agents` ↔ `storage/models` ↔ `storage/skills`
   (boot-time seeding, type-only back-edges, benign — unchanged).
4. SCC(2): `agents/prompts` ↔ `agents/prompt-registry` — type-only back-edge,
   documented as deliberate (unchanged).
5. **R85: three unsanctioned tools→agents leaf edges** — `tools/plugins/modes.ts`
   (→ agents/modes, agents/system-reminders) and `tools/plugins/dir-conventions.ts`
   (→ agents/system-reminders). Leaf-targeted, cycle-free, but they are the edge
   class the boundaries doc prohibits; either sanction them in MODULE-BOUNDARIES
   or reroute through ToolDeps.

**SQL confinement is WORSE than the R80.5 audit said**: **22 statements** live
outside `storage/` in 7 files (the audit counted ~12): `approvals.ts` ×11
(an entire inline persistence layer never counted — :382-477, :760-777),
`routes/sessions.ts` ×2 (:714, :753 — the usage SUMs RELOCATED by the R84 split,
not fixed), `agents/runtime.ts` ×2 (:3308, :3350), `server.ts` ×2 (:632, :642),
`agents/orchestrator.ts` ×1 (:1382), `tools/registry.ts` ×1 (:446),
`lib/web-push.ts` ×3 (:82-104). `storage/db.ts:4`'s "only code that issues SQL"
claim remains false.

## 4. The god files (responsibility inventories — R85 re-measure)

**`agent-core/src/agents/runtime.ts` (3,369 lines, GREW +177 since the audit)** —
completion heuristics, delegation-depth guard, allowlist narrowing (4 stacked
intersections), loop guard, turn types, message shaping, history assembly, error
persistence, env probing, `prepareTurn` (447 lines, **10 positional args**), then
`runSingleAgentTurn` (781 lines) and `runStreamedAgentTurn` (1,018 lines) — with
**378 comment-stripped lines byte-identical between the two runners (78% of the
sync runner's body)**: the retry ladder (:1511 vs :2291), loop guard (:1646 vs
:2404), retry-class gates (:1804 vs :2839) all duplicated. There is still no seam
to add a new turn concern; every addition is edited twice. Wave 2-b (the harness
extraction) is the fix and is the top structural candidate for R86.

**`agent-core/src/computer/dispatch.ts` (2,447 lines)** — now the LARGEST backend
file, never on any god-file register (the R80.5 audit's blind spot: it only
inventoried the files the rounds kept touching). Disciplined internally (command
dispatch tables) but a single-file subsystem surface.

**`agent-core/src/server.ts` (2,439 lines, was 5,719)** — the R84 split moved 71
routes into 14 domain modules; 52 routes remain (terminal 8, MCP 6, computer-use
9, diagnostics 2, approvals 2, vision 3, SSE 1, + the 21-route unnamed tail:
notifications/jobs/checkpoints/dialogs/plugins/index/keys/health). The 476-line
SSE route (:1348-1823) owns queue-continuation, debug-analyst, and crash
recovery — the hardest concurrency logic still sits in the HTTP layer.

**`src/lib/api.ts` (3,959 lines, GREW +138, 72 importers)** — still one flat
module mixing transport, ALL domain types (~90 interfaces), view-models,
inline SSE readers, and the hand-maintained `TOOL_CATALOG` mirror.

**`src/lib/stream-store.ts` (1,936 lines, GREW +45)** — `handleStreamEvent`
is a **687-line function (:1229-1915)**: 42 `event.type` comparisons over 34
event types, firing **17 cross-store side-effects into 5 stores + the query
client**. No event-handler registry — the opposite of the backend's tool
registry.

**`src/components/settings/ModelsProvidersTab.tsx` (3,304 lines, GREW +298 —
now the largest component)** — providers CRUD + keys + catalog + tests + key
pool + 4 full dialogs + 40 hook calls in one file.
`src/components/project-chat/AgentChatPanel.tsx` (2,757, shrank −175 via R81)
still orchestrates streaming, ratings, todos, browser binding, mode picker
with 64 hook calls and 8 store imports.

**Duplication tax (R85)**: `sessions/ChatView.tsx` is now **DEAD CODE** (559
lines incl. its test — zero importers since R49 removed the /sessions route);
the sync/streamed turn runners duplicate 378 lines exactly; `WorkingSection.tsx`
(1,888) renders every turn row and is imported cross-feature by SubAgentPanel.

## 5. Extension surface audit (the owner's core question)

| Surface | Real? | Addable by low-context agent | Grade |
|---|---|---|---|
| External plugins (.mjs) | YES — `registry.ts:335-390`, fail-soft, caps 32/64 | YES (1 file in `~/.acute/plugins/`, zero core edits) | B+ — but no ctx for externals, no execute-time isolation/timeout, no lifecycle/versioning; in-process full trust |
| Skills | YES — 3 merged sources, ONE shared resolver (`skills-files.ts:534`) so prompt index and `read_skill` can never disagree | YES — best surface: drop one SKILL.md | A — 20 builtins, progressive disclosure, sticky bodies, honest 409s |
| Task modes | YES — 6 builtins + `.acute/agents/*.md` customs, re-resolved from disk every turn, R75 hard enforcement in ONE chokepoint (`runtime.ts:1233-1268`), owner-pinned read-only, children inherit | YES — drop one .md | A — genuinely clean, narrow-only, safe |
| MCP servers | YES — stdio JSON-RPC, protocol 2024-11-05, one-strike, sanitized env, 16K cap | YES (settings UI only, no code) | B- — stdio-only cuts off the hosted-MCP ecosystem; old protocol; no per-server tool allowlist |
| Prompt modules | YES — 24 registry sections, per-project `.acute/prompts/<id>.md` overrides, golden-fixture pinned | YES (1 .md per section) | A- — but builtin seed text lives in the 1,242-line `prompts.ts` god file |
| Frontend extension | NO — no registry, no event-bus, no panel plugin pattern | NO — every event/panel lands in the same 4-5 hot files | D — the missing half of the "mostly extension-based" vision |

## 6. Seam audit vs PILLARS.md §7 (the pillar roadmap)

- **§7-1 ToolContext seam**: ~80% REAL under the name **`ToolDeps`**
  (`tools/index.ts:60-118`, built at `runtime.ts:1155-1211`) — carries everything the
  blueprint lists except `runId`; nested turns stream/abort/attribute through it.
  Substance shipped; the named contract is not formalized or ADR'd.
- **§7-2 Delegation**: REAL and deep — `delegate_task` with task_id/background/resume
  (ADR-0028), semaphores (maxParallel + per-key), child sessions, mode inheritance.
  PILLARS' literal event names (`delegation.started/finished`) are aspirational; the
  shipped event is `delegation.collected`.
- **§7-3 WS push channel**: NOT BUILT (no WebSocket anywhere; SSE remains the only
  push). Approval engine: DONE (ADR-0024).
- **§7-4/5/6 workflows, scheduler, canvas**: NOT BUILT — last migration is 0031; no
  workflows/executions/schedulers tables; canvas exists only as 4 hardcoded
  FreeformPanel ids.
- **Typed event log**: PARTIAL — ADR-0010 append-only log is real, but
  `SessionEvent.type` is a plain string (`sessions.ts:84`); the typed union exists
  only on the frontend (`StreamTurnEvent`, api.ts:2825).

## 7. Documentation truth audit (round-80 close)

Confirmed: 149 test files exact; v0.79.0 tagged/released; tree clean; R80 committed
(`4a9828e`) and closed (`6f512aa`, docs-only status.json ci sync — verified by diff);
`backup/pre-r80` exists; ADRs 0025/0028 map to real shipped code; `docs:check`
ran live "181/0/0"; DASHBOARD truth-synced to 0.79.0 (Pages live, HTTP 200).

Drift found (all small, all fixable):
1. **HANDOFF §3 is one commit stale** — says R80 "sits uncommitted"; it is committed,
   tagged, and released. A fresh agent verifying from `ede3455` would "confirm" a
   state that no longer matches HEAD.
2. **`docs/status.json` plan.upcoming lacks the R81 queue** that HANDOFF and the
   DASHBOARD both carry, and still lists the v0.75.0 re-test.
3. **IMPLEMENTED-API.md (~91% coverage)** — 11 shipped routes undocumented: the core
   notifications surface (list/SSE stream/read/read-all — only the push trio is
   documented), `projects/:id/{demos,index,search}`, `providers/:id/keys/reveal`,
   `sessions/:id/checkpoints`, `sessions/:id/snapshots/:seq`,
   `sessions/:id/subagents/:childId/retry`.
4. `src/README.md` describes a ~round-15 app (2 hooks, placeholder routes) — the real
   frontend has 12 hooks, 12+ directories, 156 files. It misleads low-context agents.
5. docs:check in CI is `continue-on-error` (warn-only) — "gate" language overstates it.
6. Cosmetic: ADR-0028 filename zero-pads to 6 digits (`000028-…`) vs the 4-digit
   convention of 0001-0027.

## 8. Scores (for the owner's three questions — R85)

| Question | R80.5 | R85 | What moved |
|---|---|---|---|
| "Is everything built properly, well-structured?" | 7/10 | **7.5/10** | +SCC dead, +routes split; −runtime grew, −computer/dispatch.ts never flagged, −SQL leaks grew |
| "Easy for AI agents to edit without affecting other parts?" (backend) | 6.5/10 | **7/10** | routes now a proven 5-file pattern (was 5/10); tools/skills/modes/storage still 9/10; turn behavior still 3/10 (Wave 2-b unstarted, 378 duplicated lines measured) |
| "Easy for AI agents to edit" (frontend) | 4/10 | **3.5/10** | god files GREW (+138/+45/+298), 559 lines dead code, zero seams, zero code-splitting — trend negative until Wave 3 |
| "Is the doc truth trustworthy?" | 7/10 | **6→8/10** | 6 at audit time (R84 stamp-only cohort refresh over-claimed; MODULE-BOUNDARIES §3/§4 actively misrouted agents) — 8 after this round's fixes; structural gap remains: docs:check is content-blind (backticked paths unchecked) and CI-advisory |

## 9. Risk register (top 8, ranked — R85)

1. **runtime.ts sync/streamed duplication** (PROMOTED to #1) — 378 byte-identical
   lines, 78% of the sync runner; every cross-cutting turn concern edited twice;
   10-positional-arg `prepareTurn` invites silent mis-ordering; the file GREW +177
   since the audit. Wave 2-b is the fix.
2. **Frontend hot-file concentration** (PROMOTED to #2) — api.ts/stream-store/
   AgentChatPanel/ModelsProvidersTab all grew or sat; every future pillar (image gen,
   automations, schedules) lands in the same 4-5 files unless Wave 3 lands first.
   Plus 559 lines of dead code no round ever deleted.
3. **The remaining server.ts 52 routes** — the named domains (terminal/MCP/computer/
   diagnostics/approvals/vision/SSE) PLUS the 21-route unnamed tail (notifications,
   jobs, checkpoints, dialogs, plugins) the R84 plan never listed.
4. **SQL confinement honesty** — 22 statements outside storage/ and GROWING per round
   (approvals.ts ×11 never counted; the R84 split relocated 2 instead of fixing);
   db.ts's own header claim remains false.
5. **Stringly-typed session events + unfixed seams** — the event-sourcing backbone
   PILLARS §2 depends on has no typed contract in code; ToolDeps is a de-facto seam
   (now documented as such in MODULE-BOUNDARIES) but still missing `runId` and an ADR.
6. **External plugin trust model** — in-process full trust, no execute-time
   wrapper/timeout; a hanging or hostile `execute` blocks a turn (the documented
   Wave-3 item, unchanged).
7. **docs:check blind spots** — backticked path refs are stripped before checking
   (deleted-file references pass), CI is advisory (`continue-on-error`), sub-package
   READMEs are outside the walk entirely.
8. **IMPLEMENTED-API blind spot** — still no automated check for undocumented routes
   (unlike the computed tool catalog); R85 found 1 more (`GET /providers/:id/models-config`).

## 10. Improvement roadmap (prioritized; S < 1 day, M 1-3 days, L > 3 days — R85 refresh)

Wave 1 — cheap, immediate (S, docs + tiny code):
- ~~Formalize the seams in docs~~ (DONE R80.5; re-done R85 where it re-drifted).
- Fix dead seam: `ReminderBudget` (`system-reminders.ts:109`) — STILL dead (R85).
- Move the 22 leaked SQL statements into `storage/` (approvals.ts ×11 is the big
  batch; make db.ts's claim true).
- Kill the benign registry↔mcp 2-cycle (move TOOL_NAME_RE to a `tools/names.ts`
  leaf) + sanction-or-reroute the 3 unsanctioned tools→agents leaf edges.
- Delete the 559-line dead `src/components/sessions/` directory.
- Make docs:check blocking in CI (remove `continue-on-error`) once the stamp
  ceremony is automated (R85 candidate: check backticked paths too).

Wave 2 — the structural continuation (M, the R86 candidates):
- **Finish the server.ts split** — 52 routes remain (the named domains + the
  21-route unnamed tail + the 476-line SSE route, final-phase). The pattern is
  proven; it is mechanical, test-guarded work.
- **Extract the turn-loop harness (2-b, now the #1 risk)** — shared retry ladder /
  loop guard / overflow recovery / error classification helpers used by BOTH
  runners, killing the 378-line exact duplication (and the ~1,700-line
  near-duplication). Fold `prepareTurn`'s 10 positional args into an options object.
- **Split computer/dispatch.ts** (2,447 lines — now the largest backend file) into
  per-family command modules on the routes/ pattern.

Wave 3 — frontend seams (M/L, unlocks everything the owner sees):
- **Split api.ts** into `transport.ts`, `types/*.ts` (domain modules), `sse.ts`,
  `view-models.ts`, `terminal.ts` with a barrel re-export — mechanical,
  test-covered, unlocks parallel UI work immediately.
- **Frontend stream-event handler registry** — map event-type → handler registered by
  the owning store/panel, so the 17 cross-store side-effects stop being hardcoded in
  the 687-line `handleStreamEvent`.
- Decompose AgentChatPanel into a headless `useChatSession` controller + dumb
  sections; split ModelsProvidersTab's 4 dialogs into files; delete the dead
  sessions/ renderer (Wave-1 item above).
- Execute-time wrapper for external plugins (try/catch + timeout — parity with the
  load-time fail-soft); optional minimal ctx for trusted plugins
  `{emit, appendEvent, approvals}`.

Wave 4 — the vision pillars (L, owner-gated per PILLARS):
- Typed `SessionEventType` union in `shared/` (mirror of the frontend union), then
  workflows + scheduler + canvas per PILLARS §3-6; MCP streamable-HTTP upgrade.

## 11. Where the future pillars attach (concrete points)

- **Image generation**: backend is CLEAN — new `tools/plugins/image-gen.ts` following
  `vision.ts` (242-line exemplar), 5-line `BUILT_IN_PLUGINS` registration, a migration
  like 0025/0026, `TOOL_CATALOG` mirror. Frontend is the cost: new item variant +
  stream frame + dispatcher branch + render + settings tab (the Wave 3 seams fix this).
- **Automations**: new `workflows`/`workflow_executions` tables (migration 0029+); the
  agent node wraps the EXISTING exported turn executors (PILLARS §1's "agent node =
  existing turn runtime verbatim" is TRUE in code); semaphores already exist.
- **Schedules**: new module beside `lib/background-jobs.ts` (which already demonstrates
  detached child supervision) + `schedulers` table + the existing notification-bus.
  Never reuse `sessions.mode` (CHECK-constraint trap, PILLARS §3).

## 12. DeepSeek-harness alignment check (R85)

The R51 study's honest verdict survives R80: Cordis-style everything-is-a-plugin
machinery remains NOT adopted (right call at this scale — ADR-0025 scoped adoption to
the tool layer, which is exactly what shipped). The adopted pieces hold up: the
repeat-tool-reminder guard (R51-f, with the owner's hard-stop divergence), the plugin
registry + computed catalog (R52). The three "top future candidates" from the study —
compaction pressure-trigger + overflow-retry, continuable sub-agent children, skill
catalog progressive disclosure — are now ALL SHIPPED (R46/R71 context-overflow
recovery, R79 addressable delegation with resume, R70/R72 skills).

The **round-2 deep study** (`agent-ctx/research/deepseek-harness-round2.md`, post-R81)
verified the repo first-hand (public, MIT, 267 leaf packages, the Cordis paper) and
ranked five adaptation candidates: C1 compaction pressure+KV-preserving summarizer
(partially shipped by R83's honest metering), **C2 per-tool declared `timeoutMs` with
structured TOOL_TIMEOUT results** (top pick — the hang modes we actually hit), C3
mode/permission policy as folded session events + cache-stable policy narration,
C4 tool-result spill (full artifact to disk, locator to the model), C5 the
workflow/goal shape for PILLARS. These queue behind the Wave 2-b/3 structural work —
C2 is the best first pick (S-M, low risk, high value).

## 13. What this analysis changed

### R85 (docs-only, no code)

- THIS document — R85 re-assessment section, all numbers re-measured at `c38bc8b`,
  R84's overstated claims corrected (zero-SCCs → one benign 2-cycle; ~31 remaining
  routes → 52; SSE 392 → 476), scores/risk register/roadmap refreshed.
- [MODULE-BOUNDARIES](../runbooks/MODULE-BOUNDARIES.md) — REWRITTEN to the post-R84
  reality (the #1 drift: §3's route recipe pointed at server.ts with "do not
  preemptively create routes/"; §4 described the dead cycle as current).
- [round-84](../ui-iterations/round-84.md) backfilled (the R84 round file was never
  written); [round-85](../ui-iterations/round-85.md) written (this round's evidence).
- [HANDOFF](../../HANDOFF.md) §1/§3/§4/§6/§9 — verify-from `c38bc8b`, repo map gains
  routes//tools//computer//mcp/, next-queue refreshed.
- [MAINTENANCE](../runbooks/MAINTENANCE.md) §e recipe + map → routes/ pattern.
- [IMPLEMENTED-API](api/IMPLEMENTED-API.md) — `GET /providers/:id/models-config`
  backfilled; anchor updated to routes/.
- [docs/README](../README.md) — round 82-85 entries, CONTEXT-METER indexed,
  surface-count unified.
- [TESTING](../TESTING.md) counts → R84 (2,825/155); [EXTENSIBILITY](../EXTENSIBILITY.md)
  deleted-file refs fixed; [ROADMAP](../ROADMAP.md) unfrozen from round-75;
  [status.json](../status.json) round 85 + the 16→26 tools fix + milestone 45;
  ORCHESTRATION-WORKLOG R76-R81 gap backfilled + R85 entry; CHANGELOG entry;
  [AGENT-MEMORY](../AGENT-MEMORY.md) lessons #84 (stamp-only refreshes over-claim
  freshness) + #85 (verification claims must be exact-scoped and re-runnable).
- Sub-package READMEs flagged for regeneration (agent-core/tests/src-tauri/scripts —
  outside docs:check's walk; left as the documented Wave-1 follow-up, not silently
  bumped).
- No code, no version bump, no release — analysis round only. All findings are the
  input for the owner's R86 scoping decision.

### R80.5 (the original analysis round)

- THIS document + [MODULE-BOUNDARIES](../runbooks/MODULE-BOUNDARIES.md) (new).
- [HANDOFF](../../HANDOFF.md) §3 rewritten to committed reality (verify-from is now
  `6f512aa`); stale round-28-era table explicitly archived.
- [IMPLEMENTED-API](api/IMPLEMENTED-API.md) — the 11 undocumented routes backfilled.
- [status.json](../status.json) — plan.upcoming synced to the R81 queue + this
  assessment's roadmap waves.
- [src/README](../../src/README.md) regenerated to the real frontend (was ~round-15).
- ADR-0028 filename re-padded to the 4-digit convention (0028-background-delegation.md).
- No code, no version bump, no release — analysis round only. All findings above are
  the input for the owner's R81 scoping decision.
