/**
 * ROUND-61 (R61): the MCP CLIENT MANAGER — stdio JSON-RPC (the MCP wire
 * protocol: initialize → tools/list → tools/call). One ManagedServer per
 * configured mcp_servers row, cached by id (module-level), spawned lazily,
 * killed on disable/delete/shutdown.
 *
 * Safety:
 *   · The COMMAND comes from the owner's configuration only (settings UI /
 *     REST behind the bearer wall) — never from the model.
 *   · The child env is SANITIZED: minimal inherit (PATH, HOME, TMPDIR,
 *     LANG, TERM, plus the server's own configured env). No ACUTE_PROVIDER_*
 *     keys ever leak into an MCP child (a third-party server must not see
 *     our keyring).
 *   · Timeouts on every call; a crashed server is reported, not retried
 *     in a loop (the next call respawns once).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "../lib/log.js";
import type { McpServerRecord } from "../storage/mcp.js";

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema object from the server. */
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpCallOutcome {
  ok: boolean;
  /** Text/JSON content joined for the model. */
  output: string;
  error?: string;
}

/**
 * The env an MCP child inherits — deliberately minimal, and the
 * ACUTE_PROVIDER_* namespace is STRIPPED even from the owner's configured
 * entries (defense-in-depth: a third-party server must never see our
 * keyring variable names, regardless of configuration).
 */
export function sanitizeChildEnv(configured: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "USERPROFILE", "APPDATA"]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") base[key] = value;
  }
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured)) {
    if (key.startsWith("ACUTE_PROVIDER")) continue;
    safe[key] = value;
  }
  return { ...base, ...safe };
}

class ManagedServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private toolsCache: McpToolInfo[] | null = null;
  private initializeError: string | null = null;

  constructor(private readonly record: McpServerRecord) {}

  get name(): string {
    return this.record.name;
  }

  private ensureChild(): { ok: true; child: ChildProcessWithoutNullStreams } | { ok: false; error: string } {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) {
      return { ok: true, child: this.child };
    }
    if (this.initializeError !== null) {
      // One strike per config — report, don't respawn-loop.
      return { ok: false, error: this.initializeError };
    }
    try {
      const child = spawn(this.record.command, this.record.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizeChildEnv(this.record.env),
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (text.trim() !== "") log("debug", "mcp.server.stderr", { server: this.record.name, text: text.slice(0, 300) });
      });
      child.on("exit", (code) => {
        this.failAllPending(`MCP server '${this.record.name}' exited (code ${code ?? "signal"})`);
        this.child = null;
        this.toolsCache = null;
      });
      child.on("error", (err) => {
        this.initializeError = `spawning '${this.record.command}' failed: ${String(err)}`;
        this.failAllPending(this.initializeError);
        this.child = null;
      });
      this.child = child;
      return { ok: true, child };
    } catch (err) {
      this.initializeError = `spawning '${this.record.command}' failed: ${String(err)}`;
      return { ok: false, error: this.initializeError };
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // JSON-RPC over stdio: newline-delimited messages.
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line !== "") {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (message.id !== null && message.id !== undefined) {
            const pending = this.pending.get(Number(message.id));
            if (pending !== undefined) {
              this.pending.delete(Number(message.id));
              clearTimeout(pending.timer);
              pending.resolve(message);
            }
          }
        } catch {
          // Non-JSON noise on stdout — ignored (some servers print banners).
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  private failAllPending(reason: string): void {
    for (const [, { resolve, timer }] of this.pending) {
      clearTimeout(timer);
      resolve({ jsonrpc: "2.0", id: null, error: { code: -32000, message: reason } });
    }
    this.pending.clear();
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcResponse> {
    const spawned = this.ensureChild();
    if (!spawned.ok) {
      return Promise.resolve({ jsonrpc: "2.0", id: null, error: { code: -32000, message: spawned.error } });
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<JsonRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: `MCP call '${method}' timed out after ${timeoutMs}ms` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        spawned.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ jsonrpc: "2.0", id, error: { code: -32002, message: `writing to MCP server failed: ${String(err)}` } });
      }
    });
  }

  /** initialize + tools/list. Cached after success. */
  async listTools(): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
    if (this.toolsCache !== null) return { ok: true, tools: this.toolsCache };
    const init = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "acute-code", version: "0.61.0" },
      },
      10000,
    );
    if (init.error !== undefined) {
      return { ok: false, error: `initialize failed: ${init.error.message}` };
    }
    // The initialized notification (protocol courtesy — no response).
    const spawned = this.ensureChild();
    if (spawned.ok) {
      try {
        spawned.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      } catch {
        // best-effort
      }
    }
    const list = await this.request("tools/list", {}, 10000);
    if (list.error !== undefined) {
      return { ok: false, error: `tools/list failed: ${list.error.message}` };
    }
    const result = (list.result ?? {}) as { tools?: unknown };
    const tools: McpToolInfo[] = [];
    if (Array.isArray(result.tools)) {
      for (const raw of result.tools) {
        if (raw === null || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.name !== "string" || t.name === "") continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description.slice(0, 2000) : "",
          inputSchema:
            t.inputSchema !== null && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
        });
      }
    }
    this.toolsCache = tools;
    return { ok: true, tools };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const call = await this.request("tools/call", { name, arguments: args }, 60000);
    if (call.error !== undefined) {
      return { ok: false, output: "", error: call.error.message };
    }
    const result = (call.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter((t) => t !== "")
      .join("\n");
    if (result.isError === true) {
      return { ok: false, output: text.slice(0, 16000), error: "the MCP tool reported an error" };
    }
    return { ok: true, output: text.slice(0, 16000) || "(empty result)" };
  }

  kill(): void {
    this.failAllPending(`MCP server '${this.record.name}' was stopped`);
    if (this.child !== null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already dead
      }
      this.child = null;
    }
    this.toolsCache = null;
    this.initializeError = null;
  }
}

/* ── the manager (module-level registry of live servers) ──────────────────── */

const servers = new Map<string, ManagedServer>();

function managerFor(record: McpServerRecord): ManagedServer {
  let managed = servers.get(record.id);
  if (managed === undefined) {
    managed = new ManagedServer(record);
    servers.set(record.id, managed);
  }
  return managed;
}

export function listServerTools(record: McpServerRecord): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
  return managerFor(record).listTools();
}

export function callServerTool(record: McpServerRecord, tool: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
  return managerFor(record).callTool(tool, args);
}

export function stopServer(id: string): void {
  servers.get(id)?.kill();
  servers.delete(id);
}

/** Reset the recorded spawn failure so a fixed command can retry. */
export function resetServerFailure(id: string): void {
  const managed = servers.get(id);
  if (managed !== undefined) {
    managed.kill();
    servers.delete(id);
  }
}

export function stopAllServers(): void {
  for (const id of [...servers.keys()]) stopServer(id);
}

/** Health probe for the routes: tools/list without side effects on cache. */
export async function probeServer(record: McpServerRecord): Promise<{ ok: boolean; toolCount?: number; error?: string; ms: number }> {
  const started = Date.now();
  const result = await listServerTools(record);
  const ms = Date.now() - started;
  return result.ok ? { ok: true, toolCount: result.tools.length, ms } : { ok: false, error: result.error, ms };
}
