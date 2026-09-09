<!-- last-reviewed: 2026-09-09 round-80 -->
# MODULE-BOUNDARIES — the contract for editing this repo with small context

**Status:** normative · **Established:** round-80 (owner directive: low-context agents
working on small parts without whole-system context)
**Audience:** every agent (or human) editing ACUTE-CODE — read this BEFORE touching
code; it tells you the minimum file set for each task type and the edges you must
never cross.
**Companion:** [MODULARITY-ASSESSMENT](../architecture/MODULARITY-ASSESSMENT.md) (the
evidence behind these rules); [MAINTENANCE](MAINTENANCE.md) (recipes); [ADR-0025](../decisions/0025-plugin-tool-system.md).

The repo's stated goal is extension-based modularity. These rules keep that true while
the structural debts (god files + one import cycle — see the assessment) still exist.

## When

Always. If your task is not listed in §3, ask the orchestrator/owner BEFORE inventing
a new seam. When in doubt: the seams listed here are the ONLY sanctioned crossing
points between modules.

## 1. The module map (one screen)

```
agent-core/src/
  server.ts          HTTP surface (Fastify). Outermost layer — nothing imports it
                     except main.ts + tests. PENDING SPLIT into routes/ modules.
  agents/            the turn runtime + orchestrator + prompt/mode/skill glue.
                     runtime.ts + orchestrator.ts are in a KNOWN import cycle with
                     tools/ (see §4) — do not add new edges into it.
  tools/             ADR-0025 plugin registry: plugins/*.ts declarations +
                     registry.ts (loader/catalog) + index.ts (assembler + ToolDeps).
  storage/           THE ONLY home for SQL (rule + known exceptions, see §2).
  providers/         provider registry/keyring (env-injected keys).
  computer/          desktop automation subsystem — fenced (no tools/agents imports).
  browser-proxy.ts   browser subsystem — fenced.
  mcp/               MCP client manager — fenced.
  shared/            (workspace pkg) canonical domain types — code conforms, never
                     redefines locally.
src/                 React frontend. api.ts = typed API client (86 importers);
                     lib/stream-store.ts = the live-turn state machine; components/
                     are feature groups (shell, project-chat, settings, right-sidebar).
```

## 2. Hard edges (violations get work rejected)

1. **SQL lives in `agent-core/src/storage/` only.** Known legacy exceptions (do not
   extend the list; each is a candidate for the Wave-2 move): server.ts checkpoint
   lookups + usage SUMs, runtime.ts models SELECT, orchestrator.ts session sweep,
   tools/registry.ts settings read, lib/web-push.ts subscriptions. A new feature
   needing data adds a storage module or extends one — never a route-level query.
2. **Nothing imports `server.ts`** except `agent-core/src/main.ts` and tests. Routes
   reach subsystems; subsystems never reach routes.
3. **Fenced subsystems stay fenced**: `computer/*` must not import tools/agents/server;
   `browser-proxy.ts` only browser-command + storage; `mcp/manager.ts` only lib +
   storage; `approvals.ts` only shared/storage/lib; `providers/registry.ts` only
   storage/providers. If you need cross-subsystem behavior, the crossing happens in
   `server.ts`, `agents/runtime.ts`, or via ToolDeps — not by new imports.
4. **`shared/` is the type truth.** Never re-declare a domain union locally; import
   from `shared`. Frontend mirror types (StreamTurnEvent) live in api.ts by
   established precedent — new cross-process contracts should start in shared/.
5. **Migrations are append-only and numbered** (`NNNN_*.sql`, next = 0029+). Never
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

**Add a REST route** (today: server.ts is one giant file — pattern is uniform):
1. `agent-core/src/server.ts` — find the domain section by route comment, copy a
   neighboring handler (errorBody + FieldIssue validation; auth/CORS/404/error
   envelope are app-level hooks — zero wiring needed).
2. `src/lib/api.ts` — client function (+ types).
3. `docs/architecture/api/IMPLEMENTED-API.md` — document it (truth doc).
4. NEW test file (pattern: buildServer({token, db}) + in-memory better-sqlite3).
After the Wave-2 split this becomes: NEW `routes/<domain>.ts` + register in the
assembler — do not preemptively create routes/ until that round is approved.

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

## 4. The known import cycle (do not widen)

`agents/runtime.ts` ↔ `agents/orchestrator.ts` ↔ `tools/index.ts` ↔
`tools/registry.ts` ↔ `tools/plugins/*` (25 files, one strongly-connected component).
Rules of engagement:
- Adding a NEW tools/plugins/*.ts file is always safe (the registry's import is
  dynamic-in-pattern; you add to a list, not a graph).
- Do NOT add new static imports from tools/plugins/* into agents/* (or back). The
  sanctioned crossing is **ToolDeps** (built once in prepareTurn, passed down):
  chat/chatStream are the precedent — the delegation tool's static
  getOrchestrator import is the known debt, fixed by the same injection in Wave 2.
- Pure glue modules (error-classification, task-hints, mode-policy, compaction,
  system-reminders) must stay pure — they exist specifically to break would-be
  cycles; importing runtime/orchestrator from them re-tangles the graph.

## 5. Sync-point checklists (drift guards bite)

- Tool name: 5 points (plugin file, registry, TOOL_NAMES, migration, TOOL_CATALOG) —
  tool-catalog-drift.test.ts + allowlist tests fail CI on a miss.
- Prompt section: 2 points (prompts.ts + prompt-registry.ts) — lockstep + golden.
- API route: 2 points (server.ts + api.ts) + IMPLEMENTED-API.md (no automated guard
  yet — the doc's completeness is manual; when adding a route, doc it in the same
  commit).
- Version: package.json is the single source (status.json mirrors for the dashboard).

## 6. Verification gates before any push

`pnpm verify` (lint + typecheck + test + build + e2e + license audit) — the local
pre-push gate; `pnpm docs:check` (stamps + path refs + URL HEADs) — currently CI
warn-only but expected green; every doc you touch gets its first-line stamp bumped
(`<!-- last-reviewed: 2026-09-09 round-80 -->` style, round from docs/status.json).
See [WORKFLOW](WORKFLOW.md) for the full session spine and [TESTING](TESTING.md) for
the suite map.

## Troubleshooting

- "I need to change turn behavior": that is NOT a small-context task today (sync +
  streamed runners duplicate the machinery). Route it to the orchestrator/owner with
  the MODULARITY-ASSESSMENT §10 Wave-2 reference.
- "My new tool doesn't appear": check the 5 sync points (§5) — 90% of misses are
  TOOL_NAMES or the migration.
- "My plugin fails to load": GET /plugins shows the honest load-error note; check the
  name grammar + shape (EXTENSIBILITY §plugins).

## See also

[MODULARITY-ASSESSMENT](../architecture/MODULARITY-ASSESSMENT.md) ·
[MAINTENANCE](MAINTENANCE.md) · [EXTENSIBILITY](EXTENSIBILITY.md) ·
[WORKFLOW](WORKFLOW.md) · [ARCHITECTURE](../architecture/ARCHITECTURE.md) ·
[ADR-0025](../decisions/0025-plugin-tool-system.md)
