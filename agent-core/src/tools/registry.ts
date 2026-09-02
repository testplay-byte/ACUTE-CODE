/**
 * ROUND-52 (R52-f): the PLUGIN-BASED TOOL REGISTRY.
 *
 * The owner's directive: "I am thinking about going with a plug-in-based
 * system, just like how DeepSeek harness is. It would give us much more
 * flexibility. It would allow us to add way too many tools just how we want
 * them to be." (deepseek-harness studied in
 * docs/research/deepseek-harness-notes.md — everything is a plugin there.)
 *
 * OUR PRAGMATIC ADOPTION (deliberate divergence from the notes' "not worth
 * adopting" verdict — the owner asked for it): the TOOL LAYER becomes a
 * plugin registry while the runtime stays the boring layered monolith.
 * Every built-in tool group is a self-contained plugin module
 * (tools/plugins/*.ts) contributing ToolDefinitions through one uniform
 * shape; `buildProjectTools` assembles the per-turn toolset from the
 * registry, applying the SAME semantics as before (ADR-0019 allowlist,
 * memory master switch, delegation gating). Behavior is byte-identical for
 * every existing tool — this is an architectural refactor, not a semantic
 * change (the 1000+ test suite is the proof).
 *
 * EXTERNAL PLUGINS: .mjs modules dropped into ~/.acute/plugins/ (user scope,
 * loaded by default) and <project>/.acute/plugins/ (project scope —
 * opt-in via settings tools.externalPlugins="all"; a cloned repo must never
 * get code execution by planting a file). They run IN-PROCESS with full
 * trust — the allowlist (agents must be granted the tool names; [] = ALL
 * includes externals automatically) is the only gate. Name grammar, caps
 * and collision rules are enforced at load; failures are fail-soft (logged,
 * skipped — one broken plugin never breaks a turn).
 *
 * See ADR-0025 (plugin tool system) for the decision record.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonSchema } from "ai";
import { log } from "../lib/log.js";
// Built-in plugins (the registry's fixed core — ORDER MATTERS only for the
// catalog listing; tool assembly is name-keyed).
import { filesystemPlugin } from "./plugins/filesystem.js";
import { searchPlugin } from "./plugins/search.js";
import { gitPlugin } from "./plugins/git.js";
import { execPlugin } from "./plugins/exec.js";
import { webPlugin } from "./plugins/web.js";
import { browserPlugin } from "./plugins/browser.js";
import { memoryPlugin } from "./plugins/memory.js";
import { todoPlugin } from "./plugins/todo.js";
import { delegationPlugin } from "./plugins/delegation.js";
// ROUND-61 (R61): computer use, skills, MCP — the extension surface.
import { computerUsePlugin } from "./plugins/computer-use.js";
import { skillsPlugin } from "./plugins/skills.js";
import { mcpPlugin } from "./plugins/mcp.js";

/** Every tool's uniform result (moved here from tools/index.ts — the
 * registry is the types home now; index.ts re-exports for back-compat). */
export interface ToolResult {
  ok: boolean;
  /** Human/model-facing outcome (already JSON-ish string for chat tools). */
  output: string;
}

/** Tool-name grammar: lowercase snake_case, 2–32 chars. Enforced for BUILT-IN
 * tools (a lint-time invariant) and EXTERNAL tools (a load-time gate). */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** What a plugin's factory receives per turn. `root` is the project root;
 * `toolDeps` carries db/session/approvals/emit — optional exactly as before
 * (tests + REST paths build tools without deps). */
export interface ToolBuildContext {
  root: string;
  toolDeps?: import("./index.js").ToolDeps;
}

/** One model-facing tool. The AI SDK adapter (index.ts buildProjectTools)
 * wraps `inputSchema` in jsonSchema() and hands the set to generateText. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Raw JSON Schema object — the registry wraps it (built-ins already pass
   * jsonSchema()-wrapped schemas; both are accepted). */
  inputSchema: unknown;
  execute: (input: Record<string, unknown>, ctx: ToolBuildContext) => Promise<ToolResult> | ToolResult;
}

/** A self-contained tool group — the unit of extensibility. */
export interface PluginDefinition {
  /** Stable id, e.g. "core-filesystem". */
  id: string;
  name: string;
  version: string;
  description: string;
  /** Coarse grouping for the catalog (filesystem | search | git | terminal |
   * web | browser | memory | planning | delegation | external). */
  category: string;
  /** Build this plugin's tools for one project root + deps. May return []
   * (e.g. delegation without keyring/chat, memory when disabled upstream). */
  createTools: (ctx: ToolBuildContext) => Promise<ToolDefinition[]> | ToolDefinition[];
}

/** The fixed, in-repo core plugins — every historical tool lives in one. */
export const BUILT_IN_PLUGINS: readonly PluginDefinition[] = [
  filesystemPlugin,
  searchPlugin,
  gitPlugin,
  execPlugin,
  webPlugin,
  browserPlugin,
  memoryPlugin,
  todoPlugin,
  delegationPlugin,
  // ROUND-61 (R61): the computer-use surface is SETTINGS-GATED (default
  // OFF — createTools returns [] until the owner flips the master switch);
  // skills' read_skill is always on (observation); MCP bridges only
  // owner-configured enabled servers.
  computerUsePlugin,
  skillsPlugin,
  mcpPlugin,
];

/** Catalog row for UI/docs (metadata only — never an execute handle). */
export interface ToolCatalogEntry {
  name: string;
  category: string;
  pluginId: string;
  pluginVersion: string;
  description: string;
}

/** Built-in catalog (static — the seed of the UI's tool list). Computed by
 * DECLARING the tools (createTools with a dummy ctx — declarations are pure;
 * execute is never called) so the catalog can never drift from the real
 * registrations (the R44 TOOL_CATALOG drift lesson, structuralized). The
 * delegation plugin gates on keyring/chat presence, so the ctx carries
 * inert stubs — DECLARATION-only, never invoked (documented + tested). */
export async function builtInToolCatalog(): Promise<ToolCatalogEntry[]> {
  const entries: ToolCatalogEntry[] = [];
  const declarationCtx: ToolBuildContext = {
    root: "/",
    toolDeps: {
      db: null as unknown as import("better-sqlite3").Database,
      sessionId: "catalog",
      agentId: "catalog",
      keyring: new (await import("../providers/registry.js")).ProviderKeyring({}),
      chat: (async () => ({
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolCalls: [],
      })) as unknown as import("../agents/chat.js").ChatFn,
    },
  };
  for (const plugin of BUILT_IN_PLUGINS) {
    const tools = await plugin.createTools(declarationCtx);
    for (const tool of tools) {
      entries.push({
        name: tool.name,
        category: plugin.category,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        description: tool.description,
      });
    }
  }
  return entries;
}

/* ── External plugin loading ─────────────────────────────────────────────── */

export type ExternalPluginScope = "off" | "user" | "all";

/** Load-scope caps (one broken/malicious plugin must never flood a turn). */
const MAX_EXTERNAL_PLUGINS = 32;
const MAX_EXTERNAL_TOOLS = 64;

interface ExternalPluginModule {
  default?: {
    id?: unknown;
    name?: unknown;
    version?: unknown;
    description?: unknown;
    category?: unknown;
    tools?: unknown;
  };
}

/** The shape an external .mjs plugin must default-export: same metadata as
 * PluginDefinition with `tools` as a plain array of plain objects (no
 * jsonSchema wrapper — the registry wraps plain schemas itself). */
export interface ExternalPluginInput {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  tools: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  }>;
}

function pluginDirs(root: string, scope: ExternalPluginScope): string[] {
  const dirs: string[] = [];
  if (scope === "off") return dirs;
  // Explicit override (env var — deployments/tests point the loader at an
  // arbitrary dir without touching ~).
  const override = process.env.ACUTE_EXTERNAL_PLUGIN_DIR;
  if (override !== undefined && override !== "") {
    dirs.push(override);
    return dirs;
  }
  // User scope: the owner's own machine-wide plugin folder — trusted like
  // ~/.vscode/extensions (they put the files there themselves).
  dirs.push(join(homedir(), ".acute", "plugins"));
  // Project scope: opt-in ONLY (a cloned repo planting .acute/plugins/*.mjs
  // must never earn code execution on open).
  if (scope === "all") dirs.push(join(root, ".acute", "plugins"));
  return dirs;
}

/** Normalize + validate one external module into plugin definitions.
 * Returns [] (with a log line) on any invalid shape — fail-soft. */
function coerceExternalPlugin(
  mod: ExternalPluginModule,
  file: string,
  into: PluginDefinition[],
): void {
  const raw = mod.default;
  if (typeof raw !== "object" || raw === null) {
    log("warn", "plugin.invalid", { file, reason: "no default export object" });
    return;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const version = typeof raw.version === "string" ? raw.version : "0.0.0";
  const description = typeof raw.description === "string" ? raw.description : "";
  const category = typeof raw.category === "string" ? raw.category : "external";
  const tools = raw.tools;
  if (!TOOL_NAME_RE.test(id.replaceAll("-", "_")) || id === "" || name === "") {
    log("warn", "plugin.invalid", { file, reason: `bad id/name ('${id}'/'${name}')` });
    return;
  }
  if (!Array.isArray(tools)) {
    log("warn", "plugin.invalid", { file, reason: "tools is not an array" });
    return;
  }
  const definitions: ToolDefinition[] = [];
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue;
    const tool = t as Record<string, unknown>;
    const toolName = typeof tool.name === "string" ? tool.name : "";
    const toolDescription = typeof tool.description === "string" ? tool.description : "";
    const schema = tool.schema ?? tool.inputSchema;
    const execute = tool.execute;
    if (!TOOL_NAME_RE.test(toolName)) {
      log("warn", "plugin.tool.rejected", { file, tool: toolName, reason: "name must match ^[a-z][a-z0-9_]{1,31}$" });
      continue;
    }
    if (toolDescription === "" || typeof schema !== "object" || schema === null || typeof execute !== "function") {
      log("warn", "plugin.tool.rejected", { file, tool: toolName, reason: "missing description/schema/execute" });
      continue;
    }
    definitions.push({
      name: toolName,
      description: toolDescription,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      execute: async (input) => execute(input),
    });
  }
  if (definitions.length === 0) {
    log("warn", "plugin.invalid", { file, reason: "no valid tools" });
    return;
  }
  into.push({
    id: `ext-${id}`,
    name,
    version,
    description,
    category: category === "" ? "external" : category,
    createTools: () => definitions,
  });
}

/** Dynamic import of an absolute file URL across EVERY runtime we ship in:
 *  - plain Node (the compiled sidecar): native `import()` — full ESM
 *    semantics, and the fast path below just works;
 *  - vitest's vite-node runner: the transformer rewrites `import(specifier)`
 *    into its OWN resolver, which can only resolve ids INSIDE the vite root —
 *    absolute /tmp or ~/.acute paths die with "Cannot find module … imported
 *    from registry.ts" (and `new Function("return import()")` dies harder:
 *    "A dynamic import callback was not specified" — no import callback exists
 *    in the runner's CJS context). Escape hatch: Node ≥22.12 `require(esm)`
 *    via createRequire (CI is pinned to Node 24, the bundled sidecar Node is
 *    24.20 — both have it unflagged; probe-verified under vitest 3.2). The
 *    require() fallback returns the SAME namespace shape as import(), so the
 *    coercion code is unaware of which path ran. The `/* @vite-ignore *\/`
 *    comment keeps the specifier out of static analysis on the fast path. */
async function runtimeImport(specifier: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (importError) {
    try {
      // require() takes a PATH, never a file:// href (probe-verified:
      // "Cannot find module 'file:///…'").
      const req = createRequire(specifier);
      return req(fileURLToPath(specifier));
    } catch {
      throw importError;
    }
  }
}

/** Load external plugins for one project root under the given scope.
 * Cached per (scope, dir list) for the process lifetime — plugin files are
 * read at first use per root, mirroring how terminal sessions resolve. */
const externalCache = new Map<string, PluginDefinition[]>();

export async function loadExternalPlugins(
  root: string,
  scope: ExternalPluginScope,
  /** TEST seam — explicit dirs (the real ~/.acute is not something a test
   * suite should write into). Production callers omit it. */
  dirsOverride?: string[],
): Promise<PluginDefinition[]> {
  const dirs = dirsOverride ?? pluginDirs(root, scope);
  const cacheKey = `${scope}::${dirs.join("|")}`;
  const cached = externalCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const loaded: PluginDefinition[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
    } catch {
      continue; // no plugin dir — the common case
    }
    for (const file of files) {
      if (loaded.length >= MAX_EXTERNAL_PLUGINS) {
        log("warn", "plugin.cap", { dir, reason: `> ${MAX_EXTERNAL_PLUGINS} plugins` });
        break;
      }
      const full = join(dir, file);
      try {
        const mod = (await runtimeImport(pathToFileURL(full).href)) as ExternalPluginModule;
        const before = loaded.length;
        coerceExternalPlugin(mod, full, loaded);
        if (loaded.length > before) {
          log("info", "plugin.loaded", { file: full });
        }
      } catch (error) {
        log("warn", "plugin.load_failed", {
          file: full,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // Cap total external TOOLS across plugins (keep whole plugins, drop the tail).
  let toolCount = 0;
  const capped: PluginDefinition[] = [];
  for (const plugin of loaded) {
    const count = (await plugin.createTools({ root })).length;
    if (toolCount + count > MAX_EXTERNAL_TOOLS) {
      log("warn", "plugin.cap", { plugin: plugin.id, reason: `> ${MAX_EXTERNAL_TOOLS} external tools total` });
      continue;
    }
    toolCount += count;
    capped.push(plugin);
  }
  externalCache.set(cacheKey, capped);
  return capped;
}

/** Test helper: drop the external-plugin cache (between test cases). */
export function clearExternalPluginCacheForTest(): void {
  externalCache.clear();
}

/**
 * ROUND-61 (R61): the external-plugin FILE report for the Extensions tab —
 * which .mjs files exist in the user dir (always) and the project dir (when
 * a root is given), each with a loaded:true/false bit (loaded = the load
 * cache holds plugins for that scope; load ERRORS are in the sidecar log —
 * the honest caveat the tab renders). Pure fs scan + the cached count; no
 * double-import.
 */
export function externalPluginFileReport(root?: string): {
  files: Array<{ file: string; scope: "user" | "project"; loaded: boolean }>;
  loadedCount: number;
  note: string;
} {
  const files: Array<{ file: string; scope: "user" | "project"; loaded: boolean }> = [];
  const dirs: Array<[string, "user" | "project"]> = [
    [join(homedir(), ".acute", "plugins"), "user"],
  ];
  if (root !== undefined && root !== "") {
    dirs.push([join(root, ".acute", "plugins"), "project"]);
  }
  let loadedCount = 0;
  for (const [dir, scope] of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
    } catch {
      continue; // no dir — the common case
    }
    const cached = externalCache.get(`${scope}::${dir}`);
    if (cached !== undefined) loadedCount += cached.length;
    for (const file of names) {
      files.push({ file: join(dir, file), scope, loaded: cached !== undefined && cached.length > 0 });
    }
  }
  return {
    files,
    loadedCount,
    note: "load errors (name collisions, schema violations) are in the sidecar log — one broken plugin never blocks the rest",
  };
}

/** Read the external-plugins scope from settings (storage/settings.ts keeps
 * the typed accessor; this is the raw read so the tools layer doesn't depend
 * on the storage module's db type). Default: "user". */
export function readExternalPluginScope(db: unknown): ExternalPluginScope {
  try {
    const row = (
      db as { prepare: (sql: string) => { get: (key: string) => { value: string } | undefined } }
    )
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tools.externalPlugins");
    const value = row?.value;
    return value === "off" || value === "all" || value === "user" ? value : "user";
  } catch {
    return "user";
  }
}
