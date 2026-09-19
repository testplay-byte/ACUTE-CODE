<!-- last-reviewed: 2026-09-19 round-108 -->

# ADR-0025: Plugin-Based Tool System (registry + external .mjs plugins)

**Status:** Accepted (round 52, 2026-08-30) · **Supersedes:** none (extends ADR-0019's allowlist) · **Relates to:** ADR-0019 (project tool-set truth), ADR-0024 (approval engine), docs/research/deepseek-harness-notes.md

## Context

The owner directed (R52): "I am thinking about going with a plug-in-based
system, just like how DeepSeek harness is. It would give us much more
flexibility. It would allow us to add way too many tools just how we want
them to be." The tool layer had grown to 24 tools across 10 ad-hoc groups
inside one 2000-line `buildProjectTools` — every addition touched the same
file, the UI's `TOOL_CATALOG` mirror had already drifted once (R44 lesson:
15 entries vs 21 real tools), and there was no way to add tools without
shipping code.

## Decision

### 1. The tool layer becomes a PLUGIN REGISTRY (in-repo core)

Every built-in tool group is a self-contained plugin module
(`agent-core/src/tools/plugins/*.ts`) declaring one uniform shape:

```ts
interface PluginDefinition {
  id: string;            // "core-filesystem" — ^core-[a-z-]+$
  name: string; version: string; description: string;
  category: string;      // filesystem | search | git | terminal | web | browser | memory | planning | delegation | external
  createTools(ctx: ToolBuildContext): ToolDefinition[] | Promise<ToolDefinition[]>;
}
interface ToolDefinition {           // per-turn, per-project-root
  name: string;                      // ^[a-z][a-z0-9_]{1,31}$
  description: string; inputSchema: unknown;
  execute(input, ctx): Promise<ToolResult> | ToolResult;
}
```

`tools/registry.ts` owns the types + `BUILT_IN_PLUGINS` (the fixed core:
filesystem, search, git, exec+jobs, web, browser, memory, todo, delegation —
order matters only for catalog listing). `buildProjectTools` (tools/index.ts)
assembles the per-turn toolset FROM the registry with byte-identical
semantics to the old inline builders: the ADR-0019 allowlist (`[]`/absent =
ALL, unknown names = none), the memory master switch, the delegation
keyring/chat gate (a plugin may declare ZERO tools when its dependencies are
absent — preserved from R36).

**The catalog is COMPUTED, never mirrored:** `builtInToolCatalog()` declares
the tools through the REAL plugin factories (declaration-only ctx — execute
is never invoked, documented + tested), so the UI/docs tool list can never
drift from the registrations again. This structuralizes the R44 drift
lesson.

### 2. EXTERNAL plugins: .mjs modules from disk

- `~/.acute/plugins/*.mjs` — user scope, loaded by DEFAULT (trusted like
  `~/.vscode/extensions`: the owner put the files there).
- `<project>/.acute/plugins/*.mjs` — project scope, OPT-IN ONLY via the
  `tools.externalPlugins` setting (`"off" | "user" | "all"`, default
  `"user"`); a cloned repo planting plugin files must never earn code
  execution on open.
- A plugin default-exports its metadata + a plain `tools` array (plain JSON
  Schema — the registry wraps it in `jsonSchema()`); the registry validates
  the id/name grammar, caps (32 plugins / 64 external tools / one
  process-lifetime cache per scope+dirs), drops name collisions with
  built-ins IN FAVOR of the built-in, and loads fail-soft (a broken plugin
  logs and is skipped — never breaks a turn).
- External plugins run IN-PROCESS with full trust; the allowlist is the only
  gate (agents must be granted the tool names; `[]` = ALL includes
  externals automatically).
- **Dynamic import across runtimes:** native `import()` covers plain Node
  (the compiled sidecar); vitest's vite-node runner rewrites `import()`
  into its own resolver (absolute /tmp and ~ paths fail with "Cannot find
  module") and `new Function("return import()")` dies with "A dynamic
  import callback was not specified" — the escape hatch is Node ≥22.12
  `require(esm)` via `createRequire` (CI pins Node 24; the bundled sidecar
  Node is 24.20). `runtimeImport` tries native first, falls back to
  require, and the require path returns the same namespace shape.

### 3. What deliberately does NOT change

- The runtime stays the boring layered monolith (DeepSeek-harness's
  "everything is a plugin" applies to the TOOL LAYER only — agents, the
  turn loop, storage, and the approval engine keep their architecture).
- The approval engine gates `run_command` etc. exactly as before (the
  plugin calls the same `buildApprovalDeps`).
- `ToolResult {ok, output}` and the AI-SDK adapter (`jsonSchema()` wrap,
  `generateText` toolset) are unchanged.

## Consequences

- Adding a tool = adding one plugin entry (see MAINTENANCE.md's updated
  recipe); adding a tool GROUP = one file in `tools/plugins/`.
- `TOOL_NAMES` (the seed allowlist) and the catalog are both fed from the
  same declarations — one source of truth.
- External plugins are a real extensibility surface for the owner (drop a
  file, grant the tool name to an agent) with a documented trust model.
- The `runtimeImport` two-step is load-bearing for tests; changing it
  requires re-probing BOTH runtimes (the test file documents the probes).
