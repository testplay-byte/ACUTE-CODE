/**
 * ROUND-44 (R44-a) — the agent MEMORY SYSTEM.
 *
 * Agents forgot everything between turns/sessions; storage/memory.ts is the
 * per-project persistent knowledge base, tools/memory.ts exposes it to the
 * model (memory_save / memory_recall / memory_list), and migration 0015
 * brings the table + tool allowlist to existing databases. These tests pin:
 *
 *   - storage CRUD: save validation (kinds, trim, 4000-char cap), newest-
 *     first listing, content-ranked search, delete, and the whole-line
 *     capped digest that feeds the system prompt,
 *   - ROUND-46 (memory v2): relevance-ranked search (multi-token overlap
 *     beats single-token, kind-only still findable, stopwords dropped),
 *     ranked digest (decision > fact × recency decay), dedup-on-save
 *     (duplicate content bumps updated_at instead of inserting a twin),
 *   - the TOOL layer through the REAL buildProjectTools → execute path
 *     (including graceful failure for sessions without a project and the
 *     sessionId → project fallback),
 *   - migration 0015 on a simulated pre-R44 database (template/default rows
 *     get the memory tools; user agents untouched; idempotent),
 *   - the system-prompt injection section,
 *   - the REST surface (GET/DELETE /projects/:id/memory).
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
import { createSession } from "../src/storage/sessions";
import {
  MAX_MEMORY_CONTENT_CHARS,
  deleteMemory,
  listMemories,
  memoryDigest,
  recencyMultiplier,
  saveMemory,
  saveMemoryWithDedup,
  searchMemories,
  tokenizeText,
} from "../src/storage/memory";
import { buildProjectSystemPrompt } from "../src/agents/prompts";
import { runSingleAgentTurn } from "../src/agents/runtime";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { createAgent } from "../src/storage/agents";
import { getMemorySettings, setMemorySettings } from "../src/storage/settings";

// The AI SDK tool contract — narrow to what the tests call.
type Tool = { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
function tool(set: ToolSet, name: string): Tool {
  return (set as unknown as Record<string, Tool>)[name];
}

const dir = mkdtempSync(join(tmpdir(), "acute-memory-"));

let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const TOKEN = "test-token-r44a";

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

/* ── Storage ─────────────────────────────────────────────────────────────── */

describe("memory storage", () => {
  it("saves with the documented defaults and returns the row (mem_ id, note kind, trimmed content)", () => {
    const saved = saveMemory(db, { projectId: "prj_1", content: "  pnpm workspaces — never npm at the root  " });
    expect(saved.id).toMatch(/^mem_/);
    expect(saved.projectId).toBe("prj_1");
    expect(saved.kind).toBe("note");
    expect(saved.content).toBe("pnpm workspaces — never npm at the root");
    expect(saved.source).toBe("agent");
    expect(saved.createdAt).toBe(saved.updatedAt);
    expect(Number.isNaN(Date.parse(saved.createdAt))).toBe(false);
  });

  it("validates the kind (4 values, case-insensitive) and rejects everything else", () => {
    expect(saveMemory(db, { projectId: "p", kind: "fact", content: "x" }).kind).toBe("fact");
    expect(saveMemory(db, { projectId: "p", kind: "Decision", content: "x" }).kind).toBe("decision");
    expect(saveMemory(db, { projectId: "p", kind: "preference", content: "x" }).kind).toBe("preference");
    expect(() => saveMemory(db, { projectId: "p", kind: "gossip", content: "x" })).toThrow(
      /fact \| decision \| preference \| note/,
    );
    // Empty kind = the documented default (note), not an error.
    expect(saveMemory(db, { projectId: "p", kind: "", content: "x" }).kind).toBe("note");
  });

  it("rejects empty + over-cap content (4000 is the boundary)", () => {
    expect(() => saveMemory(db, { projectId: "p", content: "   " })).toThrow(/non-empty/);
    const edge = "x".repeat(MAX_MEMORY_CONTENT_CHARS);
    expect(saveMemory(db, { projectId: "p", content: edge }).content).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    expect(() => saveMemory(db, { projectId: "p", content: `${edge}x` })).toThrow(/too long/);
  });

  it("lists newest-first and caps the limit", () => {
    for (let i = 0; i < 5; i++) {
      saveMemory(db, { projectId: "prj_list", kind: "fact", content: `fact number ${i}` });
    }
    saveMemory(db, { projectId: "prj_other", content: "different project" });
    const listed = listMemories(db, "prj_list");
    expect(listed).toHaveLength(5);
    expect(listed.every((m) => m.projectId === "prj_list")).toBe(true);
    // Same-millisecond timestamps fall through to the id tie-break; the
    // important invariant: deterministic order + the limit is honored.
    expect(listMemories(db, "prj_list", 3)).toHaveLength(3);
    const other = listMemories(db, "prj_other");
    expect(other).toHaveLength(1);
    expect(other[0].content).toBe("different project");
  });

  it("searches content + kind, content matches ranked first, LIKE wildcards escaped", () => {
    saveMemory(db, { projectId: "prj_s", kind: "fact", content: "sidecar runs on port 5178" });
    saveMemory(db, { projectId: "prj_s", kind: "decision", content: "we use pnpm everywhere" });
    saveMemory(db, { projectId: "prj_s", kind: "note", content: "ordinary note text" });

    const contentHits = searchMemories(db, "prj_s", "sidecar");
    expect(contentHits).toHaveLength(1);
    expect(contentHits[0].content).toContain("5178");

    // "decision" matches row 2 by CONTENT and row 2 only (kind alone doesn't
    // double-count); a kind-only query still finds the row.
    const kindHits = searchMemories(db, "prj_s", "decision");
    expect(kindHits).toHaveLength(1);
    expect(kindHits[0].kind).toBe("decision");

    // Content match ranks before kind-only match for the same query.
    saveMemory(db, { projectId: "prj_s", kind: "note", content: "the DECISION log lives in docs/" });
    const ranked = searchMemories(db, "prj_s", "decision");
    expect(ranked).toHaveLength(2);
    expect(ranked[0].content).toContain("DECISION log"); // content substring wins
    expect(ranked[1].kind).toBe("decision");

    // A literal % must not act as a wildcard (no rows contain "518").
    expect(searchMemories(db, "prj_s", "51%8")).toHaveLength(0);
    // Case-insensitive (ASCII) match.
    expect(searchMemories(db, "prj_s", "SIDECAR")).toHaveLength(1);
    // Empty query degrades to the newest-first listing.
    expect(searchMemories(db, "prj_s", "   ").length).toBe(4);
  });

  it("deletes by id and reports unknown ids", () => {
    const saved = saveMemory(db, { projectId: "prj_d", content: "temporary" });
    expect(deleteMemory(db, saved.id)).toEqual({ ok: true });
    expect(listMemories(db, "prj_d")).toHaveLength(0);
    expect(deleteMemory(db, saved.id).ok).toBe(false);
  });

  it("digest: ranked by importance × recency, whole-line cap, empty project → empty string", () => {
    expect(memoryDigest(db, "prj_none")).toBe("");

    saveMemory(db, { projectId: "prj_g", kind: "decision", content: "use pnpm" });
    saveMemory(db, { projectId: "prj_g", kind: "fact", content: "sidecar port 5178" });
    const digest = memoryDigest(db, "prj_g");
    // ROUND-46 v2: both fresh, but a DECISION (weight 1.0) outranks a FACT
    // (0.8) — v1's pure newest-first put the fact first; the ranked digest
    // deliberately changed that order.
    expect(digest.split("\n")).toEqual(["• [decision] use pnpm", "• [fact] sidecar port 5178"]);

    // Cap on whole lines: the decision line (22 chars) fits the 40-char
    // budget; the fact line would overflow → only the first survives.
    const capped = memoryDigest(db, "prj_g", 40);
    expect(capped.split("\n")).toHaveLength(1);
    expect(capped.startsWith("• [decision]")).toBe(true);

    // A single line longer than the whole budget is hard-sliced + ellipsized.
    saveMemory(db, { projectId: "prj_big", content: "y".repeat(200) });
    const sliced = memoryDigest(db, "prj_big", 50);
    expect(sliced.length).toBe(50);
    expect(sliced.endsWith("…")).toBe(true);
  });

  it("ROUND-46 v2: recency decay — a stale decision sinks below a fresh fact in the digest", () => {
    saveMemory(db, { projectId: "prj_r", kind: "decision", content: "old decision from long ago" });
    saveMemory(db, { projectId: "prj_r", kind: "fact", content: "fresh fact observed today" });
    // Age the decision row past the 30-day bucket (0.85 → 0.7 decay).
    db.prepare("UPDATE memory SET updated_at = ? WHERE project_id = ? AND kind = 'decision'")
      .run("2020-01-01T00:00:00.000Z", "prj_r");
    const digest = memoryDigest(db, "prj_r");
    // decision: 1.0 × 0.55 = 0.55 < fact: 0.8 × 1.0 = 0.8 → fact first.
    expect(digest.split("\n")[0]).toContain("fresh fact");
  });

  it("ROUND-46 v2: multi-token queries rank by relevance, not insertion order", () => {
    saveMemory(db, { projectId: "prj_mt", kind: "note", content: "pnpm install is sometimes slow" });
    saveMemory(db, { projectId: "prj_mt", kind: "fact", content: "pnpm workspaces power the monorepo" });
    const hits = searchMemories(db, "prj_mt", "pnpm workspaces");
    expect(hits).toHaveLength(2);
    // Both match "pnpm" (overlap 0.5); only the workspaces row matches both
    // (overlap 1.0 + substring bonus) → it wins despite being OLDER.
    expect(hits[0].content).toContain("workspaces");
  });

  it("ROUND-46 v2: stopwords drop out of queries without losing matches", () => {
    saveMemory(db, { projectId: "prj_sw", kind: "fact", content: "sidecar runs on port 5178" });
    expect(searchMemories(db, "prj_sw", "the sidecar")).toHaveLength(1);
    expect(tokenizeText("The SIDECAR runs", true)).toEqual(["sidecar", "runs"]);
    expect(tokenizeText("the a of", true)).toEqual([]);
  });

  it("ROUND-46 v2: dedup on save — duplicate content bumps instead of inserting a twin", () => {
    const first = saveMemoryWithDedup(db, {
      projectId: "prj_dd",
      kind: "note",
      content: "always run tests before pushing",
    });
    expect(first.deduplicated).toBe(false);

    // Same content, different case/kind → refresh, not insert.
    const second = saveMemoryWithDedup(db, {
      projectId: "prj_dd",
      kind: "decision",
      content: "Always run tests before pushing",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.kind).toBe("decision");
    expect(listMemories(db, "prj_dd")).toHaveLength(1);

    // The bump shows in recall (newest-first listing reflects the refresh).
    expect(listMemories(db, "prj_dd")[0].updatedAt).toBe(second.item.updatedAt);

    // Different project with identical content stays a separate row.
    saveMemoryWithDedup(db, { projectId: "prj_dd2", kind: "note", content: "always run tests before pushing" });
    expect(listMemories(db, "prj_dd2")).toHaveLength(1);
  });

  it("ROUND-46 v2: recencyMultiplier buckets + unparseable stamps", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    expect(recencyMultiplier("2026-08-27T12:00:00.000Z", now)).toBe(1.0); // 1 day
    expect(recencyMultiplier("2026-08-01T12:00:00.000Z", now)).toBe(0.85); // 27 days
    expect(recencyMultiplier("2026-06-29T12:00:00.000Z", now)).toBe(0.7); // 60 days
    expect(recencyMultiplier("2020-01-01T12:00:00.000Z", now)).toBe(0.55); // ancient
    expect(recencyMultiplier("not-a-date", now)).toBe(0.7); // unparseable → mid bucket
  });
});

/* ── Tools (the REAL buildProjectTools → execute path) ───────────────────── */

describe("memory tools", () => {
  async function projectSessionTools(projectId: string | null) {
    const session = createSession(db, {
      agentId: "agt_default_nova",
      mode: "single",
      projectId,
    });
    const tools = await buildProjectTools(join(dir, "root"), ["memory_save", "memory_recall", "memory_list"], {
      db,
      sessionId: session.id,
      agentId: "agt_default_nova",
      // NOTE: projectId deliberately omitted — the tool must resolve it via
      // the sessions-table fallback (older call sites don't pass it).
    });
    return { sessionId: session.id, tools };
  }

  it("the three tools are in the base set and flow through the allow filter", async () => {
    const all = await buildProjectTools(join(dir, "root"));
    expect(Object.keys(all)).toEqual(
      expect.arrayContaining(["memory_save", "memory_recall", "memory_list"]),
    );
    const only = await buildProjectTools(join(dir, "root"), ["memory_save"]);
    expect(Object.keys(only)).toEqual(["memory_save"]);
  });

  it("memory_save persists via the session→project fallback and recalls it back", async () => {
    const project = createProject(db, { name: "Acute Mem", rootPath: join(dir, "root") });
    const { tools } = await projectSessionTools(project.id);

    const save = await tool(tools, "memory_save").execute({
      content: "  use vitest for all agent-core tests  ",
      kind: "decision",
    });
    expect(save.ok).toBe(true);
    expect(save.output).toContain("decision");
    expect(save.output).toContain("persists across sessions");

    const stored = listMemories(db, project.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("use vitest for all agent-core tests");
    expect(stored[0].kind).toBe("decision");
    expect(stored[0].source).toBe("agent");

    const recall = await tool(tools, "memory_recall").execute({ query: "vitest" });
    expect(recall.ok).toBe(true);
    expect(recall.output).toContain("use vitest for all agent-core tests");

    const list = await tool(tools, "memory_list").execute({ limit: 5 });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("newest first");
    expect(list.output).toContain("use vitest for all agent-core tests");
  });

  it("memory_recall without a query lists the newest 12; memory_list defaults + caps", async () => {
    const project = createProject(db, { name: "Many Mem", rootPath: join(dir, "root") });
    for (let i = 0; i < 14; i++) {
      saveMemory(db, { projectId: project.id, kind: "fact", content: `fact ${i}` });
    }
    const { tools } = await projectSessionTools(project.id);

    const recall = await tool(tools, "memory_recall").execute({});
    expect(recall.ok).toBe(true);
    expect(recall.output).toContain("newest 12");
    expect((recall.output.match(/• \[fact\]/g) ?? []).length).toBe(12);

    const list = await tool(tools, "memory_list").execute({});
    expect((list.output.match(/• \[fact\]/g) ?? []).length).toBe(14); // default 20

    const capped = await tool(tools, "memory_list").execute({ limit: 500 });
    expect((capped.output.match(/• \[fact\]/g) ?? []).length).toBe(14); // cap 50 < 500 rows
  });

  it("fails gracefully when the session has no project, deps are missing, or input is invalid", async () => {
    // No project on the session (and no deps.projectId) → ok:false, no throw.
    const { tools } = await projectSessionTools(null);
    const save = await tool(tools, "memory_save").execute({ content: "orphan" });
    expect(save.ok).toBe(false);
    expect(save.output).toContain("no bound project");
    const recall = await tool(tools, "memory_recall").execute({ query: "x" });
    expect(recall.ok).toBe(false);
    const list = await tool(tools, "memory_list").execute({});
    expect(list.ok).toBe(false);

    // Unknown sessionId + no explicit projectId → same graceful failure.
    const ghost = await buildProjectTools(join(dir, "root"), ["memory_save"], {
      db,
      sessionId: "sess_does_not_exist",
      agentId: "agt_default_nova",
    });
    const ghostSave = await tool(ghost, "memory_save").execute({ content: "x" });
    expect(ghostSave.ok).toBe(false);
    expect(ghostSave.output).toContain("no bound project");

    // No deps at all (back-compat call sites).
    const bare = await buildProjectTools(join(dir, "root"), ["memory_save"]);
    const bareSave = await tool(bare, "memory_save").execute({ content: "x" });
    expect(bareSave.ok).toBe(false);
    expect(bareSave.output).toContain("unavailable in this context");

    // Validation failures surface as ok:false with actionable messages.
    const project = createProject(db, { name: "Valid", rootPath: join(dir, "root") });
    const { tools: valid } = await projectSessionTools(project.id);
    const badKind = await tool(valid, "memory_save").execute({ content: "x", kind: "rumor" });
    expect(badKind.ok).toBe(false);
    expect(badKind.output).toContain("fact | decision | preference | note");
    const empty = await tool(valid, "memory_save").execute({ content: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("non-empty");
    const tooLong = await tool(valid, "memory_save").execute({ content: "z".repeat(MAX_MEMORY_CONTENT_CHARS + 1) });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.output).toContain("too long");
  });
});

/* ── System-prompt injection ──────────────────────────────────────────────── */

describe("system prompt memory section (ROUND-44 R44-a)", () => {
  const baseCtx = {
    projectName: "Acute",
    rootPath: "/tmp/acute",
    toolNames: ["memory_save", "memory_recall", "memory_list"],
  };

  it("injects the digest section only when memories exist", () => {
    const withMemory = buildProjectSystemPrompt({
      ...baseCtx,
      memoryDigest: "• [fact] sidecar port 5178",
    });
    expect(withMemory).toContain("## Project memory (persisted across sessions)");
    expect(withMemory).toContain("• [fact] sidecar port 5178");
    expect(withMemory).toContain("memory_save");

    const without = buildProjectSystemPrompt({ ...baseCtx, memoryDigest: "" });
    expect(without).not.toContain("Project memory (persisted");
    const omitted = buildProjectSystemPrompt({ ...baseCtx });
    expect(omitted).not.toContain("Project memory (persisted");
  });
});

/* ── REST surface ─────────────────────────────────────────────────────────── */

describe("GET/DELETE /projects/:id/memory", () => {
  function authInject(options: { method: "GET" | "DELETE"; url: string }) {
    return app!.inject({ ...options, headers: { authorization: `Bearer ${TOKEN}` } });
  }

  beforeEach(() => {
    app = buildServer({ token: TOKEN, db });
  });

  it("lists a project's memories and deletes one by id", async () => {
    const project = createProject(db, { name: "REST Mem", rootPath: join(dir, "root") });
    const saved = saveMemory(db, { projectId: project.id, kind: "fact", content: "rest fact" });

    const listed = await authInject({ method: "GET", url: `/api/v1/projects/${project.id}/memory` });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({ id: saved.id, kind: "fact", content: "rest fact" });

    const removed = await authInject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/memory/${saved.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect(listMemories(db, project.id)).toHaveLength(0);

    const missing = await authInject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/memory/${saved.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("404s for unknown projects and requires the bearer token", async () => {
    const missing = await authInject({ method: "GET", url: "/api/v1/projects/prj_ghost/memory" });
    expect(missing.statusCode).toBe(404);

    const unauthed = await app!.inject({ method: "GET", url: "/api/v1/projects/whatever/memory" });
    expect(unauthed.statusCode).toBe(401);
  });
});

/* ── Migration 0015 ───────────────────────────────────────────────────────── */

/** Applies migrations 0001..0014 by hand — simulates a pre-ROUND-44 install. */
function openPreR44Database(path: string): SqliteDatabase {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 14)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(14);
  const insert = raw.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    raw.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return raw;
}

describe("migration 0015 (memory table + tool allowlist append)", () => {
  it("creates the memory table and appends memory tools to template/default rows only, idempotent", () => {
    const path = join(dir, "m0015-memory.db");
    const old = openPreR44Database(path);
    const now = new Date().toISOString();
    old
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
         VALUES ('openrouter', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1',
           'chat-completions', 1, ?)`,
      )
      .run(now);
    const ins = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'none', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const seedTools = JSON.stringify([
      "list_dir", "read_file", "write_file", "edit_file", "create_dir", "delete_file",
      "search_files", "search_code", "git_status", "git_diff", "git_log", "run_command",
      "todo_write", "web_fetch", "web_search", "index_project",
      "delegate_task", "browser_control",
    ]);
    ins.run("agt_tpl_coder", seedTools, 1, now, now);    // template, post-0014 shape
    ins.run("agt_default_nova", seedTools, 0, now, now); // default agent, post-0014 shape
    ins.run("agt_mine", seedTools, 0, now, now);         // user-created: must stay untouched
    old.close();

    const db2 = openDatabase(path); // 0015 applies
    const row = (id: string) =>
      JSON.parse(
        (db2.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string }).allowed_tools,
      ) as string[];
    // Template + default get all three memory tools appended — and, since
    // ROUND-52 (R52-a), the two job supervision tools as well (migration
    // 0021 appends them to template/default rows whose list includes
    // run_command — the memory test's seed list does).
    expect(row("agt_tpl_coder")).toEqual([
      ...JSON.parse(seedTools) as string[],
      "memory_save",
      "memory_recall",
      "memory_list",
      "job_status",
      "job_stop",
    ]);
    expect(row("agt_default_nova")).toContain("memory_save");
    expect(row("agt_default_nova")).toHaveLength(23);
    // User-created agents keep their deliberately-authored lists.
    expect(row("agt_mine")).toEqual(JSON.parse(seedTools));

    // The memory table exists with the documented shape + constraints.
    const cols = (db2.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "project_id", "kind", "content", "source", "created_at", "updated_at"]);
    expect(() =>
      db2.prepare("INSERT INTO memory (id, project_id, kind, content, source, created_at, updated_at) VALUES ('m','p','rumor','x','agent','t','t')").run(),
    ).toThrow(/CHECK constraint failed/);

    // Audit row + migration bookkeeping.
    const audit = db2
      .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0015' LIMIT 1")
      .get() as { actor: string; action: string };
    expect(audit).toEqual({ actor: "migration-0015", action: "memory.system.create" });
    expect(db2.prepare("SELECT version FROM schema_migrations WHERE version = 15").get()).toBeDefined();

    // Idempotent on reopen (no duplicate appends — 21 memory-era tools + the
    // two ROUND-52 job tools migration 0021 added to this run_command row).
    db2.close();
    const again = openDatabase(path);
    expect(
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ) as string[],
    ).toHaveLength(23);
    again.close();
  });

  it("fresh installs seed the templates WITH the memory tools (TOOL_NAMES is the seed)", async () => {
    const fresh = openDatabase(join(dir, "fresh-memory.db"));
    try {
      const tools = JSON.parse(
        (fresh.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ) as string[];
      expect(tools).toContain("memory_save");
      expect(tools).toContain("memory_recall");
      expect(tools).toContain("memory_list");
      // The default agent seeds [] (= ALL tools) — the memory tools reach it
      // through the base tool set instead.
      const { TOOL_NAMES } = await import("../src/storage/agents");
      expect([...TOOL_NAMES]).toContain("memory_save");
    } finally {
      fresh.close();
    }
  });
});

/* ── ROUND-49: the memory master switch ──────────────────────────────────── */

describe("ROUND-49: memory master switch (Settings → Advanced)", () => {
  it("settings round-trip: default ON; OFF persists; invalid type rejected", () => {
    expect(getMemorySettings(db)).toEqual({ enabled: true });
    const off = setMemorySettings(db, { enabled: false });
    expect(off).toEqual({ enabled: false });
    // Survives a reopen (persisted in the settings table).
    expect(getMemorySettings(db)).toEqual({ enabled: false });
    expect(() => setMemorySettings(db, { enabled: "yes" as unknown as boolean })).toThrow();
    setMemorySettings(db, { enabled: true });
    expect(getMemorySettings(db)).toEqual({ enabled: true });
  });

  it("memory tools are NOT registered when memoryEnabled: false — even when explicitly allowlisted; the rest of the toolset is untouched", async () => {
    const session = createSession(db, { agentId: "agt_default_nova", mode: "single" });
    const off = await buildProjectTools(join(dir, "root"), ["memory_save", "memory_recall", "memory_list", "write_file", "read_file"], {
      db,
      sessionId: session.id,
      agentId: "agt_default_nova",
      memoryEnabled: false,
    });
    expect(Object.keys(off).sort()).toEqual(["read_file", "write_file"]);
    // The switch only HIDES the tools (data + the on-switch path are intact).
    const on = await buildProjectTools(join(dir, "root"), ["memory_save", "memory_recall", "memory_list", "write_file"], {
      db,
      sessionId: session.id,
      agentId: "agt_default_nova",
      memoryEnabled: true,
    });
    expect(Object.keys(on).sort()).toEqual(["memory_list", "memory_recall", "memory_save", "write_file"]);
  });

  it("prepareTurn digest gating: main sessions get the digest while ON, nothing while OFF, and sub-agent children NEVER get it (independent context)", async () => {
    const project = createProject(db, { name: "MemGate", rootPath: join(dir, "root") });
    saveMemory(db, { projectId: project.id, kind: "fact", content: "the sidecar port is 5178" });
    const agent = createAgent(db, { name: "Gate", providerId: "openrouter", model: "test/mem-1" });
    const keyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-test-mem" });
    const systems: string[] = [];
    const chat: ChatFn = async (input) => {
      systems.push(input.system);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };

    // Main session, memory ON → digest present.
    const main = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    let outcome = await runSingleAgentTurn({ db, keyring, chat }, main.id, "hello");
    expect(outcome.ok).toBe(true);
    expect(systems[0]).toContain("## Project memory");

    // Main session, memory OFF → NO digest section anywhere.
    setMemorySettings(db, { enabled: false });
    systems.length = 0;
    const main2 = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    outcome = await runSingleAgentTurn({ db, keyring, chat }, main2.id, "hello again");
    expect(outcome.ok).toBe(true);
    expect(systems[0]).not.toContain("## Project memory");
    expect(systems[0]).not.toContain("the sidecar port is 5178");

    // Sub-agent child, memory back ON → STILL no digest (context isolation:
    // the owner directed sub-agents to run on their own context alone).
    setMemorySettings(db, { enabled: true });
    systems.length = 0;
    const child = createSession(db, {
      agentId: agent.id,
      mode: "single",
      projectId: project.id,
      parentSessionId: main.id,
      subRole: "researcher",
    });
    outcome = await runSingleAgentTurn({ db, keyring, chat }, child.id, "delegated subtask");
    expect(outcome.ok).toBe(true);
    expect(systems[0]).not.toContain("## Project memory");
    expect(systems[0]).not.toContain("the sidecar port is 5178");
  });
});
