/**
 * ROUND-117 (R117-b) — MEMORY THAT REMEMBERS: the tests for the scope tier
 * and the live memory_policy. The round doc's §1 root causes 2/3/5 ("the
 * policy flag is dead", "workspace memory was never built", "the digest is
 * a 1,500-char slice") ship in this wave; these tests pin what shipped:
 *
 *   - migration 0042 (the table rebuild): legacy rows carry scope 'project'
 *     VERBATIM (data preserved through the 12-step rebuild), project_id is
 *     nullable, the scope CHECK, both indexes, and the session_recall
 *     allowlist curation (template/default rows carrying memory_recall only
 *     — the 0038 scope lessons, idempotent),
 *   - the WORKSPACE scope in storage: save/list/search/digest siblings, the
 *     SCOPE-keyed dedup (identical content in the two tiers is two rows),
 *     update/delete by id working across scopes,
 *   - the workspace REST family (GET/POST/PUT/DELETE /memory/workspace) with
 *     the project family's exact validation grammar + bearer wall,
 *   - the COMPOSED prompt: "## Workspace memory" renders ABOVE "## Project
 *     memory" when both tiers have rows, with honest per-tier empties,
 *   - memory_policy LIVE: 'none' drops the digest AND the whole memory tool
 *     family (through the REAL buildProjectTools), 'on-start' injects on
 *     the session's FIRST turn only (through the REAL runSingleAgentTurn),
 *     'every-turn' unchanged — plus the turn-end memory.saved counter,
 *   - session_recall: real hits over seeded sessions + events, current-
 *     session exclusion, project scoping, limit default/cap, the honest
 *     no-project refusal, query validation,
 *   - the digest budget step (1500 → 3000 past 30 rows, per scope, explicit
 *     maxChars still wins) and the honest "No memories saved yet" line as
 *     it flows through the REAL runtime.
 *
 * The harness follows memory-tools.test.ts verbatim: real temp-file
 * databases (openDatabase runs the full migration chain), the real
 * buildProjectTools → execute path, the real runSingleAgentTurn with a fake
 * ChatFn, and app.inject against the real buildServer.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { buildProjectTools } from "../src/tools/index";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import {
  MAX_MEMORY_CONTENT_CHARS,
  deleteMemory,
  digestBudget,
  listMemories,
  listWorkspaceMemories,
  memoryDigest,
  saveMemory,
  saveMemoryWithDedup,
  searchMemories,
  searchWorkspaceMemories,
  updateMemory,
  workspaceMemoryDigest,
} from "../src/storage/memory";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { runSingleAgentTurn } from "../src/agents/runtime";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { createAgent } from "../src/storage/agents";
import { setMemorySettings } from "../src/storage/settings";

// The AI SDK tool contract — narrow to what the tests call (memory-tools idiom).
type Tool = { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
function tool(set: ToolSet, name: string): Tool {
  return (set as unknown as Record<string, Tool>)[name];
}

const dir = mkdtempSync(join(tmpdir(), "acute-r117b-"));

let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const TOKEN = "test-token-r117b";

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (db !== undefined) {
    db.close();
    db = undefined as unknown as SqliteDatabase;
  }
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

beforeEach(() => {
  db = openDatabase(join(dir, `${randomUUID()}.db`));
});

/* ── Migration 0042 (the scope-tier table rebuild) ───────────────────────── */

/** Applies migrations 0001..0041 by hand — simulates a pre-R117-b install
 * (the memory-tools.test.ts openPreR44Database idiom, one version later). */
function openPreR117Database(path: string): SqliteDatabase {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 41)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(41);
  const insert = raw.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    raw.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return raw;
}

describe("migration 0042 (workspace memory scopes)", () => {
  /** The pre-R117 agents shape (the 0015-test INSERT, one era later). */
  function seedAgents(raw: SqliteDatabase): void {
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1',
           'chat-completions', 1, ?)`,
      )
      .run(now);
    const ins = raw.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'every-turn', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const memoryTools = JSON.stringify(["memory_save", "memory_recall", "memory_list"]);
    const fileTools = JSON.stringify(["read_file", "write_file", "run_command"]);
    ins.run("agt_tpl_coder", memoryTools, 1, now, now); // template + memory_recall → widened
    ins.run("agt_default_nova", memoryTools, 0, now, now); // the default agent → widened
    ins.run("agt_mine", memoryTools, 0, now, now); // user agent with memory_recall → NEVER widened
    ins.run("agt_tpl_files", fileTools, 1, now, now); // template WITHOUT memory_recall → untouched
    ins.run("agt_tpl_all", "[]", 1, now, now); // '[]' = ALL tools (ADR-0019) → untouched
    ins.run(
      "agt_tpl_ahead",
      JSON.stringify(["memory_recall", "session_recall"]),
      1,
      now,
      now,
    ); // already has it → untouched
  }

  function seedLegacyMemory(raw: SqliteDatabase): void {
    const ins = raw.prepare(
      `INSERT INTO memory (id, project_id, kind, content, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("mem_legacy_1", "prj_alpha", "decision", "use pnpm workspaces", "agent",
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    ins.run("mem_legacy_2", "prj_alpha", "fact", "sidecar port 5178", "owner",
      "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    ins.run("mem_legacy_3", "prj_beta", "note", "edited row survives the rebuild", "agent",
      "2026-03-01T00:00:00.000Z", "2026-03-05T00:00:00.000Z");
  }

  it("rebuilds the table with scope; legacy rows carry 'project' with every field preserved; project_id is nullable + the scope CHECK holds", () => {
    const path = join(dir, "m0042-scopes.db");
    const old = openPreR117Database(path);
    seedAgents(old);
    seedLegacyMemory(old);
    old.close();

    const db2 = openDatabase(path); // 0042 applies
    // The legacy rows ride over VERBATIM — plus scope 'project'.
    const rows = db2
      .prepare("SELECT * FROM memory ORDER BY id")
      .all() as Array<Record<string, string>>;
    expect(rows.map((r) => r.scope)).toEqual(["project", "project", "project"]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "mem_legacy_1",
        project_id: "prj_alpha",
        kind: "decision",
        content: "use pnpm workspaces",
        source: "agent",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "mem_legacy_2",
        project_id: "prj_alpha",
        kind: "fact",
        content: "sidecar port 5178",
        source: "owner",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: "mem_legacy_3",
        project_id: "prj_beta",
        kind: "note",
        content: "edited row survives the rebuild",
        source: "agent",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-05T00:00:00.000Z",
      }),
    ]);

    // The rebuilt shape: scope column + NULLABLE project_id (the rebuild's
    // whole point — a workspace row carries project_id NULL).
    const cols = db2.prepare("PRAGMA table_info(memory)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(cols.map((c) => c.name)).toEqual([
      "id",
      "project_id",
      "scope",
      "kind",
      "content",
      "source",
      "created_at",
      "updated_at",
    ]);
    expect(cols.find((c) => c.name === "project_id")?.notnull).toBe(0);

    // The scope CHECK (project | workspace — 'system' stays roadmap-only).
    db2
      .prepare(
        "INSERT INTO memory (id, project_id, scope, kind, content, source, created_at, updated_at) VALUES ('m_w', NULL, 'workspace', 'note', 'x', 'owner', 't', 't')",
      )
      .run();
    expect(() =>
      db2
        .prepare(
          "INSERT INTO memory (id, project_id, scope, kind, content, source, created_at, updated_at) VALUES ('m_s', NULL, 'system', 'note', 'x', 'owner', 't', 't')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    // Both covering indexes exist (the project composite + the partial
    // workspace index).
    const indexes = (db2.prepare("PRAGMA index_list(memory)").all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain("idx_memory_project_updated");
    expect(indexes).toContain("idx_memory_workspace_updated");

    // Audit row + migration bookkeeping.
    const audit = db2
      .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0042' LIMIT 1")
      .get() as { actor: string; action: string };
    expect(audit).toEqual({ actor: "migration-0042", action: "memory.scopes.create" });
    expect(db2.prepare("SELECT version FROM schema_migrations WHERE version = 42").get()).toBeDefined();

    // Idempotent on reopen — the workspace row survives, no double curation.
    db2.close();
    const again = openDatabase(path);
    expect(
      (again.prepare("SELECT COUNT(*) AS n FROM memory WHERE scope = 'workspace'").get() as { n: number }).n,
    ).toBe(1);
    const allow = (id: string) =>
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string })
          .allowed_tools,
      ) as string[];
    expect(allow("agt_tpl_coder").filter((t) => t === "session_recall")).toHaveLength(1);
    again.close();
  });

  it("curates session_recall into template/default rows that carry memory_recall — user agents, memory-less rows, '[]', and already-widened rows untouched", () => {
    const path = join(dir, "m0042-curation.db");
    const old = openPreR117Database(path);
    seedAgents(old);
    old.close();

    const db2 = openDatabase(path); // 0042 applies
    const row = (id: string) =>
      JSON.parse(
        (db2.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string })
          .allowed_tools,
      ) as string[];
    // Template + default rows carrying memory_recall get the episodic sibling.
    expect(row("agt_tpl_coder")).toContain("session_recall");
    expect(row("agt_default_nova")).toContain("session_recall");
    // User-authored agents are NEVER widened (the 0038 curation respect).
    expect(row("agt_mine")).toEqual(["memory_save", "memory_recall", "memory_list"]);
    // A row whose list lacks memory_recall has no memory baseline → nothing.
    expect(row("agt_tpl_files")).toEqual(["read_file", "write_file", "run_command"]);
    // '[]' means ALL tools (ADR-0019) — the migration's length guard skips it.
    expect(row("agt_tpl_all")).toEqual([]);
    // Already carrying session_recall → untouched (idempotence within one run).
    expect(row("agt_tpl_ahead")).toEqual(["memory_recall", "session_recall"]);
    db2.close();
  });
});

/* ── The workspace scope in storage ─────────────────────────────────────── */

describe("workspace memory storage (R117-b)", () => {
  it("saves workspace rows (projectId NULL, scope 'workspace'), ignores a stray projectId, and keeps the project spellings' contract", () => {
    const saved = saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "  the owner prefers terse replies  ",
    });
    expect(saved.deduplicated).toBe(false);
    expect(saved.item).toMatchObject({
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "the owner prefers terse replies",
      source: "agent",
    });
    expect(saved.item.id).toMatch(/^mem_/);

    // A stray projectId on a workspace save is IGNORED (the scope owns the
    // truth — the row still lands project_id NULL).
    const stray = saveMemoryWithDedup(db, {
      projectId: "prj_someone",
      scope: "workspace",
      content: "the owner's machine is called acutebox",
    });
    expect(stray.item.projectId).toBeNull();
    expect(stray.item.scope).toBe("workspace");

    // The PROJECT spelling is unchanged: projectId still required.
    expect(() =>
      saveMemoryWithDedup(db, { projectId: null, content: "orphan" }),
    ).toThrow(/non-empty projectId/);
    const project = saveMemoryWithDedup(db, { projectId: "prj_a", content: "project fact" });
    expect(project.item.scope).toBe("project"); // the pre-R117 default
    expect(project.item.projectId).toBe("prj_a");
  });

  it("lists/searches/digests the two tiers in isolation (no cross-talk)", () => {
    saveMemory(db, { projectId: "prj_p", kind: "fact", content: "the sidecar port is 5178" });
    saveMemoryWithDedup(db, { projectId: null, scope: "workspace", kind: "preference", content: "the owner prefers pnpm" });

    // Listing: each tier sees only its own rows.
    expect(listMemories(db, "prj_p")).toHaveLength(1);
    expect(listWorkspaceMemories(db)).toHaveLength(1);
    expect(listWorkspaceMemories(db)[0].content).toBe("the owner prefers pnpm");

    // Search: same scoring core, scope-keyed.
    expect(searchMemories(db, "prj_p", "sidecar")).toHaveLength(1);
    expect(searchMemories(db, "prj_p", "pnpm")).toHaveLength(0); // the workspace row is invisible
    expect(searchWorkspaceMemories(db, "pnpm")).toHaveLength(1);
    expect(searchWorkspaceMemories(db, "sidecar")).toHaveLength(0);
    // Empty query degrades to the newest-first listing — per tier.
    expect(searchWorkspaceMemories(db, "   ")).toHaveLength(1);

    // Digest: each tier ranks + formats its own rows; empty tier → "".
    expect(memoryDigest(db, "prj_p")).toBe("• [fact] the sidecar port is 5178");
    expect(workspaceMemoryDigest(db)).toBe("• [preference] the owner prefers pnpm");
    expect(workspaceMemoryDigest(db)).not.toContain("5178");
    expect(memoryDigest(db, "prj_empty")).toBe("");
    expect(workspaceMemoryDigest(db)).not.toBe(""); // one row exists in this test's tier
  });

  it("dedup is keyed by the SCOPE: identical content across tiers is two rows; a duplicate workspace save refreshes", () => {
    const projectRow = saveMemoryWithDedup(db, { projectId: "prj_d", content: "always run tests" });
    const workspaceRow = saveMemoryWithDedup(db, { projectId: null, scope: "workspace", content: "always run tests" });
    expect(workspaceRow.deduplicated).toBe(false); // NOT the project row's twin
    expect(workspaceRow.item.id).not.toBe(projectRow.item.id);

    // The duplicate workspace save refreshes the workspace row only.
    const again = saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "decision",
      content: "Always Run Tests",
    });
    expect(again.deduplicated).toBe(true);
    expect(again.item.id).toBe(workspaceRow.item.id);
    expect(again.item.kind).toBe("decision");
    expect(listWorkspaceMemories(db)).toHaveLength(1);
    expect(listMemories(db, "prj_d")).toHaveLength(1);
  });

  it("update + delete address rows by id across BOTH scopes", () => {
    const workspaceRow = saveMemoryWithDedup(db, { projectId: null, scope: "workspace", content: "global truth" });
    const projectRow = saveMemory(db, { projectId: "prj_u", content: "local truth" });

    const patched = updateMemory(db, workspaceRow.item.id, { content: "global truth, revised" });
    if (!patched.ok) throw new Error("workspace update failed");
    expect(patched.item).toMatchObject({ scope: "workspace", projectId: null, content: "global truth, revised" });

    expect(deleteMemory(db, projectRow.id)).toEqual({ ok: true });
    expect(listMemories(db, "prj_u")).toHaveLength(0);
    expect(listWorkspaceMemories(db)).toHaveLength(1); // the workspace row survived
    expect(deleteMemory(db, "mem_ghost").ok).toBe(false);
  });
});

/* ── The workspace REST family ──────────────────────────────────────────── */

describe("GET/POST/PUT/DELETE /memory/workspace (R117-b)", () => {
  function authInject(options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    payload?: Record<string, unknown> | string;
  }) {
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
    if (options.payload !== undefined) headers["content-type"] = "application/json";
    return app!.inject({ ...options, headers });
  }

  beforeEach(() => {
    app = buildServer({ token: TOKEN, db });
  });

  it("GET lists the workspace tier only; the project family's listing is untouched by workspace rows", async () => {
    const project = createProject(db, { name: "REST Scope", rootPath: join(dir, "scope-root") });
    saveMemory(db, { projectId: project.id, kind: "fact", content: "project-only fact" });
    const workspaceRow = saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "workspace-only preference",
    });

    const listed = await authInject({ method: "GET", url: "/api/v1/memory/workspace" });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({
      id: workspaceRow.item.id,
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "workspace-only preference",
      source: "agent",
    });

    // The project route keeps its shape + does NOT leak the workspace row.
    const projectListed = await authInject({ method: "GET", url: `/api/v1/projects/${project.id}/memory` });
    expect(projectListed.statusCode).toBe(200);
    const projectBody = projectListed.json();
    expect(projectBody.memories).toHaveLength(1);
    expect(projectBody.memories[0].content).toBe("project-only fact");
  });

  it("POST creates a workspace row (201, source owner, scope workspace, projectId null, blank kind → note) and the exact duplicate DEDUPS (200)", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { kind: "fact", content: "  the owner's editor is Neovim  " },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.deduplicated).toBe(false);
    expect(body.memory).toMatchObject({
      projectId: null,
      scope: "workspace",
      kind: "fact",
      content: "the owner's editor is Neovim",
      source: "owner", // the owner's curated tier — the agent channel stays project-scoped
    });

    const defaulted = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { content: "no kind given" },
    });
    expect(defaulted.statusCode).toBe(201);
    expect(defaulted.json().memory.kind).toBe("note");

    // The dedup path (case-insensitive content) refreshes — no twin row.
    const duplicate = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { kind: "decision", content: "The owner's editor is Neovim" },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().deduplicated).toBe(true);
    expect(duplicate.json().memory.id).toBe(body.memory.id);
    expect(duplicate.json().memory.kind).toBe("decision");
    expect(listWorkspaceMemories(db)).toHaveLength(2); // + the defaulted note, no twin
  });

  it("POST 400s with the project family's exact grammar (bad kind, empty/over-cap content, non-object)", async () => {
    const badKind = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { kind: "vibe", content: "x" },
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error.code).toBe("VALIDATION");
    expect(badKind.json().error.message).toContain("fact | decision | preference | note");

    const emptyContent = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { content: "   " },
    });
    expect(emptyContent.statusCode).toBe(400);
    expect(emptyContent.json().error.message).toContain("content must be a non-empty string");

    const overCap = await authInject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      payload: { content: "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1) },
    });
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json().error.message).toContain(
      `content must be at most ${MAX_MEMORY_CONTENT_CHARS} characters`,
    );

    const notObject = await app!.inject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: "not json at all",
    });
    expect(notObject.statusCode).toBe(400);
    expect(listWorkspaceMemories(db)).toHaveLength(0); // nothing written
  });

  it("PUT patches partially, 400s the empty patch, 404s unknown ids; DELETE removes + 404s unknown", async () => {
    const saved = saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "fact",
      content: "port 5178",
    });
    const base = `/api/v1/memory/workspace/${saved.item.id}`;

    const patched = await authInject({ method: "PUT", url: base, payload: { content: "port 5179" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().memory).toMatchObject({ kind: "fact", content: "port 5179", scope: "workspace" });

    const moved = await authInject({ method: "PUT", url: base, payload: { kind: "decision" } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().memory).toMatchObject({ kind: "decision", content: "port 5179" });

    const empty = await authInject({ method: "PUT", url: base, payload: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toContain("provide at least one of content or kind");

    const ghost = await authInject({
      method: "PUT",
      url: "/api/v1/memory/workspace/mem_ghost",
      payload: { content: "x" },
    });
    expect(ghost.statusCode).toBe(404);

    const removed = await authInject({ method: "DELETE", url: base });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect(listWorkspaceMemories(db)).toHaveLength(0);
    const missing = await authInject({ method: "DELETE", url: base });
    expect(missing.statusCode).toBe(404);
  });

  it("sits behind the bearer wall (401 on GET and POST)", async () => {
    const unauthedGet = await app!.inject({ method: "GET", url: "/api/v1/memory/workspace" });
    expect(unauthedGet.statusCode).toBe(401);
    const unauthedPost = await app!.inject({
      method: "POST",
      url: "/api/v1/memory/workspace",
      headers: { "content-type": "application/json" },
      payload: { content: "never written" },
    });
    expect(unauthedPost.statusCode).toBe(401);
    expect(listWorkspaceMemories(db)).toHaveLength(0);
  });
});

/* ── The composed prompt (the scope ladder) ─────────────────────────────── */

describe("the composed memory prompt (workspace above project)", () => {
  const baseCtx = {
    projectName: "Acute",
    rootPath: "/tmp/acute",
    toolNames: ["memory_save", "memory_recall", "memory_list", "session_recall"],
  };

  it("renders BOTH labeled sections with the workspace tier ABOVE the project tier", () => {
    const prompt = buildProjectSystemPrompt({
      ...baseCtx,
      memoryWorkspaceDigest: "• [preference] the owner prefers pnpm",
      memoryDigest: "• [fact] the sidecar port is 5178",
    });
    expect(prompt).toContain("## Workspace memory");
    expect(prompt).toContain("Cross-project facts");
    expect(prompt).toContain("the owner prefers pnpm");
    expect(prompt).toContain("## Project memory (persisted across sessions)");
    expect(prompt).toContain("the sidecar port is 5178");
    // The ladder: workspace ABOVE project (it applies in every project).
    expect(prompt.indexOf("## Workspace memory")).toBeLessThan(
      prompt.indexOf("## Project memory (persisted across sessions)"),
    );
    // The episodic RECALL line (session_recall is in vocab).
    expect(prompt).toContain("session_recall to check what past sessions");
  });

  it("is honest per tier: workspace rows + an empty project tier says 'No memories saved for this project yet'; both empty says 'No memories saved yet'", () => {
    const workspaceOnly = buildProjectSystemPrompt({
      ...baseCtx,
      memoryWorkspaceDigest: "• [preference] the owner prefers pnpm",
      memoryDigest: "",
    });
    expect(workspaceOnly).toContain("## Workspace memory");
    expect(workspaceOnly).toContain("No memories saved for this project yet");
    expect(workspaceOnly).not.toContain("No memories saved yet —"); // the both-empty line, exact

    const bothEmpty = buildProjectSystemPrompt({
      ...baseCtx,
      memoryWorkspaceDigest: "",
      memoryDigest: "",
    });
    expect(bothEmpty).toContain("No memories saved yet");
    expect(bothEmpty).toContain("## Project memory (persisted across sessions)");
  });

  it("a workspace digest alone (project digest undefined) still composes the section", () => {
    const prompt = buildProjectSystemPrompt({
      ...baseCtx,
      memoryWorkspaceDigest: "• [fact] the owner's machine is called acutebox",
    });
    expect(prompt).toContain("## Workspace memory");
    expect(prompt).toContain("acutebox");
  });
});

/* ── memory_policy: the tool family (the REAL buildProjectTools) ────────── */

describe("memory_policy → the tool family (R117-b)", () => {
  async function memoryToolsFor(policy: "none" | "on-start" | "every-turn") {
    const session = createSession(db, { agentId: "agt_default_nova", mode: "single" });
    return buildProjectTools(
      join(dir, "root"),
      ["memory_save", "memory_recall", "memory_list", "session_recall", "write_file", "read_file"],
      {
        db,
        sessionId: session.id,
        agentId: "agt_default_nova",
        memoryPolicy: policy,
      },
    );
  }

  it("'none' drops the WHOLE memory family (memory_save/recall/list AND session_recall) even when explicitly allowlisted; the rest of the toolset is untouched", async () => {
    const off = await memoryToolsFor("none");
    expect(Object.keys(off).sort()).toEqual(["read_file", "write_file"]);

    // 'on-start' / 'every-turn' (and undefined) keep the family — the policy
    // only ever NARROWS.
    const onStart = await memoryToolsFor("on-start");
    expect(Object.keys(onStart).sort()).toEqual([
      "memory_list",
      "memory_recall",
      "memory_save",
      "read_file",
      "session_recall",
      "write_file",
    ]);
    const everyTurn = await memoryToolsFor("every-turn");
    expect(Object.keys(everyTurn)).toContain("session_recall");
  });
});

/* ── memory_policy: the digest (the REAL runSingleAgentTurn harness) ─────── */

describe("memory_policy → the digest injection (R117-b, real turns)", () => {
  const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-test-r117b" });

  // A shared chat that records every composed system prompt (the
  // memory-tools digest-gating idiom).
  function fakeChatFrom(systems: string[]): ChatFn {
    return async (input) => {
      systems.push(input.system);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
  }

  async function runTurn(sessionId: string, message: string, systems: string[]): Promise<void> {
    const outcome = await runSingleAgentTurn({ db, keyring, chat: fakeChatFrom(systems) }, sessionId, message);
    expect(outcome.ok).toBe(true);
  }

  it("'none': no digest AND no workspace digest — even with memories saved in BOTH scopes", async () => {
    const project = createProject(db, { name: "Policy None", rootPath: join(dir, "none-root") });
    saveMemory(db, { projectId: project.id, kind: "fact", content: "the sidecar port is 5178" });
    saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "the owner prefers pnpm",
    });
    const agent = createAgent(db, {
      name: "NoMem",
      providerId: "openrouter",
      model: "test/r117b-1",
      memoryPolicy: "none",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    const systems: string[] = [];
    await runTurn(session.id, "hello", systems);
    expect(systems[0]).not.toContain("## Project memory");
    expect(systems[0]).not.toContain("## Workspace memory");
    expect(systems[0]).not.toContain("the sidecar port is 5178");
    expect(systems[0]).not.toContain("the owner prefers pnpm");
    expect(systems[0]).not.toContain("No memories saved yet");
  });

  it("'on-start': the FIRST turn gets BOTH sections; the second turn of the SAME session gets NEITHER", async () => {
    const project = createProject(db, { name: "Policy OnStart", rootPath: join(dir, "onstart-root") });
    saveMemory(db, { projectId: project.id, kind: "fact", content: "the sidecar port is 5178" });
    saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: "preference",
      content: "the owner prefers pnpm",
    });
    const agent = createAgent(db, {
      name: "StartMem",
      providerId: "openrouter",
      model: "test/r117b-2",
      memoryPolicy: "on-start",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    // Turn 1 (no prior message.user event → the first-turn probe passes).
    const systems: string[] = [];
    await runTurn(session.id, "first message", systems);
    expect(systems[0]).toContain("## Project memory");
    expect(systems[0]).toContain("## Workspace memory");
    expect(systems[0]).toContain("the sidecar port is 5178");
    expect(systems[0]).toContain("the owner prefers pnpm");
    // Workspace above project, same ladder as the composed-prompt pin.
    expect(systems[0].indexOf("## Workspace memory")).toBeLessThan(systems[0].indexOf("## Project memory"));

    // Turn 2 on the SAME session: the digest is gone (the session has seen
    // a user turn — memory_policy 'on-start' means first-turn ONLY).
    systems.length = 0;
    await runTurn(session.id, "second message", systems);
    expect(systems[0]).not.toContain("## Project memory");
    expect(systems[0]).not.toContain("## Workspace memory");
    expect(systems[0]).not.toContain("the sidecar port is 5178");
  });

  it("'every-turn' (the default): BOTH turns get the sections", async () => {
    const project = createProject(db, { name: "Policy Every", rootPath: join(dir, "every-root") });
    saveMemory(db, { projectId: project.id, kind: "fact", content: "the sidecar port is 5178" });
    const agent = createAgent(db, {
      name: "AlwaysMem",
      providerId: "openrouter",
      model: "test/r117b-3",
      memoryPolicy: "every-turn",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    const systems: string[] = [];
    await runTurn(session.id, "first", systems);
    expect(systems[0]).toContain("## Project memory");
    expect(systems[0]).toContain("the sidecar port is 5178");

    systems.length = 0;
    await runTurn(session.id, "second", systems);
    expect(systems[0]).toContain("## Project memory"); // unchanged behavior
    expect(systems[0]).toContain("the sidecar port is 5178");
  });

  it("the honest empty line flows through the REAL runtime: a memoryless project (memory ON) renders 'No memories saved yet'", async () => {
    const project = createProject(db, { name: "Empty Mem", rootPath: join(dir, "empty-root") });
    const agent = createAgent(db, {
      name: "EmptyMem",
      providerId: "openrouter",
      model: "test/r117b-4",
      memoryPolicy: "every-turn",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });

    const systems: string[] = [];
    await runTurn(session.id, "hello", systems);
    expect(systems[0]).toContain("## Project memory (persisted across sessions)");
    expect(systems[0]).toContain("No memories saved yet");
    // The memory surface is announced — the model knows memory_save exists.
    expect(systems[0]).toContain("memory_save");
  });
});

/* ── The turn-end memory.saved counter (the honesty event) ──────────────── */

describe("turn-end memory.saved counter (R117-b)", () => {
  const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-test-r117b" });

  async function runSimpleTurn(_agentId: string, sessionId: string): Promise<void> {
    const chat: ChatFn = async () => ({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "hello");
    expect(outcome.ok).toBe(true);
  }

  function memorySavedEvents(sessionId: string): Array<Record<string, unknown>> {
    return listSessionEvents(db, sessionId)
      .filter((e) => e.type === "memory.saved")
      .map((e) => e.payload as Record<string, unknown>);
  }

  it("counts successful memory_save tool calls + compaction events at turn end; zero saves → no event; 'none' policy → no event", async () => {
    const project = createProject(db, { name: "Counter", rootPath: join(dir, "counter-root") });
    const agent = createAgent(db, {
      name: "Counter",
      providerId: "openrouter",
      model: "test/r117b-5",
      memoryPolicy: "every-turn",
    });

    // Seed the session's PAST: one successful memory_save tool call + one
    // compaction event (both channels the counter reads).
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "memory_save", argsSummary: "save", ok: true, outputSummary: "saved" },
    });
    appendSessionEvent(db, session.id, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "prior work summarized", throughSeq: 1, droppedMessages: 1, tokensSaved: 10 },
    });
    await runSimpleTurn(agent.id, session.id);
    // The payload carries the counter + the envelope appendSessionEvent adds
    // (agentId + ts) — pin the counter fields with objectContaining.
    expect(memorySavedEvents(session.id)).toEqual([
      expect.objectContaining({ saved: 2, agentSaved: 1, systemSaved: 1 }),
    ]);

    // A turn with ZERO saves (a fresh session, nothing seeded) appends NO
    // event — a zero-count row is noise.
    const quiet = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    await runSimpleTurn(agent.id, quiet.id);
    expect(memorySavedEvents(quiet.id)).toHaveLength(0);

    // A failed memory_save call (ok false) does not count.
    const failed = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, failed.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "memory_save", argsSummary: "save", ok: false, outputSummary: "no bound project" },
    });
    await runSimpleTurn(agent.id, failed.id);
    expect(memorySavedEvents(failed.id)).toHaveLength(0);

    // Policy 'none' → the capture step is gated off entirely.
    const noneAgent = createAgent(db, {
      name: "CounterNone",
      providerId: "openrouter",
      model: "test/r117b-6",
      memoryPolicy: "none",
    });
    const noneSession = createSession(db, {
      agentId: noneAgent.id,
      mode: "single",
      projectId: project.id,
    });
    appendSessionEvent(db, noneSession.id, {
      type: "tool.use",
      agentId: noneAgent.id,
      payload: { role: "tool", toolName: "memory_save", argsSummary: "save", ok: true, outputSummary: "saved" },
    });
    await runSimpleTurn(noneAgent.id, noneSession.id);
    expect(memorySavedEvents(noneSession.id)).toHaveLength(0);

    // Projectless sessions get no capture either (nowhere to count for).
    const projectless = createSession(db, { agentId: agent.id, mode: "single", projectId: null });
    appendSessionEvent(db, projectless.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "memory_save", argsSummary: "save", ok: true, outputSummary: "saved" },
    });
    await runSimpleTurn(agent.id, projectless.id);
    expect(memorySavedEvents(projectless.id)).toHaveLength(0);

    // The master switch gates it too.
    setMemorySettings(db, { enabled: false });
    const switched = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, switched.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "memory_save", argsSummary: "save", ok: true, outputSummary: "saved" },
    });
    await runSimpleTurn(agent.id, switched.id);
    expect(memorySavedEvents(switched.id)).toHaveLength(0);
  });
});

/* ── session_recall (the episodic search, the REAL tool path) ───────────── */

describe("session_recall (R117-b episodic memory)", () => {
  async function recallTools(sessionId: string) {
    return buildProjectTools(join(dir, "root"), ["session_recall"], {
      db,
      sessionId,
      agentId: "agt_default_nova",
    });
  }

  /** Seed one past session with title + one event carrying the needle. */
  function seedSession(projectId: string, title: string, eventText: string): string {
    const session = createSession(db, { agentId: "agt_default_nova", mode: "single", projectId, title });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: "agt_default_nova",
      payload: { role: "assistant", content: eventText },
    });
    return session.id;
  }

  it("returns real hits (id + title + last activity + a payload-windowed snippet), scoped to THIS project and excluding the current session", async () => {
    const project = createProject(db, { name: "Recall", rootPath: join(dir, "recall-root") });
    const s1 = seedSession(project.id, "OAuth research", "we traced the oauth token refresh flow and fixed the expiry bug");
    seedSession(project.id, "Build fix", "pinned pnpm to 9 to fix the lockfile");
    // A decoy in ANOTHER project with the same needle text.
    const otherProject = createProject(db, { name: "Other", rootPath: join(dir, "other-root") });
    seedSession(otherProject.id, "OAuth elsewhere", "unrelated oauth work in another project");
    // The CURRENT session mentions the needle too — it must be excluded.
    const current = createSession(db, {
      agentId: "agt_default_nova",
      mode: "single",
      projectId: project.id,
      title: "OAuth current session",
    });
    appendSessionEvent(db, current.id, {
      type: "message.user",
      agentId: "agt_default_nova",
      payload: { role: "user", content: "what about the oauth bug again" },
    });

    const tools = await recallTools(current.id);
    const recall = await tool(tools, "session_recall").execute({ query: "oauth" });
    expect(recall.ok).toBe(true);
    expect(recall.output).toContain("1 past session in this project matching 'oauth'");
    expect(recall.output).toContain(s1);
    expect(recall.output).toContain('"OAuth research"');
    expect(recall.output).toContain("last activity");
    // The snippet comes from the matched event payload, windowed + collapsed.
    expect(recall.output).toContain("oauth token refresh flow");
    // Neither the other project's session, the non-matching sibling, nor the
    // CURRENT session (id) appears.
    expect(recall.output).not.toContain("OAuth elsewhere");
    expect(recall.output).not.toContain("pinned pnpm");
    expect(recall.output).not.toContain(current.id);
  });

  it("title-only matches use the title as the snippet; no matches is an honest ok:true; empty query + missing deps refuse", async () => {
    const project = createProject(db, { name: "Recall2", rootPath: join(dir, "recall2-root") });
    seedSession(project.id, "Wire protocol deep dive", "only generic notes here");
    const current = createSession(db, { agentId: "agt_default_nova", mode: "single", projectId: project.id });

    const tools = await recallTools(current.id);
    // Title-only match → the title is the snippet.
    const byTitle = await tool(tools, "session_recall").execute({ query: "protocol" });
    expect(byTitle.ok).toBe(true);
    expect(byTitle.output).toContain('"Wire protocol deep dive"');

    // No matches → ok:true with the honest empty line (a research dead-end,
    // not an error).
    const none = await tool(tools, "session_recall").execute({ query: "zzz-nothing-matches" });
    expect(none.ok).toBe(true);
    expect(none.output).toContain("no past sessions in this project match");

    // Empty/non-string query → ok:false with the actionable message.
    const empty = await tool(tools, "session_recall").execute({ query: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("non-empty 'query'");
    const missing = await tool(tools, "session_recall").execute({});
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("non-empty 'query'");

    // No deps at all (back-compat call sites).
    const bare = await buildProjectTools(join(dir, "root"), ["session_recall"]);
    const bareRecall = await tool(bare, "session_recall").execute({ query: "x" });
    expect(bareRecall.ok).toBe(false);
    expect(bareRecall.output).toContain("unavailable in this context");
  });

  it("projectless sessions get the honest no-project refusal (the memory family's gate)", async () => {
    const projectless = createSession(db, { agentId: "agt_default_nova", mode: "single", projectId: null });
    const tools = await recallTools(projectless.id);
    const recall = await tool(tools, "session_recall").execute({ query: "anything" });
    expect(recall.ok).toBe(false);
    expect(recall.output).toContain("episodic recall is project-scoped");
    expect(recall.output).toContain("no bound project");
  });

  it("limit defaults to 5 and caps at 10 (a research pointer, not a transcript dump)", async () => {
    const project = createProject(db, { name: "Bulk", rootPath: join(dir, "bulk-root") });
    for (let i = 0; i < 12; i++) {
      seedSession(project.id, `bulk topic ${i}`, `session ${i} discussed the bulkfact issue in depth`);
    }
    const current = createSession(db, { agentId: "agt_default_nova", mode: "single", projectId: project.id });
    const tools = await recallTools(current.id);

    const def = await tool(tools, "session_recall").execute({ query: "bulkfact" });
    expect(def.ok).toBe(true);
    expect((def.output.match(/^- /gm) ?? []).length).toBe(5); // the default

    const capped = await tool(tools, "session_recall").execute({ query: "bulkfact", limit: 999 });
    expect(capped.ok).toBe(true);
    expect((capped.output.match(/^- /gm) ?? []).length).toBe(10); // the cap

    const tight = await tool(tools, "session_recall").execute({ query: "bulkfact", limit: 1 });
    expect((tight.output.match(/^- /gm) ?? []).length).toBe(1);
  });
});

/* ── The digest budget step (richness-scaled) ───────────────────────────── */

describe("digest budget scaling (R117-b)", () => {
  it("digestBudget is the step function: 1500 at ≤30 rows, 3000 beyond", () => {
    expect(digestBudget(0)).toBe(1_500);
    expect(digestBudget(30)).toBe(1_500);
    expect(digestBudget(31)).toBe(3_000);
    expect(digestBudget(500)).toBe(3_000);
  });

  it("the PROJECT digest scales: 31 long rows widen past 1500; 30 rows keep the pre-R117 cap; an explicit maxChars still wins", () => {
    const long = "z".repeat(120);
    for (let i = 0; i < 31; i++) {
      saveMemory(db, { projectId: "prj_rich", kind: "note", content: `${long} ${i}` });
    }
    const rich = memoryDigest(db, "prj_rich");
    expect(rich.length).toBeGreaterThan(1_500); // the scaled budget let more lines in
    expect(rich.length).toBeLessThanOrEqual(3_000); // ...but not past the new cap
    expect((rich.match(/\n/g) ?? []).length).toBeGreaterThanOrEqual(20); // whole lines, not slices

    for (let i = 0; i < 30; i++) {
      saveMemory(db, { projectId: "prj_mid", kind: "note", content: `${long} ${i}` });
    }
    const mid = memoryDigest(db, "prj_mid");
    expect(mid.length).toBeLessThanOrEqual(1_500); // 30 rows keep the small budget

    // Explicit maxChars keeps full control (the tests' tiny-budget idiom).
    expect(memoryDigest(db, "prj_rich", 40).split("\n")).toHaveLength(1);
  });

  it("the WORKSPACE digest scales with its own tier's richness, independent of the project tier", () => {
    const long = "w".repeat(120);
    for (let i = 0; i < 31; i++) {
      saveMemoryWithDedup(db, { projectId: null, scope: "workspace", kind: "note", content: `${long} ${i}` });
    }
    expect(workspaceMemoryDigest(db).length).toBeGreaterThan(1_500);
    expect(workspaceMemoryDigest(db).length).toBeLessThanOrEqual(3_000);
  });

  it("a rich PROJECT tier does not widen an EMPTY workspace tier (per-scope budgets)", () => {
    const long = "w".repeat(120);
    for (let i = 0; i < 40; i++) {
      saveMemory(db, { projectId: "prj_rich2", kind: "note", content: `${long} ${i}` });
    }
    // 40 project rows push the project digest to the 3,000 budget, but the
    // workspace tier has ZERO rows: "" and the small budget.
    expect(memoryDigest(db, "prj_rich2").length).toBeGreaterThan(1_500);
    expect(workspaceMemoryDigest(db)).toBe("");
  });
});
