/**
 * ROUND-61 (R61): SKILLS storage + the read_skill tool + MCP storage +
 * the MCP manager (with a REAL fake JSON-RPC child process — node stdin/
 * stdout speaking the MCP wire protocol).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  COMPUTER_USE_SKILL_ID,
  createSkill,
  deleteSkill,
  getSkill,
  listEnabledSkills,
  listSkills,
  seedBuiltinSkills,
  updateSkill,
} from "../src/storage/skills";
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, updateMcpServer } from "../src/storage/mcp";
import { callServerTool, listServerTools, probeServer, resetServerFailure, sanitizeChildEnv, stopServer } from "../src/mcp/manager";
import { resetComputerSessionForTests } from "../src/computer/session";

let db: SqliteDatabase;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-skills-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  resetComputerSessionForTests();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/* ── skills storage ─────────────────────────────────────────────────────────── */

describe("ROUND-61 (R61): skills storage", () => {
  it("the built-in computer-use skill is seeded once per open (INSERT OR IGNORE — edits persist)", () => {
    const skills = listSkills(db);
    const cu = skills.find((s) => s.id === COMPUTER_USE_SKILL_ID);
    expect(cu).toBeDefined();
    expect(cu?.name).toBe("computer-use");
    expect(cu?.source).toBe("builtin");
    expect(cu?.enabled).toBe(true);
    expect(cu?.body).toContain("Core loop");
    // User EDIT persists across reseeds:
    updateSkill(db, COMPUTER_USE_SKILL_ID, { body: "MY EDITED BODY" });
    seedBuiltinSkills(db);
    expect(getSkill(db, COMPUTER_USE_SKILL_ID)?.body).toBe("MY EDITED BODY");
  });

  it("createSkill validates the slug + rejects duplicates; full CRUD works", () => {
    expect(() => createSkill(db, { name: "Bad Name" })).toThrow(/slug/i);
    expect(() => createSkill(db, { name: "x" })).toThrow(/slug/i);
    const created = createSkill(db, { name: "my-review-flow", description: "how I review", body: "# Review flow" });
    expect(created.source).toBe("user");
    expect(created.enabled).toBe(true);
    expect(() => createSkill(db, { name: "my-review-flow" })).toThrow(/already exists/);
    const updated = updateSkill(db, created.id, { enabled: false, description: "updated" });
    expect(updated?.enabled).toBe(false);
    expect(updated?.description).toBe("updated");
    // Enabled filter drives the prompt listing + read_skill.
    expect(listEnabledSkills(db).map((s) => s.name)).not.toContain("my-review-flow");
    const del = deleteSkill(db, created.id);
    expect(del.ok).toBe(true);
    expect(getSkill(db, created.id)).toBeUndefined();
  });

  it("built-ins refuse deletion (disable instead) — 409-shaped contract", () => {
    const result = deleteSkill(db, COMPUTER_USE_SKILL_ID);
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/disable/i);
    expect(getSkill(db, COMPUTER_USE_SKILL_ID)).toBeDefined();
  });
});

/* ── MCP storage ───────────────────────────────────────────────────────────── */

describe("ROUND-61 (R61): MCP server storage", () => {
  it("create/list/update/delete with slug validation + JSON arg/env round-trip", () => {
    const server = createMcpServer(db, {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { NODE_ENV: "production" },
    });
    expect(server.enabled).toBe(true);
    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(server.env).toEqual({ NODE_ENV: "production" });

    expect(() => createMcpServer(db, { name: "Bad Name", command: "x" })).toThrow(/slug/i);
    createMcpServer(db, { name: "dup", command: "x" });
    expect(() => createMcpServer(db, { name: "dup", command: "x" })).toThrow(/already exists/);
    // Clean up the dup so the final length assertion sees only our server.
    const dupRow = listMcpServers(db).find((srv) => srv.name === "dup");
    if (dupRow !== undefined) deleteMcpServer(db, dupRow.id);

    const updated = updateMcpServer(db, server.id, { enabled: false, env: { A: "b" } });
    expect(updated?.enabled).toBe(false);
    expect(updated?.env).toEqual({ A: "b" });

    expect(deleteMcpServer(db, server.id)).toBe(true);
    expect(listMcpServers(db)).toHaveLength(0);
  });

  it("corrupt JSON rows degrade to empty args/env (fail-soft read)", () => {
    const server = createMcpServer(db, { name: "corrupt", command: "x", args: ["ok"] });
    db.prepare("UPDATE mcp_servers SET args_json = ?, env_json = ? WHERE id = ?").run("{not json", "{also bad", server.id);
    const reread = getMcpServer(db, server.id);
    expect(reread?.args).toEqual([]);
    expect(reread?.env).toEqual({});
  });
});

/* ── the MCP manager (real child process speaking JSON-RPC) ────────────────── */

/** A minimal MCP server in node: initialize → tools/list → tools/call. */
const FAKE_SERVER_SRC = `
const lines = [];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) lines.push(JSON.parse(line));
    idx = buf.indexOf("\\n");
  }
  process.stdin.on("end", respond);
  respond();
});
function respond() {
  for (const msg of lines.splice(0)) {
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
      ] } });
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "fail") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + msg.params.arguments.text }] } });
      }
    }
  }
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
`;

describe("ROUND-61 (R61): the MCP manager (stdio JSON-RPC)", () => {
  const serverScript = join(tmpdir(), `fake-mcp-${randomUUID()}.cjs`);
  const writeScript = () => {
    writeFileSync(serverScript, FAKE_SERVER_SRC, "utf8");
  };

  it("sanitizeChildEnv: minimal inherit + configured — NO ACUTE_PROVIDER_* leaks", () => {
    const env = sanitizeChildEnv({ MY_VAR: "x", ACUTE_PROVIDER_OPENROUTER: "leak-me" });
    expect(env["MY_VAR"]).toBe("x");
    expect(Object.keys(env).some((k) => k.startsWith("ACUTE_PROVIDER"))).toBe(false);
    // PATH survives (the child needs it) when present.
    if (process.env["PATH"] !== undefined) expect(env["PATH"]).toBe(process.env["PATH"]);
  });

  it("initialize + tools/list + tools/call round-trip against a live child", async () => {
    writeScript();
    const record = {
      id: "mcp_test_1",
      name: "fake",
      command: process.execPath,
      args: [serverScript],
      env: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    resetServerFailure(record.id);
    const listed = await listServerTools(record);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.tools.map((t) => t.name)).toEqual(["echo", "fail"]);
      expect(listed.tools[0]?.description).toBe("Echo text back");
    }
    const called = await callServerTool(record, "echo", { text: "hello" });
    expect(called.ok).toBe(true);
    expect(called.output).toBe("echo:hello");
    const failed = await callServerTool(record, "fail", {});
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("boom");
    stopServer(record.id);
  });

  it("a missing executable reports ok:false (never throws, never loops)", async () => {
    const record = {
      id: "mcp_test_2",
      name: "ghost",
      command: "/nonexistent/definitely-not-here",
      args: [],
      env: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const listed = await listServerTools(record);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error).toMatch(/spawning/i);
    stopServer(record.id);
  });

  it("probeServer reports ok + toolCount + ms for a live child", async () => {
    writeScript();
    const record = {
      id: "mcp_test_3",
      name: "probe",
      command: process.execPath,
      args: [serverScript],
      env: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    resetServerFailure(record.id);
    const probe = await probeServer(record);
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.toolCount).toBe(2);
    expect(probe.ms).toBeGreaterThanOrEqual(0);
    stopServer(record.id);
  });

  it("spawn survives a bogus-first-line banner (non-JSON stdout noise ignored)", async () => {
    const script = join(tmpdir(), `fake-mcp-noisy-${randomUUID()}.cjs`);
    writeFileSync(script, `${FAKE_SERVER_SRC}\nprocess.stdout.write("BANNER LINE\\n");\n`, "utf8");
    const record = {
      id: "mcp_test_4",
      name: "noisy",
      command: process.execPath,
      args: [script],
      env: {},
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    resetServerFailure(record.id);
    const listed = await listServerTools(record);
    expect(listed.ok).toBe(true);
    stopServer(record.id);
  });
});

void spawn;
