/**
 * ROUND-61 (R61): the MCP BRIDGE plugin — tools from user-configured stdio
 * MCP servers, surfaced as mcp__<server>__<tool> (the wide-spread MCP
 * naming convention; the server NAME is a ≤32-char slug so the combined
 * id fits the registry's 32-char tool-name grammar — longer names are
 * skipped with a logged diagnostic, never silently truncated).
 *
 * The server list is read from mcp_servers (owner-configured via Settings
 * → Extensions; NEVER model-writable). Disabled servers contribute no
 * tools. A server that fails to spawn/initialize contributes no tools
 * (fail-soft, logged) — one broken extension never breaks a turn.
 *
 * Tool execution rides mcp/manager.ts (spawn + JSON-RPC + timeouts +
 * sanitized env — no ACUTE_PROVIDER_* keys ever reach a child).
 */
import { jsonSchema } from "ai";
import { listMcpServers } from "../../storage/mcp.js";
import { callServerTool, listServerTools } from "../../mcp/manager.js";
import { log } from "../../lib/log.js";
import { TOOL_NAME_RE } from "../registry.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const mcpPlugin: PluginDefinition = {
  id: "core-mcp",
  name: "MCP Servers",
  version: "1.0.0",
  description:
    "Bridges user-configured stdio MCP servers' tools into the toolset as mcp__<server>__<tool>.",
  category: "external",
  createTools: async (ctx): Promise<ToolDefinition[]> => {
    const toolDeps = ctx.toolDeps;
    // Declaration contexts (db:null) can't list servers — no tools.
    if (toolDeps === undefined || toolDeps.db === null || toolDeps.db === undefined) return [];
    const servers = listMcpServers(toolDeps.db).filter((s) => s.enabled);
    const tools: ToolDefinition[] = [];
    for (const server of servers) {
      const listed = await listServerTools(server);
      if (!listed.ok) {
        log("warn", "mcp.bridge.unavailable", { server: server.name, error: listed.error });
        continue;
      }
      for (const info of listed.tools) {
        const name = `mcp__${server.name}__${info.name}`;
        if (!TOOL_NAME_RE.test(name)) {
          log("warn", "mcp.bridge.name_too_long", { server: server.name, tool: info.name });
          continue;
        }
        const description =
          info.description !== ""
            ? `MCP tool '${info.name}' from server '${server.name}': ${info.description}`.slice(0, 2000)
            : `MCP tool '${info.name}' from server '${server.name}'.`;
        tools.push({
          name,
          description,
          inputSchema: jsonSchema(info.inputSchema as never),
          execute: async (input): Promise<{ ok: boolean; output: string }> => {
            // Re-read the row at call time (the config may have changed
            // since createTools — disable/delete between turns).
            const current = listMcpServers(toolDeps.db).find((s) => s.id === server.id && s.enabled);
            if (current === undefined) {
              return { ok: false, output: `the MCP server '${server.name}' is no longer configured or enabled` };
            }
            const outcome = await callServerTool(current, info.name, input as Record<string, unknown>);
            return outcome.ok
              ? { ok: true, output: outcome.output }
              : { ok: false, output: `mcp__${server.name}__${info.name} failed: ${outcome.error}\n${outcome.output}`.slice(0, 16000) };
          },
        });
      }
    }
    return tools;
  },
};
