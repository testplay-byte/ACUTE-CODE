/**
 * Agentic project tools — ROUND-52 (R52-f) REFACTOR: THE PLUGIN REGISTRY.
 *
 * This module used to hold EVERY tool definition inline (1000+ lines). Since
 * the owner's round-52 directive ("a plug-in-based system, just like how
 * DeepSeek harness is… it would allow us to add way too many tools just how
 * we want them"), each tool group is a self-contained PLUGIN module in
 * tools/plugins/*.ts, registered in tools/registry.ts (which also loads
 * optional external .mjs plugins — see registry.ts and ADR-0025).
 *
 * This file is now the ASSEMBLER + the stable public surface:
 *   - buildProjectTools(root, allowedTools?, deps?) — identical semantics to
 *     the pre-R52 function: ADR-0019 allowlist ([]/undefined = ALL), the
 *     memory master switch, delegation gating (keyring/chat presence),
 *     built-ins first with external plugins appended (name collisions favor
 *     the built-in), every tool wrapped for the AI SDK (jsonSchema input).
 *   - ToolDeps / NO_TOOLS — unchanged shapes (runtime.ts + tests import them).
 *   - Re-exports of the pure fs/search helpers (fs-ops.ts) + ToolResult
 *     (registry.ts) for every pre-R52 import site (server.ts, tests).
 *
 * Original round-1..51 doc note (kept for history): every tool is
 * PATH-CONTAINMENT SANDBOXED to the project root; shell execution and web
 * access pass through the approvals engine (approvals.ts).
 */
import type { ToolSet } from "ai";
import type { PermissionMode } from "shared";
import {
  BUILT_IN_PLUGINS,
  loadExternalPlugins,
  readExternalPluginScope,
  type ToolBuildContext,
  type ToolDefinition,
} from "./registry.js";

// ── Back-compat surface (server.ts + the test suites import these) ─────────
export {
  projectTree,
  listDir,
  readFile,
  writeFile,
  editFile,
  createDir,
  deleteFile,
  searchFiles,
  searchCode,
  resolveInsideRoot,
  type TreeNode,
  type SearchCodeOptions,
} from "./fs-ops.js";
export type { ToolResult, ToolDefinition, PluginDefinition, ToolCatalogEntry } from "./registry.js";
export { builtInToolCatalog, BUILT_IN_PLUGINS } from "./registry.js";
export { buildApprovalDeps } from "./approval-deps.js";

export interface ToolDeps {
  db: import("better-sqlite3").Database;
  sessionId: string;
  agentId: string;
  seq?: number;
  /** Round-28 WS-G: the project id (for codebase_index + searchIndexSymbols).
   * Optional for back-compat (older call sites that don't pass it). */
  projectId?: string;
  /** ROUND-36 (ADR-0022): forward live sub-agent status events onto the
   * parent's stream (streamed turns pass their SSE emitter). Optional. */
  emit?: (event: unknown) => void;
  /** ROUND-36: the keyring — the delegate tool builds child runs with it. */
  keyring?: import("../providers/registry.js").ProviderKeyring;
  /** ROUND-36: the chat fn for child turns (injected to avoid cycles). */
  chat?: import("../agents/chat.js").ChatFn;
  /** ROUND-50 (R50-b, owner: sub-agent panels must stream the raw live
   * response "just like the main agent"): the STREAMING adapter, forwarded by
   * prepareTurn when the parent turn runs the streamed path. Present → the
   * delegate_task tool hands it to the orchestrator and children run
   * runStreamedAgentTurn (live text/thinking deltas ride the parent's SSE as
   * subagent-event envelopes). Absent → children keep the sync step-snapshot
   * path (channel-less runs: unchanged fail-fast ask semantics). */
  chatStream?: import("../agents/chat.js").StreamChatFn;
  /** ROUND-37/R48 (approvals): any turn with a live emit channel — the
   * streamed parent turn AND sub-agent children delegated from it — may
   * pause and ask the owner for permission (a child's approvals ride the
   * parent's SSE as subagent-event envelopes; the decision route wakes the
   * child's waiter). Channel-less runs (the plain sync route, retryChild)
   * still fail fast on non-auto commands (no 120s burn). */
  interactiveApprovals?: boolean;
  /** ROUND-37: the live turn's abort signal — a pending approval denies on
   * abort (the waiter races it; the SDK alone may not cancel tool promises). */
  signal?: AbortSignal;
  /** ROUND-37: persisted-event writer — approval.requested/resolved fold
   * into the session log so the exchange renders after reload. */
  appendEvent?: (event: {
    type: "approval.requested" | "approval.resolved";
    agentId: string;
    payload: Record<string, unknown>;
  }) => void;
  /** ROUND-49: the memory master switch (settings/memory). When explicitly
   * false, the memory_save/recall/list tools are NOT registered and the
   * system prompt carries no memory digest. Undefined = enabled (default),
   * so existing call sites (tests, older paths) keep the tools. */
  memoryEnabled?: boolean;
  /** ROUND-50 (R50-c1): the session's permission mode (full/ask/plan/
   * editor), forwarded by runtime.ts prepareTurn. The tool-set RESTRICTIONS
   * (plan/editor) are applied to the allowlist BEFORE buildProjectTools
   * runs; this field carries the mode to the approval gates — "full"
   * auto-approves ask-tier decisions (denylist-supreme refusals stay hard
   * in every mode, see approvals.ts). */
  permissionMode?: PermissionMode;
}

/**
 * ROUND-50 (R50-c1): sentinel allowlist meaning "register NO tools".
 * buildProjectTools treats `undefined` AND `[]` as "ALL tools" (ADR-0019 —
 * the agent-allowlist semantic), so a mode intersection that produced an
 * EMPTY list (e.g. an explicit allowlist of only run_command in editor
 * mode) cannot be expressed as `[]`. prepareTurn passes this sentinel in
 * that case; the fake name matches no registered tool, so the model gets an
 * empty toolset. (The ROUND-40 bug was the sentinel being applied to
 * []-allowlist agents by mistake — this is the deliberate, documented use.)
 */
export const NO_TOOLS: readonly string[] = ["__none__"];

/** The assembled per-turn tool shape handed to the AI SDK. */
type JsonSchemaFreeTool = {
  description: string;
  /** AI SDK v7 contract: raw JSON Schema must be wrapped in jsonSchema() so the
   * SDK gets its validation callables — a bare object fails at generateText
   * time with "schema is not a function" (found live in the M4 run). */
  inputSchema: unknown;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};

/**
 * Build the model-facing tool set for one project root: every plugin's
 * tools (built-ins first, then external plugins when enabled), filtered by
 * the agent allowlist. Semantics identical to the pre-R52 inline builder —
 * the plugins carry their own descriptions/schemas/execute bodies verbatim.
 */
export async function buildProjectTools(
  root: string,
  allowedTools?: readonly string[],
  deps?: ToolDeps,
): Promise<ToolSet> {
  const allow = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;
  const ctx: ToolBuildContext = { root, ...(deps !== undefined ? { toolDeps: deps } : {}) };

  // Built-in plugins first (registration order = catalog order).
  const definitions: ToolDefinition[] = [];
  for (const plugin of BUILT_IN_PLUGINS) {
    definitions.push(...(await plugin.createTools(ctx)));
  }

  // ROUND-52 (R52-f): external plugins — user scope by default, project
  // scope opt-in via settings (tools.externalPlugins = "user" | "all" |
  // "off"). Only when a db rides the deps (a real turn); bare/test builds
  // never load external code (back-compat + fail-closed for tests).
  if (deps !== undefined) {
    const scope = readExternalPluginScope(deps.db);
    if (scope !== "off") {
      const external = await loadExternalPlugins(root, scope);
      const builtInNames = new Set(definitions.map((d) => d.name));
      for (const plugin of external) {
        for (const tool of await plugin.createTools(ctx)) {
          // Built-ins win on collision — an external plugin can never shadow
          // a core tool (spoofing run_command, say).
          if (builtInNames.has(tool.name)) continue;
          definitions.push(tool);
        }
      }
    }
  }

  // Assemble the SDK toolset; the allowlist filter applies to built-ins AND
  // externals uniformly (ADR-0019: an agent must be granted the names; the
  // default [] agent = ALL tools, externals included).
  const tools: Record<string, JsonSchemaFreeTool> = {};
  for (const definition of definitions) {
    if (allow !== null && !allow.has(definition.name)) continue;
    tools[definition.name] = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input) => {
        const result = await definition.execute(input, ctx);
        return { ok: result.ok, output: result.output };
      },
    };
  }

  return tools as unknown as ToolSet;
}
