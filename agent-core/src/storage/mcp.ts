/**
 * ROUND-61 (R61): MCP-server storage — the owner's directive: "the ability
 * to add MCP servers too". Rows are OWNER-CONFIGURED ONLY (the settings UI
 * + REST behind the bearer wall); the model can never write here — the
 * plugin bridge only READS. Commands run as child processes by
 * mcp/manager.ts with a sanitized env.
 */
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db.js";

export interface McpServerRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  env_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: McpServerRow): McpServerRecord {
  let args: string[] = [];
  let env: Record<string, string> = {};
  try {
    const parsedArgs = JSON.parse(row.args_json);
    if (Array.isArray(parsedArgs)) args = parsedArgs.filter((a) => typeof a === "string");
  } catch {
    // corrupt row → empty args (honest fail-soft)
  }
  try {
    const parsedEnv: unknown = JSON.parse(row.env_json);
    if (parsedEnv !== null && typeof parsedEnv === "object" && !Array.isArray(parsedEnv)) {
      const entries = Object.entries(parsedEnv as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      env = Object.fromEntries(entries);
    }
  } catch {
    // corrupt row → empty env
  }
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args,
    env,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMcpServers(db: SqliteDatabase): McpServerRecord[] {
  return (db.prepare("SELECT * FROM mcp_servers ORDER BY created_at ASC, name ASC").all() as McpServerRow[]).map(toRecord);
}

export function getMcpServer(db: SqliteDatabase, id: string): McpServerRecord | undefined {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;
  return row ? toRecord(row) : undefined;
}

export interface McpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function createMcpServer(db: SqliteDatabase, input: McpServerInput): McpServerRecord {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error("server name must be a lowercase slug (letters, digits, dashes; 2-32 chars — it appears in tool names)");
  }
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error("command must be a non-empty string (the executable to spawn)");
  }
  if (input.command.length > 500) {
    throw new Error("command must be at most 500 chars");
  }
  const existing = db.prepare("SELECT id FROM mcp_servers WHERE name = ?").get(name);
  if (existing !== undefined) {
    throw new Error(`an MCP server named '${name}' already exists`);
  }
  const args = (input.args ?? []).filter((a) => typeof a === "string" && a.length <= 2000);
  const env = Object.fromEntries(
    Object.entries(input.env ?? {}).filter(([k, v]) => typeof k === "string" && typeof v === "string" && k.length <= 128 && v.length <= 2000),
  );
  const id = `mcp_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, input.command.trim(), JSON.stringify(args), JSON.stringify(env), input.enabled === false ? 0 : 1, now, now);
  return getMcpServer(db, id) as McpServerRecord;
}

export interface McpServerPatch {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export function updateMcpServer(
  db: SqliteDatabase,
  id: string,
  patch: McpServerPatch,
): McpServerRecord | undefined {
  const existing = getMcpServer(db, id);
  if (existing === undefined) return undefined;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!NAME_RE.test(name)) {
      throw new Error("server name must be a lowercase slug (letters, digits, dashes; 2-32 chars)");
    }
    const clash = db.prepare("SELECT id FROM mcp_servers WHERE name = ? AND id != ?").get(name, id);
    if (clash !== undefined) {
      throw new Error(`an MCP server named '${name}' already exists`);
    }
  }
  const command = patch.command?.trim() ?? existing.command;
  if (command === "") throw new Error("command must be non-empty");
  const args = patch.args ?? existing.args;
  const env = patch.env ?? existing.env;
  db.prepare(
    `UPDATE mcp_servers SET name = ?, command = ?, args_json = ?, env_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.name?.trim() ?? existing.name,
    command,
    JSON.stringify(args),
    JSON.stringify(env),
    (patch.enabled ?? existing.enabled) ? 1 : 0,
    new Date().toISOString(),
    id,
  );
  return getMcpServer(db, id);
}

export function deleteMcpServer(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return result.changes > 0;
}
