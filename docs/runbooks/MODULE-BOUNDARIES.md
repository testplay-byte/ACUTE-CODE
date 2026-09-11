<!-- last-reviewed: 2026-09-10 round-86 -->
# MODULE-BOUNDARIES — the contract for editing this repo with small context

**Status:** normative · **Established:** round-80 (owner directive: low-context agents
working on small parts without whole-system context) · **Rewritten:** round-85 to the
post-R84 reality (the cycle is dead, the routes/ split is live)
**Audience:** every agent (or human) editing ACUTE-CODE — read this BEFORE touching
code; it tells you the minimum file set for each task type and the edges you must
never cross.
**Companion:** [MODULARITY-ASSESSMENT](../architecture/MODULARITY-ASSESSMENT.md) (the
evidence behind these rules); [MAINTENANCE](MAINTENANCE.md) (recipes); [ADR-0025](../decisions/0025-plugin-tool-system.md).

The repo's stated goal is extension-based modularity. These rules keep that true while
the remaining structural debts (the turn-loop duplication + the frontend god files —
see the assessment §10) still exist.

## When

Always. If your task is not listed in §3, ask the orchestrator/owner BEFORE inventing
a new seam. When in doubt: the seams listed here are the ONLY sanctioned crossing
points between modules.

## 1. The module map (one screen — post-R84)

```
agent-core/src/
  server.ts          HTTP surface (Fastify) — the ASSEMBLER. Routes live in
                     routes/<domain>.ts modules (74 of 133 routes, R84+R86+R87 —
                     the SSE domain shipped in R86; system.ts (the reset) +
                     questions.ts (the ask_user resolve) joined in R87); server.ts
                     keeps 51 (terminal, MCP, computer-use, diagnostics,
                     approvals, vision + the notifications/jobs/checkpoints/
                     dialogs/plugins groups) pending their move. Nothing imports
                     server.ts except main.ts + tests.
  routes/            domain route modules — each exports register<Domain>(scope, ctx);
                     RouteContext (context.ts) carries {db, keyring, chat, token,
                     dataDir (R87 — the reset's machine-file purge)}; server.ts's
                     buildServer calls them in the ORIGINAL registration order
                     (Fastify wildcard precedence). Import only downward
                     (storage/agents/tools/lib/shared) — never each other's internals
                     (helpers.ts/context.ts excepted; sse.ts imports the sync route's
                     field gates from sessions.ts — the documented shared-validation
                     exception; models.ts exports its field gates to providers.ts —
                     the R50-d shared-validation exception).
  agents/            the turn runtime + orchestrator + prompt/mode/skill glue.
                     runtime.ts (3,369) + orchestrator.ts (1,436) are the known
                     god files — the sync/streamed runner duplication is the
                     documented Wave-2b debt; sub-roles.ts is a LEAF (imports nothing).
  tools/             ADR-0025 plugin registry: plugins/*.ts declarations +
                     registry.ts (loader/catalog) + index.ts (assembler + ToolDeps —
                     THE sanctioned tools↔everything seam).
  storage/           THE ONLY home for SQL (rule + known exceptions, see §2).
                     31 migrations (next = 0032+).
  providers/         provider registry/keyring (env-injected keys).
  computer/          desktop automation subsystem — fenced (no tools/agents imports);
                     dispatch.ts (2,447) is the known largest-file debt.
  browser-proxy.ts   browser subsystem — fenced.
  mcp/               MCP client manager — fenced.
  shared/            (workspace pkg) canonical domain types — code conforms, never
                     redefines locally.
src/                 React frontend. api.ts = typed API client (85 importing files
                     — the
                     documented Wave-3 split target); lib/stream-store.ts = the
                     live-turn state machine (687-line handleStreamEvent — the
                     documented handler-registry target); components/ are feature
                     groups (shell, project-chat, settings, right-sidebar).
```

## 2. Hard edges (violations get work rejected)

1. **SQL lives in `agent-core/src/storage/` only.** Known legacy exceptions (do not
   extend the list; each is a candidate for the Wave-1 move): `approvals.ts` ×11
   (the inline persistence layer, :382-477/:760-777), `routes/sessions.ts` usage
   SUMs (:714/:753 — relocated by the R84 split, not fixed), `agents/runtime.ts`
   models SELECTs (:3308/:3350), `server.ts` checkpoint lookups (:632/:642),
   `agents/orchestrator.ts` session sweep (:1382), `tools/registry.ts` settings
   read (:446), `lib/web-push.ts` subscriptions (:82-104). A new feature needing
   data adds a storage module or extends one — never a route-level query.
2. **Nothing imports `server.ts`** except `agent-core/src/main.ts` and tests. Routes
   reach subsystems; subsystems never reach routes. **New routes go in
   `routes/<domain>.ts`** (existing domain) or a NEW `routes/<domain>.ts` module
   registered in buildServer — not into server.ts.
3. **Fenced subsystems stay fenced**: `computer/*` must not import tools/agents/server;
   `browser-proxy.ts` only browser-command + storage; `mcp/manager.ts` only lib +
   storage; `approvals.ts` only shared/storage/lib; `providers/registry.ts` only
   storage/providers. If you need cross-subsystem behavior, the crossing happens in
   `server.ts`, `routes/*`, `agents/runtime.ts`, or via ToolDeps — not by new imports.
4. **`shared/` is the type truth.** Never re-declare a domain union locally; import
   from `shared`. Frontend mirror types (StreamTurnEvent) live in api.ts by
   established precedent — new cross-process contracts should start in shared/.
5. **Migrations are append-only and numbered** (`NNNN_*.sql`, next = **0032+**). Never
   edit an applied migration; never reuse a number.
6. **Frontend domain consumers do not hand-roll fetches.** All HTTP goes through
   `src/lib/api.ts` functions (envelope parsing + error mapping live there once).
7. **External plugin trust model**: `.mjs` plugins run IN-PROCESS with full trust
   (no execute isolation yet). Never add a plugin API that widens trust (ctx access,
   file writes outside ToolDeps) without an ADR.

## 3. Minimum file sets per task (the low-context cheat sheet)

**Add a built-in tool** (the recipe in [MAINTENANCE](MAINTENANCE.md) §a is normative):
1. NEW file `agent-core/src/tools/plugins/<name>.ts` — export a PluginDefinition
   (copy `plugins/todo.ts`, 53 lines, as the exemplar — do NOT read the whole layer).
2. `agent-core/src/tools/registry.ts` — one line in BUILT_IN_PLUGINS.
3. `agent-core/src/storage/agents.ts` — TOOL_NAMES append (allowlist vocabulary).
4. NEW migration `NNNN_<name>_tool.sql` appending the name to existing allowlists
   (idempotent json_insert pattern; copy migration 0026).
5. `src/lib/api.ts` — TOOL_CATALOG mirror entry (drift test guards it).
6. NEW test file `agent-core/tests/<name>.test.ts`. Read exactly: plugins/todo.ts,
   registry.ts (registration block only), MAINTENANCE §a. Nothing else.

**Add an external plugin** (no repo changes): one `.mjs` in `~/.acute/plugins/` (user)
or `<project>/.acute/plugins/` (needs the project settings flip). Contract:
default-export `{id, name, version, description, category, tools:[{name, desc,
schema, execute}]}`; tool-name grammar `^[a-z][a-z0-9_]{1,31}$`; built-ins win
collisions; load errors are fail-soft and visible on GET /plugins.

**Add a REST route** (post-R84 — the split is LIVE):
1. `agent-core/src/routes/<domain>.ts` — add the handler to the owning domain module
   (copy a neighboring handler; errorBody + FieldIssue validation; auth/CORS/404/
   error envelope are app-level hooks — zero wiring needed). For a NEW domain: create
   `routes/<domain>.ts` exporting `register<Domain>(scope, ctx)` and add ONE call in
   `server.ts`'s buildServer, at the position that preserves the intended registration
   order (mind Fastify wildcard precedence).
2. `src/lib/api.ts` — client function (+ types).
3. `docs/architecture/api/IMPLEMENTED-API.md` — document it (truth doc).
4. Extend the domain's test coverage (pattern: buildServer({token, db}) + in-memory
   better-sqlite3; today coverage flows through buildServer — per-domain unit files
   don't exist yet).
5. If the route needs SQL, the SQL goes in `storage/` — never in the route module.

**Add a prompt section**: `agents/prompts.ts` (the block, stamped id) +
`agents/prompt-registry.ts` (registry entry, SAME position — lockstep tests + golden
fixture pin both) + a row in [PROMPT-MODULES](PROMPT-MODULES.md). Optional per-project
override file `.acute/prompts/<id>.md` needs no code at all.

**Add a skill**: drop `<project>/.acute/skills/<name>/SKILL.md` (or
`~/.agents/skills/`). Zero core changes, zero allowlist edits (empty agent allowlist =
all). Caps: desc ≤500 chars, body ≤60K, references/ ≤8×64KB.

**Add a task mode**: drop `<project>/.acute/agents/<mode>.md` (frontmatter `tools:`
narrow-only; id shadows builtins; ≤8 customs, body ≤16K). Zero core changes. Read
[EXTENSIBILITY](EXTENSIBILITY.md) §modes first.

**Add a storage table**: NEW migration + accessor module in storage/ + (if surfaced)
a route + an api.ts function. Reuse row↔domain mappers from a sibling module.

**Add a frontend settings tab**: NEW `src/components/settings/<Name>Tab.tsx`
(self-contained — copy SkillsTab's shell), one line in SettingsPage's switch. Shared
theme tokens only (bg-card / text-muted / border-line via index.css); no store
additions unless persistence is genuinely global.

**Add a stream event type** (currently the most expensive small task — 4 files):
`api.ts` (StreamTurnEvent union) + `lib/stream-store.ts` (handleStreamEvent branch) +
the rendering component + backend emission. The Wave-3 handler registry exists to
fix exactly this; until then expect whole-file context on stream-store.ts.

## 4. The import graph (post-R84: a DAG — keep it that way)

The 25-file agents↔tools cycle is **DEAD** (R84): the delegation plugin no longer
statically imports the orchestrator — it imports the `agents/sub-roles.ts` LEAF
(imports nothing) and receives the orchestrator through the **ToolDeps** seam
(tools/index.ts) with a lazy dynamic-import fallback at execution time. Rules of
engagement going forward:

- Adding a NEW `tools/plugins/*.ts` file is always safe (you add to a list, not a
  graph).
- **Do NOT reintroduce static imports from `tools/` into `agents/` (or back).** The
  sanctioned crossing is **ToolDeps** (built once in prepareTurn, passed down):
  chat/chatStream/orchestrator are the precedent — follow that pattern for any new
  tools→agents capability.
- Known benign residue (documented, safe to fix): one 2-cycle
  `tools/registry.ts:53` ↔ `tools/plugins/mcp.ts:20` (mcpPlugin/TOOL_NAME_RE, since
  R61); three unsanctioned tools→agents LEAF edges (`tools/plugins/modes.ts` →
  agents/modes + agents/system-reminders; `tools/plugins/dir-conventions.ts` →
  agents/system-reminders). Leaf-targeted, cycle-free — but do not add more; prefer
  ToolDeps or a shared leaf.
- Pure glue modules (error-classification, task-hints, mode-policy, compaction,
  system-reminders) must stay pure — they exist specifically to keep the graph a DAG;
  importing runtime/orchestrator from them re-tangles it.
- Before any structural round, re-run a Tarjan SCC check over the full value-import
  graph (104 files — the R84 check's 90-file scope is why its "zero cycles" claim
  missed the benign 2-cycle; see MODULARITY-ASSESSMENT §3).

## 5. Sync-point checklists (drift guards bite)

- Tool name: 5 points (plugin file, registry, TOOL_NAMES, migration, TOOL_CATALOG) —
  tool-catalog-drift.test.ts + allowlist tests fail CI on a miss.
- Prompt section: 2 points (prompts.ts + prompt-registry.ts) — lockstep + golden.
- API route: 2 points (server.ts|routes/<domain>.ts + api.ts) + IMPLEMENTED-API.md
  (no automated guard yet — the doc's completeness is manual; when adding a route,
  doc it in the same commit).
- Version: package.json is the single source (status.json mirrors for the dashboard).

## 6. Verification gates before any push

`pnpm verify` (lint + typecheck + test + build + e2e + license audit) — the local
pre-push gate; `pnpm docs:check` (stamps + path refs + URL HEADs) — currently CI
warn-only but expected green; every doc you touch gets its first-line stamp bumped
(`<!-- last-reviewed: 2026-09-10 round-86 -->` style, round from docs/status.json).
See [WORKFLOW](WORKFLOW.md) for the full session spine and [TESTING](TESTING.md) for
the suite map.

## Troubleshooting

- "I need to change turn behavior": that is NOT a small-context task today (sync +
  streamed runners duplicate the machinery — 378 byte-identical lines, MODULARITY-
  ASSESSMENT §4). Route it to the orchestrator/owner with the Wave-2b reference.
- "My new tool doesn't appear": check the 5 sync points (§5) — 90% of misses are
  TOOL_NAMES or the migration.
- "My plugin fails to load": GET /plugins shows the honest load-error note; check the
  name grammar + shape (EXTENSIBILITY §plugins).
- "My new route 404s": confirm you registered it in buildServer AND that the
  registration order doesn't put a wildcard route (`/sessions/:id/...`) before your
  literal path.

## See also

[MODULARITY-ASSESSMENT](../architecture/MODULARITY-ASSESSMENT.md) ·
[MAINTENANCE](MAINTENANCE.md) · [EXTENSIBILITY](EXTENSIBILITY.md) ·
[WORKFLOW](WORKFLOW.md) · [ARCHITECTURE](../architecture/ARCHITECTURE.md) ·
[ADR-0025](../decisions/0025-plugin-tool-system.md)
