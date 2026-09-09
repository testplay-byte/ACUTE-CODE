<!-- last-reviewed: 2026-09-09 round-80 -->
# MODULARITY ASSESSMENT — the structure audit for the extension-based vision

**Status:** reference · **Established:** round-80 (docs-only analysis round, owner-directed)
**Audience:** the owner deciding the R81+ direction; any agent planning structural work
**Method:** three parallel analysis sweeps (backend architecture / extension surfaces +
frontend / docs-vs-code truth verification), every claim backed by file:line evidence
read directly from the tree at commit `6f512aa`. Cross-checked against PILLARS.md,
ADR-0025, ADR-0028, and the deepseek-harness study. Companion rules doc:
[MODULE-BOUNDARIES](../runbooks/MODULE-BOUNDARIES.md).

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

## 2. What the system is today (the numbers)

| Layer | Size | Shape |
|---|---|---|
| `agent-core/` (Node sidecar) | 88 TS files, ~42.5K LOC | Fastify server + agents runtime + 16 internal tool plugins + storage (28 migrations) + computer-use + browser proxy + MCP |
| `src/` (React frontend) | 156 files, ~50.5K LOC | Shell + project-chat + 8 settings tabs + 5 right-sidebar panels + 10 global Zustand stores + popout/mini apps |
| `src-tauri/` (Rust shell) | small | sidecar lifecycle, key injection, dialogs, wincred, browser |
| `shared/` | 1 file, 123 lines | canonical domain types (honored: 9 imports, no local redefinitions found) |
| Tests | 149 files (exact), 2,772 claimed (static floor ~2,675 = 96.5%) | agent-core 85 / frontend 61 / e2e 2 / shared 1 / launcher 1 |
| Docs | 181 docs, 28 ADRs, 80 round files | stamped, path-checked, CI-warned |

Process discipline is the strongest asset: 80 owner-gated rounds, ADR trail, honest
error surfacing, fail-soft loading everywhere, drift tests (tool catalog, prompt
registry), and verification culture. The round system itself is a working template for
how low-context agents already operate on this repo.

## 3. The dependency map and its cycles

Clean one-way flow overall: `server.ts` is the outermost layer (only `main.ts` +
tests import it); subsystem fences HOLD — `browser-proxy` never imports `computer`,
`computer` never imports `tools/agents/server`, `approvals`/`mcp`/`terminal-sessions`/
`providers` are tightly fenced, `shared` is honored. Three cycles found (Tarjan):

1. **SCC(25) — the big one**: `agents/runtime` ↔ `agents/orchestrator` ↔
   `agents/mode-policy` ↔ `tools/index` ↔ `tools/registry` ↔ all 16 `tools/plugins/*`.
   Root cause: `tools/plugins/delegation.ts` imports `agents/orchestrator` statically,
   which imports `agents/runtime`, which imports `tools/index` (the tool builder).
   ESM-legal but no layer boundary exists between runtime, orchestration, and tools.
2. SCC(4): `storage/db` ↔ `storage/agents` ↔ `storage/models` ↔ `storage/skills` —
   boot-time seeding only, benign.
3. SCC(2): `agents/prompts` ↔ `agents/prompt-registry` — type-only back-edge,
   documented as deliberate in the file header.

**SQL confinement is ~95% true, not 100%**: ~12 statements live outside `storage/`
(`server.ts:1587/2770-2814`, `runtime.ts:3189`, `orchestrator.ts:1330`,
`tools/registry.ts:441-453`, `lib/web-push.ts:82-104`) — contradicting db.ts's own
"only code that issues SQL" claim and the docs' binding rule #1.

## 4. The god files (responsibility inventories)

**`agent-core/src/server.ts` (5,086 lines)** — L239-703 module helpers; L705-954
bootstrap/hooks; L956-5037 ONE `app.register` closure holding **all 116 scoped routes
across ~24 domain groups**; the 392-line SSE route (L3860-4251) owns queue-continuation,
debug-analyst, and crash recovery — the hardest concurrency logic sits in the HTTP
layer. Verdict: disciplined (uniform patterns, ~17% comment density) but a
conflict-prone monolith; the in-repo fix pattern (`registerBrowserRoutes`) is proven.

**`agent-core/src/agents/runtime.ts` (3,192 lines)** — completion heuristics,
delegation-depth guard, allowlist narrowing (4 stacked intersections), loop guard,
turn types, message shaping, history assembly, error persistence, env probing,
`prepareTurn` (437 lines, **10 positional args**), then `runSingleAgentTurn` (754
lines) and `runStreamedAgentTurn` (982 lines) — a near-duplicate pair, ~16 concerns
each, with the retry ladder, loop guard, and error classification **duplicated in
both** (L1743 vs L2734; L1588 vs L2325). There is no seam to add a new turn concern
today; every addition is edited twice inside the 25-file cycle.

**`src/lib/api.ts` (3,821 lines, 86 importers)** — one flat module mixing transport,
ALL domain types, view-models, inline SSE readers, and the hand-maintained
`TOOL_CATALOG` mirror. Changing one domain forces navigating the whole file; merge
conflicts concentrate. It IS typed and heavily tested (api.test.ts, 1,914 lines).

**`src/lib/stream-store.ts` (1,891 lines)** — `handleStreamEvent` (~650-line if-chain
at :1211) interprets ~30 event types AND hardcodes side-effects into 4 other stores
(browser, computer-monitor, right-sidebar, toasts). No event-handler registry — the
opposite of the backend's tool registry.

**`src/components/project-chat/AgentChatPanel.tsx` (2,932 lines)** — 53 hook calls,
7 store imports; orchestrates streaming, ratings, todos, browser binding, mode picker,
and renders chat itself. Not restylable without whole-file context.
`src/components/settings/ModelsProvidersTab.tsx` (3,006) is the settings exception
(providers CRUD + keys + catalog + tests + key pool in one file).

**Duplication tax**: `sessions/ChatView.tsx` is a second chat renderer kept in visual
sync by copy; the sync/streamed turn runners duplicate ~1,700 lines of loop machinery.

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
- **§7-4/5/6 workflows, scheduler, canvas**: NOT BUILT — last migration is 0028; no
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

## 8. Scores (for the owner's three questions)

| Question | Score | Justification |
|---|---|---|
| "Is everything built properly, well-structured?" | **7/10** | Discipline and contracts are top-decile; two monoliths + one import cycle are the structural debt |
| "Easy for AI agents to edit without affecting other parts?" (backend) | **6.5/10** | tools/prompts/skills/modes/storage = 9/10; routes = 5/10 (uniform patterns, giant file); turn behavior = 3/10 (duplicated runners, cycle) |
| "Easy for AI agents to edit" (frontend) | **4/10** | api.ts + stream-store + god components; zero extension seams; duplicated chat renderer |
| "Is the doc truth trustworthy?" | **7/10** | Real machinery + honest culture, with the specific drifts in §7 |

## 9. Risk register (top 6, ranked)

1. **server.ts monolith** — highest merge-conflict + navigation cost; every REST-facing
   feature lands here.
2. **runtime.ts sync/streamed duplication** — every cross-cutting concern edited
   twice; 10-positional-arg `prepareTurn` invites silent mis-ordering.
3. **The 25-file agents↔tools cycle** — no enforced layer boundary; changes ripple
   invisibly between runtime, orchestrator, and tool layer.
4. **Frontend hot-file concentration** — every future pillar (image gen, automations,
   schedules) lands in the same 4-5 files unless seams are introduced first.
5. **Stringly-typed session events + unfixed seams** — the event-sourcing backbone
   PILLARS §2 depends on has no typed contract in code; ToolDeps is a de-facto seam
   nobody documented as THE seam.
6. **IMPLEMENTED-API blind spot** — the designated truth doc can silently under-report
   (no automated check catches undocumented routes, unlike the computed tool catalog).

## 10. Improvement roadmap (prioritized; S < 1 day, M 1-3 days, L > 3 days)

Wave 1 — cheap, immediate (S, docs + tiny code):
- **Formalize the seams** (this round, done in docs): MODULE-BOUNDARIES.md is the
  normative contract; IMPLEMENTED-API backfilled; HANDOFF §3 fixed; status.json
  synced. Proposed follow-ups: rename/export `ToolDeps` as the documented seam, add
  `runId`, one ADR addendum (owner-gated).
- Fix dead seam: `ReminderBudget` (`system-reminders.ts:109`) is exported but never
  constructed — wire it or delete it.
- Move the ~12 leaked SQL statements into `storage/` (makes the binding rule true).
- Make docs:check blocking in CI (remove `continue-on-error`) once the stamp ceremony
  is retired or automated better.

Wave 2 — the structural two (M, the R81 candidates):
- **Split server.ts by domain** into `routes/<domain>.ts` modules each exporting
  `registerX(scope, ctx)` with `ctx = {db, keyring, chat, ring}` — the
  `registerBrowserRoutes` pattern already proves it. buildServer becomes a ~150-line
  assembler. Behavior-identical, test-guarded.
- **Extract the turn-loop harness** — shared retry ladder / loop guard / overflow
  recovery / error classification helpers used by BOTH runners, killing the ~1,700-line
  duplication. Optionally fold `prepareTurn`'s 10 positional args into an options
  object.
- **Break the 25-file SCC** at the delegation edge: inject the orchestrator (or a
  `DelegateTask` fn) through `ToolDeps` like `chat`/`chatStream` already are — converts
  the cycle into a clean DAG.

Wave 3 — frontend seams (M/L, unlocks everything the owner sees):
- **Split api.ts** into `transport.ts`, `types/*.ts` (domain modules), `sse.ts`,
  `view-models.ts`, `terminal.ts` with a barrel re-export — mechanical,
  test-covered, unlocks parallel UI work immediately.
- **Frontend stream-event handler registry** — map event-type → handler registered by
  the owning store/panel, so computer-use/browser/toast side-effects stop being
  hardcoded in `handleStreamEvent`.
- Decompose AgentChatPanel into a headless `useChatSession` controller + dumb
  sections; retire ChatView's duplicate renderer.
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

## 12. DeepSeek-harness alignment check

The R51 study's honest verdict survives R80: Cordis-style everything-is-a-plugin
machinery remains NOT adopted (right call at this scale — ADR-0025 scoped adoption to
the tool layer, which is exactly what shipped). The adopted pieces hold up: the
repeat-tool-reminder guard (R51-f, with the owner's hard-stop divergence), the plugin
registry + computed catalog (R52). The three "top future candidates" from the study —
compaction pressure-trigger + overflow-retry, continuable sub-agent children, skill
catalog progressive disclosure — are now ALL SHIPPED (R46/R71 context-overflow
recovery, R79 addressable delegation with resume, R70/R72 skills). The next study
candidates worth an owner look: `guard/timeout-policy` (per-tool declared timeoutMs
with structured TOOL_TIMEOUT results) and the interaction/user-approval
"policy-as-folded-log" shape.

## 13. What this analysis changed (docs-only, no code)

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
